// index.js
// LoL Spell HUD 用の「Discordボット」+「複数人同期WebSocket中継サーバー」を
// 1つのプロセスにまとめたもの。Northflankに1つデプロイするだけで両方動く。
//
// 設計方針：
// - このサーバーはスペル/CDの中身を一切理解しない、ただの「状態の中継役」。
//   各HUD(Electron)側が自分の状態(JSON)を送ってきたら、他の全HUDに転送するだけ。
// - 部屋(room)は1つだけの前提（友達数人のグループ用途なので、複数ルームは不要）。
//   ROOM_CODEという合言葉が一致したクライアントだけ接続できる。
// - `/rs` は「全員のHUDをリセットして」という合図をブロードキャストするだけ。
//   リセット後の実際の状態組み立ては各HUD側のresetAll()に任せる。
// - `/join` で入ったVCに向けて、タイマーUP(`timer-up`)が届くたびに通知音を再生する。

require('dotenv').config();

const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ROOM_CODE = process.env.ROOM_CODE || 'change-me';
const HUD_ZIP_URL =
  process.env.HUD_ZIP_URL ||
  '（HUD_ZIP_URL が未設定です。Northflankの環境変数に設定してください）';
const PORT = process.env.PORT || 3000;

// 一定時間、通知音が鳴らなかったら自動でVCから退出する（デフォルト30分）
const VC_IDLE_TIMEOUT_MINUTES = Number(process.env.VC_IDLE_TIMEOUT_MINUTES) || 30;
const VC_IDLE_TIMEOUT_MS = VC_IDLE_TIMEOUT_MINUTES * 60 * 1000;

// VCで鳴らす通知音。lol-hud-server/assets/notify.mp3 を用意してGitHubにpushしてください。
// (HUD側のオフラインモード用notify.mp3とは別物・別ファイルです)
const NOTIFY_SOUND_PATH = path.join(__dirname, 'assets', 'notify.mp3');

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error(
    '[起動失敗] DISCORD_TOKEN と CLIENT_ID は必須です。.env または Northflankの環境変数で設定してください。'
  );
  process.exit(1);
}

// ============================================================
// WebSocket 中継サーバー（HUD間の状態同期）
// ============================================================

let latestState = null; // 直近の全体状態スナップショット。中身はHUD側にしか分からない不透明データ。
const clients = new Set();

const server = http.createServer((req, res) => {
  // Northflankのヘルスチェックや動作確認用に簡単な応答を返す
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('LoL Spell HUD sync server is running.\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let room = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    room = url.searchParams.get('room');
  } catch (e) {
    ws.close(4000, 'bad request');
    return;
  }

  if (room !== ROOM_CODE) {
    ws.close(4001, 'invalid room code');
    return;
  }

  clients.add(ws);
  console.log(`[sync] クライアント接続（現在 ${clients.size} 人）`);

  // クライアント側は、この 'joined' が来て初めて「入室成功」の画面に切り替える
  ws.send(JSON.stringify({ type: 'joined' }));

  // 接続直後、既に誰かが動かしている状態があれば渡して追いつかせる
  if (latestState) {
    ws.send(JSON.stringify({ type: 'state-update', state: latestState }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'state-update' && msg.state) {
      latestState = msg.state;
      broadcast(msg, ws);
    } else if (msg.type === 'timer-up') {
      broadcast(msg, ws);
      queueNotifySound(); // VCに入っていれば通知音を鳴らす（入っていなければ何もしない）
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[sync] クライアント切断（現在 ${clients.size} 人）`);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

function broadcast(msg, exceptWs) {
  const payload = JSON.stringify(msg);
  clients.forEach((c) => {
    if (c !== exceptWs && c.readyState === c.OPEN) {
      c.send(payload);
    }
  });
}

function broadcastReset() {
  latestState = null;
  const payload = JSON.stringify({ type: 'reset' });
  clients.forEach((c) => {
    if (c.readyState === c.OPEN) c.send(payload);
  });
}

server.listen(PORT, () => {
  console.log(`[sync] ポート ${PORT} で待受中`);
});

// ============================================================
// VC通知音の再生（/join で入ったVCで鳴らす）
// ============================================================

let voiceConnection = null;
const audioPlayer = createAudioPlayer();
let notifyQueue = 0;
let isPlayingNotify = false;
let lastVoiceActivityAt = Date.now();

audioPlayer.on(AudioPlayerStatus.Idle, () => {
  isPlayingNotify = false;
  playNextNotify();
});

audioPlayer.on('error', (e) => {
  console.error('[voice] 再生エラー:', e);
  isPlayingNotify = false;
});

function playNextNotify() {
  if (isPlayingNotify || notifyQueue <= 0 || !voiceConnection) return;
  notifyQueue -= 1;
  try {
    const resource = createAudioResource(NOTIFY_SOUND_PATH);
    isPlayingNotify = true;
    audioPlayer.play(resource);
  } catch (e) {
    console.error('[voice] notify.mp3の再生に失敗（ファイルが無いかも）:', e.message);
    isPlayingNotify = false;
  }
}

function queueNotifySound() {
  if (!voiceConnection) return; // botがどのVCにも入っていなければ何もしない
  lastVoiceActivityAt = Date.now();
  notifyQueue += 1;
  playNextNotify();
}

// 一定時間、通知音が鳴らなかったら自動でVCから退出する
setInterval(() => {
  if (!voiceConnection) return;
  const idleMs = Date.now() - lastVoiceActivityAt;
  if (idleMs > VC_IDLE_TIMEOUT_MS) {
    console.log(`[voice] ${VC_IDLE_TIMEOUT_MINUTES}分間操作が無かったため自動退出しました`);
    voiceConnection.destroy();
    voiceConnection = null;
  }
}, 60 * 1000);

// ============================================================
// Discordボット（/rs, /setup, /join, /leave）
// ============================================================

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName('rs')
    .setDescription('LoL Spell HUDの試合リセット（全員のHUDを初期状態に戻します）'),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('LoL Spell HUDの導入方法とダウンロードリンクを表示します'),
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('botを自分がいるVCに呼んで、タイマーUP時の通知音再生を有効にします'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('botをVCから退出させます（通知音は鳴らなくなります）'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('[discord] ギルド限定コマンドを登録しました（即反映）');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(
      '[discord] グローバルコマンドを登録しました（反映まで最大1時間ほどかかる場合があります）'
    );
  }
}

discordClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'rs') {
    const inVoice = Boolean(
      interaction.member && interaction.member.voice && interaction.member.voice.channelId
    );

    if (!inVoice) {
      await interaction.reply({
        content: '⚠️ VC（ボイスチャンネル）に参加してから実行してください。',
        ephemeral: true,
      });
      return;
    }

    broadcastReset();
    await interaction.reply('🔄 試合リセットしました。全員のHUDが初期状態に戻ります。');
    return;
  }

  if (interaction.commandName === 'join') {
    const channel = interaction.member && interaction.member.voice && interaction.member.voice.channel;

    if (!channel) {
      await interaction.reply({
        content: '⚠️ 先にVC（ボイスチャンネル）に参加してから実行してください。',
        ephemeral: true,
      });
      return;
    }

    if (voiceConnection) {
      voiceConnection.destroy();
      voiceConnection = null;
    }

    voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    voiceConnection.subscribe(audioPlayer);
    lastVoiceActivityAt = Date.now();

    voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
      voiceConnection = null;
    });

    await interaction.reply(`🔊 「${channel.name}」に参加しました。タイマーがUPになったらここで通知音を鳴らします。`);
    return;
  }

  if (interaction.commandName === 'leave') {
    if (voiceConnection) {
      voiceConnection.destroy();
      voiceConnection = null;
      await interaction.reply('👋 VCから退出しました。');
    } else {
      await interaction.reply({ content: 'もともとVCには参加していません。', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'setup') {
    const embed = new EmbedBuilder()
      .setTitle('🎮 LoL Spell HUD セットアップ')
      .setDescription(
        [
          '**導入方法**',
          '1. 下のリンクからHUDをダウンロード',
          '2. zipを展開',
          '3. 中のexeを起動（または `npm install` → `npm start`）',
          '4. HUDが表示されたら使用開始',
          '',
          '**複数人同期を使う場合**',
          'HUD起動時に出る「ルームに入る」画面で、教えてもらったルームコードを入力してください。',
          '',
          '**基本操作**',
          '左クリック：タイマー開始 / 停止',
          '右クリック：可変スペル切り替え（対応スロットのみ）',
          'Cosmic / Ionianアイコンクリック：補正ON/OFF',
          '`/rs`：試合リセット（VC参加者のみ実行可）',
          '`/join`：VC通知音を鳴らすため、botを自分のVCに呼ぶ',
          '`/leave`：botをVCから退出させる',
          '',
          `**ダウンロード**\n${HUD_ZIP_URL}`,
        ].join('\n')
      )
      .setColor(0x5865f2);

    await interaction.reply({ embeds: [embed] });
  }
});

discordClient.once('ready', () => {
  console.log(`[discord] ${discordClient.user.tag} としてログインしました`);
});

registerCommands()
  .then(() => discordClient.login(DISCORD_TOKEN))
  .catch((e) => {
    console.error('[discord] 起動に失敗しました:', e);
    process.exit(1);
  });

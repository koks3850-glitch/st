ここに notify.mp3 という名前でVC通知音のファイルを置いてください。

- HUD側（lol-hud/assets/notify.mp3）はオフライン起動モード限定のローカル再生用です。
- こちら（lol-hud-server/assets/notify.mp3）は、オンライン同期モード時にDiscordのVCで
  再生される音声ファイルです。**別のファイルなので、両方に置く必要があります。**

このファイルを置いたら、GitHubにpush（またはアップロード）してNorthflankで再デプロイしてください。
ファイルが無い場合、通知音は鳴らないだけでエラーにはなりません。

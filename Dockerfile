FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

# NorthflankはPORT環境変数を自動で渡してくるので、index.js側でそれを使う
CMD ["node", "index.js"]

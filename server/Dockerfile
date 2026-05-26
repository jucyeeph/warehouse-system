FROM node:18-alpine

WORKDIR /app

# 安装依赖（better-sqlite3需要编译工具）
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js thumbnail-service.js thumbnails-cli.js ./

EXPOSE 3000

CMD ["node", "server.js"]

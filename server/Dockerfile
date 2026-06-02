FROM node:22-alpine

WORKDIR /app

# Native dependencies such as better-sqlite3 and sharp need build tools when
# prebuilt packages are unavailable for the NAS platform.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js thumbnail-service.js thumbnails-cli.js ./

EXPOSE 3000

CMD ["node", "server.js"]

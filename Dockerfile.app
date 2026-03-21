FROM node:20-alpine AS builder

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm install

COPY client/ ./client/
RUN cd client && npm run build

FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

RUN apk add --no-cache procps

COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p recordings

EXPOSE 8086

ENV PORT=8086

CMD ["node", "server/index.js"]

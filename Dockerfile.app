FROM node:20-alpine AS builder

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm install

COPY client/ ./client/
RUN cd client && npm run build

FROM node:20-alpine

RUN apk add --no-cache ffmpeg procps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist

EXPOSE 8086

ENV PORT=8086

RUN mkdir -p recordings

CMD ["node", "server/index.js"]

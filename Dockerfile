FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY container/package.json ./package.json
RUN npm install --production

COPY server/services/ffmpeg.js ./services/
COPY container/process.js ./

CMD ["node", "process.js"]

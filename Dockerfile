FROM node:20-alpine

RUN apk add --no-cache ffmpeg mimalloc

ENV LD_PRELOAD=/usr/lib/libmimalloc.so.2

WORKDIR /app

COPY container/package.json ./package.json
RUN npm install --production

COPY server/services/ffmpeg.js ./services/
COPY container/process.js ./

CMD ["node", "process.js"]

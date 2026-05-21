FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core fonts-noto-color-emoji \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

# Use a recent static ffmpeg build (Debian's ffmpeg chokes on "Late SEI" h264 from some providers)
COPY --from=mwader/static-ffmpeg:7.0.2 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:7.0.2 /ffprobe /usr/local/bin/ffprobe

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./server.js

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg
ENV CAPTIONS_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
ENV EMOJI_FONT_FILE=/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf

CMD ["node", "server.js"]

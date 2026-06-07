FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Render/scavenge toolchain: ffmpeg (encode/concat), chromium (Hyperframes headless render),
# yt-dlp (media download), python3 (TTS/STT models). chromium is provided by the OS so
# Hyperframes/puppeteer reuse it instead of downloading a second copy.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip curl ca-certificates chromium \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TRANSPORT=http \
    PORT=3100 \
    STORAGE_TYPE=local \
    STORAGE_PATH=/data/output \
    MEDIA_CACHE_DIR=/data/cache \
    WORKDIR=/tmp/video-creator-jobs

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Bake the Hyperframes render engine into the image (its native sharp dep resolves a Linux
# prebuilt here, unlike on dev machines). System chromium is reused via PUPPETEER_EXECUTABLE_PATH.
RUN npm install -g hyperframes@0.6.77 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY gsap ./gsap

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1
CMD ["node", "dist/index.js"]

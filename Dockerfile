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
      ffmpeg python3 python3-pip curl ca-certificates chromium unzip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -o /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && chmod +x /usr/local/bin/deno \
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
RUN npm install -g hyperframes@0.6.77 && npm cache clean --force \
    # The global install puts the runtime at node_modules/hyperframes/dist, but the
    # CLI's loader resolves its core at <prefix>/lib/core/dist — bridge them.
    && mkdir -p /usr/local/lib/core \
    && ln -sfn /usr/local/lib/node_modules/hyperframes/dist /usr/local/lib/core/dist

COPY --from=build /app/dist ./dist
COPY gsap ./gsap

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1
CMD ["node", "dist/index.js"]

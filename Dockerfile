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
# Hyperframes/puppeteer reuse it instead of downloading a second copy. deno is yt-dlp's
# JavaScript runtime and the yt-dlp[default] extra bundles the EJS challenge-solver scripts
# so YouTube's n-signature challenges resolve offline, without a runtime fetch from GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip curl ca-certificates chromium unzip \
      fonts-liberation fonts-noto-color-emoji fonts-noto-core \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
    && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -o /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && chmod +x /usr/local/bin/deno \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell \
    # Hyperframes self-updates the global install via `npm install -g` at runtime; in an
    # immutable image that's an anti-pattern, and concurrent renders race on the install
    # (ENOENT/ENOTEMPTY). Pin the baked version and disable the runtime update.
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_AUTO_INSTALL=1 \
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
RUN npm install -g hyperframes@0.6.81 && npm cache clean --force \
    # The global install puts the runtime at node_modules/hyperframes/dist, but the
    # CLI's loader resolves its core at <prefix>/lib/core/dist — bridge them.
    && mkdir -p /usr/local/lib/core \
    && ln -sfn /usr/local/lib/node_modules/hyperframes/dist /usr/local/lib/core/dist

# chrome-headless-shell unlocks BeginFrame-based deterministic capture, which is far
# faster than the screenshot fallback Hyperframes uses with a regular Chrome build.
# The binary ships linux64-only; the build platform here is amd64. Symlink it to a
# stable path so PRODUCER_HEADLESS_SHELL_PATH (set above) resolves regardless of the
# versioned install directory.
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path /opt/puppeteer \
    && shell_path="$(find /opt/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -1)" \
    && test -n "$shell_path" \
    && ln -sfn "$shell_path" /usr/local/bin/chrome-headless-shell

COPY --from=build /app/dist ./dist
COPY gsap ./gsap

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1
CMD ["node", "dist/index.js"]

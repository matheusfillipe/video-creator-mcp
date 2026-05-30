# MCP Video Renderer

MCP (Model Context Protocol) server that renders HTML+GSAP compositions to MP4 video via [Hyperframes](https://hyperframes.dev).

**Transport:** StreamableHTTP (Express)  
**Storage:** Local filesystem or S3/Minio  
**Deploy:** systemd service on port 3100

## Architecture

```
Agent → MCP Tool (render_video) → Queue → Hyperframes CLI → MP4 → Storage → URL
```

The server exposes two MCP tools:
- **render_video** — accepts base64 HTML, optional base64 audio, renders to MP4, returns URL
- **render_queue** — returns current queue status (idle/running, jobs waiting)

Render jobs are queued (one at a time) to avoid CPU spikes.

## Setup

```bash
# Install deps
npm install

# Copy and edit env
cp .env.example .env

# Run dev
npm run dev
```

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Server port |
| `STORAGE_TYPE` | `local` | `local` or `s3` |
| `STORAGE_PATH` | `./output` | Local output directory |
| `PUBLIC_URL` | (none) | Base URL for accessing rendered files (no trailing slash) |
| `WORKDIR` | `/tmp/mcp-render-jobs` | Temp working dir for render jobs |
| `S3_ENDPOINT` | — | S3/Minio endpoint (when `s3`) |
| `S3_BUCKET` | — | S3 bucket name |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY` | — | S3 access key |
| `S3_SECRET_KEY` | — | S3 secret key |

## Deploy (systemd)

```bash
# Install service
sudo cp mcp-video-renderer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-video-renderer

# Quick restart
./deploy.sh
```

## MCP Client Setup

In Hermes config, register as an MCP server:

```yaml
mcpServers:
  video-renderer:
    type: streamable-http
    url: http://localhost:3100/mcp
```

## HTML Composition Requirements

- Must include `<div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">`
- All elements must use `position:absolute` with `top`/`left` (never `bottom` — causes clipping)
- Canvas: 1920×1080 for landscape, 1080×1920 for portrait
- GSAP animations via `gsap.timeline()` or `gsap.to()` with delays
- Audio: pass as base64 WAV/MP3 in `audio` param — auto-injected as `<audio>` element
- `data-width`/`data-height` on `#root` determines orientation, must match `--resolution`

## API

### `POST /mcp`
MCP StreamableHTTP endpoint. Initialize with `initialize` request, then send tool calls.

### `GET /health`
```json
{ "status": "ok", "storage": "local", "queue": { "current": "idle", "queued": 0 } }
```

### `GET /output/:filename`
Serves rendered videos (local storage mode).

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol
- `express` — HTTP server
- `@aws-sdk/client-s3` — S3 storage
- `zod` — input validation
- `uuid` — job IDs

Requires [Hyperframes CLI](https://hyperframes.dev) installed globally (`npx hyperframes`).

# Video Creator MCP

MCP (Model Context Protocol) server that renders HTML+GSAP compositions to MP4 video via [Hyperframes](https://hyperframes.dev). Includes YouTube/media download, TTS, background removal, analytics, and multi-segment timeline assembly.

**Transport:** StreamableHTTP (Express)
**Storage:** Local filesystem or S3/Minio
**Deploy:** systemd service on port 3100

## Architecture

```
                    ┌─ download_media (yt-dlp)
                    ├─ video_info, search_videos (yt-dlp analytics)
Agent → MCP Tools ─├─ render_video (single segment → Hyperframes → MP4)
                    ├─ render_timeline (multi-segment → concat + audio overlay)
                    ├─ tts (Kokoro-82M text-to-speech)
                    ├─ remove_background (AI background removal)
                    ├─ lint (composition validation)
                    └─ media_cache, render_queue (status/management)
                         │
                         ▼
                    Hyperframes CLI → ffmpeg → Storage → URL
```

Render jobs are queued (one at a time) to avoid CPU spikes.

## MCP Tools

### Rendering

| Tool | Description |
|---|---|
| `render_video` | Render a single HTML+GSAP composition to MP4. Accepts base64 HTML, optional base64 audio, media references. Returns URL. |
| `render_timeline` | Render a multi-segment video in one call. Each segment is rendered individually, concatenated via ffmpeg, with per-segment audio overlay at specified offsets. **Use this for videos with multiple video clips** (tier lists, compilations, montages). |
| `tts` | Generate speech audio from text (Kokoro-82M). Returns base64 WAV for use in `render_video`. |
| `lint` | Validate an HTML+GSAP composition for common mistakes before rendering. |

### Media

| Tool | Description |
|---|---|
| `download_media` | Download video/image from any yt-dlp source (YouTube, TikTok, Twitter, direct URLs). Caches locally. Returns media_id. Supports trim via start/end. |
| `media_cache` | List or remove cached media. |
| `remove_background` | Remove background from video/image (outputs transparent WebM/PNG). Returns new media_id. |
| `get_thumbnail` | Download YouTube video thumbnail. Returns media_id. |

### YouTube Analytics

| Tool | Description |
|---|---|
| `video_info` | Full metadata + analytics for a YouTube video. Includes heatmap (most replayed sections). |
| `search_videos` | Search YouTube, returns top results with metadata. |
| `get_subtitles` | Download subtitles/captions (SRT). Supports auto-generated. |

### Status

| Tool | Description |
|---|---|
| `render_queue` | Check render queue status (idle/running, jobs waiting). |

## render_timeline — Multi-Segment Videos

Hyperframes can only render one `<video>` element per composition (multiple videos stack on top of each other). `render_timeline` solves this by rendering each segment independently, then assembling:

```json
{
  "name": "render_timeline",
  "arguments": {
    "segments": [
      { "html": "<base64 title card>", "duration": 5 },
      { "html": "<base64 text card>", "duration": 3 },
      { "html": "<base64 video clip>", "duration": 8, "media": [{ "media_id": "abc123" }] },
      { "html": "<base64 outro>", "duration": 5 }
    ],
    "audio": [
      { "media_id": "abc123", "offset_ms": 8000, "volume": 0.6, "fade_ms": 1000 }
    ],
    "fps": 30,
    "resolution": "1080p"
  }
}
```

Server-side pipeline:
1. Render each segment via Hyperframes (one `<video>` max per segment)
2. Concatenate all segments via ffmpeg
3. Overlay audio tracks at specified millisecond offsets (with volume + fade)
4. Return single final MP4

**Progress:** Reports segment-by-segment progress via `progressToken`.

## Setup

```bash
# Install deps
npm install

# Copy and edit env
cp .env.example .env

# Run dev
npm run dev
```

## Requirements

- **Node.js** 18+
- **Hyperframes CLI** — `npx hyperframes` (auto-installed on first use)
- **ffmpeg** — for audio overlay and timeline concat
- **yt-dlp** — for YouTube/media downloads (with [deno](https://deno.land) for extraction)
- **Kokoro-82M** Python package — for TTS (`pip install kokoro-onnx`)

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Server port |
| `STORAGE_TYPE` | `local` | `local` or `s3` |
| `STORAGE_PATH` | `./output` | Local output directory |
| `PUBLIC_URL` | (none) | Base URL for accessing rendered files (no trailing slash) |
| `WORKDIR` | `/tmp/mcp-render-jobs` | Temp working dir for render jobs |
| `MEDIA_CACHE_DIR` | `~/.cache/video-creator-mcp/media` | Downloaded media cache |
| `YTDLP_PATH` | `yt-dlp` | Path to yt-dlp binary |
| `YTDLP_COOKIES` | (none) | Path to Netscape cookies.txt for authenticated downloads |
| `YTDLP_FORMAT` | `best[height<=720][ext=mp4]/best[height<=720]/best` | yt-dlp format selector |
| `S3_ENDPOINT` | — | S3/Minio endpoint (when `s3`) |
| `S3_BUCKET` | — | S3 bucket name |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY` | — | S3 access key |
| `S3_SECRET_KEY` | — | S3 secret key |

## Deploy (systemd)

```bash
# Install service
sudo cp video-creator-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now video-creator-mcp

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
- Media: pass `media_id` array, reference in HTML as `src="assets/<filename>"`

## API

### `POST /mcp`
MCP StreamableHTTP endpoint. Initialize with `initialize` request, then send tool calls.

### `GET /health`
```json
{ "status": "ok", "version": "0.2.0", "storage": "local", "queue": { "current": "idle", "queued": 0 } }
```

### `GET /output/:filename`
Serves rendered videos (local storage mode).

## Known Limitations

- **Multiple `<video>` elements**: Hyperframes renders all videos simultaneously (they stack). Use `render_timeline` with one video per segment instead.
- **Audio sync**: Hyperframes plays all `<audio>` from frame 0. Use `render_timeline` for proper per-segment audio, or strip audio and overlay via ffmpeg.
- **Long renders**: Node's built-in `fetch` has a ~5min body timeout. Use `node:http` module or call `render_timeline` (which handles this internally).

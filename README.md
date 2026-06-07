# video-creator-mcp

An agent-driven [MCP](https://modelcontextprotocol.io) server for **scavenging sources, composing, and rendering video**. An agent searches YouTube and other sources, downloads and trims clips, authors HTML+GSAP compositions, and renders them to MP4 via [Hyperframes](https://hyperframes.dev) + ffmpeg.

- **Language:** TypeScript (strict)
- **Transport:** stateless Streamable HTTP (`/mcp`) or stdio
- **Storage:** local filesystem or S3/MinIO
- **Rendering:** asynchronous jobs — submit, then poll for the result URL

## Architecture

```
                 ┌ tools/      thin MCP handlers (one defineTool envelope)
 Agent ── /mcp ──┤ services/   media · youtube · renderer · timeline · tts · effects · storage · engine · jobs
                 └ lib/        exec · net (SSRF guard) · cacheId · lock · queue · fs
                                   │
                          Hyperframes (headless Chrome) + ffmpeg + yt-dlp → Storage → URL
```

Every CPU-heavy operation (render, timeline, tts, lint, background removal) funnels through one
concurrency `Limiter` so parallel work never starves the host. Render/timeline calls are submitted
as background **jobs**; the tool returns a `job_id` you poll with `video_render_status`.

## Tools

| Tool | Purpose |
|---|---|
| `video_render` | Render one HTML+GSAP composition → MP4. Async (returns `job_id`). |
| `video_render_timeline` | Render multiple segments, concatenate, overlay audio tracks at offsets. Async. |
| `video_render_status` | Poll a render/timeline job; when `done`, holds the result `url`. |
| `video_render_queue` | Engine concurrency state + all jobs. |
| `video_download_media` | Download/trim media from any yt-dlp source **or direct URL**. Returns `media_id`. |
| `video_media_cache` | List or remove cached media. |
| `video_search_youtube` | Search YouTube; ranked results. |
| `video_get_info` | Metadata + **most-replayed heatmap peaks** + available subtitles/thumbnails. |
| `video_get_subtitles` | Download captions as SRT. |
| `video_get_thumbnail` | Cache a video thumbnail; returns `media_id`. |
| `video_tts` | Kokoro text-to-speech; returns base64 WAV. |
| `video_lint` | Validate a composition before rendering. |
| `video_remove_background` | AI background removal → transparent media. |

## Composing external audio & video, with volume / mute

Any audio or video URL can be composed in — it does not need to be on YouTube:

1. `video_download_media({ url, start?, end? })` → `media_id` (works for direct `.mp4`/`.mp3`/… links and any yt-dlp source).
2. Reference it in a composition's `media` array as `src="assets/<filename>"`.
3. Control its sound:
   - **Mute a video clip:** author it as `<video muted ...>` in the segment HTML.
   - **Background music / voiceover at a set volume:** add a `video_render_timeline` `audio` track — `{ media_id, offset_ms, volume, fade_ms }`. `volume` is `0`–`1` (`0` mutes it).

## Development

```bash
npm install
npm run dev        # tsx watch, http transport
npm run lint       # biome
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run build      # tsc → dist/
npm start          # node dist/index.js
```

> The render engine (Hyperframes) pulls in the native `sharp` module, which needs a platform
> prebuilt. Use the Docker image (Linux, baked-in Hyperframes) for rendering; some dev machines
> lack a `sharp` prebuilt.

## Docker

```bash
docker compose up --build      # http transport on :3100, volumes for output + media cache
# or
docker build -t video-creator-mcp .
docker run -p 3100:3100 video-creator-mcp
```

The image bundles ffmpeg, chromium, yt-dlp, and Hyperframes.

## Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `TRANSPORT` | `http` | `http` (remote) or `stdio` (local). |
| `PORT` | `3100` | HTTP port. |
| `MCP_API_KEY` | (unset) | If set, requires clients to send it as `x-api-key`. |
| `STORAGE_TYPE` | `local` | `local` or `s3`. |
| `STORAGE_PATH` | `./output` | Local output directory. |
| `PUBLIC_URL` | (unset) | Base URL prefix for returned file links. |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | S3/MinIO settings. |
| `MEDIA_CACHE_DIR` | `~/.cache/video-creator-mcp/media` | Download cache. |
| `WORKDIR` | `/tmp/video-creator-jobs` | Per-render scratch dir. |
| `RENDER_CONCURRENCY` | `1` | Max concurrent engine jobs. |
| `YTDLP_PATH` / `YTDLP_COOKIES` / `YTDLP_FORMAT` | `yt-dlp` / — / 720p mp4 | yt-dlp settings. |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow downloads from private/internal addresses (off blocks SSRF). |

## Security

- Download URLs are validated (`assertSafeUrl`): http/https only, and hosts resolving to
  private/loopback/link-local/metadata addresses are rejected unless `ALLOW_PRIVATE_NETWORK=true`.
- Set `MCP_API_KEY` when exposing the HTTP transport outside a trusted gateway.

## Endpoints

- `POST /mcp` — MCP Streamable HTTP (stateless JSON).
- `GET /health` — `{ status, name, version }`.

## Authoring compositions

Compositions are base64-encoded HTML with GSAP. Key rules (run `video_lint` first):

- Include `<div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">`.
- All elements `position:absolute` with `top`/`left` (never `bottom`).
- `gsap.timeline({ paused: true })` registered on `window.__timelines["main"]`; timed elements get `class="clip"` + `data-start`/`data-duration`/`data-track-index`.
- No `Math.random` (seed it), no fetch/async during setup. Animate a wrapper around `<video>`; one `<video>` per composition (use `video_render_timeline` for multiple clips).

See <https://hyperframes.mintlify.app/llms.txt> for the full Hyperframes reference.

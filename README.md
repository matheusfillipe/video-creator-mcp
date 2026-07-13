> ⚠️ No code here was created or reviewed by a human. Use at your own risk.

# video-creator-mcp

**An AI agent's video studio, behind an API.**

Hand an MCP-capable agent a prompt — "make a 2-minute documentary about X" — and this server does the hands-on work: finds footage on YouTube, grabs the right clips, lays text and animation over them, syncs music, narrates, and renders a finished MP4. Everything an LLM can't do on its own, in one place.

```
agent: "make a 90s explainer about quantum entanglement, narrate it"
server:  searches YouTube → picks 8 clips at their heatmap peaks
         generates voiceover, mixes it under the music
         stamps captions, renders 1920×1080 H.264
         returns:  https://your-bucket/render-abc123.mp4
```

## What it can do

- **Find footage** — YouTube search with metadata, "most-replayed" heatmaps, full caption/subtitle search to clip the exact moment someone says X.
- **Pull media from anywhere** — YouTube, TikTok, X, Reddit, Vimeo, or any direct audio/video/image URL. Range-trim at download, SSRF-guarded.
- **Compose** — full slideshows (`video_render_slideshow`), animated countdowns/tier lists, terminal demos, data-driven line charts, or fully custom HTML+GSAP scenes. Templates stamp the HTML for the agent — no hand-authored markup needed for the common shapes.
- **Edit on the timeline** — multiple clips with per-segment text overlays, background video that plays *through* text changes (not restarting on every slide), Ken-Burns zoom on stills.
- **Audio control** — per-clip volume + mute, soundtrack/narration overlay with fade and offset, video length auto-clamped to the music.
- **Narrate** — built-in TTS with multiple voices.
- **Render in the background** — submit a job, poll for the URL. Nothing blocks the agent on a multi-minute render.
- **Catch mistakes before they ship** — composition linter, frame extractor for visual verification, audio-analysis for cut-point grounding.

## Use it from Claude Code

Two ways. Pick one.

### A) Hosted (zero install, recommended)

Connect Claude Code directly to a hosted instance over HTTP:

```bash
claude mcp add --transport http video-creator-mcp \
  https://video-mcp.t3ks.com/mcp \
  --header "x-api-key: YOUR_KEY"
```

This is the fastest path — no toolchain to install locally, GPU-accelerated render server, S3-backed outputs.

### B) Local via npx (self-hosted)

Run the server as a stdio child process under Claude Code. **Needs `ffmpeg` + `chromium` (or `chrome-headless-shell`) + `yt-dlp` on `PATH`** for full functionality:

```bash
claude mcp add video-creator-mcp \
  -- npx -y video-creator-mcp@latest
```

This boots the server in stdio mode and points Claude Code at it. Defaults: `STORAGE_TYPE=local` (writes MP4s to `./output`), media cache in `~/.cache/video-creator-mcp`.

To configure (S3 storage, custom paths, etc.), pass env vars after `--` in the install command, or edit the entry in `~/.claude/claude_desktop_config.json` (or wherever your MCP config lives) and add an `env` block:

```jsonc
{
  "mcpServers": {
    "video-creator-mcp": {
      "command": "npx",
      "args": ["-y", "video-creator-mcp@latest"],
      "env": {
        "TRANSPORT": "stdio",
        "STORAGE_TYPE": "s3",
        "S3_ENDPOINT": "https://s3.example.com",
        "S3_BUCKET": "video-renders",
        "S3_ACCESS_KEY": "...",
        "S3_SECRET_KEY": "...",
        "PUBLIC_URL": "https://video-renders.example.com"
      }
    }
  }
}
```

Once installed (either way), in any Claude Code session try:

> "Make a 30-second video about handyc's GitHub repos with cinematic nature backgrounds and a documentary feel."

The server picks the right rendering tool, downloads source clips, composes captions, renders to MP4, and posts the URL back.

## Develop locally

```bash
npm install
npm run dev          # http://localhost:3100/mcp (Streamable HTTP)
```

Point any MCP client at `http://localhost:3100/mcp`. Set `MCP_API_KEY` to require an `x-api-key` header on every call.


## Docker (recommended)

Rendering needs a headless browser plus ffmpeg; the image bundles both:

```bash
docker build -t video-creator-mcp .
docker run --rm -p 3100:3100 \
  -v $(pwd)/output:/app/output \
  -v $(pwd)/cache:/root/.cache/video-creator-mcp \
  video-creator-mcp
```

For real production use, schedule it on a node with `/dev/dri` access — chrome's WebGL capture path is ~10× faster on a GPU than on software SwiftShader.

## Tools

31 tools spanning search, download, audio, lint, render, verify (including `video_preview_frame` — single-frame composition preview in ~1.5s instead of a full render). Full reference auto-generated from the live server:

**→ [docs/TOOLS.md](docs/TOOLS.md)**

The agent picks the right one from a routing table loaded as an MCP resource (`guide://authoring`); template tools (`video_render_slideshow`, `video_render_tierlist`) and `video_graphic` (kind: terminal/chart/math/manim/block/html) stamp HTML internally so the agent emits JSON, not markup.

## Configuration

Copy `.env.example` to `.env`. Common knobs:

| Var | What |
| --- | --- |
| `TRANSPORT` | `http` (default) or `stdio` |
| `PORT` | `3100` |
| `MCP_API_KEY` | optional; requires `x-api-key` header |
| `STORAGE_TYPE` | `local` (`./output`) or `s3` (MinIO/Cloudflare R2/AWS) |
| `RENDER_CONCURRENCY` | parallel render jobs (default 1) |
| `RENDER_SEGMENT_CONCURRENCY` | parallel chrome segments per job (default 3) |
| `ALLOW_PRIVATE_NETWORK` | unblock downloads of private/internal URLs |

Downloads are SSRF-guarded by default — hosts resolving to private/internal addresses are rejected.

## Under the hood

Compositions are HTML + [GSAP](https://gsap.com), rasterized by [Hyperframes](https://hyperframes.dev) (headless Chrome) and assembled with ffmpeg. The slideshow path groups consecutive same-media segments into one continuous chrome render so the background plays through text transitions naturally. For the authoring rules an agent follows, see <https://hyperframes.mintlify.app/llms.txt>.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:tools   # regenerate docs/TOOLS.md (also runs on pre-commit and in CI)
```

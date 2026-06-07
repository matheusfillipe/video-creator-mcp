# video-creator-mcp

Give an AI agent the ability to **make videos**. It searches YouTube and the web, grabs and trims clips, lays text, images and animation over them, mixes audio, and renders a finished MP4 — all driven over the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-capable agent (like cloudbot) can use it.

Think of it as a small video studio sitting behind an API the agent talks to.

## What it can do

- **Find footage** — search YouTube, read a video's metadata and its "most-replayed" heatmap to pick the best moments.
- **Pull media from anywhere** — YouTube, TikTok, X, Reddit, Vimeo, or any direct audio/video/image URL, trimmed to the part you want.
- **Compose** — stack video clips, text, images and animation; sequence multiple clips into one timeline.
- **Control the sound** — per-clip volume and mute, plus background music or voiceover overlaid at any point.
- **Narrate** — built-in text-to-speech voices.
- **Render** — to MP4 as a background job: the agent submits, gets a job id, and polls until the video is ready (so it never blocks on a long render).

## Quick start

```bash
npm install
npm run dev          # MCP server on http://localhost:3100/mcp
```

Point an MCP client at `http://localhost:3100/mcp` (stateless Streamable HTTP). Set `MCP_API_KEY` to require an `x-api-key` header.

## Run with Docker (recommended)

Rendering needs ffmpeg and a headless browser; the image bundles them, so this is the most reliable way to run it:

```bash
docker compose up --build      # :3100, with volumes for rendered output + media cache
```

## Tools

The agent has 13 tools — search, download, render, timeline, tts, and more. Full reference, every parameter, auto-generated from the live server:

**→ [docs/TOOLS.md](docs/TOOLS.md)**

## Configuration

Copy `.env.example` to `.env`. Common knobs: `TRANSPORT`, `PORT`, `MCP_API_KEY`, `STORAGE_TYPE` (`local`/`s3`), `RENDER_CONCURRENCY`. Downloads are SSRF-guarded — hosts resolving to private/internal addresses are blocked unless `ALLOW_PRIVATE_NETWORK=true`.

## Under the hood

Compositions are HTML + [GSAP](https://gsap.com), rendered to frames by [Hyperframes](https://hyperframes.dev) (headless Chrome) and assembled with ffmpeg. Multi-clip videos render each segment, concatenate them, and mix the audio tracks. For the authoring rules an agent follows, see <https://hyperframes.mintlify.app/llms.txt>.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:tools   # regenerate docs/TOOLS.md (also runs on pre-commit and is checked in CI)
```

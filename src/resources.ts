import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AUTHORING_GUIDE = `# Authoring video compositions

HTML is the source of truth for video. A composition is HTML with \`data-*\` timing attributes, a GSAP timeline for animation, and CSS for appearance; this server base64-encodes it and renders MP4 frames. Run \`video_lint\` before \`video_render\`.

**This is the core skill. For depth — motion principles, techniques, transitions, typography, palettes, data-in-motion, GSAP — call \`video_skill\` (no argument lists every doc; pass a \`doc\` path to read one). Read \`video_skill\` references before any non-trivial or multi-scene composition; the rules below are the minimum.**

## Structure & data attributes
- Standalone composition: put the root div directly in \`<body>\` (no \`<template>\`): \`<div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">\` (N = seconds).
- Tag every timed element with \`data-start\`, \`data-duration\`, and \`data-track-index\` (integer; same-track clips can't overlap; track-index is NOT visual layering — use CSS \`z-index\`).
- Register the timeline — init the registry FIRST, then assign (assigning to \`window.__timelines[...]\` without the \`|| {}\` init throws, since it starts undefined):
\`\`\`js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// ...tweens...
window.__timelines["main"] = tl;
\`\`\`
Duration comes from \`data-duration\`, not the GSAP length. Never create empty tweens to set duration.

## GSAP loading (this server)
GSAP is provided by the renderer — reference \`<script src="assets/gsap.min.js"></script>\`, or omit the script tag and it is injected. NEVER load GSAP from a CDN: renders run with no internet.

## Non-negotiable rules
- **Deterministic:** no \`Math.random()\`, \`Date.now()\`, or time-based logic (seed a PRNG if needed).
- **GSAP animates visual props only** (opacity, x, y, scale, rotation, color, transforms). Never animate \`visibility\`/\`display\`, never call \`video.play()\`/\`audio.play()\` — the framework owns playback.
- **Synchronous timeline build** — never inside \`async\`/\`setTimeout\`/Promise; the engine reads \`window.__timelines\` right after load.
- **No \`repeat: -1\`** — compute a finite repeat count from duration.
- Video must be \`muted playsinline\`; audio is a separate \`<audio>\` element. One \`<video>\` per composition — for multiple clips use \`video_render_timeline\`.
- For later-scene elements use \`tl.set(selector, vars, time)\` inside the timeline, not \`gsap.set()\` at load (they aren't in the DOM yet).

## Layout before animation
Position every element at its most-visible frame as static HTML+CSS first (fill the scene with \`width/height:100%\` + padding + flex/gap; reserve \`position:absolute\` for decoratives). Then add entrances with \`gsap.from()\` (animate FROM offscreen/invisible) and exits with \`gsap.to()\`. Building the end-state first surfaces overlaps before rendering.

## Scene transitions (multi-scene)
Always use transitions between scenes (no jump cuts). Every element animates IN via \`gsap.from()\`. NEVER use exit animations except on the final scene — the transition IS the exit, so the outgoing scene must be fully visible when it fires. (Details + shader options: \`video_skill('hyperframes/references/transitions.md')\`.)

## Animation guardrails
Offset the first animation 0.1-0.3s; vary eases (3+ per scene); 60px+ headlines, 20px+ body, 16px+ labels for rendered video; \`tabular-nums\` on number columns; avoid full-screen linear gradients on dark bg (H.264 banding — use radial/solid + localized glow).

## Building real videos from footage
1. \`video_search_youtube\` → find sources.
2. \`video_get_info\` → read the **heatmap peaks** (most-replayed seconds) to pick the moment.
3. \`video_download_media\` with \`start\`/\`end\` around that peak → a trimmed \`media_id\`.
4. Compose with \`video_render_timeline\`, or a ready template (\`video_render_tierlist\` / \`video_render_terminal\` / \`video_render_chart\`), or a catalog block (\`video_catalog\` → \`video_render_block\`).
5. Poll \`video_render_status\`; the result \`url\` is a public link to the MP4.

**Find a spoken moment:** to clip/loop "the part where he says X", call \`video_search_subtitles\` with \`query: "X"\` — it returns the matching caption lines with \`start\`/\`end\` seconds (or \`available:false\` if the video has no captions). Use those timestamps as the \`start\`/\`end\` for \`video_download_media\`. Omit \`query\` to dump the whole timed transcript.

**Loop/repeat a clip:** to play a clip N times, \`video_download_media\` the range once, then \`video_loop\` with \`media_id\` + \`count\` — stream-copy, keeps audio, near-instant. \`video_loop\` returns a NEW \`media_id\` for the looped clip — use it to compose over the whole loop.

**Loop + changing text/overlays (do it THIS way — it's ~40× cheaper):** \`video_loop\` → its \`media_id\`, then **ONE** \`video_render\` composition: the looped clip as a full-frame \`<video src="assets/<looped-filename>" muted playsinline>\`, plus a GSAP timeline that reveals caption[i] during its window (e.g. each 3s slot). One composition, one render. **Do NOT emit N near-identical \`video_render_timeline\` segments** — that retypes the whole clip's HTML N times (thousands of output tokens, minutes of latency). Render ONCE; never re-author after a render succeeds.

## Overlaying text/graphics on footage (captions, titles, logos, lower-thirds)
**This server IS the compositor — there is no separate "subtitle"/"caption"/"overlay" tool, and you must never pretend one exists or invent a result URL.** To draw text or any element over a clip: reference the clip as a \`<video src="assets/<filename>" muted playsinline ...>\` (pass its \`media_id\` in the \`media\` array) inside a composition, then absolutely-position your text/divs on top — the video and your HTML render composited together. Use \`video_render\` for one overlay over a single clip; use \`video_render_timeline\` when the overlay must CHANGE across the video (e.g. a different caption each loop — one segment per caption, each segment = the same clip + that caption). Each segment's \`media: [{ media_id }]\` keeps the clip's audio.

\`\`\`html
<!-- one timeline segment: the clip + a caption burned on top -->
<video src="assets/<filename>" muted playsinline data-start="0" data-duration="3" data-track-index="0"
       style="position:absolute;top:0;left:0;width:1920px;height:1080px;object-fit:cover"></video>
<div id="cap" class="clip" data-start="0" data-duration="3" data-track-index="1"
     style="position:absolute;left:120px;right:120px;top:880px;text-align:center;color:#fff;font:800 72px Arial;text-shadow:0 3px 10px #000;background:rgba(0,0,0,.5);padding:24px 0;border-radius:16px">have you given up yet?</div>
\`\`\`

Before positioning an overlay over busy footage, call \`video_analyze_static\` on the media — it returns static/structured regions (baked-in subtitles, watermarks, logos) as pixel boxes + a per-cell avoid/clutter grid. Put overlays in low-avoid cells and never cover an avoid region. Skip this for solid-background templates (terminal/chart).

Pass \`metadata\` (title/description/tags) to any render tool and it also writes a \`<video>.json\` publish sidecar to the bucket, returning \`metadata_url\` — the YouTube package, in the same call.`;

const TIERLIST_TEMPLATE = `# Tier-list / countdown template (\`video_render_tierlist\`)

Builds a countdown video without hand-authoring HTML. Layout: an **intro title card**, then for each entry a **black "#rank — name" card** followed by that entry's **video clip** with a **rank badge** (top-right) and a **name lower-third**.

## Workflow
For each entry: \`video_search_youtube\` → \`video_get_info\` (use \`heatmap_peaks\` to find the hype moment) → \`video_download_media({ url, start, end })\` around that peak → keep the \`media_id\`.
Then call \`video_render_tierlist\` once with all entries.

## Example
\`\`\`json
{
  "title": "Top 10 Most Awaited Games of 2026",
  "subtitle": "Ranked countdown",
  "entries": [
    { "rank": 10, "name": "Game Name", "media_id": "abc123", "clip_seconds": 6 },
    { "rank": 9,  "name": "Another Game", "media_id": "def456", "clip_seconds": 6 }
  ],
  "music_media_id": "optional-music-id",
  "resolution": "1080p"
}
\`\`\`
Clips are muted (so 10 trailers don't clash); pass \`music_media_id\` for a single background track. Returns a \`job_id\` — poll \`video_render_status\`.`;

const TERMINAL_TEMPLATE = `# Terminal template (\`video_render_terminal\`)

Animated macOS terminal: the \`command\` types out character-by-character, then each \`output\` line reveals in sequence and the cursor blinks. Pass data, not HTML.

## Example
\`\`\`json
{
  "command": "brew install ffmpeg",
  "output": [
    "==> Downloading ffmpeg 7.0.0",
    "==> Pouring ffmpeg--7.0.0.arm64_sonoma.bottle.tar.gz",
    "🍺  /opt/homebrew/Cellar/ffmpeg/7.0.0: 1,800 files, 50MB"
  ],
  "prompt": "user@Mac ~ % ",
  "duration_seconds": 8
}
\`\`\`
Returns a \`job_id\` — poll \`video_render_status\`.`;

const CHART_TEMPLATE = `# Animated line-chart template (\`video_render_chart\`)

Side-scrolling multi-line chart: each series plots left-to-right; once the data fills the visible window (\`window_size\` points) the plot scrolls so the leading edge stays in view, and every series shows a value label pinned to its tip. Pass one or more \`series\` (or a single \`points\` array for one line).

## Example (two series)
\`\`\`json
{
  "title": "Revenue vs. Cost",
  "series": [
    { "name": "Revenue", "color": "#34e3a4",
      "points": [ { "label": "Jan", "value": 12 }, { "label": "Feb", "value": 19 }, { "label": "Mar", "value": 31 } ] },
    { "name": "Cost", "color": "#ff7a90",
      "points": [ { "value": 8 }, { "value": 11 }, { "value": 14 } ] }
  ],
  "y_label": "$ (k)",
  "value_suffix": "k",
  "window_size": 8,
  "duration_seconds": 10
}
\`\`\`
x-axis labels come from the first series. For lots of points, raise \`duration_seconds\` and keep \`window_size\` small so it scrolls smoothly. Returns a \`job_id\` — poll \`video_render_status\`.`;

const HYPERFRAMES_GUIDE = `# Hyperframes block catalog

Beyond the dedicated templates, this server can render any block from HeyGen's Hyperframes catalog (80+ blocks: terminals, charts, maps/globe, captions, transitions, device showcases, …).

## Workflow
1. \`video_catalog({ query?, type?, tag? })\` — discover blocks (returns name, type, description, tags).
2. \`video_render_block({ name, duration_seconds? })\` — render a block as-is to MP4. Best for self-contained GSAP/SVG blocks; blocks shipping extra asset files (3D, html-in-canvas) aren't supported by render_block.

## When to use what
- Countdown/ranking → \`video_render_tierlist\`
- Terminal → \`video_render_terminal\` (command + output)
- Line chart → \`video_render_chart\` (points array)
- Anything else in the catalog → \`video_render_block\`
- Fully custom → author HTML and call \`video_render\`

Full Hyperframes reference: <https://hyperframes.mintlify.app/llms.txt>`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "authoring-guide",
    "guide://authoring",
    {
      title: "Composition authoring guide",
      description: "Rules + workflow for building videos with this server (read before authoring).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AUTHORING_GUIDE }],
    }),
  );

  server.registerResource(
    "tierlist-template",
    "template://tierlist",
    {
      title: "Tier-list / countdown template",
      description:
        "How to build countdown/tier-list videos with video_render_tierlist + the heatmap workflow.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: TIERLIST_TEMPLATE }],
    }),
  );

  server.registerResource(
    "terminal-template",
    "template://terminal",
    {
      title: "Terminal animation template",
      description:
        "How to render an animated terminal with video_render_terminal (command + output).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: TERMINAL_TEMPLATE }],
    }),
  );

  server.registerResource(
    "chart-template",
    "template://chart",
    {
      title: "Animated line-chart template",
      description: "How to render an animated line chart with video_render_chart (points array).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: CHART_TEMPLATE }],
    }),
  );

  server.registerResource(
    "hyperframes-catalog",
    "guide://hyperframes",
    {
      title: "Hyperframes block catalog guide",
      description: "Discover + render any catalog block via video_catalog / video_render_block.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: HYPERFRAMES_GUIDE }],
    }),
  );
}

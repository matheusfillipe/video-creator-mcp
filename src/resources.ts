import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AUTHORING_GUIDE = `# Authoring video compositions

A composition is base64-encoded HTML + [GSAP](https://gsap.com) that the renderer turns into MP4 frames. Run \`video_lint\` before \`video_render\`.

## Rules
- Wrap content in \`<div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">\` (N = seconds).
- Every element uses \`position:absolute\` with \`top\`/\`left\` — never \`bottom\` (it clips).
- Register the timeline: \`window.__timelines["main"] = gsap.timeline({ paused: true })\`.
- Tag every timed element with \`class="clip"\` + \`data-start\` + \`data-duration\` + \`data-track-index\`.
- No \`Math.random()\` (seed it), no \`fetch\`/async during setup. Animate a wrapper div around \`<video>\`; never call \`.play()\`/\`.pause()\`.
- One \`<video>\` per composition — for multiple clips use \`video_render_timeline\` (or a template).

## Building real videos
1. \`video_search_youtube\` → find sources.
2. \`video_get_info\` → read the **heatmap peaks** (most-replayed seconds) to pick the best moment.
3. \`video_download_media\` with \`start\`/\`end\` around that peak → a trimmed \`media_id\`.
4. Compose with \`video_render_timeline\`, or a ready template like \`video_render_tierlist\`.
5. Poll \`video_render_status\`; the result \`url\` is a public link to the MP4.
6. Optionally \`video_attach_metadata\` (pass the result \`filename\`) to write a title/description/tags JSON sidecar next to it in the bucket — the publish package for YouTube.

See <https://hyperframes.mintlify.app/llms.txt> for the full Hyperframes reference.`;

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

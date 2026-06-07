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
}

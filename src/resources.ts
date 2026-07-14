import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readSkillDoc } from "./services/skills.js";

const AUTHORING_GUIDE = `# Video editor — quick reference

Pick a tool, fetch sources, render, verify, ship. Most briefs match a template tool — those are seconds of LLM time. Custom HTML is the slow path (~2 min/segment of LLM authoring); call \`video_skill('hyperframes/html-authoring.md')\` ONLY when no template fits.

## STEP 0 — pick the tool from the brief shape

| Brief shape | Tool |
| --- | --- |
| **Cut editing** — trim/join clips, "the part where he says X", stack top/bottom or side-by-side (shorts style), picture-in-picture, speed changes, swap/mix music, plain text overlays | **\`video_edit\`** (one JSON spec → ffmpeg; renders a 60s edit in <1 min) |
| **Narrated video / explainer** (footage documentary, math explainer, or a mix) with narration that must stay in sync | **\`video_plan\` → \`video_compose\`** (declarative composition: captions, music, transitions and layouts are declared in the spec; validate free with video_plan, fix findings, render once) |
| Slideshow: text cards over background clips ("present X", explainer, slide titles) | \`video_render_slideshow\` |
| Math: a function graph, a formula, a constant/number, or a sequence (golden ratio, Fibonacci, Euler's identity, "graph of f(x)", 3blue1brown style) | \`video_graphic\` (kind: math) |
| Math: geometry, a theorem proof, a 3D surface (saddle/paraboloid), a parametric curve (a SPIRAL, Lissajous), or any custom geometry/physics/3D animation | \`video_graphic\` (kind: manim; write a short manim Scene) |
| Loop one clip + rotating timed text ("have you given up?") | \`video_loop\` → \`video_caption\` |
| Countdown / top-N / tier list | \`video_render_tierlist\` |
| Typed terminal command | \`video_graphic\` (kind: terminal) |
| Line chart from data points | \`video_graphic\` (kind: chart) |
| Catalog block (map, globe, device mockup, …) | \`video_catalog\` → \`video_graphic\` (kind: block) |
| Animated graphic overlays (motion design, GSAP) over ONE clip, or any custom HTML/GSAP composition | \`video_graphic\` (kind: html; read html-authoring skill) |

**\`video_edit\` is the path for anything cut-shaped.** It trims, concatenates (with optional crossfades), stacks groups (vstack = top/bottom shorts split, hstack, pip, grid), burns timed text, and lays music over — one call, no HTML, no browser. To cut "the part where he says X": \`video_search_subtitles\` gives the exact start/end, \`video_download_media\` that window, reference the media_id in the spec. Reach for HTML compositions ONLY for animated motion-design overlays the plain text of \`video_edit\` can't express.

**\`video_plan\` → \`video_compose\` is the path for anything narrated.** A composition is tracks of clips: each scene pairs a visual (footage, a still image, or a math graphic) with a narration line, an optional caption clip, and cascading style defaults; a video clip can be trimmed with \`in\`/\`out\` in the scene itself (no separate \`video_edit\` pass for that); music is one audio clip that loops and ducks under the voice; transitions (\`transition_out\` fade) and multi-visual layouts (vstack/hstack/pip/grid) are declared per scene. Keep captions at the default \`bottom\` when a scene's visual has its own top title (a math \`graphic\`'s \`title\` sits at the top, so a top caption crowds it). Always call \`video_plan\` first: it resolves and validates the composition for free and returns findings; fix every error, then call \`video_compose\` exactly once.

**Every generated graphic renders through \`video_graphic\`.** A formula, graph, constant (golden ratio), sequence (Fibonacci), 3D surface (a Pringle/saddle \`z = x²/a² − y²/b²\`), spiral, or theorem proof (kind: math for graphs/formulas, kind: manim for 3D/parametric/geometry) is drawn from the math itself, not sourced from footage or assembled from pictures. A line chart (kind: chart), a typed terminal (kind: terminal), a catalog block (kind: block), or a custom animated overlay (kind: html) all dispatch through the same tool, chosen by \`graphic.kind\`.

## Source fetching — keep it tight
- \`video_search_youtube\` returns several candidates; **pick one per segment without re-searching**. Don't download 30 clips to "have options" — the next turn's LLM call costs ~20s. Each unused download is a wasted minute.
- \`video_get_info\` on a chosen URL surfaces heatmap peaks. \`video_download_media\` with \`start\`/\`end\` around the peak. Reuse clips across segments (different windows of the same source) when the brief doesn't require distinct footage per slide.
- After downloading the SOUNDTRACK: \`video_analyze_audio\` once to ground cut points in real energy peaks, not the user's guessed timestamps.

## Mandatory rules
- **Soundtrack named in the brief → the finished video MUST carry that audio.** Silent video when music was requested is the #1 failure. Download the track, then bake it into the SAME render call: \`video_graphic\` (kind math/manim) and \`video_render_tierlist\` take a \`music_media_id\`; \`video_compose\` takes a music clip on its own audio track; \`video_edit\` takes an \`audio\` track. Only for footage you already rendered silent do you need a separate \`video_add_audio(mode:"replace", loop:true)\`. The music always loops to cover the whole video, so never match the song length to the video or trim either one.
- **Add the music exactly once.** Whether via the render's \`music_media_id\`, a composition's music clip, or one \`video_add_audio\` call — do it a SINGLE time. Do NOT re-download the song or add audio a second time; that just burns turns.
- **Don't re-render after success.** \`video_render_status\` returns a \`url\` → run ONE verify pass → report. Skipping verify ships cropped text; doing more than one re-render burns minutes.

## Vision-validate BEFORE you render — use \`video_preview_frame\`
**Verifying a finished render is the wrong loop.** A full render is minutes; one preview frame is ~1.5s. Catch layout problems while they're still cheap to fix.

Two things take a preview pass before rendering, because their layout is not obvious from the spec:
- Every HTML composition before \`video_graphic\` (kind: html) / \`video_render_timeline\` / \`video_render_slideshow\`: call \`video_preview_frame\` with the SAME html + media, at 3 key timestamps (≈0.5s, mid, ≈95% of duration).
- Any \`video_compose\` scene that is NOT a plain single visual: pass the composition to \`video_preview_frame\` (\`composition\` + an \`at\` timestamp inside each such scene). This applies when a scene uses a multi-visual \`layout\` (vstack/hstack/grid/pip) or a \`caption\` positioned top/center over a visual that has its own title. Preview renders one frame with no TTS, so it is cheap.

Then: vision-check the returned PNGs (or the contact-sheet jpg) for text bleed, layer overlap, letterbox, wrong content, mostly-black, mojibake. All clean → render once. Any bad → fix the spec and preview again. **Render is the LAST step.** When \`video_render_status\` returns a url, report it and STOP (no second verify pass on the finished MP4).

\`video_edit\`, a single-visual \`video_compose\` scene, and \`video_graphic\` kinds math/manim/chart/terminal/block need no preview pass; their layout is deterministic from the spec. Verify their SOURCES instead (\`video_extract_frame\` on downloaded clips) and ship the result directly.

\`video_extract_frame\` is for verifying **source clips** (a freshly downloaded YouTube clip — does it actually contain what the title promised?), not for verifying your own render output. If you used preview_frame correctly, you don't need to re-check the final.

## When to read deeper
- \`video_skill\` (no arg) lists every doc.
- \`video_skill('hyperframes/html-authoring.md')\` — full HTML/GSAP/CSS rules. Read **only** before authoring a custom \`video_graphic\` (kind: html) or \`video_render_timeline\` composition. The slideshow / tierlist / \`video_graphic\` terminal/chart kinds stamp HTML for you.
- \`video_skill('hyperframes/references/transitions.md')\` — multi-scene transition options.

\`\`\`html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><script src="assets/gsap.min.js"></script>
<style>
  body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000;font-family:Arial,sans-serif}
  #v{position:absolute;top:0;left:0;width:1920px;height:1080px;object-fit:cover}
  .label{position:absolute;left:120px;right:120px;top:880px;text-align:center;color:#fff;font-size:72px;font-weight:800;text-shadow:0 3px 10px #000;background:rgba(0,0,0,.5);padding:24px 0;border-radius:16px}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="9" data-width="1920" data-height="1080">
  <video id="v" src="assets/LOOPED_OR_CLIP_FILENAME.mp4" muted playsinline data-start="0" data-duration="9" data-track-index="0"></video>
  <div class="label clip" id="l0" data-start="0" data-duration="3" data-track-index="1">have you given up?</div>
  <div class="label clip" id="l1" data-start="3" data-duration="3" data-track-index="1">still here?</div>
  <div class="label clip" id="l2" data-start="6" data-duration="3" data-track-index="1">rickrolled.</div>
  <script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script>
</div>
</body></html>
\`\`\`

Why it passes (keep these): root div \`data-composition-id="main"\` + \`data-duration\`; the \`<video>\` is \`muted playsinline\` with \`data-start/duration/track-index\`; every timed label has \`class="clip"\` + those data attrs; \`window.__timelines = window.__timelines || {}\` BEFORE assigning \`window.__timelines["main"] = tl\`; timeline built synchronously; no \`Math.random\`. For a looped clip: \`video_loop\` first, then use its returned \`media_id\` + filename here. To place overlays clear of baked-in text, \`video_analyze_static\` returns avoid regions.

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

const TERMINAL_TEMPLATE = `# Terminal graphic (\`video_graphic\` kind: terminal)

Animated macOS terminal: the \`command\` types out character-by-character, then each \`output\` line reveals in sequence and the cursor blinks. Pass data, not HTML.

## Example
\`\`\`json
{
  "graphic": {
    "kind": "terminal",
    "command": "brew install ffmpeg",
    "output": [
      "==> Downloading ffmpeg 7.0.0",
      "==> Pouring ffmpeg--7.0.0.arm64_sonoma.bottle.tar.gz",
      "🍺  /opt/homebrew/Cellar/ffmpeg/7.0.0: 1,800 files, 50MB"
    ],
    "prompt": "user@Mac ~ % "
  },
  "duration_seconds": 8
}
\`\`\`
Returns a \`job_id\` — poll \`video_render_status\`.`;

const CHART_TEMPLATE = `# Animated line-chart graphic (\`video_graphic\` kind: chart)

Side-scrolling multi-line chart: each series plots left-to-right; once the data fills the visible window (\`window_size\` points) the plot scrolls so the leading edge stays in view, and every series shows a value label pinned to its tip. Pass one or more \`series\` (or a single \`points\` array for one line).

## Example (two series)
\`\`\`json
{
  "graphic": {
    "kind": "chart",
    "title": "Revenue vs. Cost",
    "series": [
      { "name": "Revenue", "color": "#34e3a4",
        "points": [ { "label": "Jan", "value": 12 }, { "label": "Feb", "value": 19 }, { "label": "Mar", "value": 31 } ] },
      { "name": "Cost", "color": "#ff7a90",
        "points": [ { "value": 8 }, { "value": 11 }, { "value": 14 } ] }
    ],
    "y_label": "$ (k)",
    "value_suffix": "k",
    "window_size": 8
  },
  "duration_seconds": 10
}
\`\`\`
x-axis labels come from the first series. For lots of points, raise \`duration_seconds\` and keep \`window_size\` small so it scrolls smoothly. Returns a \`job_id\` — poll \`video_render_status\`.`;

const HYPERFRAMES_GUIDE = `# Hyperframes block catalog

Beyond the dedicated templates, this server can render any block from HeyGen's Hyperframes catalog (80+ blocks: terminals, charts, maps/globe, captions, transitions, device showcases, …).

## Workflow
1. \`video_catalog({ query?, type?, tag? })\` — discover blocks (returns name, type, description, tags).
2. \`video_graphic({ graphic: { kind: "block", name }, duration_seconds? })\` — render a block as-is to MP4. Best for self-contained GSAP/SVG blocks; blocks shipping extra asset files (3D, html-in-canvas) aren't supported by kind "block".

## When to use what
- Countdown/ranking → \`video_render_tierlist\`
- Terminal → \`video_graphic\` (kind: terminal; command + output)
- Line chart → \`video_graphic\` (kind: chart; points array)
- Anything else in the catalog → \`video_graphic\` (kind: block)
- Fully custom → author HTML and call \`video_graphic\` (kind: html)

Full Hyperframes reference: <https://hyperframes.mintlify.app/llms.txt>`;

export function registerResources(server: McpServer): void {
  // Served from the skill file so the doc has one source of truth. Registered as a resource
  // (not just a video_skill doc) so the anime.js contract is always in an author's context.
  server.registerResource(
    "animejs-guide",
    "guide://animejs",
    {
      title: "anime.js composition guide",
      description: "Driving a composition with anime.js: the __hfAnime contract and canvas layout.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: readSkillDoc("animejs/authoring.md") },
      ],
    }),
  );

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
        "How to render an animated terminal with video_graphic (kind: terminal; command + output).",
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
      description:
        "How to render an animated line chart with video_graphic (kind: chart; points array).",
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
      description:
        "Discover + render any catalog block via video_catalog / video_graphic (kind: block).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: HYPERFRAMES_GUIDE }],
    }),
  );
}

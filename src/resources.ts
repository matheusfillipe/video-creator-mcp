import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AUTHORING_GUIDE = `# Authoring video compositions

HTML is the source of truth for video. A composition is HTML with \`data-*\` timing attributes, a GSAP timeline for animation, and CSS for appearance; this server base64-encodes it and renders MP4 frames. Run \`video_lint\` before \`video_render\`.

**This is the core skill. For depth — motion principles, techniques, transitions, typography, palettes, data-in-motion, GSAP — call \`video_skill\` (no argument lists every doc; pass a \`doc\` path to read one). Read \`video_skill\` references before any non-trivial or multi-scene composition; the rules below are the minimum.**

## Don't redo work — the #1 latency killer
Author the HTML **once**. \`video_lint\` returns errors AND warnings: **0 errors → render immediately.** Warnings (e.g. \`timed_element_missing_clip_class\`) are non-blocking — never re-author just to clear a warning. Re-author ONLY to fix an actual error. After \`video_render_status\` returns a \`url\`, report it and **STOP** — do not re-lint, re-author, or re-render. Each re-author re-types thousands of HTML tokens (~45s) and each render is minutes; redundant passes are why a job takes 5 minutes instead of 1.

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

**Documentaries / montages / compilations** (several clips into one longer video) = ONE \`video_render_timeline\` call, NOT a single clip and NOT a loop. Download several DIFFERENT sources (\`video_search_youtube\` → \`video_download_media\` a distinct window from each), make each its own 3-15s segment (one \`<video>\` per segment), and let segment-count x length add up to the asked duration — a "2 minute" doc is ~12-20 segments, not one clip stretched out. Put narration/music in the timeline's \`audio\` array; the array takes **media_ids**, so fetch the audio file to a media_id with \`video_download_media\` first (\`video_tts\` returns base64, usable only in single-clip \`video_render\` — for a timeline, download the audio as a URL). Add on-screen facts as text per segment. Match the requested length and clip variety; never loop one clip and call it a documentary, and never describe a length/footage/narration you didn't actually render.

## Curiosity loop — VISION-VALIDATE before committing
A 2-min chrome render costs ~8 minutes of software-GL time, so **validate every assumption upfront**:
1. **Source clip is clean?** After every \`video_download_media\`, call \`video_extract_frame\` at 2-3 timestamps within the window and pass the returned \`url\` to your vision tool (e.g. \`describe_image\`). Reject any clip with baked-in watermarks ("4K Planet Earth", "Nature Relaxation Films", logos), on-screen text/captions, or wrong-scene content. Pick a different window or a different source — never use a source clip you haven't visually checked.
2. **Audio peaks are where the user said?** Call \`video_analyze_audio\` on the soundtrack \`media_id\`. The reported \`active_spans\`, \`mean_volume_db\`, and \`silences\` show you the REAL energy curve — anchor cuts to those, not the user's guessed timestamps.
3. **Layout works at full size?** Before \`video_render_timeline\` of N segments, render the SAME composition with \`data-duration="3"\` via \`video_render\` (a quick sample), then extract frames at 0.5s and 2.5s with \`video_extract_frame\` on the result and vision-check: video element fills 1920×1080 (no letterboxing), text isn't cut off, no overlap with baked source-text, contrast is readable. Fix the HTML before scaling up.
4. **Static overlay zones?** \`video_analyze_static\` on the source returns avoid-region boxes — keep captions/labels in low-clutter, low-static cells.

Treat these as REQUIRED gates, not optional polish. The cost of skipping them is shipping a 10-min render with cropped video and mojibake text.

**Narration & sound — MANDATORY when an audio URL is in the brief.** If the user names a soundtrack/narration URL (or asks for any kind of music or voiceover), the finished video MUST carry that audio — a silent timeline of >30s when audio was named is always wrong, the server warns about it. **And the video length MUST match the soundtrack length** (or the explicit duration the user requested, whichever is shorter): segments summing to more than the audio leaves a silent black tail playing past the music, which is always wrong. Cap your timeline at the soundtrack length and trim the song trailer rather than running video past the music. Two paths:

1. **video_render_timeline path (preferred when you're already building a timeline):** \`video_download_media\` the audio URL → media_id → pass it as an entry in the timeline's \`audio\` array \`[{media_id: "<audio>", offset_ms: 0, volume: 0.8, fade_ms: 1500}]\`. The timeline mixes it during the final render — no extra step.

2. **video_add_audio path (use after a single-clip video_render or video_caption that doesn't take an audio array):** \`video_download_media\` audio URL → media_id → \`video_add_audio(media_id: "<your video>", audio_media_id: "<audio>", mode: "replace")\` lays the voiceover over (muted) footage. To keep the footage's OWN audio as quiet background under narration, use \`mode: "mix"\` with \`existing_volume: 0.2\`.

If narration AND background music are both requested, layer them: timeline.audio gets the music, then \`video_add_audio\` mixes the narration on top of the rendered output. Never hand back a silent video when sound was requested — that's the single most common failure mode the server flags.

**Find a spoken moment:** to clip/loop "the part where he says X", call \`video_search_subtitles\` with \`query: "X"\` → \`matches[]\` with \`start\`/\`end\` seconds; feed them to \`video_download_media\`. The result tells you the \`precision\` you got: **word** (tight per-word window, from auto/ASR captions — best for looping an exact phrase) or **cue** (phrase block ~1-6s, from manual captions — accurate wording). Default \`prefer:"word"\` for the tightest cut; if the auto wording is wrong, re-call with \`prefer:"text"\` for the manual transcript. \`available:false\` = no captions. Omit \`query\` to dump the timed transcript.

**Loop/repeat a clip:** to play a clip N times, \`video_download_media\` the range once, then \`video_loop\` with \`media_id\` + \`count\` — stream-copy, keeps audio, near-instant. \`video_loop\` returns a NEW \`media_id\` for the looped clip — use it to compose over the whole loop.

**Loop + rotating subtitles / talking to the viewer → \`video_caption\` (the cheap, correct path):** \`video_loop\` → its \`media_id\`, then \`video_caption\` with \`captions:[{text,start,duration}, …]\` to burn the timed text straight onto the loop in ONE ffmpeg pass — no HTML, no chrome render, seconds not minutes. This is the right tool for plain timed text ("have you given up yet?", "you still there?", "still watching?"). It returns a finished MP4 \`url\` (and a chainable \`media_id\`). Only reach for an HTML composition (below) when you need animated or graphic overlays beyond plain text. **Never** emit N \`video_render_timeline\` segments to loop a clip.

## Putting text/elements over a clip
**Plain timed text → \`video_caption\` (above): one ffmpeg pass, no HTML.** Reach for an HTML composition here only for richer overlays — animation/motion, styled graphics, logos, lower-thirds. This server IS the compositor (your HTML renders over the \`<video>\`); never invent a result URL. The composition is one small file: **copy this COMPLETE, lint-clean example, change the video filename + label text/timings, \`video_lint\` once (passes as-is), then \`video_render\` with \`media:[{ media_id }]\`.** Don't split one clip into N segments, don't re-author after lint passes.

**Labels appear/disappear by \`class="clip"\` + \`data-start\`/\`data-duration\` — the framework does that for you. Write NO per-element GSAP for plain labels (that hand-written JS is where compositions break and lint-loop). The one \`<script>\` is fixed boilerplate — copy it verbatim. Add tweens ONLY if you specifically want motion/fades. Write each label as a plain HTML \`<div>…</div>\` — never build elements in JavaScript (escaped tags like \`<\\/div>\` leak into the video as visible junk).**

**HARD layout rules — every segment, no exceptions.** Without these you ship letterboxed/black-bar slop:
- **Every segment MUST have a \`<video>\` filling the canvas.** A \`video_render_timeline\` segment without a \`<video>\` element renders as a black slide with floating text — completely defeats the point of a video. If you don't have enough source clips for every segment, REUSE clips (the same \`media_id\` can appear in multiple segments at different windows). Black slides are forbidden in documentaries/montages; a text-only intro frame is OK ONLY if the brief explicitly asks for a title card with no footage.
- **Canvas size MUST match the render \`resolution\` param.** \`resolution:"1080p"\` (or "landscape", "4k", "uhd") = body 1920×1080 AND \`data-width="1920" data-height="1080"\` AND \`<video>\` 1920×1080. \`resolution:"portrait"\` = 1080×1920 in all three places. \`resolution:"square"\` = 1080×1080. The server auto-fixes preset mismatches but a self-consistent HTML is faster.
- \`body\` MUST be exactly \`width:Wpx;height:Hpx;margin:0\` matching the canvas (no smaller, no scrollbars).
- The \`<video>\` element MUST cover the full canvas: \`position:absolute;top:0;left:0;width:Wpx;height:Hpx;object-fit:cover\`. NEVER position it in a sub-rectangle, NEVER omit object-fit.
- Text overlays are positioned in PIXELS over the video (\`position:absolute\`), never below it. A black bar full of text is never the right layout — overlay the text on the footage with a translucent backing.
- Always include \`<meta charset="UTF-8">\` in \`<head>\`. Skipping it mojibakes em-dashes/arrows/smart-quotes to "Ã" garbage in chrome.
- Style contract is locked at the brief: pick ONE accent color, ONE font family, ONE motion language (fade vs slide vs zoom) and use it everywhere. Mixing per segment looks amateurish.
- **Read every render error literally.** If the failure says "aspect ratio mismatch", the fix is fixing the HTML dimensions or the resolution param — not switching to catalog blocks "because the runtime is strict". Don't guess at causes; the error text is the cause.

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

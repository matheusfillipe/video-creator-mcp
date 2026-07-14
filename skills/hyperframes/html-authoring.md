# HTML authoring — depth rules

Read this BEFORE using `video_graphic` (kind: html) or `video_render_timeline` with custom HTML. If your brief fits a template tool (slideshow/tierlist/terminal/chart/catalog), the template stamps correct HTML for you — don't read this, just call the template.

## Structure & data attributes
- Standalone composition: put the root div directly in `<body>` (no `<template>`):
  `<div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">` (N = seconds).
- Tag every timed element with `data-start`, `data-duration`, and `data-track-index` (integer; same-track clips can't overlap; track-index is NOT visual layering — use CSS `z-index`).
- Register the timeline — init the registry FIRST, then assign (assigning to `window.__timelines[...]` without the `|| {}` init throws, since it starts undefined):
```js
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// ...tweens...
window.__timelines["main"] = tl;
```
Duration comes from `data-duration`, not the GSAP length. Never create empty tweens to set duration.

## GSAP loading
GSAP is provided by the renderer — reference `<script src="assets/gsap.min.js"></script>`, or omit the script tag and it is injected. NEVER load GSAP from a CDN: renders run with no internet.

## Non-negotiable rules
- **Deterministic:** no `Math.random()`, `Date.now()`, or time-based logic (seed a PRNG if needed).
- **GSAP animates visual props only** (opacity, x, y, scale, rotation, color, transforms). Never animate `visibility`/`display`, never call `video.play()`/`audio.play()` — the framework owns playback.
- **Synchronous timeline build** — never inside `async`/`setTimeout`/Promise; the engine reads `window.__timelines` right after load.
- **No `repeat: -1`** — compute a finite repeat count from duration.
- Video must be `muted playsinline`; audio is a separate `<audio>` element. One `<video>` per composition — for multiple clips use `video_render_timeline` with N segments.
- For later-scene elements use `tl.set(selector, vars, time)` inside the timeline, not `gsap.set()` at load (they aren't in the DOM yet).

## Layout before animation
Position every element at its most-visible frame as static HTML+CSS first (fill the scene with `width/height:100%` + padding + flex/gap; reserve `position:absolute` for decoratives). Then add entrances with `gsap.from()` (animate FROM offscreen/invisible) and exits with `gsap.to()`. Building the end-state first surfaces overlaps before rendering.

## Scene transitions (multi-scene)
Always use transitions between scenes (no jump cuts). Every element animates IN via `gsap.from()`. NEVER use exit animations except on the final scene — the transition IS the exit, so the outgoing scene must be fully visible when it fires. (Details + shader options: `video_skill('hyperframes/references/transitions.md')`.)

## Animation guardrails
Offset the first animation 0.1-0.3s; vary eases (3+ per scene); 60px+ headlines, 20px+ body, 16px+ labels for rendered video; `tabular-nums` on number columns; avoid full-screen linear gradients on dark bg (H.264 banding — use radial/solid + localized glow).

## HARD layout rules — every segment, no exceptions
- **Every segment MUST have a `<video>` filling the canvas.** A `video_render_timeline` segment without a `<video>` element renders as a black slide with floating text. If you don't have enough source clips, REUSE clips (same `media_id` at different windows).
- **Canvas size MUST match the render `resolution` param.** `resolution:"1080p"` = body 1920×1080 AND `data-width="1920" data-height="1080"` AND `<video>` 1920×1080. `resolution:"portrait"` = 1080×1920 everywhere. The server auto-fixes preset mismatches but self-consistent HTML is faster.
- `body` MUST be exactly `width:Wpx;height:Hpx;margin:0` matching the canvas (no smaller, no scrollbars).
- The `<video>` element MUST cover the full canvas: `position:absolute;top:0;left:0;width:Wpx;height:Hpx;object-fit:cover`. NEVER position it in a sub-rectangle, NEVER omit object-fit.
- **Text overlays use `position:absolute` over the video**, never below it. A black bar full of text is never the right layout — overlay the text on the footage with a translucent backing.
- **Every text element MUST set ALL FOUR of: `max-width: 80%` (or explicit `left/right` insets), `word-wrap: break-word`, `overflow-wrap: break-word`, `box-sizing: border-box`.** A bare `<h1>Long title</h1>` styled only with `font-size:72px` overflows a 1280×720 canvas horizontally.
- **Two visible text elements MUST NOT share the same anchor.** Two labels at `top:50%; left:50%; transform:translate(-50%,-50%)` render on top of each other. Anchor each text layer to a different region (title at `top:30%`, subtitle at `top:60%`).
- Always include `<meta charset="UTF-8">` in `<head>`. Skipping it mojibakes em-dashes/arrows/smart-quotes to "Ã" garbage.
- Style contract is locked at the brief: pick ONE accent color, ONE font family, ONE motion language (fade vs slide vs zoom) and use it everywhere.
- **Read every render error literally.** If the failure says "aspect ratio mismatch", fix the HTML dimensions or the resolution param — don't switch tools "because the runtime is strict". The error text is the cause.

## Lint-clean template — copy verbatim, change only the bracketed values

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><script src="assets/gsap.min.js"></script>
<style>
  body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000;font-family:Arial,sans-serif}
  #v{position:absolute;top:0;left:0;width:1920px;height:1080px;object-fit:cover}
  .label{position:absolute;left:120px;right:120px;top:880px;text-align:center;color:#fff;font-size:72px;font-weight:800;text-shadow:0 3px 10px #000;background:rgba(0,0,0,.5);padding:24px 0;border-radius:16px;max-width:90%;margin:0 auto;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box}
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
```

Why it passes (keep these): root div `data-composition-id="main"` + `data-duration`; the `<video>` is `muted playsinline` with `data-start/duration/track-index`; every timed label has `class="clip"` + those data attrs; `window.__timelines = window.__timelines || {}` BEFORE assigning `window.__timelines["main"] = tl`; timeline built synchronously; no `Math.random`. For a looped clip: `video_loop` first, then use its returned `media_id` + filename here.

Labels appear/disappear by `class="clip"` + `data-start`/`data-duration` — the framework does that for you. Write NO per-element GSAP for plain labels. The one `<script>` is fixed boilerplate — copy it verbatim. Add tweens ONLY if you specifically want motion/fades. Write each label as plain HTML `<div>…</div>` — never build elements in JavaScript (escaped tags like `<\/div>` leak into the video as visible junk).

## Pre-render checks — VISION-VALIDATE the sources
A 2-min chrome render costs ~8 minutes of software-GL time, so validate upfront:
1. **Source clip is clean?** After `video_download_media`, `video_extract_frame` at 2-3 timestamps within the window → vision tool. Reject baked-in watermarks ("4K Planet Earth", "Nature Relaxation Films"), on-screen text, wrong-scene content.
2. **Audio peaks?** `video_analyze_audio` returns the real energy curve — anchor cuts to that, not the user's guessed timestamps.
3. **Layout works at full size?** Before scaling to N segments, `video_preview_frame` the SAME html + media at 2-3 timestamps (no render, ~1.5-3s/frame), vision-check: video fills 1920×1080 (no letterboxing), text not cut off, no overlap with baked source-text.
4. **Static overlay zones?** `video_analyze_static` returns avoid-region boxes.

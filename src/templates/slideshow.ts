import { escapeHtml } from "./html.js";

export interface SlideshowTextOverlay {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface SlideshowSegmentOptions {
  texts: SlideshowTextOverlay[];
  videoFilename: string;
  totalDurationSeconds: number;
  resolution: "landscape" | "portrait" | "square";
  accentColor?: string;
  isImage?: boolean;
}

const DIMS = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
};

export function slideshowSegmentHtml(opts: SlideshowSegmentOptions): string {
  const { w, h } = DIMS[opts.resolution];
  const fontPx = opts.resolution === "portrait" ? 80 : 84;
  const accent = opts.accentColor ?? "#ffffff";
  const dur = opts.totalDurationSeconds;
  const src = `assets/${opts.videoFilename}`;
  const captions = opts.texts
    .map(
      (t, i) =>
        `  <div class="caption clip" id="c${i}" data-start="${t.startSeconds}" data-duration="${t.durationSeconds}" data-track-index="1">${escapeHtml(t.text)}</div>`,
    )
    .join("\n");
  const tweens = opts.texts
    .map(
      (t, i) =>
        `    tl.from("#c${i}", { opacity: 0, y: 40, duration: 0.7, ease: "power2.out" }, ${t.startSeconds});`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="assets/gsap.min.js"></script>
<style>
  body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000;font-family:'Inter','Helvetica Neue',Arial,sans-serif}
  #v{position:absolute;top:0;left:0;width:${w}px;height:${h}px;object-fit:cover}
  #vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center, transparent 25%, rgba(0,0,0,0.6) 100%);pointer-events:none}
  .caption{position:absolute;left:5%;right:5%;top:50%;transform:translateY(-50%);text-align:center;color:${accent};font-size:${fontPx}px;font-weight:800;line-height:1.18;letter-spacing:-0.015em;text-shadow:0 6px 30px rgba(0,0,0,.85),0 0 80px rgba(0,0,0,.5);max-width:90%;margin:0 auto;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${dur}" data-width="${w}" data-height="${h}">
  ${opts.isImage ? `<img id="v" src="${src}" data-start="0" data-duration="${dur}" data-track-index="0" />` : `<video id="v" src="${src}" muted playsinline data-start="0" data-duration="${dur}" data-track-index="0"></video>`}
  <div id="vignette"></div>
${captions}
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
${tweens}
    window.__timelines["main"] = tl;
  </script>
</div>
</body></html>`;
}

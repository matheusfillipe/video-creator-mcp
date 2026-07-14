// Composition builders for countdown / tier-list videos. Each returns a self-contained
// Hyperframes HTML+GSAP document (one composition = one timeline segment). The render
// pipeline concatenates these segments, so a full tier-list is: intro card, then for each
// entry a black "#rank — name" card followed by the entry's clip with a rank badge + name.

import { escapeHtml } from "./html.js";

function document(durationSeconds: number, body: string, timeline: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="assets/gsap.min.js"></script><style>html,body{margin:0;padding:0}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${durationSeconds}" data-width="1920" data-height="1080" style="position:absolute;top:0;left:0;width:1920px;height:1080px;background:#0a0a0a;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
${body}
</div>
<script>window.__timelines=window.__timelines||{};var tl=gsap.timeline({paused:true});window.__timelines["main"]=tl;${timeline}</script>
</body></html>`;
}

export interface TitleCardOptions {
  title: string;
  subtitle?: string;
  durationSeconds: number;
}

export function titleCardHtml(options: TitleCardOptions): string {
  const title = escapeHtml(options.title);
  const subtitle = options.subtitle ? escapeHtml(options.subtitle) : "";
  const hold = Math.max(0.1, options.durationSeconds - 0.6).toFixed(2);
  const body = `<div class="clip" data-start="0" data-duration="${options.durationSeconds}" data-track-index="0" style="position:absolute;top:430px;left:0;width:1920px;text-align:center;color:#ffffff;font-size:104px;font-weight:800;letter-spacing:1px;">${title}</div>${
    subtitle
      ? `\n<div class="clip" data-start="0" data-duration="${options.durationSeconds}" data-track-index="1" style="position:absolute;top:600px;left:0;width:1920px;text-align:center;color:#7fd1ff;font-size:52px;font-weight:600;">${subtitle}</div>`
      : ""
  }`;
  const timeline = `tl.fromTo(".clip",{opacity:0,y:40},{opacity:1,y:0,duration:0.6,stagger:0.15});tl.to(".clip",{opacity:1,duration:${hold}});`;
  return document(options.durationSeconds, body, timeline);
}

// Clip segments (the ranked video with its rank badge + name lower-third) are composited
// directly with ffmpeg in the timeline assembler — see services/timeline.ts. Only the
// animated title/rank cards are authored here as html compositions.

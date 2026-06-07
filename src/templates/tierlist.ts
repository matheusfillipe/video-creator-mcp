// Composition builders for countdown / tier-list videos. Each returns a self-contained
// Hyperframes HTML+GSAP document (one composition = one timeline segment). The render
// pipeline concatenates these segments, so a full tier-list is: intro card, then for each
// entry a black "#rank — name" card followed by the entry's clip with a rank badge + name.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

export interface RankClipOptions {
  rank: number;
  name: string;
  mediaFilename: string;
  durationSeconds: number;
  accentColor?: string;
}

export function rankClipHtml(options: RankClipOptions): string {
  const name = escapeHtml(options.name);
  const accent = options.accentColor ?? "#ffd24a";
  const hold = Math.max(0.1, options.durationSeconds - 0.6).toFixed(2);
  const body = `<div class="clip" data-start="0" data-duration="${options.durationSeconds}" data-track-index="0" style="position:absolute;top:0;left:0;width:1920px;height:1080px;"><video src="assets/${options.mediaFilename}" muted style="width:100%;height:100%;object-fit:cover;"></video></div>
<div class="clip" data-start="0" data-duration="${options.durationSeconds}" data-track-index="1" style="position:absolute;top:48px;left:1560px;width:320px;text-align:center;background:rgba(0,0,0,0.55);color:${accent};font-size:104px;font-weight:900;padding:6px 0;border-radius:18px;">#${options.rank}</div>
<div class="clip" data-start="0" data-duration="${options.durationSeconds}" data-track-index="2" style="position:absolute;left:60px;top:900px;max-width:1400px;background:rgba(0,0,0,0.62);color:#ffffff;font-size:58px;font-weight:700;padding:16px 30px;border-radius:14px;">${name}</div>`;
  const timeline = `tl.fromTo(".clip[data-track-index='1']",{opacity:0,scale:0.6},{opacity:1,scale:1,duration:0.5,ease:"back.out(2)"});tl.fromTo(".clip[data-track-index='2']",{opacity:0,x:-40},{opacity:1,x:0,duration:0.5},"<0.1");tl.to(".clip",{opacity:1,duration:${hold}});`;
  return document(options.durationSeconds, body, timeline);
}

# Animating a composition with anime.js

`video_render` and `video_render_timeline` seek a paused timeline once per captured frame. GSAP is
the default driver (see the rules in the tool description); **anime.js v3 is also supported** and is
already loaded on the page — reach for it when its syntax expresses the motion more directly
(keyframe arrays, per-property easing, `anime.stagger`).

## Contract with this server
- `anime` is a **global**, injected as `assets/anime.min.js`. Never inline the library.
- Pass the markup to `video_render` as **plain text** — do not base64-encode it yourself.
- Build the timeline with **`autoplay: false`** and register it on **`window.__hfAnime`** (an array):
  ```js
  const tl = anime.timeline({ autoplay: false });
  window.__hfAnime = [tl];
  ```
  Registration is mandatory — a paused timeline is not in `anime.running`, so nothing discovers it.
- Do **not** put an anime.js timeline on `window.__timelines`; that registry is GSAP's, and both
  drivers would then seek the same timeline with different time units.
- `anime` uses **milliseconds** (`duration: 4000` = 4s). The server converts frame time for you.
- One driver per composition. Mixing GSAP and anime.js in one file is untested.

## Laying out a portrait canvas (1080×1920)
The canvas has no responsive layout — every element is absolutely positioned in canvas pixels, so
arithmetic decides the composition. Getting this wrong renders a technically-correct animation that
looks broken.

- **Every non-zero length carries a unit.** `left:190` is invalid CSS: the declaration is dropped,
  the element falls back to the canvas origin, and half of it hangs off-frame. Write `left:190px`.
- **Centre by arithmetic, not by transform.** anime.js writes `transform`, so a centring
  `translate(-50%,-50%)` is overwritten the moment you animate. For a box of width `W`, use
  `left: (1080 - W) / 2 px`. For text, span the canvas — `left:0; width:1080px; text-align:center`.
- **Keep content inside a ~72px margin**, and size a hero element to roughly 60–75% of the canvas
  width (≈ 650–800px). A 700px box at `left:0` is off-centre by 190px; a 960px-tall box starting at
  `top:0` fills the frame.
- **DOM order is paint order.** A later opaque element covers an earlier one. Put the text *after*
  the card, or give it `z-index`.
- **Set every animated property's start state** with `anime.set(...)` or a `[from, to]` array. A
  property the timeline never touches at t=0 renders at its CSS value.
- Verify the framing with `video_preview_frame` on a mid-scene time before you render.

## Worked example (portrait, 5s)
```html
<div id="root" data-composition-id="main" data-start="0" data-duration="5"
     data-width="1080" data-height="1920"
     style="position:absolute;top:0;left:0;width:1080px;height:1920px;background:#0a0a14;overflow:hidden;">

  <!-- hero card: 760 wide → left:(1080-760)/2 = 160px -->
  <div id="card" style="position:absolute;left:160px;top:420px;width:760px;height:900px;
       border-radius:36px;background:linear-gradient(135deg,#ff40ae,#af0095);
       box-shadow:0 24px 90px rgba(255,0,147,.45);"></div>

  <!-- title paints after the card, so it sits on top -->
  <div id="title" style="position:absolute;left:0;top:220px;width:1080px;text-align:center;
       font-family:Arial,Helvetica,sans-serif;font-size:120px;font-weight:900;letter-spacing:8px;
       color:#fff;">
    <span class="ltr">M</span><span class="ltr">O</span><span class="ltr">T</span><span class="ltr">I</span><span class="ltr">O</span><span class="ltr">N</span>
  </div>
</div>
<script>
  anime.set('#card', { translateY: 320, rotate: -6, opacity: 0 });
  anime.set('.ltr',  { opacity: 0, translateY: 40 });

  const tl = anime.timeline({ autoplay: false });
  tl.add({ targets: '#card', translateY: [320, 0], rotate: [-6, 0], opacity: [0, 1],
           duration: 1400, easing: 'easeOutExpo' }, 0);
  tl.add({ targets: '.ltr', opacity: [0, 1], translateY: [40, 0],
           duration: 700, easing: 'easeOutExpo', delay: anime.stagger(70) }, 700);
  window.__hfAnime = [tl];
</script>
```
`.ltr` spans let one tween stagger the letters; without them a single `#title` target fades as a block.

## Gotchas
- Easing names are exact: `easeOutExpo`, not `easeOutExponential`. An unknown name silently falls
  back to the default easing, so the motion you asked for never happens. Parametric forms
  (`cubicBezier(...)`, `spring(...)`, `steps(...)`) are also valid.
- Attributes are `data-duration` / `data-start` / `data-track-index`. A typo renders and does nothing.
- This is anime.js **v3**. The v4 API (`createTimeline`, ES module imports) is not what's loaded.
- The timeline's own length must cover `data-duration`; a shorter timeline holds its last frame.

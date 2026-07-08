# Animating a composition with anime.js

`video_render` and `video_render_timeline` seek a paused timeline once per captured frame. GSAP is
the default driver (see the rules in the tool description); **anime.js v3 is also supported** and is
already loaded on the page — reach for it when its syntax expresses the motion more directly
(keyframe arrays, per-property easing, stagger).

## Contract with this server
- `anime` is a **global**, injected as `assets/anime.min.js`. Never inline the library: the linter
  would then flag the library's own `Math.random()`/`requestAnimationFrame` as your code.
- Build the timeline with **`autoplay: false`** and register it on **`window.__hfAnime`** (an array):
  ```js
  const tl = anime.timeline({ autoplay: false, easing: 'linear' });
  window.__hfAnime = [tl];
  ```
  Registration is mandatory — a paused timeline is not in `anime.running`, so nothing discovers it.
- Do **not** put an anime.js timeline on `window.__timelines`; that registry is GSAP's, and both
  drivers would then seek the same timeline with different time units.
- `anime` uses **milliseconds** (`duration: 4000` = 4s). The server converts frame time for you.
- Everything else is unchanged: the `<div id="root" data-composition-id="main" data-duration="N" …>`
  wrapper, `position:absolute` with `top`/`left`, no `Math.random()`, no `fetch` during setup.
- One driver per composition. Mixing GSAP and anime.js in one file is untested.

## Worked example (portrait, 4s)
```html
<div id="root" data-composition-id="main" data-start="0" data-duration="4"
     data-width="1080" data-height="1920"
     style="position:absolute;top:0;left:0;width:1080px;height:1920px;background:#0a0f1e;overflow:hidden;">
  <div id="box" style="position:absolute;top:150px;left:440px;width:200px;height:200px;background:#ff4d6d;"></div>
  <div id="title" style="position:absolute;top:1500px;left:0;width:1080px;text-align:center;font-size:90px;color:#fff;">anime.js</div>
</div>
<script>
  anime.set('#title', { opacity: 0 });
  const tl = anime.timeline({ autoplay: false, easing: 'linear' });
  tl.add({ targets: '#box',   translateY: 1150, rotate: 360, duration: 4000 }, 0);
  tl.add({ targets: '#title', opacity: [0, 1],  duration: 1200 }, 800);
  window.__hfAnime = [tl];
</script>
```

## Gotchas
- Give every animated element its start state up front (`anime.set(...)`, or a `[from, to]` array on
  the property). A property the timeline never touches at t=0 renders at its CSS value.
- This is anime.js **v3**. The v4 API (`createTimeline`, ES module imports) is not what's loaded.
- The timeline's own length must cover `data-duration`; a shorter timeline holds its last frame.

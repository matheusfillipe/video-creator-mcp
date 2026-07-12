# Authoring a manim scene for `video_render_manim`

`video_render_manim` renders arbitrary [Manim Community](https://docs.manim.community) code to MP4.
Reach for it whenever the visual is a *generated* animation rather than footage or a template:
geometry and proofs, transformations, 3D, number theory, vectors/fields, typography — anything
`video_render_math` (which only draws a formula + its function graph) can't express.

## Contract with this server
- The `code` you pass must define **exactly one `Scene` subclass**; pass its name as `scene_name`.
- Set the output size at module top (this server renders **portrait** shorts by default):
  `config.pixel_width=1080`, `config.pixel_height=1920`, `config.frame_rate=30`. Use `1920`×`1080`
  for landscape. The manim *frame* is 8 units tall; portrait is ~4.5 units wide — keep x within ±2.2.
- Dark background reads best: `self.camera.background_color="#0b0f14"`.
- LaTeX works (`MathTex`, `Tex`) — no keys needed. Put LaTeX in a Python raw string: `MathTex(r"\frac{a}{b}")`.
- Keep it under ~60s of animation. Dense `Surface`/`always_redraw` scenes render slower.
- **Always pass `resolution=(24,24)`–`(32,32)` to `Surface`/`Torus`/`Sphere`.** The default is
  `(101,101)` — ~10k points re-transformed every frame — which turns a 20-second render into many
  minutes. `(24,24)` looks identical at short-video size.
- **Leave the tool's `renderer` param unset.** The server sends a `ThreeDScene` to the GPU (~10x
  faster) and 2D to Cairo, and silently falls back to Cairo if the GPU can't run the scene. Forcing
  `cairo` on a 3D scene turns a ~20s render into minutes.
- **Do NOT add audio in code.** Pass `music_media_id` (from `video_download_media`) to the tool and the
  server loops it under the finished clip.
- **Background music.** If the brief includes a music URL, `video_download_media` it and pass the
  returned `media_id` as `music_media_id`. Otherwise source a royalty-free track
  (`video_search_youtube "no copyright ambient/lofi/cinematic music"` → `video_download_media` a slice
  → `music_media_id`).

## Layout: reserve zones, never overlap (read this — it is the #1 defect)

The frame is **8 units tall** (`y` from `-4` to `+4`). The single most common failure is content
colliding with the title, with a bottom caption, or with itself, because coordinates were **hardcoded**
(`set_y(1.5)`, `move_to([x, 1.5, 0])`, an arrow drawn to a literal `y=3.3`) without accounting for
element heights. A title at `to_edge(UP)` occupies roughly `y > 2.6`; a bottom caption occupies
`y < -2.8`. **Every other mobject — including arrows and a floating `\infty` — must stay strictly
between those lines.**

Rules that prevent it:
- **Reserve the top for the title *and any persistent subtitle*.** If you keep a "Step N — …" label
  under the title, body content must stay below the *subtitle's* bottom, not just the title's.
- **Lay out relatively, not by absolute `y`.** Build each step's content as ONE
  `VGroup(...).arrange(DOWN, buff=…)` / `.arrange(RIGHT, buff=…)`, then place the whole group with
  `.next_to(anchor, DOWN)` / `.move_to(...)` / the `fit_body` helper below. Avoid per-row `set_y`.
- **A rising arrow or `\infty` ends *below* the reserved top**, never at a literal `3.x`.
- **Pin a stack's bottom above the caption**: `stack.next_to([0, BOT, 0], UP, buff=0)`.
- **Fit anything that might be too wide/tall**: `.scale_to_fit_width(min(g.width, 12.5))` (landscape) or
  `4.2` (portrait); `.scale_to_fit_height(TOP - BOT)` if it's too tall.
- **Clear a scene before the next**: `self.play(FadeOut(prev_a, prev_b, …))`.
- **Self-check before you finish.** A cheap `assert` on bounding boxes turns a silent visual overlap into
  a loud error the tool reports back to you — fix the coordinates and re-render:
  `assert body.get_top()[1] < TOP and body.get_bottom()[1] > BOT`.

Copy-paste skeleton (landscape; for portrait use `TOP≈3.0`, width cap `4.2`, `x` within ±2.2):
```python
title = Text("…", font_size=46, weight=BOLD).to_edge(UP, buff=0.5)
subtitle = Text("Step 1 — …", font_size=34, weight=BOLD).next_to(title, DOWN, buff=0.3)  # optional
self.add(title, subtitle)
TOP = subtitle.get_bottom()[1] - 0.35   # no subtitle → title.get_bottom()[1] - 0.35
BOT = -2.6                              # leave room for a bottom caption

def fit_body(m):
    m.scale_to_fit_width(min(m.width, 12.5))
    if m.height > TOP - BOT: m.scale_to_fit_height(TOP - BOT)
    return m.move_to([0, (TOP + BOT) / 2, 0])

body = VGroup(a, b, c).arrange(DOWN, buff=0.6)   # or arrange(RIGHT, ...) for a row
fit_body(body); self.add(body)
assert body.get_top()[1] < TOP and body.get_bottom()[1] > BOT   # catch a collision early
```

## What manim can do here (capability tour)
- **2D geometry / proofs** — `Polygon`, `Circle`, `Line`, `Angle`, `RightAngle`, `Arc`, `Dot`, `Brace`; label with `MathTex`/`Text`; animate `Create`, `DrawBorderThenFill`.
- **Transformations / morphs** — `Transform`, `ReplacementTransform`, `TransformMatchingTex` (great for turning one equation into the next), `Rotate`, `.animate` syntax.
- **3D** — subclass `ThreeDScene`; `ThreeDAxes`, `Surface`, `Sphere`, `Cube`; draw space curves (knots, spirals, Lissajous) with `ParametricFunction(lambda t: …, t_range=[a, b])`; `set_camera_orientation(phi=…, theta=…)` and `begin_ambient_camera_rotation(rate=…)`.
- **Dynamic / data-driven** — `ValueTracker` + `always_redraw(lambda: …)` for anything that follows a moving parameter (traces, sweeps, growing bars, a dot on a path).
- **Graphs** — `Axes().plot(...)`, `MoveAlongPath`, `get_area`, `get_riemann_rectangles` (for calculus visuals `video_render_math` won't do).
- **Number / typography** — `NumberLine`, `NumberPlane`, `Table`, `DecimalNumber` (count-ups), `Write`/`AddTextLetterByLetter`.

## Worked examples (each renders portrait as-is)

### Geometry — Pythagoras with a square on every side
```python
import numpy as np
from manim import *
config.pixel_width=1080; config.pixel_height=1920; config.frame_rate=30
class S(Scene):
    def construct(self):
        self.camera.background_color="#0b0f14"
        self.play(Write(MathTex("a^2 + b^2 = c^2", font_size=64, color="#ffcc00").to_edge(UP, buff=1.1)))
        O=np.array([-0.2,-1.6,0]); a=2.4; b=1.7
        A=O; B=O+np.array([a,0,0]); C=O+np.array([0,b,0])
        self.play(Create(Polygon(A,B,C, color=WHITE, stroke_width=5)))
        sq_a=Polygon(A,B,B+[0,-a,0],A+[0,-a,0], color="#58c4dd", fill_opacity=0.45)
        sq_b=Polygon(A,C,C+[-b,0,0],A+[-b,0,0], color="#34e3a4", fill_opacity=0.45)
        BC=C-B; L=np.linalg.norm(BC); up=np.array([BC[1],-BC[0],0])/L
        sq_c=Polygon(B,C,C+up*L,B+up*L, color="#ff7a90", fill_opacity=0.45)
        self.play(Create(sq_a),Create(sq_b),Create(sq_c))
        self.play(*[FadeIn(MathTex(t,color=c).move_to(s))
                    for t,c,s in [("a^2","#58c4dd",sq_a),("b^2","#34e3a4",sq_b),("c^2","#ff7a90",sq_c)]])
        self.wait(1.5)
```

### Transformation — one shape morphing through many
```python
from manim import *
config.pixel_width=1080; config.pixel_height=1920; config.frame_rate=30
class S(Scene):
    def construct(self):
        self.camera.background_color="#0b0f14"
        self.play(Write(Text("One Shape, Many Forms", font_size=44, color="#58c4dd", weight=BOLD).to_edge(UP, buff=1.2)))
        shape=Circle(radius=2, color="#34e3a4", stroke_width=7); self.play(Create(shape))
        for t in [Square(3.4,color="#ffcc00",stroke_width=7),
                  Triangle(color="#ff7a90",stroke_width=7).scale(2.2),
                  Star(n=6,outer_radius=2,color="#a78bfa",stroke_width=7)]:
            self.play(Transform(shape,t), run_time=1.2); self.wait(0.25)
```

### 3D — a rotating surface
```python
import numpy as np
from manim import *
config.pixel_width=1080; config.pixel_height=1920; config.frame_rate=30
class S(ThreeDScene):
    def construct(self):
        self.camera.background_color="#0b0f14"
        self.set_camera_orientation(phi=65*DEGREES, theta=45*DEGREES)
        axes=ThreeDAxes(x_range=[-3,3],y_range=[-3,3],z_range=[-2,2])
        surf=Surface(lambda u,v: axes.c2p(u,v,np.sin(u)*np.cos(v)), u_range=[-3,3], v_range=[-3,3],
                     resolution=(28,28), fill_opacity=0.85, checkerboard_colors=["#58c4dd","#34e3a4"], stroke_width=1)
        self.add(axes); self.play(Create(surf), run_time=2)
        self.begin_ambient_camera_rotation(rate=0.4); self.wait(4)
```

### Dynamic — a value drives the whole scene (unit circle → sine)
```python
import numpy as np
from manim import *
config.pixel_width=1080; config.pixel_height=1920; config.frame_rate=30
class S(Scene):
    def construct(self):
        self.camera.background_color="#0b0f14"
        self.play(Write(Text("sine, from a circle", font_size=46, color="#ffcc00", weight=BOLD).to_edge(UP, buff=1.0)))
        circ=Circle(radius=1.3, color="#58c4dd").shift(LEFT*3.2+DOWN*0.5)
        axes=Axes(x_range=[0,6.5,PI/2], y_range=[-1.3,1.3,1], x_length=4.5, y_length=2.6).shift(RIGHT*1.2+DOWN*0.5)
        self.play(Create(circ), Create(axes))
        t=ValueTracker(0)
        dot=always_redraw(lambda: Dot(circ.get_center()+1.3*np.array([np.cos(t.get_value()),np.sin(t.get_value()),0]), color="#ff7a90"))
        curve=always_redraw(lambda: axes.plot(np.sin, x_range=[0, max(0.001,t.get_value()), 0.02], color="#ff7a90", stroke_width=5))
        link=always_redraw(lambda: DashedLine(dot.get_center(), axes.c2p(t.get_value(), np.sin(t.get_value())), color=GREY_B, stroke_width=2))
        self.add(dot, curve, link)
        self.play(t.animate.set_value(2*PI), run_time=6, rate_func=linear); self.wait(0.5)
```

## Gotchas
- **Build a curve with `ParametricFunction`, never `VMobject.set_points_smoothly(points)`.** A
  many-point `set_points_smoothly` hangs the GPU renderer outright; the same curve as a
  `ParametricFunction(lambda t: …, t_range=[a, b])` draws in seconds.
- **The 3D camera takes only `phi`, `theta` and `gamma`.** `set_camera_orientation(zoom=…)` /
  `focal_distance=…`, and the matching `camera.set_zoom(…)` / `camera.set_focal_distance(…)`, exist
  only on the CPU camera and abort a GPU render. To frame the shot, scale the mobjects
  (`surface.scale(1.4)`) — don't reach for the camera and don't force `renderer="cairo"`.
- Surface-family kwargs are not validated on the GPU renderer: a misspelled kwarg (e.g.
  `resolution_major=`) is silently ignored and the default `(101,101)` resolution applies — pass
  `resolution=(u,v)` exactly.
- Anything tied to a `ValueTracker` must be wrapped in `always_redraw(lambda: …)`, else it's drawn once and freezes.
- 3D needs `ThreeDScene` (not `Scene`) and a camera orientation, or you see the surface edge-on.
- In a `ThreeDScene`, a title/label made with `Text`/`MathTex` tilts and warps with the camera. Keep 2D text flat and readable by registering it with `self.add_fixed_in_frame_mobjects(label)` (position it with `to_edge`/`to_corner` first), and add it with `self.add(...)` — don't let it live in the rotating 3D space.
- `MathTex`/`Tex` render through LaTeX; keep expressions valid and in raw strings so backslashes survive.
- Overlap with the title/caption is the most common defect — follow "Layout: reserve zones" above; keep
  every mobject (arrows and `\infty` included) between the reserved top and bottom, and self-check with an assert.

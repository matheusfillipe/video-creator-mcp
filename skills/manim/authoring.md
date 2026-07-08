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
- **3D renders on the GPU automatically.** A `ThreeDScene` uses the OpenGL renderer (~3x faster than software); 2D stays on Cairo (most predictable). Override with the tool's `renderer` param (`auto` | `cairo` | `opengl`) if needed.
- **Do NOT add audio in code.** Pass `music_media_id` (from `video_download_media`) to the tool and the
  server loops it under the finished clip.

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
- `set_camera_orientation(phi=…, theta=…)` takes no `zoom=` on the GPU renderer — it aborts the
  render and the scene re-renders on the slow CPU path. Scale the mobjects or move the camera instead.
- Surface-family kwargs are not validated on the GPU renderer: a misspelled kwarg (e.g.
  `resolution_major=`) is silently ignored and the default `(101,101)` resolution applies — pass
  `resolution=(u,v)` exactly.
- Anything tied to a `ValueTracker` must be wrapped in `always_redraw(lambda: …)`, else it's drawn once and freezes.
- 3D needs `ThreeDScene` (not `Scene`) and a camera orientation, or you see the surface edge-on.
- In a `ThreeDScene`, a title/label made with `Text`/`MathTex` tilts and warps with the camera. Keep 2D text flat and readable by registering it with `self.add_fixed_in_frame_mobjects(label)` (position it with `to_edge`/`to_corner` first), and add it with `self.add(...)` — don't let it live in the rotating 3D space.
- `MathTex`/`Tex` render through LaTeX; keep expressions valid and in raw strings so backslashes survive.
- A tall shape can collide with a top title — give the title `to_edge(UP, buff=~1)` and keep the figure below it.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { ExecError, run } from "../lib/exec.js";
import { validateColor } from "../lib/ffmpeg.js";
import type { Resolution } from "../types.js";
import { getCached, mediaIdFor, writeMediaFromBuffer } from "./media.js";
import { dimsFor } from "./timeline.js";

// The plot expression is interpolated into generated Python, so it must be provably
// inert: only numbers, x, arithmetic, and whitelisted math functions may appear.
// Names in NP_FUNCTIONS map to numpy calls; abs/pi/e are handled explicitly in pyExpr.
const NP_FUNCTIONS = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "exp",
  "log",
  "log10",
  "sqrt",
  "floor",
  "ceil",
  "sign",
];
const ALLOWED_FUNCTIONS = [...NP_FUNCTIONS, "abs", "pi", "e"];
const NP_FUNCTION_RE = new RegExp(`\\b(${NP_FUNCTIONS.join("|")})\\b`, "g");

// No whitelisted function takes more than one argument, so a comma could only smuggle
// an extra positional into the generated axes.plot(...) call — disallow it.
const EXPR_TOKEN = /[A-Za-z_]+|[0-9.]+|\*\*|[+\-*/()\s]/g;

export function validatePlotExpr(expr: string): string | null {
  if (expr.length > 200) return "expression too long (max 200 chars)";
  const matched = expr.match(EXPR_TOKEN)?.join("") ?? "";
  if (matched !== expr) return "expression contains unsupported characters";
  for (const token of expr.match(/[A-Za-z_]+/g) ?? []) {
    if (token === "x") continue;
    if (!ALLOWED_FUNCTIONS.includes(token)) {
      return `unknown function or name "${token}" (allowed: x, ${ALLOWED_FUNCTIONS.join(", ")})`;
    }
  }
  return null;
}

export interface MathScene {
  latex: string;
  plot_expr?: string;
  x_range?: number[];
  y_range?: number[];
  duration?: number;
}

export interface MathShortSpec {
  title: string;
  scenes: MathScene[];
  resolution?: Resolution;
  accent_color?: string;
  quick_reveal?: boolean;
}

function pyExpr(expr: string): string {
  return expr
    .replace(NP_FUNCTION_RE, "np.$1")
    .replace(/\babs\b/g, "np.abs")
    .replace(/\bpi\b/g, "np.pi")
    .replace(/\be\b/g, "np.e");
}

function pyStr(s: string): string {
  return JSON.stringify(s);
}

// LaTeX needs its backslashes intact, so it goes into a Python raw string. A raw string
// can't end in a backslash and a bare double quote would terminate it; LaTeX has no use
// for either, so both are rewritten rather than rejected.
function pyRawStr(s: string): string {
  return `r"${s.replace(/"/g, "''").replace(/\\+$/, "")}"`;
}

// Mirrors the manim-style math shorts format: dark background, title up top, each scene
// shows its LaTeX formula and draws the plot left-to-right with a leading dot.
export function mathShortScene(spec: MathShortSpec): string {
  const { width, height } = dimsFor(spec.resolution ?? "portrait");
  const accent = spec.accent_color ?? "#58C4DD";
  // quick_reveal shows the formula/graph immediately instead of animating them in. A narrated
  // scene is cut to its spoken line, so a ~2s reveal would eat a short line before the formula
  // is even visible; the narrated path wants the math on screen for the whole line.
  const quick = spec.quick_reveal ?? false;
  const lines: string[] = [
    "import numpy as np",
    "from manim import *",
    "",
    `config.pixel_width = ${width}`,
    `config.pixel_height = ${height}`,
    "config.frame_rate = 30",
    "",
    "class MathShort(Scene):",
    "    def construct(self):",
    `        self.camera.background_color = "#0b0f14"`,
    `        title = Text(${pyStr(spec.title)}, font_size=52, weight=BOLD, color="${accent}")`,
    "        title.to_edge(UP, buff=0.9)",
    quick ? "        self.add(title)" : "        self.play(Write(title), run_time=1.0)",
  ];
  for (const [i, scene] of spec.scenes.entries()) {
    const duration = scene.duration ?? 6;
    const xr = scene.x_range ?? [-5, 5];
    const yr = scene.y_range ?? [-3, 3];
    lines.push(
      "",
      `        formula${i} = MathTex(${pyRawStr(scene.latex)}, font_size=50)`,
      `        formula${i}.next_to(title, DOWN, buff=0.5)`,
      quick
        ? `        self.add(formula${i})`
        : `        self.play(FadeIn(formula${i}), run_time=0.8)`,
    );
    if (scene.plot_expr) {
      lines.push(
        `        axes${i} = Axes(x_range=[${xr[0]}, ${xr[1]}], y_range=[${yr[0]}, ${yr[1]}], x_length=6.8, y_length=5.2, tips=True, axis_config={"color": GREY_B, "stroke_width": 2})`,
        `        axes${i}.next_to(formula${i}, DOWN, buff=0.5)`,
        `        graph${i} = axes${i}.plot(lambda x: ${pyExpr(scene.plot_expr)}, x_range=[${xr[0]}, ${xr[1]}, 0.01], color="${accent}", stroke_width=5)`,
        `        dot${i} = Dot(color="${accent}", radius=0.09)`,
        `        dot${i}.move_to(graph${i}.get_start())`,
        `        self.play(Create(axes${i}), run_time=${quick ? "0.4" : "1.0"})`,
        `        self.play(Create(graph${i}), MoveAlongPath(dot${i}, graph${i}), run_time=${Math.max(1, duration - (quick ? 0.8 : 3)).toFixed(1)}, rate_func=linear)`,
        "        self.wait(0.8)",
        quick
          ? ""
          : `        self.play(FadeOut(formula${i}), FadeOut(axes${i}), FadeOut(graph${i}), FadeOut(dot${i}), run_time=0.6)`,
      );
    } else {
      lines.push(
        `        self.wait(${duration.toFixed(1)})`,
        quick ? "" : `        self.play(FadeOut(formula${i}), run_time=0.6)`,
      );
    }
  }
  lines.push("        self.wait(0.5)", "");
  return lines.join("\n");
}

export interface ManimRenderOutput {
  buffer: Buffer;
  filename: string;
}

export type ManimRenderer = "auto" | "cairo" | "opengl";

// The Cairo renderer projects 3D on the CPU (slow); the OpenGL renderer draws it on the GPU's DRI
// render node (~3x faster for a ThreeDScene). Cairo stays the default for 2D, where it's fast and
// its output is the most predictable; "auto" switches to OpenGL only when the scene is 3D.
export function useOpenGl(renderer: ManimRenderer, sceneCode: string): boolean {
  if (renderer === "opengl") return true;
  if (renderer === "cairo") return false;
  return /\bThreeDScene\b/.test(sceneCode);
}

async function findRenderedFile(mediaDir: string): Promise<string> {
  const stack = [mediaDir];
  while (stack.length) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".mp4") && !full.includes("partial_movie_files")) return full;
    }
  }
  throw new Error("manim produced no mp4 output");
}

const RENDER_TIMEOUT_MS = 600_000;
// The GPU attempt is speculative: a 3D scene that renders at all on OpenGL finishes in
// well under a minute, and the renderer can deadlock outright on some scenes. Cut it off
// early so the Cairo fallback still has its full budget instead of the request stalling.
const OPENGL_ATTEMPT_TIMEOUT_MS = 120_000;

async function runManimAttempt(
  sceneCode: string,
  sceneName: string,
  useGl: boolean,
  timeoutMs: number = RENDER_TIMEOUT_MS,
): Promise<ManimRenderOutput> {
  const jobId = randomUUID().slice(0, 8);
  const dir = join(config.workDir, `manim-${jobId}`);
  await mkdir(dir, { recursive: true });
  try {
    const scriptPath = join(dir, "scene.py");
    await writeFile(scriptPath, sceneCode);
    const rendererArgs = useGl ? ["--renderer=opengl", "--write_to_movie"] : [];
    await run(
      "manim",
      [
        "render",
        "-q",
        "h",
        "--media_dir",
        join(dir, "media"),
        ...rendererArgs,
        scriptPath,
        sceneName,
      ],
      { timeoutMs, cwd: dir },
    );
    const outFile = await findRenderedFile(join(dir, "media"));
    const buffer = await readFile(outFile);
    return { buffer, filename: `manim-${jobId}.mp4` };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

export async function renderManimScene(
  sceneCode: string,
  sceneName: string,
  renderer: ManimRenderer = "auto",
): Promise<ManimRenderOutput> {
  // "auto" sends a ThreeDScene to the GPU (OpenGL) for speed, but the OpenGL renderer
  // leaves parts of manim's 3D camera API unimplemented (set_camera_orientation(zoom=...)
  // aborts) and deadlocks on some scenes. Fall back to the CPU (Cairo) renderer so the
  // scene still produces a video. An explicit renderer choice is honoured as given, with
  // no fallback.
  if (renderer === "auto" && useOpenGl("auto", sceneCode)) {
    try {
      return await runManimAttempt(sceneCode, sceneName, true, OPENGL_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof ExecError)) throw error;
      return runManimAttempt(sceneCode, sceneName, false);
    }
  }
  return runManimAttempt(sceneCode, sceneName, useOpenGl(renderer, sceneCode));
}

export async function renderMathShort(spec: MathShortSpec): Promise<ManimRenderOutput> {
  if (spec.accent_color && !validateColor(spec.accent_color)) {
    throw new Error(
      `accent_color "${spec.accent_color}" must be a hex value or a basic color name`,
    );
  }
  for (const [i, scene] of spec.scenes.entries()) {
    if (scene.plot_expr) {
      const error = validatePlotExpr(scene.plot_expr);
      if (error) throw new Error(`scene ${i} plot_expr: ${error}`);
    }
  }
  return renderManimScene(mathShortScene(spec), "MathShort");
}

// A math short is a deterministic function of its spec, so a narrated/composed scene that
// re-requests the same formula (e.g. a re-render after tweaking an unrelated scene) hits the
// media cache instead of paying for another manim render.
export async function renderMathShortCached(params: {
  idSeed: string;
  sourceUrl: string;
  spec: MathShortSpec;
}): Promise<{ path: string }> {
  const cached = await getCached(mediaIdFor(params.idSeed));
  if (cached) return { path: cached.path };
  const { buffer } = await renderMathShort(params.spec);
  const meta = await writeMediaFromBuffer({
    idSeed: params.idSeed,
    buffer,
    ext: ".mp4",
    sourceUrl: params.sourceUrl,
  });
  return { path: meta.path };
}

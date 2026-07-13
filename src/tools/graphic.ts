import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { decodeComposition } from "../lib/composition-checks.js";
import { fetchBlockComposition } from "../services/catalog.js";
import { DURATION_RE, muxLoopedMusic, renderWarnings } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderManimScene, renderMathShort } from "../services/manim.js";
import { saveRender } from "../services/publish.js";
import { renderComposition } from "../services/renderer.js";
import { lineChartHtml } from "../templates/chart.js";
import { terminalHtml } from "../templates/terminal.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, compositionHtml, encode, metadataArg } from "./shared.js";

// Collapses the render_math/chart/terminal/manim/block/html tool zoo behind one typed entry
// point, discriminated by graphic.kind. Every branch dispatches to the exact service call the
// standalone render_* tool uses; no rendering logic lives here.

const MATH_GRAPHIC = z.object({
  kind: z.literal("math"),
  title: z.string().min(1).describe("Title shown at the top throughout."),
  scenes: z
    .array(
      z.object({
        latex: z
          .string()
          .min(1)
          .describe("LaTeX for the formula, e.g. 'f(x) = 3e^{-x^2}\\\\sin(15x)'."),
        plot_expr: z
          .string()
          .optional()
          .describe(
            "Plottable expression in x, e.g. '3*exp(-x**2)*sin(15*x)'. Omit for a formula-only scene.",
          ),
        x_range: z
          .array(z.number())
          .length(2)
          .optional()
          .describe("[min, max] for the x-axis. Default [-5, 5]."),
        y_range: z
          .array(z.number())
          .length(2)
          .optional()
          .describe("[min, max] for the y-axis. Default [-3, 3]."),
        duration: z
          .number()
          .min(2)
          .max(20)
          .optional()
          .describe("Seconds for this scene (default 6)."),
      }),
    )
    .min(1)
    .max(12)
    .describe("Scenes shown in sequence, each fading out before the next."),
  accent_color: z.string().optional().describe("Hex color for formulas/graphs."),
});

const CHART_GRAPHIC = z.object({
  kind: z.literal("chart"),
  title: z.string().optional().describe("Chart title shown top-left."),
  series: z
    .array(
      z.object({
        name: z.string().optional().describe("Series name shown in the legend."),
        color: z.string().optional().describe("Line color (CSS); auto-assigned if omitted."),
        points: z
          .array(z.object({ label: z.string().optional(), value: z.number() }))
          .min(2)
          .describe("Ordered points for this series."),
      }),
    )
    .optional()
    .describe("One or more line series plotted together; x-labels come from the first series."),
  points: z
    .array(z.object({ label: z.string().optional(), value: z.number() }))
    .min(2)
    .optional()
    .describe("Convenience for a single line; use `series` for multiple."),
  x_label: z.string().optional().describe("x-axis caption."),
  y_label: z.string().optional().describe("y-axis caption."),
  accent_color: z.string().optional().describe("Line color for the single-series `points` path."),
  value_suffix: z.string().default("").describe("Appended to value labels, e.g. '%' or 'k'."),
  window_size: z
    .number()
    .int()
    .min(2)
    .max(60)
    .default(8)
    .describe("Points visible at once before the chart scrolls."),
  fps: z.number().int().min(1).max(60).default(30),
});

const TERMINAL_GRAPHIC = z.object({
  kind: z.literal("terminal"),
  command: z.string().min(1).describe("Command that types out, e.g. 'brew install ffmpeg'."),
  output: z
    .array(z.string())
    .default([])
    .describe("Output lines shown after the command runs, in order."),
  prompt: z.string().default("user@Mac ~ % ").describe("Shell prompt before the command."),
  fps: z.number().int().min(1).max(60).default(30),
});

const MANIM_GRAPHIC = z.object({
  kind: z.literal("manim"),
  code: z
    .string()
    .min(1)
    .describe("Complete Python source including imports (from manim import *)."),
  scene_name: z.string().min(1).describe("Name of the Scene class to render."),
  renderer: z
    .enum(["auto", "cairo", "opengl"])
    .default("auto")
    .describe(
      "Rendering backend, leave unset. 'auto' (default) runs a 3D ThreeDScene on the GPU and 2D on the CPU, and falls back to the CPU by itself if the GPU can't run the scene. Forcing 'cairo' on a 3D scene costs minutes instead of seconds; only pass this to reproduce a specific backend.",
    ),
});

const BLOCK_GRAPHIC = z.object({
  kind: z.literal("block"),
  name: z.string().min(1).describe("Catalog block slug, e.g. 'data-chart' (see video_catalog)."),
  fps: z.number().int().min(1).max(60).default(30),
});

const htmlMediaRef = z.object({
  media_id: z.string().describe("media_id from video_download_media / video_get_thumbnail."),
});

const HTML_GRAPHIC = z.object({
  kind: z.literal("html"),
  html: compositionHtml("The HTML+GSAP composition markup (plain text; base64 also accepted)."),
  audio_base64: z.string().optional().describe("Base64 WAV/MP3, injected as an <audio> track."),
  audio_volume: z.number().min(0).max(1).default(0.9).describe("Audio volume 0-1."),
  fps: z.number().int().min(1).max(60).default(30).describe("Frames per second."),
  media: z.array(htmlMediaRef).optional().describe("Pre-downloaded media to include."),
});

const GRAPHIC = z.discriminatedUnion("kind", [
  MATH_GRAPHIC,
  CHART_GRAPHIC,
  TERMINAL_GRAPHIC,
  MANIM_GRAPHIC,
  BLOCK_GRAPHIC,
  HTML_GRAPHIC,
]);

// The old video_render_math tool restricts to these four; 4k/uhd were never offered for a
// manim short. Kept as string[] so a wider Resolution literal can be checked with .includes.
const MATH_RESOLUTIONS: string[] = ["1080p", "landscape", "portrait", "square"];

const DESCRIPTION = `Render one generated visual, chosen by graphic.kind: math | chart | terminal | manim | block | html. Dispatch, defaults and validation mirror the standalone render_math/render_chart/render_terminal/render_manim/render_block/render tools exactly; this is a single typed entry point over the same service calls. Common knobs live at the TOP level, not inside graphic, and each is honored only by the kinds noted below; passing one to a kind that doesn't support it is a validation error, not a silent no-op:
- resolution: kind "math" (1080p/landscape/portrait/square, default landscape) and kind "html" (full range, default 1080p).
- duration_seconds: kind "chart" (default 10, max 120), kind "terminal" (default 8, max 60), kind "block" (overrides the block's built-in duration, max 60).
- music_media_id / music_volume: kind "math" and kind "manim" only, looped to cover the whole video.
Examples (one field set per kind; everything else optional):
  math:     { kind: "math", title: "Waves", scenes: [{ latex: "y=\\\\sin(x)", plot_expr: "sin(x)" }] }
  chart:    { kind: "chart", title: "Users", points: [{ value: 10 }, { value: 40 }, { value: 25 }] }
  terminal: { kind: "terminal", command: "brew install ffmpeg", output: ["Installing ffmpeg... done"] }
  manim:    { kind: "manim", code: "from manim import *\\nclass S(Scene):\\n    def construct(self): self.play(Write(Text('Hi')))", scene_name: "S" } (needs MANIM_SCENES enabled)
  block:    { kind: "block", name: "data-chart" } (see video_catalog for names)
  html:     { kind: "html", html: "<div id=\\"root\\" data-composition-id=\\"main\\" data-start=\\"0\\" data-duration=\\"5\\" data-width=\\"1920\\" data-height=\\"1080\\">...</div>" }
Asynchronous: returns a job_id, poll video_render_status until state is "done".`;

export function registerGraphicTools(server: McpServer): void {
  registerTool(server, {
    name: "video_graphic",
    title: "Render a Generated Graphic",
    description: DESCRIPTION,
    inputSchema: {
      graphic: GRAPHIC.describe(
        "The visual to render, discriminated by kind. Pass only the fields for the chosen kind.",
      ),
      resolution: RESOLUTION.optional().describe(
        'Output resolution/orientation. Used by kind "math" and kind "html" only; other kinds always render at 1080p and reject this field.',
      ),
      duration_seconds: z
        .number()
        .positive()
        .max(120)
        .optional()
        .describe(
          'Total video length in seconds. Used by kind "chart", kind "terminal" and kind "block" only; other kinds derive their length from their own content and reject this field.',
        ),
      music_media_id: z
        .string()
        .optional()
        .describe(
          'Background-music media_id from video_download_media, looped to cover the whole video and baked in here. Used by kind "math" and kind "manim" only.',
        ),
      music_volume: z
        .number()
        .min(0)
        .max(2)
        .default(0.8)
        .describe("Music volume (default 0.8); only meaningful together with music_media_id."),
      metadata: metadataArg,
    },
    handler: async ({
      metadata,
      graphic,
      resolution,
      duration_seconds,
      music_media_id,
      music_volume,
    }) => {
      const recipeArgs = { graphic, resolution, duration_seconds, music_media_id, music_volume };

      switch (graphic.kind) {
        case "math": {
          if (duration_seconds !== undefined) {
            throw new Error(
              'duration_seconds is not used by kind "math"; set each scene\'s own duration instead.',
            );
          }
          const mathResolution = resolution ?? "landscape";
          if (!MATH_RESOLUTIONS.includes(mathResolution)) {
            throw new Error(
              `kind "math" only supports resolution 1080p, landscape, portrait or square (got "${mathResolution}").`,
            );
          }
          const { title, scenes, accent_color } = graphic;
          const jobId = submitJob("math", async () => {
            const { buffer, filename } = await renderMathShort({
              title,
              scenes,
              resolution: mathResolution,
              ...(accent_color ? { accent_color } : {}),
            });
            const final = music_media_id
              ? await muxLoopedMusic(buffer, ".mp4", music_media_id, music_volume)
              : buffer;
            return saveRender(final, filename, metadata, {
              tool: "video_graphic",
              args: recipeArgs,
            });
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        case "chart": {
          if (resolution !== undefined) {
            throw new Error('resolution is not used by kind "chart" (always renders at 1080p).');
          }
          if (music_media_id !== undefined) {
            throw new Error('music_media_id is not used by kind "chart".');
          }
          const series =
            graphic.series && graphic.series.length > 0
              ? graphic.series
              : graphic.points
                ? [
                    {
                      points: graphic.points,
                      ...(graphic.accent_color ? { color: graphic.accent_color } : {}),
                    },
                  ]
                : [];
          if (series.length === 0) {
            throw new Error("Provide `series` (one or more lines) or `points` (a single line).");
          }
          const jobId = submitJob("chart", async () => {
            const html = lineChartHtml({
              title: graphic.title,
              series,
              xLabel: graphic.x_label,
              yLabel: graphic.y_label,
              valueSuffix: graphic.value_suffix,
              windowSize: graphic.window_size,
              durationSeconds: duration_seconds ?? 10,
            });
            const { buffer, filename } = await renderComposition({
              htmlBase64: encode(html),
              fps: graphic.fps,
              resolution: "1080p",
            });
            return saveRender(buffer, filename, metadata, {
              tool: "video_graphic",
              args: recipeArgs,
            });
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        case "terminal": {
          if (resolution !== undefined) {
            throw new Error('resolution is not used by kind "terminal" (always renders at 1080p).');
          }
          if (music_media_id !== undefined) {
            throw new Error('music_media_id is not used by kind "terminal".');
          }
          if (duration_seconds !== undefined && duration_seconds > 60) {
            throw new Error('duration_seconds for kind "terminal" is capped at 60.');
          }
          const jobId = submitJob("terminal", async () => {
            const html = terminalHtml({
              command: graphic.command,
              output: graphic.output,
              prompt: graphic.prompt,
              durationSeconds: duration_seconds ?? 8,
            });
            const { buffer, filename } = await renderComposition({
              htmlBase64: encode(html),
              fps: graphic.fps,
              resolution: "1080p",
            });
            return saveRender(buffer, filename, metadata, {
              tool: "video_graphic",
              args: recipeArgs,
            });
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        case "manim": {
          if (!config.manimScenes) {
            throw new Error(
              'kind "manim" is disabled on this server. Set MANIM_SCENES=1 to enable manim scene rendering.',
            );
          }
          if (resolution !== undefined) {
            throw new Error(
              'resolution is not used by kind "manim"; set config.pixel_width/height in the scene code.',
            );
          }
          if (duration_seconds !== undefined) {
            throw new Error(
              'duration_seconds is not used by kind "manim"; control duration in the scene code.',
            );
          }
          const { code, scene_name, renderer } = graphic;
          const jobId = submitJob("manim", async () => {
            const { buffer, filename } = await renderManimScene(code, scene_name, renderer);
            const final = music_media_id
              ? await muxLoopedMusic(buffer, ".mp4", music_media_id, music_volume)
              : buffer;
            return saveRender(final, filename, metadata, {
              tool: "video_graphic",
              args: recipeArgs,
            });
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        case "block": {
          if (resolution !== undefined) {
            throw new Error('resolution is not used by kind "block" (always renders at 1080p).');
          }
          if (music_media_id !== undefined) {
            throw new Error('music_media_id is not used by kind "block".');
          }
          if (duration_seconds !== undefined && duration_seconds > 60) {
            throw new Error('duration_seconds for kind "block" is capped at 60.');
          }
          const { name, fps } = graphic;
          const jobId = submitJob("block", async () => {
            const html = await fetchBlockComposition(name, duration_seconds);
            const { buffer, filename } = await renderComposition({
              htmlBase64: encode(html),
              fps,
              resolution: "1080p",
            });
            const saved = await saveRender(buffer, filename, metadata, {
              tool: "video_graphic",
              args: recipeArgs,
            });
            return { ...saved, block: name };
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        case "html": {
          if (duration_seconds !== undefined) {
            throw new Error(
              'duration_seconds is not used by kind "html"; set data-duration in the composition markup.',
            );
          }
          if (music_media_id !== undefined) {
            throw new Error(
              'music_media_id is not used by kind "html"; pass graphic.audio_base64 instead.',
            );
          }
          const htmlResolution = resolution ?? "1080p";
          const { html, audio_base64, audio_volume, fps, media } = graphic;
          // audio_base64 stays out of the recipe: the sidecar is world-readable and an inline
          // track would put megabytes of base64 next to every render (mirrors video_render).
          const { audio_base64: _omit, ...graphicForRecipe } = graphic;
          const htmlRecipeArgs = { ...recipeArgs, graphic: graphicForRecipe };
          const jobId = submitJob("render", async () => {
            const { buffer, filename } = await renderComposition({
              htmlBase64: html,
              fps,
              resolution: htmlResolution,
              audioBase64: audio_base64,
              audioVolume: audio_volume,
              media,
            });
            const saved = await saveRender(buffer, filename, metadata, {
              tool: "video_graphic",
              args: htmlRecipeArgs,
            });
            const declared = DURATION_RE.exec(decodeComposition(html));
            const warnings = await renderWarnings(buffer, Number(declared?.[1] ?? 0));
            return warnings.length > 0 ? { ...saved, warnings } : saved;
          });
          return {
            job_id: jobId,
            state: "queued",
            poll_with: `video_render_status with job_id "${jobId}"`,
          };
        }

        default: {
          const exhaustive: never = graphic;
          throw new Error(`Unknown graphic.kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  });
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { muxLoopedMusic } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderManimScene, renderMathShort } from "../services/manim.js";
import { saveRender } from "../services/publish.js";
import { registerTool } from "./defineTool.js";
import { metadataArg } from "./shared.js";

const musicArg = {
  music_media_id: z
    .string()
    .optional()
    .describe(
      "Background-music media_id from video_download_media. Looped to cover the whole video and baked in here, so a math short with music is ONE call — no separate video_add_audio.",
    ),
  music_volume: z.number().min(0).max(2).default(0.8).describe("Music volume (default 0.8)."),
};

export function registerManimTools(server: McpServer): void {
  registerTool(server, {
    name: "video_render_math",
    title: "Render a Math Animation Short (manim)",
    description:
      "Render a math-animation video in the classic manim style: dark background, a title, and per scene a LaTeX formula with its graph drawn left-to-right by a moving dot. Pass DATA only — the server generates and renders the manim scene. Perfect for 'graph shorts' (portrait) showing a sequence of functions. plot_expr is a plain math expression in x (sin, cos, exp, log, sqrt, abs, pi, e ... — no arbitrary code). Asynchronous: returns a job_id — poll video_render_status.",
    inputSchema: {
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
      resolution: z.enum(["1080p", "landscape", "portrait", "square"]).default("portrait"),
      accent_color: z.string().optional().describe("Hex color for formulas/graphs."),
      ...musicArg,
      metadata: metadataArg,
    },
    handler: async ({
      title,
      scenes,
      resolution,
      accent_color,
      music_media_id,
      music_volume,
      metadata,
    }) => {
      const jobId = submitJob("math", async () => {
        const { buffer, filename } = await renderMathShort({
          title,
          scenes,
          resolution,
          ...(accent_color ? { accent_color } : {}),
        });
        const final = music_media_id
          ? await muxLoopedMusic(buffer, ".mp4", music_media_id, music_volume)
          : buffer;
        return saveRender(final, filename, metadata);
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });

  if (config.manimScenes) {
    registerTool(server, {
      name: "video_render_manim",
      title: "Render a Custom Manim Scene",
      description:
        'Render arbitrary manim (Manim Community) scene code to MP4 — use for geometry, theorem proofs, transformations, and 3D that video_render_math can\'t express. The code must define exactly one Scene subclass whose name you pass as scene_name. Keep scenes under ~60s. For a portrait short, set the pixel size at module top and a dark background; adapt this skeleton:\n```\nfrom manim import *\nconfig.pixel_width=1080\nconfig.pixel_height=1920\nconfig.frame_rate=30\nclass Proof(Scene):\n    def construct(self):\n        self.camera.background_color="#0b0f14"\n        tri = Polygon([-2,-1.5,0],[2,-1.5,0],[2,1.5,0], color=BLUE)\n        self.play(Create(tri))\n        self.wait(1)\n```\nAsynchronous: returns a job_id — poll video_render_status.',
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("Complete Python source including imports (from manim import *)."),
        scene_name: z.string().min(1).describe("Name of the Scene class to render."),
        ...musicArg,
        metadata: metadataArg,
      },
      handler: async ({ code, scene_name, music_media_id, music_volume, metadata }) => {
        const jobId = submitJob("manim", async () => {
          const { buffer, filename } = await renderManimScene(code, scene_name);
          const final = music_media_id
            ? await muxLoopedMusic(buffer, ".mp4", music_media_id, music_volume)
            : buffer;
          return saveRender(final, filename, metadata);
        });
        return {
          job_id: jobId,
          state: "queued",
          poll_with: `video_render_status with job_id "${jobId}"`,
        };
      },
    });
  }
}

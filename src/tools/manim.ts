import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { submitJob } from "../services/jobs.js";
import { renderManimScene, renderMathShort } from "../services/manim.js";
import { saveRender } from "../services/publish.js";
import { registerTool } from "./defineTool.js";
import { metadataArg } from "./shared.js";

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
      metadata: metadataArg,
    },
    handler: async ({ title, scenes, resolution, accent_color, metadata }) => {
      const jobId = submitJob("math", async () => {
        const { buffer, filename } = await renderMathShort({
          title,
          scenes,
          resolution,
          ...(accent_color ? { accent_color } : {}),
        });
        return saveRender(buffer, filename, metadata);
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
        "Render arbitrary manim (Manim Community) scene code to MP4. The code must define exactly one Scene subclass whose name you pass as scene_name. Use for animations the data-driven tools can't express: geometry, transformations, 3D, physics diagrams. Keep scenes under ~60s. Asynchronous: returns a job_id — poll video_render_status.",
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("Complete Python source including imports (from manim import *)."),
        scene_name: z.string().min(1).describe("Name of the Scene class to render."),
        metadata: metadataArg,
      },
      handler: async ({ code, scene_name, metadata }) => {
        const jobId = submitJob("manim", async () => {
          const { buffer, filename } = await renderManimScene(code, scene_name);
          return saveRender(buffer, filename, metadata);
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeStatic } from "../services/analyzer.js";
import { submitJob } from "../services/jobs.js";
import { downloadMedia } from "../services/media.js";
import { registerTool } from "./defineTool.js";

export function registerAnalyzeTools(server: McpServer): void {
  registerTool(server, {
    name: "video_analyze_static",
    title: "Find Static Regions (Safe Overlay Zones)",
    description:
      "Profile any video URL for static, structured regions — baked logos, watermarks, and on-screen text/banners that an overlay should NOT cover. Returns a grid where each cell scores staticness (unchanging over time), clutter (edge/detail density), and avoid (static AND structured = a baked graphic), plus bounding boxes of the avoid regions and the overall static_pct — all in the source video's pixel coordinates. Pick low-avoid, low-clutter cells to place text/graphics. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      url: z.string().min(1).describe("Video URL (any yt-dlp source or direct media link)."),
      fps: z
        .number()
        .min(0.2)
        .max(10)
        .default(2)
        .describe("Frames sampled per second for the analysis."),
      grid: z.number().int().min(2).max(12).default(4).describe("Grid resolution (NxN cells)."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ url, fps, grid }) => {
      const jobId = submitJob("analyze", async () => {
        const meta = await downloadMedia({ url, audio: false });
        return analyzeStatic(meta.path, fps, grid);
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });
}

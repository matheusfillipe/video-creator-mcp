import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeAudio, analyzeStatic } from "../services/analyzer.js";
import { submitJob } from "../services/jobs.js";
import { downloadMedia, loadMeta } from "../services/media.js";
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

  registerTool(server, {
    name: "video_analyze_audio",
    title: "Profile Audio (Loudness & Silence)",
    description:
      "Profile a clip's audio track — the audio analog of video_analyze_static. Returns duration, mean/max volume (dB), integrated loudness (LUFS) + range, the silence regions, and the complementary active_spans (where there is actually sound). Use it to learn how long generated or fetched narration is, time captions/cuts to where there's speech, or trim dead air. Input is a media_id (e.g. from video_download_media) or any audio/video URL. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      input: z
        .string()
        .min(1)
        .describe("A media_id or an audio/video URL (any yt-dlp source or direct link)."),
      silence_db: z
        .number()
        .min(-90)
        .max(0)
        .default(-30)
        .describe("Silence threshold in dB; audio quieter than this counts as silence."),
      min_silence: z
        .number()
        .min(0.05)
        .max(10)
        .default(0.5)
        .describe("Shortest silence to report, seconds."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ input, silence_db, min_silence }) => {
      const jobId = submitJob("analyze-audio", async () => {
        const cached = await loadMeta(input);
        const path = cached ? cached.path : (await downloadMedia({ url: input, audio: true })).path;
        return analyzeAudio(path, silence_db, min_silence);
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });
}

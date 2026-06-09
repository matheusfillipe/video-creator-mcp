import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { engineStatus } from "../services/engine.js";
import { getJob, listJobs, submitJob } from "../services/jobs.js";
import { renderComposition } from "../services/renderer.js";
import { storage } from "../services/storage.js";
import { assembleTimeline } from "../services/timeline.js";
import { registerTool } from "./defineTool.js";

const RESOLUTION = z.enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"]);
const mediaRef = z.object({
  media_id: z.string().describe("media_id from video_download_media / video_get_thumbnail."),
});

const segmentMediaRef = z.object({
  media_id: z.string().describe("media_id from video_download_media / video_get_thumbnail."),
  volume: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("This clip's own audio volume 0-1 (default 1.0). 0 mutes it."),
  muted: z.boolean().optional().describe("Mute this clip's own audio entirely."),
});

const RENDER_RULES = `Render an HTML+GSAP composition to MP4. Asynchronous: returns a job_id — poll video_render_status until state is "done", then read result.url.

Authoring rules (run video_lint first):
- html must be base64-encoded and contain <div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">.
- All elements use position:absolute with top/left (never bottom). Canvas 1920x1080 landscape, 1080x1920 portrait — must match resolution.
- GSAP: gsap.timeline({ paused: true }) registered on window.__timelines["main"]; add class="clip" + data-start/data-duration/data-track-index to timed elements.
- No Math.random (use a seeded PRNG), no fetch/async during timeline setup. Animate a wrapper div around <video>; never call .play()/.pause().
- For multiple video clips use video_render_timeline instead (one <video> per composition).
- Reference downloaded media as src="assets/<filename>" and pass its media_id in the media array.
Reference: https://hyperframes.mintlify.app/llms.txt`;

export function registerRenderTools(server: McpServer): void {
  registerTool(server, {
    name: "video_render",
    title: "Render Video",
    description: RENDER_RULES,
    inputSchema: {
      html: z.string().min(1).describe("Base64-encoded HTML+GSAP composition."),
      audio_base64: z.string().optional().describe("Base64 WAV/MP3, injected as an <audio> track."),
      audio_volume: z.number().min(0).max(1).default(0.9).describe("Audio volume 0-1."),
      fps: z.number().int().min(1).max(60).default(30).describe("Frames per second."),
      resolution: RESOLUTION.default("1080p").describe("Output resolution/orientation."),
      media: z.array(mediaRef).optional().describe("Pre-downloaded media to include."),
    },
    handler: ({ html, audio_base64, audio_volume, fps, resolution, media }) => {
      const jobId = submitJob("render", async () => {
        const { buffer, filename } = await renderComposition({
          htmlBase64: html,
          fps,
          resolution,
          audioBase64: audio_base64,
          audioVolume: audio_volume,
          media,
        });
        const url = await storage().save(buffer, filename);
        return { url, filename, size_bytes: buffer.byteLength };
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });

  registerTool(server, {
    name: "video_render_timeline",
    title: "Render Multi-Segment Timeline",
    description:
      "Render a multi-segment video: each segment is a self-contained base64 HTML+GSAP composition (3-15s, one <video> max), rendered independently then concatenated. A clip's own audio plays at full volume by default — set `volume` (0-1) or `muted` on its media ref to control it, no need to hand-author <video muted> or a parallel track. Use the top-level `audio` for external music/voiceover overlaid at offsets. Asynchronous: returns a job_id to poll with video_render_status. Use for tier lists, compilations, montages, or any video with multiple clips.",
    inputSchema: {
      segments: z
        .array(
          z.object({
            html: z.string().min(1).describe("Base64 HTML+GSAP for this segment."),
            duration: z.number().positive().describe("Segment duration, seconds."),
            media: z
              .array(segmentMediaRef)
              .optional()
              .describe("Media in this segment; per-clip volume/muted controls its own audio."),
          }),
        )
        .min(1)
        .describe("Ordered segments."),
      audio: z
        .array(
          z.object({
            media_id: z.string().describe("Cached media to take audio from."),
            offset_ms: z.number().min(0).describe("Start offset from the video start, ms."),
            volume: z.number().min(0).max(1).default(0.6).describe("Track volume 0-1."),
            fade_ms: z.number().min(0).default(1000).describe("Fade-out duration, ms."),
          }),
        )
        .optional()
        .describe("Audio tracks overlaid at offsets."),
      fps: z.number().int().min(1).max(60).default(30).describe("Frames per second."),
      resolution: RESOLUTION.default("1080p").describe("Output resolution/orientation."),
    },
    handler: ({ segments, audio, fps, resolution }) => {
      const jobId = submitJob("timeline", async () => {
        const { buffer, filename, warnings } = await assembleTimeline({
          segments,
          audio,
          fps,
          resolution,
        });
        const url = await storage().save(buffer, filename);
        return {
          url,
          filename,
          size_bytes: buffer.byteLength,
          segments: segments.length,
          warnings: warnings ?? [],
        };
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });

  registerTool(server, {
    name: "video_render_status",
    title: "Render Job Status",
    description:
      "Check a render/timeline job. When state is 'done', result holds the rendered video url. When 'error', error holds the message.",
    inputSchema: {
      job_id: z
        .string()
        .min(1)
        .describe("job_id returned by video_render / video_render_timeline."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ job_id }) => {
      const job = getJob(job_id);
      if (!job) throw new Error(`No job with id "${job_id}" (it may have expired)`);
      return Promise.resolve(job);
    },
  });

  registerTool(server, {
    name: "video_render_queue",
    title: "Render Queue Status",
    description: "Show the render engine concurrency state and all known jobs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: () => Promise.resolve({ engine: engineStatus(), jobs: listJobs() }),
  });
}

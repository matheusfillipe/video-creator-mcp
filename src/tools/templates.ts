import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitJob } from "../services/jobs.js";
import { loadMeta } from "../services/media.js";
import { saveRender } from "../services/publish.js";
import { renderComposition } from "../services/renderer.js";
import {
  type TimelineParams,
  type TimelineSegment,
  assembleTimeline,
} from "../services/timeline.js";
import { lineChartHtml } from "../templates/chart.js";
import { slideshowSegmentHtml } from "../templates/slideshow.js";
import { terminalHtml } from "../templates/terminal.js";
import { titleCardHtml } from "../templates/tierlist.js";
import type { Resolution } from "../types.js";
import { registerTool } from "./defineTool.js";
import { metadataArg } from "./shared.js";

function encode(html: string): string {
  return Buffer.from(html, "utf-8").toString("base64");
}

export function registerTemplateTools(server: McpServer): void {
  registerTool(server, {
    name: "video_render_tierlist",
    title: "Render a Tier-List / Countdown Video",
    description:
      "Build a countdown/tier-list video from ranked entries. Layout: an intro title card, then for each entry a black '#rank — name' card followed by that entry's video clip with a rank badge (top-right) and a name lower-third. Each clip is a media_id from video_download_media — trim it to the best moment first using video_get_info's heatmap peaks. Clips are muted; pass music_media_id for background music. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      title: z.string().min(1).describe("Intro title, e.g. 'Top 10 Most Awaited Games of 2026'."),
      subtitle: z.string().optional().describe("Intro subtitle line."),
      entries: z
        .array(
          z.object({
            rank: z.number().int().describe("Rank number for the badge (e.g. 10 down to 1)."),
            name: z.string().min(1).describe("Entry name shown in the lower-third."),
            media_id: z
              .string()
              .min(1)
              .describe("Trimmed clip media_id from video_download_media."),
            clip_seconds: z
              .number()
              .positive()
              .max(30)
              .default(6)
              .describe("Seconds to show the clip."),
          }),
        )
        .min(1)
        .describe("Ranked entries, in display order (e.g. #10 first … #1 last)."),
      intro_seconds: z.number().positive().max(15).default(3.5).describe("Intro card duration."),
      card_seconds: z
        .number()
        .positive()
        .max(10)
        .default(2.5)
        .describe("Per-entry text-card duration."),
      music_media_id: z.string().optional().describe("Optional background-music media_id."),
      music_volume: z.number().min(0).max(1).default(0.25).describe("Background-music volume."),
      fps: z.number().int().min(1).max(60).default(30),
      resolution: z
        .enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"])
        .default("1080p")
        .describe("Output resolution/orientation."),
      metadata: metadataArg,
    },
    handler: async (args) => {
      const segments: TimelineSegment[] = [
        {
          html: encode(
            titleCardHtml({
              title: args.title,
              subtitle: args.subtitle,
              durationSeconds: args.intro_seconds,
            }),
          ),
          duration: args.intro_seconds,
        },
      ];
      const entryWarnings: string[] = [];
      for (const entry of args.entries) {
        const meta = await loadMeta(entry.media_id);
        if (!meta) {
          entryWarnings.push(
            `#${entry.rank} ${entry.name}: media_id "${entry.media_id}" not in cache — skipped`,
          );
          continue;
        }
        segments.push({
          html: encode(
            titleCardHtml({
              title: `#${entry.rank}`,
              subtitle: entry.name,
              durationSeconds: args.card_seconds,
            }),
          ),
          duration: args.card_seconds,
        });
        segments.push({
          duration: entry.clip_seconds,
          clipOverlay: {
            media_id: entry.media_id,
            rankText: `#${entry.rank}`,
            nameText: entry.name,
          },
        });
      }

      if (segments.length <= 1) {
        throw new Error(
          `No entries had cached media — download clips with video_download_media first. ${entryWarnings.join("; ")}`,
        );
      }

      const params: TimelineParams = {
        segments,
        fps: args.fps,
        resolution: args.resolution as Resolution,
      };
      if (args.music_media_id) {
        params.audio = [{ media_id: args.music_media_id, offset_ms: 0, volume: args.music_volume }];
      }

      const jobId = submitJob("tierlist", async () => {
        const { buffer, filename, warnings } = await assembleTimeline(params);
        const saved = await saveRender(buffer, filename, args.metadata);
        return {
          ...saved,
          segments: segments.length,
          warnings: [...entryWarnings, ...(warnings ?? [])],
        };
      });
      return {
        job_id: jobId,
        state: "queued",
        entries: args.entries.length,
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });

  registerTool(server, {
    name: "video_render_slideshow",
    title: "Render a Slideshow / Presentation Video",
    description:
      "Build a slideshow/presentation/explainer video from a list of {text, media_id, duration_seconds} segments. The server stamps a pre-styled HTML template per segment (full-canvas video background + centered fading caption with correct max-width/word-wrap), then composes them into one MP4. **This is the right tool for any 'present X', 'explore X over scenery', 'documentary-style', 'slides with music' brief — DO NOT write HTML manually for these.** **IF THE BRIEF NAMES A SOUNDTRACK / SONG / NARRATION URL, `audio_media_id` IS NOT OPTIONAL — download the audio with video_download_media first and pass its media_id here, or the rendered video will be silent.** Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      segments: z
        .array(
          z.object({
            text: z.string().min(1).describe("The caption text shown over this segment."),
            media_id: z
              .string()
              .min(1)
              .describe("Background-video media_id from video_download_media."),
            duration_seconds: z
              .number()
              .positive()
              .max(60)
              .describe("How long this segment plays (seconds)."),
          }),
        )
        .min(1)
        .describe("Slideshow segments in display order; each becomes one scene."),
      audio_media_id: z
        .string()
        .optional()
        .describe("Soundtrack / narration media_id (covers the full video)."),
      audio_volume: z.number().min(0).max(1).default(0.8).describe("Soundtrack volume."),
      audio_fade_ms: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(1500)
        .describe("Fade-in and fade-out length on the soundtrack, milliseconds."),
      accent_color: z.string().optional().describe("Caption color (CSS); defaults to white."),
      fps: z.number().int().min(1).max(60).default(30),
      resolution: z
        .enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"])
        .default("1080p")
        .describe("Output resolution/orientation."),
      metadata: metadataArg,
    },
    handler: async (args) => {
      const orientation: "landscape" | "portrait" | "square" =
        args.resolution === "portrait"
          ? "portrait"
          : args.resolution === "square"
            ? "square"
            : "landscape";

      const timelineSegments: TimelineSegment[] = [];
      const mediaIds = new Set<string>();
      const segmentWarnings: string[] = [];
      for (const [i, seg] of args.segments.entries()) {
        const meta = await loadMeta(seg.media_id);
        if (!meta) {
          segmentWarnings.push(`segment ${i}: media_id "${seg.media_id}" not in cache — skipped`);
          continue;
        }
        mediaIds.add(seg.media_id);
        timelineSegments.push({
          html: encode(
            slideshowSegmentHtml({
              text: seg.text,
              videoFilename: meta.filename,
              durationSeconds: seg.duration_seconds,
              resolution: orientation,
              ...(args.accent_color ? { accentColor: args.accent_color } : {}),
            }),
          ),
          duration: seg.duration_seconds,
          media: [{ media_id: seg.media_id }],
        });
      }

      if (timelineSegments.length === 0) {
        throw new Error(
          `No segments had cached media — download clips with video_download_media first. ${segmentWarnings.join("; ")}`,
        );
      }

      const params: TimelineParams = {
        segments: timelineSegments,
        fps: args.fps,
        resolution: args.resolution as Resolution,
      };
      if (args.audio_media_id) {
        params.audio = [
          {
            media_id: args.audio_media_id,
            offset_ms: 0,
            volume: args.audio_volume,
            fade_ms: args.audio_fade_ms,
          },
        ];
      }

      const jobId = submitJob("slideshow", async () => {
        const { buffer, filename, warnings } = await assembleTimeline(params);
        const saved = await saveRender(buffer, filename, args.metadata);
        return {
          ...saved,
          segments: timelineSegments.length,
          unique_clips: mediaIds.size,
          warnings: [...segmentWarnings, ...(warnings ?? [])],
        };
      });
      return {
        job_id: jobId,
        state: "queued",
        segments: timelineSegments.length,
        unique_clips: mediaIds.size,
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });

  registerTool(server, {
    name: "video_render_terminal",
    title: "Render a Terminal Animation",
    description:
      "Render an animated macOS terminal (Hyperframes apple-terminal look): the command types out character-by-character, then the output lines reveal in sequence and the cursor blinks. Pass the command and output as data — no HTML. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      command: z.string().min(1).describe("Command that types out, e.g. 'brew install ffmpeg'."),
      output: z
        .array(z.string())
        .default([])
        .describe("Output lines shown after the command runs, in order."),
      prompt: z.string().default("user@Mac ~ % ").describe("Shell prompt before the command."),
      duration_seconds: z.number().positive().max(60).default(8).describe("Total video length."),
      fps: z.number().int().min(1).max(60).default(30),
      metadata: metadataArg,
    },
    handler: async ({ command, output, prompt, duration_seconds, fps, metadata }) => {
      const jobId = submitJob("terminal", async () => {
        const html = terminalHtml({ command, output, prompt, durationSeconds: duration_seconds });
        const { buffer, filename } = await renderComposition({
          htmlBase64: encode(html),
          fps,
          resolution: "1080p",
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

  registerTool(server, {
    name: "video_render_chart",
    title: "Render an Animated Line Chart",
    description:
      "Render a side-scrolling animated line chart: each series plots left-to-right, the view scrolls once the data fills the window so the leading edge stays in view, and every series shows a value label pinned to its tip. Pass one or more `series` (or a single `points` array) — no HTML. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
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
        .describe("Convenience for a single line — use `series` for multiple."),
      x_label: z.string().optional().describe("x-axis caption."),
      y_label: z.string().optional().describe("y-axis caption."),
      accent_color: z
        .string()
        .optional()
        .describe("Line color for the single-series `points` path."),
      value_suffix: z.string().default("").describe("Appended to value labels, e.g. '%' or 'k'."),
      window_size: z
        .number()
        .int()
        .min(2)
        .max(60)
        .default(8)
        .describe("Points visible at once before the chart scrolls."),
      duration_seconds: z.number().positive().max(120).default(10).describe("Total video length."),
      fps: z.number().int().min(1).max(60).default(30),
      metadata: metadataArg,
    },
    handler: async (args) => {
      const series =
        args.series && args.series.length > 0
          ? args.series
          : args.points
            ? [{ points: args.points, ...(args.accent_color ? { color: args.accent_color } : {}) }]
            : [];
      if (series.length === 0) {
        throw new Error("Provide `series` (one or more lines) or `points` (a single line).");
      }
      const jobId = submitJob("chart", async () => {
        const html = lineChartHtml({
          title: args.title,
          series,
          xLabel: args.x_label,
          yLabel: args.y_label,
          valueSuffix: args.value_suffix,
          windowSize: args.window_size,
          durationSeconds: args.duration_seconds,
        });
        const { buffer, filename } = await renderComposition({
          htmlBase64: encode(html),
          fps: args.fps,
          resolution: "1080p",
        });
        return saveRender(buffer, filename, args.metadata);
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

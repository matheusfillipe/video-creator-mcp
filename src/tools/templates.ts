import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitJob } from "../services/jobs.js";
import { loadMeta } from "../services/media.js";
import { renderComposition } from "../services/renderer.js";
import { storage } from "../services/storage.js";
import {
  type TimelineParams,
  type TimelineSegment,
  assembleTimeline,
} from "../services/timeline.js";
import { lineChartHtml } from "../templates/chart.js";
import { terminalHtml } from "../templates/terminal.js";
import { titleCardHtml } from "../templates/tierlist.js";
import type { Resolution } from "../types.js";
import { registerTool } from "./defineTool.js";

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
      for (const entry of args.entries) {
        const meta = await loadMeta(entry.media_id);
        if (!meta) {
          throw new Error(
            `media_id "${entry.media_id}" not in cache — download it with video_download_media first`,
          );
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

      const params: TimelineParams = {
        segments,
        fps: args.fps,
        resolution: args.resolution as Resolution,
      };
      if (args.music_media_id) {
        params.audio = [{ media_id: args.music_media_id, offset_ms: 0, volume: args.music_volume }];
      }

      const jobId = submitJob("tierlist", async () => {
        const { buffer, filename } = await assembleTimeline(params);
        const url = await storage().save(buffer, filename);
        return { url, filename, size_bytes: buffer.byteLength, segments: segments.length };
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
    },
    handler: async ({ command, output, prompt, duration_seconds, fps }) => {
      const jobId = submitJob("terminal", async () => {
        const html = terminalHtml({ command, output, prompt, durationSeconds: duration_seconds });
        const { buffer, filename } = await renderComposition({
          htmlBase64: encode(html),
          fps,
          resolution: "1080p",
        });
        const url = await storage().save(buffer, filename);
        return { url, filename, size_bytes: buffer.byteLength };
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
      "Render an animated line chart: the line plots left-to-right while a marker + value label track its leading edge and the axis labels reveal as the line reaches them. Pass the data as a points array — no HTML. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      title: z.string().optional().describe("Chart title shown top-left."),
      points: z
        .array(
          z.object({
            label: z.string().optional().describe("x-axis label for this point."),
            value: z.number().describe("y value."),
          }),
        )
        .min(2)
        .describe("Ordered data points; the line is drawn through them left-to-right."),
      x_label: z.string().optional().describe("x-axis caption."),
      y_label: z.string().optional().describe("y-axis caption."),
      accent_color: z.string().default("#7fd1ff").describe("Line/marker color (CSS color)."),
      value_suffix: z.string().default("").describe("Appended to value labels, e.g. '%' or 'k'."),
      duration_seconds: z.number().positive().max(60).default(8).describe("Total video length."),
      fps: z.number().int().min(1).max(60).default(30),
    },
    handler: async (args) => {
      const jobId = submitJob("chart", async () => {
        const html = lineChartHtml({
          title: args.title,
          points: args.points,
          xLabel: args.x_label,
          yLabel: args.y_label,
          accentColor: args.accent_color,
          valueSuffix: args.value_suffix,
          durationSeconds: args.duration_seconds,
        });
        const { buffer, filename } = await renderComposition({
          htmlBase64: encode(html),
          fps: args.fps,
          resolution: "1080p",
        });
        const url = await storage().save(buffer, filename);
        return { url, filename, size_bytes: buffer.byteLength };
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

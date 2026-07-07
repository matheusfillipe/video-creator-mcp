import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type EditSpec, renderEdit } from "../services/edit.js";
import { submitJob } from "../services/jobs.js";
import { saveRender } from "../services/publish.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, metadataArg } from "./shared.js";

const segment = z.object({
  media_id: z.string().min(1).describe("Clip from video_download_media."),
  start: z.number().min(0).optional().describe("Trim in-point (seconds into the clip)."),
  end: z.number().min(0).optional().describe("Trim out-point (seconds into the clip)."),
  speed: z.number().min(0.25).max(4).optional().describe("Playback speed (0.25-4, default 1)."),
  volume: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("This clip's own audio volume (0 mutes, default 1)."),
});

export function registerEditTools(server: McpServer): void {
  registerTool(server, {
    name: "video_edit",
    title: "Cut, Stack and Mix Clips (fast, no HTML)",
    description:
      "The fast path for cut editing: trim clips, join them (optionally with crossfades), stack groups side-by-side or top/bottom (shorts style), burn timed text, and lay music/narration over the result — all from one JSON spec, executed as plain ffmpeg. No HTML, no browser: a 60s edit renders in well under a minute. USE THIS for any brief shaped like 'take clip A from X-Y and clip B where he says Z, put them together / stack them / add this song'. groups is a list of tracks: layout single=1 group (clips play in sequence), vstack=2 groups (top/bottom halves — the classic shorts split), hstack=2 (left/right), pip=2 (second group as a corner inset), grid=4. Every clip is cover-cropped to its cell, so 16:9 sources drop cleanly into a portrait 9:16 canvas. With multiple groups the output stops at the shortest group. Asynchronous: returns a job_id — poll video_render_status.",
    inputSchema: {
      layout: z
        .enum(["single", "vstack", "hstack", "pip", "grid"])
        .default("single")
        .describe("How groups are arranged on the canvas."),
      groups: z
        .array(z.array(segment).min(1))
        .min(1)
        .max(4)
        .describe(
          'Array of GROUPS, where each group is itself an ARRAY of segments — so this is a list of lists, even for a single group. layout single = 1 group; vstack/hstack/pip = 2 groups; grid = 4. Segments within a group play in sequence; groups are the layout slots. Example vstack: [[{media_id:"top"}],[{media_id:"bottom"}]].',
        ),
      text: z
        .array(
          z.object({
            content: z.string().min(1),
            start: z.number().min(0).describe("When the text appears (seconds)."),
            duration: z.number().positive().describe("How long it stays (seconds)."),
            position: z.enum(["top", "center", "bottom"]).default("bottom"),
            size: z.number().int().min(12).max(300).optional().describe("Font px (auto if unset)."),
            color: z.string().optional().describe("Hex (#RRGGBB) or a basic color name."),
            box: z.boolean().optional().describe("Translucent backing box (default true)."),
          }),
        )
        .optional()
        .describe("Timed text overlays burned onto the combined video."),
      audio: z
        .array(
          z.object({
            media_id: z.string().min(1).describe("Audio media_id from video_download_media."),
            offset: z.number().min(0).optional().describe("Start position in the video (seconds)."),
            volume: z.number().min(0).max(2).optional().describe("Track volume (default 0.8)."),
            mode: z
              .enum(["replace", "mix", "duck"])
              .default("mix")
              .describe(
                "replace drops the clips' own audio; mix layers on top; duck lowers the clips' audio to 25% under this track.",
              ),
          }),
        )
        .optional()
        .describe("Music/narration tracks laid over the edit."),
      fade: z
        .number()
        .min(0)
        .max(3)
        .optional()
        .describe("Crossfade seconds between segments in a group (0 = hard cuts, the default)."),
      resolution: RESOLUTION.default("1080p").describe("Canvas — use portrait for shorts."),
      fps: z.number().int().min(1).max(60).default(30),
      metadata: metadataArg,
    },
    handler: async ({ metadata, ...args }) => {
      const { layout, groups, text, audio, fade, resolution, fps } = args;
      const spec: EditSpec = {
        layout,
        groups,
        resolution,
        fps,
        ...(text ? { text } : {}),
        ...(audio ? { audio } : {}),
        ...(fade !== undefined ? { fade } : {}),
      };
      const jobId = submitJob("edit", async () => {
        const { buffer, filename, duration, warnings } = await renderEdit(spec);
        const saved = await saveRender(buffer, filename, metadata, { tool: "video_edit", args });
        return { ...saved, duration, warnings };
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

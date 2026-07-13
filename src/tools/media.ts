import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadMedia, listCachedMedia, removeCachedMedia } from "../services/media.js";
import { registerTool } from "./defineTool.js";

export function registerMediaTools(server: McpServer): void {
  registerTool(server, {
    name: "video_download_media",
    title: "Download Media",
    description:
      "Download a video/image/audio from any yt-dlp-compatible URL (YouTube, TikTok, X, Reddit, Vimeo, direct media links) into the cache. When start/end are given it fetches ONLY that window via range requests (no full download), falling back to a full download + trim if the source rejects ranges. Set audio=false for clips you'll render muted (e.g. tier-list segments) to skip the audio stream — smaller and faster. Independent URLs can be downloaded concurrently. Returns a media_id to reference in video_edit, video_compose, video_graphic, or video_render_timeline. Re-downloading the same URL+window+audio is served from cache.",
    inputSchema: {
      url: z.string().min(1).describe("Source URL (any yt-dlp source or direct media link)."),
      start: z.number().min(0).optional().describe("Window start, seconds."),
      end: z.number().min(0).optional().describe("Window end, seconds."),
      audio: z
        .boolean()
        .default(true)
        .describe("Include the audio stream. Set false for clips rendered muted (faster)."),
    },
    handler: async ({ url, start, end, audio }) => {
      const meta = await downloadMedia({ url, start, end, audio });
      return {
        ...meta,
        html_hint: `Reference as src="assets/${meta.filename}" and pass media_id "${meta.media_id}" in a render media array.`,
      };
    },
  });

  registerTool(server, {
    name: "video_media_cache",
    title: "Media Cache",
    description: "List cached media, or remove one cached item by media_id.",
    inputSchema: {
      action: z.enum(["list", "remove"]).default("list").describe("List all, or remove one."),
      media_id: z.string().optional().describe("Required when action=remove."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ action, media_id }) => {
      if (action === "remove") {
        if (!media_id) throw new Error("media_id is required when action=remove");
        return removeCachedMedia(media_id);
      }
      return listCachedMedia();
    },
  });
}

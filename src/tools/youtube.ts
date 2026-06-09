import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatVideoInfo,
  getSubtitles,
  getThumbnail,
  getVideoInfo,
  searchSubtitles,
  searchYouTube,
} from "../services/youtube.js";
import { registerTool } from "./defineTool.js";

export function registerYoutubeTools(server: McpServer): void {
  registerTool(server, {
    name: "video_search_youtube",
    title: "Search YouTube",
    description:
      "Search YouTube and return ranked results (title, channel, duration, views, upload date, thumbnail). Use to discover source clips before downloading them with video_download_media.",
    inputSchema: {
      query: z.string().min(1).describe("Search query."),
      max_results: z.number().int().min(1).max(20).default(5).describe("Number of results (1-20)."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ query, max_results }) => searchYouTube(query, max_results),
  });

  registerTool(server, {
    name: "video_get_info",
    title: "YouTube Video Info & Heatmap",
    description:
      "Full metadata for a YouTube video (or any yt-dlp URL): title, channel, duration, views, description, tags, available subtitle languages, thumbnails, and the most-replayed HEATMAP peaks. Use the heatmap to pick the best moments to trim with video_download_media.",
    inputSchema: {
      url: z.string().min(1).describe("YouTube URL or 11-char video id."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ url }) => formatVideoInfo(await getVideoInfo(url)),
  });

  registerTool(server, {
    name: "video_get_subtitles",
    title: "Get Subtitles / Captions",
    description:
      "Download a video's subtitles/captions as SRT text. Call video_get_info first to see which languages exist. Set auto=true to fall back to auto-generated captions.",
    inputSchema: {
      url: z.string().min(1).describe("YouTube URL or video id."),
      lang: z.string().default("en").describe("Subtitle language code."),
      auto: z.boolean().default(false).describe("Use auto-generated captions."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ url, lang, auto }) => getSubtitles(url, lang, auto),
  });

  registerTool(server, {
    name: "video_search_subtitles",
    title: "Search Subtitles for a Spoken Phrase",
    description:
      "Fetch a video's timed captions and find WHERE something is said. Pass a `query` to get the matching lines with start/end timestamps — feed those to video_download_media to clip/loop that exact moment (e.g. 'loop the part where he says X'). Omit `query` to dump the timed transcript. Returns available=false (no error) when the video has no captions, so you can just try. Read-only.",
    inputSchema: {
      url: z.string().min(1).describe("YouTube URL or video id."),
      query: z
        .string()
        .optional()
        .describe("Phrase to locate; omit to return the whole timed transcript."),
      lang: z
        .string()
        .default("en.*,en")
        .describe("Subtitle language(s) in yt-dlp --sub-langs syntax (e.g. 'en.*,en')."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ url, query, lang }) => searchSubtitles(url, query ?? "", lang),
  });

  registerTool(server, {
    name: "video_get_thumbnail",
    title: "Get Video Thumbnail",
    description:
      "Download a video thumbnail into the media cache and return its media_id for use in a composition.",
    inputSchema: {
      url: z.string().min(1).describe("YouTube URL or video id."),
      max_width: z.number().int().min(16).max(3840).default(1280).describe("Max thumbnail width."),
    },
    handler: async ({ url, max_width }) => {
      const meta = await getThumbnail(url, max_width);
      return {
        ...meta,
        html_hint: `Reference as src="assets/${meta.filename}" and pass media_id "${meta.media_id}" in a render media array.`,
      };
    },
  });
}

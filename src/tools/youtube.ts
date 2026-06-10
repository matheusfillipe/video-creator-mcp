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
      "Find WHERE something is said and get timestamps to clip/loop it (e.g. 'loop the part where he says X'). Pass a `query` to get `matches[]` with start/end seconds — feed those to video_download_media. Two caption kinds, a real trade-off: AUTO captions (ASR) give WORD-level timing (tightest loop window) but the wording can be slightly wrong; MANUAL captions are accurate text but only cue-level (~1-6s blocks). `prefer` picks which to try first and each falls back to the other. The result REPORTS what you got: `precision` ('word'|'cue') and `track` ('auto'|'manual') — if the timing is too loose, or the auto wording is wrong, re-call with the other `prefer`. Omit `query` to dump the timed transcript. available=false (no error) when there are no captions, so just try. Read-only.",
    inputSchema: {
      url: z.string().min(1).describe("YouTube URL or video id."),
      query: z
        .string()
        .optional()
        .describe("Phrase to locate; omit to return the whole timed transcript."),
      prefer: z
        .enum(["word", "text"])
        .default("word")
        .describe(
          "Which caption kind to try first. 'word' = auto/ASR word-level timing (tightest cut for looping an exact phrase). 'text' = manual captions' faithful wording (cue-level ~1-6s). Falls back to the other when the preferred kind is missing.",
        ),
      lang: z
        .string()
        .default("en,en-orig")
        .describe(
          "Subtitle language(s), yt-dlp --sub-langs syntax. Keep it to a couple explicit codes (e.g. 'en,en-orig') — a glob like 'en.*' pulls dozens of auto-translations and gets rate-limited.",
        ),
    },
    annotations: { readOnlyHint: true },
    handler: ({ url, query, lang, prefer }) => searchSubtitles(url, query ?? "", lang, prefer),
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

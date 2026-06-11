import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractFrame, lintComposition, removeBackground } from "../services/effects.js";
import { runOnEngine } from "../services/engine.js";
import { registerTool } from "./defineTool.js";

export function registerEffectsTools(server: McpServer): void {
  registerTool(server, {
    name: "video_lint",
    title: "Lint Composition",
    description:
      "Validate a base64 HTML+GSAP composition for common authoring mistakes before rendering. Always lint before video_render.",
    inputSchema: {
      html: z.string().min(1).describe("Base64-encoded HTML composition."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ html }) => runOnEngine(() => lintComposition(html)),
  });

  registerTool(server, {
    name: "video_remove_background",
    title: "Remove Background",
    description:
      "AI background removal. Input is a media_id (from video_download_media) or a direct URL. Video → transparent WebM/MOV, image → transparent PNG. Returns a new media_id.",
    inputSchema: {
      input: z.string().min(1).describe("A media_id or a direct http(s) URL."),
      format: z.enum(["webm", "mov", "png"]).default("webm").describe("Output format."),
    },
    handler: async ({ input, format }) => {
      const meta = await runOnEngine(() => removeBackground(input, format));
      return {
        ...meta,
        html_hint: `Reference as src="assets/${meta.filename}" and pass media_id "${meta.media_id}" in a render media array.`,
      };
    },
  });

  registerTool(server, {
    name: "video_extract_frame",
    title: "Extract Single Frame as Image",
    description:
      "Pull a single PNG frame from a downloaded clip at time `time_sec`. Returns the image as a public URL AND a media_id, so you can pass the URL to vision/describe_image to verify content BEFORE committing to a render: spot watermarks, baked-in text, channel logos, or wrong scenes. Use this proactively after video_download_media for every candidate clip — a 1s vision check is far cheaper than re-rendering a 10-min timeline. Returns instantly (no chrome).",
    inputSchema: {
      media_id: z.string().min(1).describe("media_id of the clip (from video_download_media)."),
      time_sec: z
        .number()
        .min(0)
        .default(0)
        .describe("Time within the clip (seconds) to sample. Clamped to clip duration."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ media_id, time_sec }) => {
      const { url, filename, meta } = await runOnEngine(() =>
        extractFrame({ mediaId: media_id, timeSec: time_sec }),
      );
      return {
        media_id: meta.media_id,
        filename,
        url,
        width: meta.width,
        height: meta.height,
        time_sec,
        vision_hint:
          "Pass `url` to your vision/describe_image tool to verify the frame (no watermark, scene matches, no baked text).",
      };
    },
  });
}

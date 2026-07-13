import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractFrame, lintComposition, removeBackground } from "../services/effects.js";
import { runOnEngine } from "../services/engine.js";
import { previewFrames } from "../services/preview.js";
import { saveRender } from "../services/publish.js";
import type { Resolution } from "../types.js";
import { registerTool } from "./defineTool.js";
import { compositionHtml } from "./shared.js";

export function registerEffectsTools(server: McpServer): void {
  registerTool(server, {
    name: "video_lint",
    title: "Lint Composition",
    description:
      "Validate a base64 HTML+GSAP composition for common authoring mistakes before rendering. Always lint before video_graphic (kind: html) or video_render_timeline.",
    inputSchema: {
      html: compositionHtml("The HTML composition markup (plain text; base64 also accepted)."),
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
    name: "video_preview_frame",
    title: "Preview a Composition Frame WITHOUT Rendering",
    description:
      "Render a SINGLE PNG of how a composition will look at one or more timestamps — WITHOUT doing the full multi-minute video render. Pass the same html (base64) + media array you'd pass to video_graphic (kind: html) or video_render_timeline, plus an `at` array of times in seconds. Returns one PNG url per timestamp + a contact-sheet jpg (grid). Cost: ~1.5-3s per frame. Use this AGGRESSIVELY before any render >30s: check the title slide, the moment a caption changes, the audio-peak beats. A 5-second preview is 100x cheaper than a 5-min render that ships with cropped text or wrong layout.",
    inputSchema: {
      html: compositionHtml(
        "The composition markup, same shape as video_graphic (kind: html) (plain text; base64 also accepted).",
      ),
      at: z
        .array(z.number().min(0))
        .min(1)
        .max(10)
        .describe("Timestamps (seconds, within the composition's data-duration) to capture."),
      media: z
        .array(
          z.object({
            media_id: z.string().min(1),
          }),
        )
        .optional()
        .describe("media_ids referenced by the HTML (linked into assets/ before snapshot)."),
      resolution: z
        .enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"])
        .default("1080p")
        .describe("Output resolution preset."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ html, at, media, resolution }) => {
      const output = await runOnEngine(() =>
        previewFrames({
          htmlBase64: html,
          timeSeconds: at,
          resolution: resolution as Resolution,
          ...(media ? { media } : {}),
        }),
      );
      const frames: Array<{ time_seconds: number; url: string; filename: string }> = [];
      for (const f of output.frames) {
        const saved = await saveRender(f.buffer, f.filename);
        frames.push({ time_seconds: f.time_seconds, url: saved.url, filename: saved.filename });
      }
      const contact = output.contactSheet
        ? await saveRender(output.contactSheet.buffer, output.contactSheet.filename)
        : null;
      return {
        frames,
        ...(contact ? { contact_sheet_url: contact.url } : {}),
        vision_hint:
          "Pass each frame `url` (or the contact sheet) to your vision/describe_image tool to verify layout BEFORE you commit to a full render.",
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

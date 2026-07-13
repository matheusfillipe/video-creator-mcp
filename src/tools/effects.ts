import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractFrame, lintComposition, removeBackground } from "../services/effects.js";
import { runOnEngine } from "../services/engine.js";
import { previewFrames } from "../services/preview.js";
import { saveRender } from "../services/publish.js";
import type { Resolution } from "../types.js";
import { COMPOSITION, previewCompositionFrame } from "./compose.js";
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
      "Render SINGLE PNGs of how a shot will look at one or more timestamps, WITHOUT doing the full multi-minute video render. Exactly one of `html` or `composition` is required. `html`: pass the same html (base64) + media array you'd pass to video_graphic (kind: html) or video_render_timeline; returns one PNG per timestamp + a contact-sheet jpg (grid). `composition`: pass the SAME declarative spec video_compose takes; previews layout/visual placement for whichever scene each `at` timestamp lands in, with ESTIMATED scene timing (no TTS run, the same estimate video_plan uses) and NO captions burned in (captions need real word alignment, which needs a real render). Cost: ~1.5-3s per frame. Use this AGGRESSIVELY before any render >30s: check the title slide, a multi-visual layout, the moment a scene changes. A 5-second preview is 100x cheaper than a 5-min render that ships with cropped text or wrong layout.",
    inputSchema: {
      html: compositionHtml(
        "The composition markup, same shape as video_graphic (kind: html) (plain text; base64 also accepted). Exactly one of html/composition is required.",
      ).optional(),
      composition: COMPOSITION.optional().describe(
        "The declarative composition (same schema as video_compose) to preview. Exactly one of html/composition is required.",
      ),
      at: z
        .array(z.number().min(0))
        .min(1)
        .max(10)
        .describe(
          "Timestamps (seconds) to capture. html mode: within the composition's data-duration. composition mode: within the ESTIMATED total duration (see video_plan).",
        ),
      media: z
        .array(
          z.object({
            media_id: z.string().min(1),
          }),
        )
        .optional()
        .describe(
          "html mode only: media_ids referenced by the HTML (linked into assets/ before snapshot).",
        ),
      resolution: z
        .enum(["1080p", "4k", "uhd", "landscape", "portrait", "square"])
        .default("1080p")
        .describe(
          "html mode only: output resolution preset. composition mode uses composition.output.resolution instead.",
        ),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ html, composition, at, media, resolution }) => {
      if ((html === undefined) === (composition === undefined)) {
        throw new Error(
          composition === undefined
            ? "video_preview_frame needs either html or composition."
            : "video_preview_frame takes either html or composition, not both.",
        );
      }

      if (composition) {
        const jobId = randomUUID().slice(0, 8);
        const frames: Array<{
          time_seconds: number;
          url: string;
          filename: string;
          scene_id: string;
          estimated: true;
        }> = [];
        for (const [i, t] of at.entries()) {
          const preview = await runOnEngine(() => previewCompositionFrame(composition, t));
          // scene id is agent-authored free text; keep it out of the storage key raw.
          const safeScene = preview.sceneId.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
          const saved = await saveRender(
            preview.buffer,
            `compose-preview-${jobId}-${String(i).padStart(2, "0")}-${safeScene}-${t}s.png`,
          );
          frames.push({
            time_seconds: t,
            url: saved.url,
            filename: saved.filename,
            scene_id: preview.sceneId,
            estimated: true,
          });
        }
        return {
          frames,
          vision_hint:
            "Pass each frame `url` to your vision/describe_image tool to verify layout/placement BEFORE you commit to video_compose. Timing is ESTIMATED (no TTS run yet) and captions are NOT shown (they need real word alignment from an actual render); this checks layout only, not final timing.",
        };
      }

      const output = await runOnEngine(() =>
        previewFrames({
          htmlBase64: html as string,
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

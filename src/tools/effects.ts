import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lintComposition, removeBackground } from "../services/effects.js";
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
}

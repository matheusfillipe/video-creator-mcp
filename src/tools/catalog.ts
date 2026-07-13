import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchBlockComposition, listCatalog } from "../services/catalog.js";
import { submitJob } from "../services/jobs.js";
import { saveRender } from "../services/publish.js";
import { renderComposition } from "../services/renderer.js";
import { registerTool } from "./defineTool.js";
import { encode, metadataArg } from "./shared.js";

export function registerCatalogTools(server: McpServer): void {
  registerTool(server, {
    name: "video_catalog",
    title: "Browse the Hyperframes Block Catalog",
    description:
      "List/search the Hyperframes catalog of prebuilt blocks and components (terminals, charts, maps, captions, transitions, device showcases, …). Returns each item's name, type, description and tags. Render a single-composition block as-is with video_render_block; for the dedicated templates use video_render_terminal / video_render_chart / video_render_tierlist.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Case-insensitive filter over name/title/description/tags."),
      type: z.enum(["block", "component"]).optional().describe("Filter by item type."),
      tag: z.string().optional().describe("Filter by catalog tag, e.g. 'data', 'captions', 'map'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ query, type, tag }) => {
      const items = await listCatalog({ query, type, tag });
      return { count: items.length, items };
    },
  });

  registerTool(server, {
    name: "video_render_block",
    title: "Render a Catalog Block",
    description:
      "Render a Hyperframes catalog block by name (from video_catalog) to MP4 as-is, with its built-in sample content. Best for self-contained GSAP/SVG blocks; blocks that ship extra asset files (3D, html-in-canvas) are not supported. To customize content, use the dedicated templates or author HTML with video_render. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe("Catalog block slug, e.g. 'data-chart' (see video_catalog)."),
      duration_seconds: z
        .number()
        .positive()
        .max(60)
        .optional()
        .describe("Override the block's built-in duration."),
      fps: z.number().int().min(1).max(60).default(30),
      metadata: metadataArg,
    },
    handler: async ({ name, duration_seconds, fps, metadata }) => {
      const jobId = submitJob("block", async () => {
        const html = await fetchBlockComposition(name, duration_seconds);
        const { buffer, filename } = await renderComposition({
          htmlBase64: encode(html),
          fps,
          resolution: "1080p",
        });
        const saved = await saveRender(buffer, filename, metadata);
        return { ...saved, block: name };
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

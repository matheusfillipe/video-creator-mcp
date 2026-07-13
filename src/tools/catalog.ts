import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCatalog } from "../services/catalog.js";
import { registerTool } from "./defineTool.js";

export function registerCatalogTools(server: McpServer): void {
  registerTool(server, {
    name: "video_catalog",
    title: "Browse the Hyperframes Block Catalog",
    description:
      "List/search the Hyperframes catalog of prebuilt blocks and components (terminals, charts, maps, captions, transitions, device showcases, …). Returns each item's name, type, description and tags. Render a single-composition block as-is with video_graphic (kind: block); for the dedicated templates use the video_graphic terminal/chart kinds or video_render_tierlist.",
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
}

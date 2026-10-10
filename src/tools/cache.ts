import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { purgeCache } from "../services/cache-gc.js";
import { registerTool } from "./defineTool.js";

export function registerCacheTools(server: McpServer): void {
  registerTool(server, {
    name: "video_cache_purge",
    title: "Purge the Media Cache",
    description:
      "Remove items from the server's media cache: downloads, generated voices and music, crops and intermediate renders. Name media_ids, or give unused_for_hours, or set all. A purged item is produced again the next time something needs it, so purge to force a fresh voice or download, or to free disk. Returns how many items and bytes were removed. Run it between renders, not during one.",
    inputSchema: {
      media_ids: z.array(z.string().min(1)).optional().describe("Exact media_ids to remove."),
      unused_for_hours: z
        .number()
        .min(0)
        .optional()
        .describe("Remove every item not used for at least this many hours."),
      all: z.boolean().default(false).describe("Remove the whole cache."),
    },
    annotations: { destructiveHint: true },
    handler: async ({ media_ids, unused_for_hours, all }) => {
      if (!all && !media_ids?.length && unused_for_hours === undefined) {
        throw new Error("Name media_ids, give unused_for_hours, or set all: true.");
      }
      const { items, freedBytes } = await purgeCache(
        {
          mediaIds: media_ids,
          unusedForMs: unused_for_hours === undefined ? undefined : unused_for_hours * 3_600_000,
          all,
        },
        Date.now(),
      );
      return { items, freed_bytes: freedBytes };
    },
  });
}

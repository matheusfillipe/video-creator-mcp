import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readSidecar } from "../services/publish.js";
import { registerTool } from "./defineTool.js";

export function registerRecipeTools(server: McpServer): void {
  registerTool(server, {
    name: "video_get_recipe",
    title: "Get a Video's Recipe (to remake or tweak it)",
    description:
      "Fetch the recipe a video was made with — the exact tool + args (manim code, edit spec, media_ids, params) stored in its JSON sidecar. Pass the video's URL (…/name.mp4) or its sidecar (…/name.json). This is how you ITERATE on an earlier render: get the recipe, change one field (duration, a scene, music_media_id, the code), then call that same tool again. Returns the recipe, or a note if this artifact has none.",
    inputSchema: {
      url: z
        .string()
        .min(1)
        .describe("The video's public URL (…/name.mp4) or its sidecar (…/name.json)."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ url }) => {
      const sidecar = await readSidecar(url);
      if (!sidecar) {
        return { found: false, message: "No sidecar found for that url." };
      }
      if (!sidecar.recipe) {
        return {
          found: false,
          message:
            "This artifact has no stored recipe (an older render, or one made by a tool that doesn't record recipes yet) — only publish metadata is available.",
        };
      }
      return {
        found: true,
        recipe: sidecar.recipe,
        hint: `To iterate: call ${sidecar.recipe.tool} again with these args, changing what you want.`,
      };
    },
  });
}

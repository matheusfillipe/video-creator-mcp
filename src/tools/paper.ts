import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPaperMedia } from "../services/paper.js";
import { registerTool } from "./defineTool.js";

export function registerPaperTools(server: McpServer): void {
  registerTool(server, {
    name: "video_paper_media",
    title: "Research Paper Figures & Demo Videos",
    description:
      "The real material of an arXiv paper, for explaining it with its own figures instead of generated imagery: the paper's body text (formulas as LaTeX, no bibliography, capped at 80k characters), every raster figure from its arXiv HTML version with its caption, and the authors' demo videos from its Hugging Face paper page and project page. Each figure and video has an id (fig1.., vid1..) and a url to pass to video_download_media. Papers without an arXiv HTML version return no text and no figures. Read-only.",
    inputSchema: {
      arxiv_id: z
        .string()
        .regex(/^\d{4}\.\d{4,5}$/)
        .describe("arXiv id without version, e.g. 2610.10524."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: ({ arxiv_id }) => getPaperMedia(arxiv_id),
  });
}

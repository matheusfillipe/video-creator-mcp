import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPaperMedia } from "../services/paper.js";
import { registerTool } from "./defineTool.js";

export function registerPaperTools(server: McpServer): void {
  registerTool(server, {
    name: "video_paper_media",
    title: "Research Paper Figures & Demo Videos",
    description:
      "The real material of an arXiv paper, for explaining it with its own figures instead of generated imagery: the paper's body text (formulas as LaTeX, no bibliography, capped at 80k characters), every raster figure from its arXiv HTML version with its caption, its tables rendered as large stills when render_tables is set, and the authors' demo videos from its Hugging Face paper page and project page. Each figure, table and video has an id (fig1.., tab1.., vid1..) and a url to pass to video_download_media. Papers without an arXiv HTML version return no text, figures or tables.",
    inputSchema: {
      arxiv_id: z
        .string()
        .regex(/^\d{4}\.\d{4,5}$/)
        .describe("arXiv id without version, e.g. 2610.10524."),
      render_tables: z
        .boolean()
        .optional()
        .describe(
          "Render each of the paper's tables (up to 6) to a 1920x1080 still, a few seconds per table. Off by default.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: ({ arxiv_id, render_tables }) =>
      getPaperMedia(arxiv_id, { withTables: render_tables ?? false }),
  });
}

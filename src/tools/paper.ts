import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { focusPaperTable, getPaperMedia } from "../services/paper.js";
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
          "Render each of the paper's tables (up to 6) to a 1920x1080 still, a few seconds per table, and return its rows as text for video_paper_table_focus. Off by default.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: ({ arxiv_id, render_tables }) =>
      getPaperMedia(arxiv_id, { withTables: render_tables ?? false }),
  });

  registerTool(server, {
    name: "video_paper_table_focus",
    title: "Focused Card of a Paper Table",
    description:
      "Render only the part of a paper's table a line talks about: the header row plus the chosen rows, the first column plus the chosen columns, with cited cells highlighted, large on a near-square card that reads in a vertical video. Row and column numbers count from 0 in the rows video_paper_media returns with render_tables (cells split on ' | '). Returns the still's url for video_download_media.",
    inputSchema: {
      arxiv_id: z.string().regex(/^\d{4}\.\d{4,5}$/),
      table_id: z
        .string()
        .regex(/^tab\d+$/)
        .describe("Table id from video_paper_media, e.g. tab2."),
      rows: z
        .array(z.number().int().min(0))
        .min(1)
        .max(8)
        .describe("Rows to show besides the header."),
      cols: z
        .array(z.number().int().min(0))
        .max(6)
        .optional()
        .describe("Columns to show besides the first; all columns when left out."),
      highlight: z
        .array(z.object({ row: z.number().int().min(0), col: z.number().int().min(0) }))
        .max(6)
        .optional()
        .describe("Cells to mark, such as the number the narration reads out."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: ({ arxiv_id, table_id, rows, cols, highlight }) =>
      focusPaperTable(arxiv_id, table_id, { rows, cols, highlight }),
  });
}

import { config } from "../config.js";
import { cacheId } from "../lib/cacheId.js";
import { ExecError } from "../lib/exec.js";
import { assertSafeUrl } from "../lib/net.js";
import { previewFrames } from "./preview.js";
import { storage } from "./storage.js";

export interface PaperFigure {
  id: string;
  url: string;
  caption: string;
}

export interface PaperVideo {
  id: string;
  url: string;
  source: string;
}

export interface PaperTable {
  id: string;
  html: string;
  caption: string;
}

export interface PaperMedia {
  arxiv_id: string;
  title: string;
  project_page: string | null;
  text: string;
  figures: PaperFigure[];
  tables: PaperTableStill[];
  videos: PaperVideo[];
}

// A rendered table plus its rows as text (cells joined by " | "), numbered from 0 in the order
// video_paper_table_focus takes them.
export interface PaperTableStill extends PaperFigure {
  rows: string[];
}

const MAX_FIGURES = 14;
const MAX_TABLES = 6;
const MAX_VIDEOS = 6;
const MAX_TEXT_CHARS = 80_000;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// arXiv's HTML version serves each figure as an image beside its caption. Vector figures (svg)
// are skipped because the renderer only takes raster stills, and a figure holding a table is one
// of the tables, whatever icons sit inside its cells.
export function parseArxivFigures(html: string, pageUrl: string): PaperFigure[] {
  const figures: PaperFigure[] = [];
  for (const block of html.match(/<figure[\s\S]*?<\/figure>/g) ?? []) {
    const src = block.match(/<img[^>]*src="([^"]+)"/)?.[1];
    if (!src || src.endsWith(".svg") || block.includes("<table")) continue;
    const caption = stripTags(block.match(/<figcaption[\s\S]*?<\/figcaption>/)?.[0] ?? "").slice(
      0,
      300,
    );
    figures.push({ id: `fig${figures.length + 1}`, url: new URL(src, pageUrl).href, caption });
    if (figures.length >= MAX_FIGURES) break;
  }
  return figures;
}

// The paper's tables as HTML.
export function parseArxivTables(html: string): PaperTable[] {
  const tables: PaperTable[] = [];
  for (const block of html.match(/<figure[^>]*ltx_table[\s\S]*?<\/figure>/g) ?? []) {
    const table = block.match(/<table[\s\S]*<\/table>/)?.[0];
    if (!table) continue;
    const caption = stripTags(block.match(/<figcaption[\s\S]*?<\/figcaption>/)?.[0] ?? "").slice(
      0,
      300,
    );
    // Cell icons point at relative paths that do not resolve outside arXiv, so we drop them.
    tables.push({ id: `tab${tables.length + 1}`, html: table.replace(/<img[^>]*>/g, ""), caption });
    if (tables.length >= MAX_TABLES) break;
  }
  return tables;
}

// A standalone page that shows one table large on white, scaled to fill a 1920x1080 frame.
export function tablePage(tableHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;width:1920px;height:1080px;background:#fff}
#t{position:absolute;left:50%;top:50%;transform-origin:center;color:#111;font:28px "Liberation Sans",Arial,sans-serif}
table{border-collapse:collapse}td,th{padding:6px 16px;text-align:center;white-space:nowrap}
.ltx_border_t{border-top:2px solid #111}.ltx_border_tt{border-top:3px solid #111}
.ltx_border_b{border-bottom:2px solid #111}.ltx_border_bb{border-bottom:3px solid #111}
.ltx_border_r{border-right:1px solid #111}.ltx_border_l{border-left:1px solid #111}
.ltx_font_bold{font-weight:bold}.ltx_font_italic{font-style:italic}
</style></head><body><div id="t">${tableHtml}</div><script>
const t=document.getElementById("t");
const s=Math.min(1840/t.offsetWidth,1000/t.offsetHeight,2.5);
t.style.transform="translate(-50%,-50%) scale("+s+")";
</script></body></html>`;
}

// The paper body as plain text, so a writer can check every claim against the paper itself. We
// keep each formula's LaTeX source (MathML alttext) and drop the bibliography.
export function parseArxivText(html: string): string {
  const article = html.match(/<article[\s\S]*<\/article>/)?.[0] ?? html;
  const body = article
    .replace(/<section[^>]*ltx_bibliography[\s\S]*?<\/section>/g, "")
    .replace(/<math[^>]*alttext="([^"]*)"[\s\S]*?<\/math>/g, " $1 ");
  return stripTags(body).slice(0, MAX_TEXT_CHARS);
}

// Demo clips on a project page: direct video files and embedded YouTube players.
export function parseProjectVideos(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:mp4|webm))"/gi)) {
    urls.add(new URL(m[1] as string, pageUrl).href);
  }
  for (const m of html.matchAll(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/g)) {
    urls.add(`https://www.youtube.com/watch?v=${m[1]}`);
  }
  return [...urls];
}

async function fetchText(url: string): Promise<string> {
  await assertSafeUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

interface HfPaper {
  title?: string;
  projectPage?: string;
  mediaUrls?: string[];
}

// Each table rendered to a still, kept in the private bucket when the server has one.
// Draws a page to a PNG and stores it, in the private bucket when the server has one. Returns
// null when the browser fails to draw it.
async function renderStill(page: string, filename: string): Promise<string | null> {
  const frames = await previewFrames({
    htmlBase64: Buffer.from(page).toString("base64"),
    timeSeconds: [0],
    resolution: "landscape",
  }).then(
    (out) => out.frames,
    (error: unknown) => {
      if (error instanceof ExecError) return [];
      throw error;
    },
  );
  const still = frames[0];
  if (!still) return null;
  const visibility = config.storage.s3.privateBucket ? "private" : "public";
  return storage().save(still.buffer, filename, "image/png", visibility);
}

// Each table rendered to a still. A table the browser fails to draw is left out; the rest of the
// paper's material still counts.
async function renderTables(arxivId: string, tables: PaperTable[]): Promise<PaperTableStill[]> {
  const rendered: PaperTableStill[] = [];
  for (const table of tables) {
    const url = await renderStill(tablePage(table.html), `paper-${arxivId}-${table.id}.png`);
    if (!url) continue;
    const rows = parseTableGrid(table.html).map((cells) => cells.join(" | "));
    rendered.push({ id: table.id, url, caption: table.caption, rows });
  }
  return rendered;
}

// The table's cells as text, row by row. A cell spanning several columns is followed by empty
// cells, so column numbers line up across rows. A cell spanning several rows repeats in each,
// so every row keeps its label.
export function parseTableGrid(tableHtml: string): string[][] {
  const grid: string[][] = [];
  const carried: { text: string; rowsLeft: number }[] = [];
  for (const row of tableHtml.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const cells: string[] = [];
    const fillCarried = () => {
      for (let held = carried[cells.length]; held?.rowsLeft; held = carried[cells.length]) {
        cells.push(held.text);
        held.rowsLeft--;
      }
    };
    for (const cell of row.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g)) {
      fillCarried();
      const colspan = Number(cell[1]?.match(/colspan="(\d+)"/)?.[1] ?? 1);
      const rowspan = Number(cell[1]?.match(/rowspan="(\d+)"/)?.[1] ?? 1);
      const text = stripTags(
        (cell[2] ?? "").replace(/<annotation[\s\S]*?<\/annotation>|<cite[\s\S]*?<\/cite>/g, ""),
      );
      for (let i = 0; i < colspan; i++) {
        if (rowspan > 1) carried[cells.length] = { text: i ? "" : text, rowsLeft: rowspan - 1 };
        cells.push(i ? "" : text);
      }
    }
    fillCarried();
    if (cells.some(Boolean)) grid.push(cells);
  }
  return grid;
}

export interface TableFocus {
  rows: number[];
  cols?: number[];
  highlight?: { row: number; col: number }[];
}

// A 16:9 card with the header row, the chosen rows and columns, and the cited cells highlighted,
// scaled to fill the card so the numbers a line talks about read large when a vertical frame shows
// it full width. Row 0 and column 0 always stay, since they name what the numbers are.
export function focusTablePage(grid: string[][], focus: TableFocus): string {
  const width = Math.max(...grid.map((row) => row.length));
  const keepRows = [...new Set([0, ...focus.rows])].filter((r) => r >= 0 && r < grid.length);
  const keepCols = focus.cols?.length
    ? [...new Set([0, ...focus.cols])].filter((c) => c >= 0 && c < width).sort((a, b) => a - b)
    : [...Array(width).keys()];
  const marked = new Set((focus.highlight ?? []).map(({ row, col }) => `${row}:${col}`));
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = keepRows
    .sort((a, b) => a - b)
    .map((r) => {
      const tag = r === 0 ? "th" : "td";
      const cells = keepCols.map((c) => {
        const mark = marked.has(`${r}:${c}`) ? ' class="hit"' : "";
        return `<${tag}${mark}>${escapeHtml(grid[r]?.[c] ?? "")}</${tag}>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;width:1920px;height:1080px;background:#fff}
#t{position:absolute;left:50%;top:50%;transform-origin:center;color:#111;font:40px "Liberation Sans",Arial,sans-serif}
table{border-collapse:collapse}th,td{padding:14px 26px;text-align:center;white-space:nowrap;border-bottom:2px solid #ccc}
th{border-bottom:4px solid #111;font-weight:bold}td:first-child,th:first-child{text-align:left;font-weight:bold}
.hit{background:#ffe14d;font-weight:bold;outline:4px solid #e0a800}
</style></head><body><div id="t"><table>${body}</table></div><script>
const t=document.getElementById("t");
const s=Math.min(1800/t.offsetWidth,1000/t.offsetHeight,3);
t.style.transform="translate(-50%,-50%) scale("+s+")";
</script></body></html>`;
}

// The focused card of one table of a paper, stored like the table stills.
export async function focusPaperTable(
  arxivId: string,
  tableId: string,
  focus: TableFocus,
): Promise<{ url: string; rows_shown: number; cols_shown: number }> {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  const table = parseArxivTables(await fetchText(htmlUrl)).find((t) => t.id === tableId);
  if (!table) throw new Error(`${arxivId} has no table ${tableId}`);
  const grid = parseTableGrid(table.html);
  const url = await renderStill(
    focusTablePage(grid, focus),
    `paper-${arxivId}-${tableId}-focus-${cacheId(JSON.stringify(focus))}.png`,
  );
  if (!url) throw new Error(`the browser failed to draw ${tableId} of ${arxivId}`);
  return {
    url,
    rows_shown: new Set([0, ...focus.rows]).size,
    cols_shown: focus.cols?.length ? new Set([0, ...focus.cols]).size : (grid[0]?.length ?? 0),
  };
}

// The paper's own visual material: its figures from arXiv and the authors' demo videos from the
// Hugging Face paper page and the project page. A missing source only shrinks the result.
export async function getPaperMedia(
  arxivId: string,
  { withTables = false }: { withTables?: boolean } = {},
): Promise<PaperMedia> {
  const hf: HfPaper = await fetchText(`https://huggingface.co/api/papers/${arxivId}`)
    .then((t) => JSON.parse(t) as HfPaper)
    .catch(() => ({}));
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  const html = await fetchText(htmlUrl).catch(() => "");
  const figures = parseArxivFigures(html, htmlUrl);

  const videoUrls = new Set((hf.mediaUrls ?? []).filter((u) => /\.(mp4|webm|mov|qt)$/i.test(u)));
  if (hf.projectPage) {
    const page = await fetchText(hf.projectPage).catch(() => "");
    for (const url of parseProjectVideos(page, hf.projectPage)) videoUrls.add(url);
  }
  const videos = [...videoUrls].slice(0, MAX_VIDEOS).map((url, i) => ({
    id: `vid${i + 1}`,
    url,
    source: (hf.mediaUrls ?? []).includes(url) ? "huggingface" : "project_page",
  }));

  return {
    arxiv_id: arxivId,
    title: hf.title ?? "",
    project_page: hf.projectPage ?? null,
    text: html ? parseArxivText(html) : "",
    figures,
    tables: withTables ? await renderTables(arxivId, parseArxivTables(html)) : [],
    videos,
  };
}

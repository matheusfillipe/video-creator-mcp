import { assertSafeUrl } from "../lib/net.js";

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

export interface PaperMedia {
  arxiv_id: string;
  title: string;
  project_page: string | null;
  text: string;
  figures: PaperFigure[];
  videos: PaperVideo[];
}

const MAX_FIGURES = 14;
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
// are skipped because the renderer only takes raster stills.
export function parseArxivFigures(html: string, pageUrl: string): PaperFigure[] {
  const figures: PaperFigure[] = [];
  for (const block of html.match(/<figure[\s\S]*?<\/figure>/g) ?? []) {
    const src = block.match(/<img[^>]*src="([^"]+)"/)?.[1];
    if (!src || src.endsWith(".svg")) continue;
    const caption = stripTags(block.match(/<figcaption[\s\S]*?<\/figcaption>/)?.[0] ?? "").slice(
      0,
      300,
    );
    figures.push({ id: `fig${figures.length + 1}`, url: new URL(src, pageUrl).href, caption });
    if (figures.length >= MAX_FIGURES) break;
  }
  return figures;
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

// The paper's own visual material: its figures from arXiv and the authors' demo videos from the
// Hugging Face paper page and the project page. A missing source only shrinks the result.
export async function getPaperMedia(arxivId: string): Promise<PaperMedia> {
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
    videos,
  };
}

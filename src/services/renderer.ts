import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { sanitizedEnv, spawnStreaming } from "../lib/exec.js";
import type { Resolution } from "../types.js";
import { linkMediaToWorkdir } from "./media.js";

const FRAME_RE = /Streaming frame\s*(\d+)\s*\/\s*(\d+)/;
const DURATION_RE = /data-duration\s*=\s*["'](\d+(?:\.\d+)?)["']/;
const WIDTH_RE = /data-width\s*=\s*["'](\d+)["']/;
const HEIGHT_RE = /data-height\s*=\s*["'](\d+)["']/;

// Hyperframes rejects a composition whose dimensions don't match the resolution preset.
function sniffCompositionSize(html: string): { w: number; h: number } | null {
  const w1 = Number(WIDTH_RE.exec(html)?.[1] ?? 0);
  const h1 = Number(HEIGHT_RE.exec(html)?.[1] ?? 0);
  if (w1 && h1) return { w: w1, h: h1 };
  const bodyBlock = /body\s*\{([^}]*)\}/i.exec(html);
  if (bodyBlock?.[1]) {
    const w2 = Number(/width\s*:\s*(\d+)\s*px/i.exec(bodyBlock[1])?.[1] ?? 0);
    const h2 = Number(/height\s*:\s*(\d+)\s*px/i.exec(bodyBlock[1])?.[1] ?? 0);
    if (w2 && h2) return { w: w2, h: h2 };
  }
  return null;
}

function adjustResolutionForHtml(html: string, requested: Resolution): Resolution {
  const dims = sniffCompositionSize(html);
  if (!dims) return requested;
  const { w, h } = dims;
  if (w === h) return "square";
  const compIsLandscape = w > h;
  const reqIsLandscape =
    requested === "1080p" || requested === "landscape" || requested === "4k" || requested === "uhd";
  if (compIsLandscape && reqIsLandscape) return requested;
  if (!compIsLandscape && requested === "portrait") return requested;
  return compIsLandscape ? "1080p" : "portrait";
}
const here = dirname(fileURLToPath(import.meta.url));
const GSAP_SOURCE = join(here, "..", "..", "gsap", "gsap.min.js");
const ANIME_SOURCE = join(here, "..", "..", "animejs", "anime.min.js");
const ANIME_TAG = '<script src="assets/anime.min.js"></script>';

// Each `hyperframes render` boots a producer HTTP server (default port 9847) and writes
// intermediate frames to a shared renders dir. Concurrent renders must not collide on
// either, so each invocation gets a distinct port and a renders dir inside its work dir.
const PRODUCER_PORT_BASE = 9847;
const PRODUCER_PORT_WINDOW = 64;
let producerPortSeq = 0;

export interface RenderProgress {
  current: number;
  total: number;
}

export interface RenderParams {
  htmlBase64: string;
  fps: number;
  resolution: Resolution;
  audioBase64?: string;
  audioVolume?: number;
  media?: Array<{ media_id: string }>;
}

export interface RenderOutput {
  buffer: Buffer;
  filename: string;
  warnings?: string[];
}

function ensureDocument(html: string): string {
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) {
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<script src="assets/gsap.min.js"></script>\n${ANIME_TAG}\n</head>\n<body>\n${html}\n</body>\n</html>`;
  }
  let out = html;
  // chrome defaults to Latin-1 without an explicit <meta charset>; UTF-8 punctuation breaks.
  if (!/<meta[^>]+charset/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (match) => `${match}\n<meta charset="UTF-8">`);
  }
  if (!out.includes("gsap")) {
    out = out.replace("<head>", '<head>\n<script src="assets/gsap.min.js"></script>');
  }
  // Both animation libraries ship as assets so a composition never inlines a minified bundle:
  // hyperframes' linter would then flag the library's own Math.random/rAF as the author's.
  if (!out.includes(ANIME_TAG)) {
    out = out.replace("<head>", `<head>\n${ANIME_TAG}`);
  }
  return out;
}

function injectAudioTag(html: string, volume: number): string {
  if (html.includes("<audio")) return html;
  const duration = DURATION_RE.exec(html)?.[1] ?? "30";
  const tag = `\n<audio data-start="0" data-duration="${duration}" data-volume="${volume}" src="assets/audio.wav"></audio>\n`;
  return html.replace("</body>", `${tag}</body>`);
}

// A model sometimes JS-escapes a close tag ("<\/div>") into text content, which renders
// as visible junk ("\/div>") over the video. "\/" is never valid in HTML body text, so
// strip it — but leave <script> blocks untouched, where "<\/script>" is legitimate JS.
function stripEscapedTagJunk(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|(<?\\\/[a-zA-Z][\w-]*>)/g, (match, junk) =>
    junk ? "" : match,
  );
}

async function copyGsap(assetsDir: string): Promise<void> {
  for (const [source, name] of [
    [GSAP_SOURCE, "gsap.min.js"],
    [ANIME_SOURCE, "anime.min.js"],
  ] as const) {
    try {
      await copyFile(source, join(assetsDir, name));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Bundled ${name} not found at ${source}: ${detail}`);
    }
  }
}

export async function renderComposition(
  params: RenderParams,
  onProgress?: (progress: RenderProgress) => void,
): Promise<RenderOutput> {
  const jobId = randomUUID().slice(0, 8);
  const workDir = join(config.workDir, jobId);
  const assetsDir = join(workDir, "assets");
  const outputFile = join(workDir, "output.mp4");
  await mkdir(assetsDir, { recursive: true });

  try {
    let html = ensureDocument(
      stripEscapedTagJunk(Buffer.from(params.htmlBase64, "base64").toString("utf-8")),
    );
    await copyGsap(assetsDir);
    for (const item of params.media ?? []) {
      await linkMediaToWorkdir(item.media_id, workDir);
    }
    if (params.audioBase64) {
      await writeFile(join(assetsDir, "audio.wav"), Buffer.from(params.audioBase64, "base64"));
      html = injectAudioTag(html, params.audioVolume ?? 0.9);
    }
    await writeFile(join(workDir, "index.html"), html);

    const effectiveResolution = adjustResolutionForHtml(html, params.resolution);
    const args = [
      "render",
      workDir,
      "--output",
      outputFile,
      "--fps",
      String(params.fps),
      "--resolution",
      effectiveResolution,
      // Pin 1 worker — skips auto-worker calibration which probes ~2-3s per frame on
      // software-GL pods and intermittently fails segments with "slow frame capture".
      "--workers",
      "1",
      // Force chrome's hardware GPU path when /dev/dri is mounted. Without this flag
      // hyperframes' "auto" probe still launches chrome with --use-angle=swiftshader
      // (verified in the chrome args), falling back to software regardless.
      "--browser-gpu",
      // Hardware H.264 encode via VAAPI (AMD 780M). Cuts the final libx264 encode pass
      // from minutes to seconds for long timelines.
      "--gpu",
    ];
    const producerPort = PRODUCER_PORT_BASE + (producerPortSeq++ % PRODUCER_PORT_WINDOW);
    // Invoke the globally-installed binary directly rather than via npx: under parallel
    // renders, concurrent npx invocations race on its cache and one would try to fetch a
    // newer hyperframes from the registry instead of using the baked version.
    await spawnStreaming(
      "hyperframes",
      args,
      (line) => {
        const match = FRAME_RE.exec(line);
        if (match?.[1] && match[2]) {
          onProgress?.({ current: Number(match[1]), total: Number(match[2]) });
        }
      },
      {
        env: {
          ...sanitizedEnv(),
          PRODUCER_PORT: String(producerPort),
          PRODUCER_RENDERS_DIR: join(workDir, "renders"),
        },
      },
    );

    const buffer = await readFile(outputFile);
    return { buffer, filename: `render-${jobId}.mp4` };
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (error: NodeJS.ErrnoException) => {
        console.error(`[renderer] cleanup of ${workDir} failed: ${error.code ?? error.message}`);
      },
    );
  }
}

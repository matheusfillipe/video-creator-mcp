import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { spawnStreaming } from "../lib/exec.js";
import type { Resolution } from "../types.js";
import { linkMediaToWorkdir } from "./media.js";

const FRAME_RE = /Streaming frame\s*(\d+)\s*\/\s*(\d+)/;
const DURATION_RE = /data-duration\s*=\s*["'](\d+(?:\.\d+)?)["']/;
const here = dirname(fileURLToPath(import.meta.url));
const GSAP_SOURCE = join(here, "..", "..", "gsap", "gsap.min.js");

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
}

function ensureDocument(html: string): string {
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) {
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<script src="assets/gsap.min.js"></script>\n</head>\n<body>\n${html}\n</body>\n</html>`;
  }
  if (!html.includes("gsap")) {
    return html.replace("<head>", '<head>\n<script src="assets/gsap.min.js"></script>');
  }
  return html;
}

function injectAudioTag(html: string, volume: number): string {
  if (html.includes("<audio")) return html;
  const duration = DURATION_RE.exec(html)?.[1] ?? "30";
  const tag = `\n<audio data-start="0" data-duration="${duration}" data-volume="${volume}" src="assets/audio.wav"></audio>\n`;
  return html.replace("</body>", `${tag}</body>`);
}

async function copyGsap(assetsDir: string): Promise<void> {
  try {
    await copyFile(GSAP_SOURCE, join(assetsDir, "gsap.min.js"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bundled GSAP not found at ${GSAP_SOURCE}: ${detail}`);
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
    let html = ensureDocument(Buffer.from(params.htmlBase64, "base64").toString("utf-8"));
    await copyGsap(assetsDir);
    for (const item of params.media ?? []) {
      await linkMediaToWorkdir(item.media_id, workDir);
    }
    if (params.audioBase64) {
      await writeFile(join(assetsDir, "audio.wav"), Buffer.from(params.audioBase64, "base64"));
      html = injectAudioTag(html, params.audioVolume ?? 0.9);
    }
    await writeFile(join(workDir, "index.html"), html);

    const args = [
      "hyperframes",
      "render",
      workDir,
      "--output",
      outputFile,
      "--fps",
      String(params.fps),
      "--resolution",
      params.resolution,
    ];
    const producerPort = PRODUCER_PORT_BASE + (producerPortSeq++ % PRODUCER_PORT_WINDOW);
    await spawnStreaming(
      "npx",
      args,
      (line) => {
        const match = FRAME_RE.exec(line);
        if (match?.[1] && match[2]) {
          onProgress?.({ current: Number(match[1]), total: Number(match[2]) });
        }
      },
      {
        env: {
          ...process.env,
          PRODUCER_PORT: String(producerPort),
          PRODUCER_RENDERS_DIR: join(workDir, "renders"),
        },
      },
    );

    const buffer = await readFile(outputFile);
    return { buffer, filename: `render-${jobId}.mp4` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

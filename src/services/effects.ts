import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { assertSafeUrl } from "../lib/net.js";
import type { MediaMeta } from "../types.js";
import { loadMeta, writeMediaFromBuffer } from "./media.js";

const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;

// Bold reads better burned over moving footage than the regular weight.
const CAPTION_FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";

export interface Caption {
  text: string;
  start: number;
  duration: number;
}
export type CaptionPosition = "top" | "center" | "bottom";

export interface CaptionParams {
  mediaId: string;
  captions: Caption[];
  position: CaptionPosition;
  fontSize?: number;
  color: string;
  box: boolean;
}

function yExpression(position: CaptionPosition, margin: number): string {
  if (position === "top") return String(margin);
  if (position === "center") return "(h-text_h)/2";
  return `h-text_h-${margin}`;
}

// Burn timed text onto a clip with a single ffmpeg drawtext pass — one drawtext filter per
// caption, shown only within its [start, start+duration] window via `enable=between(t,..)`.
// This is the cheap path for "loop a clip and talk to the viewer with rotating subtitles":
// libx264 re-encodes once in roughly real time, versus a headless-chrome composition that
// renders every frame in software GL at ~3x real time. Text comes from files so arbitrary
// caption content can't break the filtergraph syntax, and expansion is off so `%`/`\` in a
// caption stay literal.
export async function captionMedia(
  params: CaptionParams,
): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const meta = await loadMeta(params.mediaId);
  if (!meta) {
    throw new Error(
      `Unknown media_id "${params.mediaId}" — download it first with video_download_media.`,
    );
  }
  if (params.captions.length === 0) {
    throw new Error("captions must contain at least one entry");
  }
  const dir = await mkdtemp(join(tmpdir(), "vcm-caption-"));
  try {
    const fontSize = params.fontSize ?? Math.max(24, Math.round((meta.height || 1080) / 20));
    const margin = Math.round(fontSize * 0.9);
    const yExpr = yExpression(params.position, margin);
    const filters: string[] = [];
    for (const [index, caption] of params.captions.entries()) {
      const textFile = join(dir, `cap${index}.txt`);
      await writeFile(textFile, caption.text);
      const end = caption.start + caption.duration;
      const parts = [
        `fontfile=${CAPTION_FONT}`,
        `textfile=${textFile}`,
        "expansion=none",
        `enable='between(t,${caption.start},${end})'`,
        "x=(w-text_w)/2",
        `y=${yExpr}`,
        `fontsize=${fontSize}`,
        `fontcolor=${params.color}`,
      ];
      if (params.box) {
        parts.push("box=1", "boxcolor=black@0.5", `boxborderw=${Math.round(fontSize * 0.35)}`);
      }
      filters.push(`drawtext=${parts.join(":")}`);
    }
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      [
        "-y",
        "-i",
        meta.path,
        "-vf",
        filters.join(","),
        "-c:a",
        "copy",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outFile,
      ],
      { timeoutMs: 300_000 },
    );
    const buffer = await readFile(outFile);
    const captionedMeta = await writeMediaFromBuffer({
      idSeed: `caption:${params.mediaId}:${params.position}:${fontSize}:${params.color}:${params.box}:${JSON.stringify(params.captions)}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `caption://${params.mediaId}`,
    });
    return { buffer, meta: captionedMeta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type BackgroundFormat = "webm" | "mov" | "png";

export async function lintComposition(htmlBase64: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-lint-"));
  try {
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");
    await writeFile(join(dir, "index.html"), html);
    const { stdout, stderr } = await run("npx", ["hyperframes", "lint", dir], {
      timeoutMs: 30_000,
      allowNonZero: true,
    });
    return stdout || stderr || "Lint passed — no issues found.";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeBackground(
  input: string,
  format: BackgroundFormat,
): Promise<MediaMeta> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-rmbg-"));
  try {
    let inputFile: string;
    if (input.startsWith("http")) {
      await assertSafeUrl(input);
      inputFile = join(dir, "input.mp4");
      await run("curl", ["-sL", "--max-redirs", "5", "-o", inputFile, "--max-time", "120", input], {
        timeoutMs: 130_000,
      });
    } else {
      const meta = await loadMeta(input);
      if (!meta) throw new Error(`Media ${input} not found in cache`);
      inputFile = meta.path;
    }

    const isImage = IMAGE_RE.test(inputFile);
    if (!isImage && format === "png") {
      throw new Error("PNG output is only valid for image input; use 'webm' or 'mov' for video");
    }
    const outFormat: BackgroundFormat = isImage ? "png" : format;
    const outputPath = join(dir, `out.${outFormat}`);
    await run("npx", ["hyperframes", "remove-background", "-o", outputPath, inputFile], {
      timeoutMs: 300_000,
    });
    const buffer = await readFile(outputPath);
    return writeMediaFromBuffer({
      idSeed: `rmbg:${input}:${outFormat}`,
      buffer,
      ext: `.${outFormat}`,
      sourceUrl: `rmbg://${input}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

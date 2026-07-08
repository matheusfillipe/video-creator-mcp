import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { run } from "../lib/exec.js";
import type { Resolution } from "../types.js";
import { linkMediaToWorkdir } from "./media.js";

const here = dirname(fileURLToPath(import.meta.url));
const GSAP_SOURCE = join(here, "..", "..", "gsap", "gsap.min.js");
const ANIME_SOURCE = join(here, "..", "..", "animejs", "anime.min.js");
const ANIME_TAG = '<script src="assets/anime.min.js"></script>';

function ensureDocument(html: string): string {
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) {
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<script src="assets/gsap.min.js"></script>\n${ANIME_TAG}\n</head>\n<body>\n${html}\n</body>\n</html>`;
  }
  let out = html;
  if (!/<meta[^>]+charset/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (match) => `${match}\n<meta charset="UTF-8">`);
  }
  if (!out.includes("gsap")) {
    out = out.replace("<head>", '<head>\n<script src="assets/gsap.min.js"></script>');
  }
  if (!out.includes(ANIME_TAG)) {
    out = out.replace("<head>", `<head>\n${ANIME_TAG}`);
  }
  return out;
}

export interface PreviewParams {
  htmlBase64: string;
  timeSeconds: number[];
  resolution: Resolution;
  media?: Array<{ media_id: string }>;
}

export interface PreviewOutput {
  frames: Array<{ time_seconds: number; buffer: Buffer; filename: string }>;
  contactSheet?: { buffer: Buffer; filename: string };
}

export async function previewFrames(params: PreviewParams): Promise<PreviewOutput> {
  const jobId = randomUUID().slice(0, 8);
  const workDir = join(config.workDir, `preview-${jobId}`);
  const assetsDir = join(workDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  try {
    const html = ensureDocument(Buffer.from(params.htmlBase64, "base64").toString("utf-8"));
    await copyFile(GSAP_SOURCE, join(assetsDir, "gsap.min.js"));
    await copyFile(ANIME_SOURCE, join(assetsDir, "anime.min.js"));
    for (const item of params.media ?? []) {
      await linkMediaToWorkdir(item.media_id, workDir);
    }
    await writeFile(join(workDir, "index.html"), html);

    const atArg = params.timeSeconds.map((t) => t.toFixed(3)).join(",");
    await run("hyperframes", ["snapshot", workDir, "--at", atArg, "--describe", "false"], {
      timeoutMs: 120_000,
    });

    const snapsDir = join(workDir, "snapshots");
    const files = await readdir(snapsDir);
    const frames: PreviewOutput["frames"] = [];
    for (const [i, t] of params.timeSeconds.entries()) {
      const prefix = `frame-${String(i).padStart(2, "0")}-`;
      const name = files.find((f) => f.startsWith(prefix) && f.endsWith(".png"));
      if (!name) {
        throw new Error(
          `hyperframes snapshot didn't produce a PNG for index ${i} (t=${t}s). Available: ${files.join(", ")}`,
        );
      }
      const buffer = await readFile(join(snapsDir, name));
      frames.push({
        time_seconds: t,
        buffer,
        filename: `preview-${jobId}-${String(i).padStart(2, "0")}-${t}s.png`,
      });
    }

    let contactSheet: PreviewOutput["contactSheet"];
    const sheet = files.find((f) => f === "contact-sheet.jpg");
    if (sheet) {
      contactSheet = {
        buffer: await readFile(join(snapsDir, sheet)),
        filename: `preview-${jobId}-contact-sheet.jpg`,
      };
    }
    return { frames, contactSheet };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

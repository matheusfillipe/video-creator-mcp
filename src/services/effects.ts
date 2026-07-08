import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkComposition } from "../lib/composition-checks.js";
import { run } from "../lib/exec.js";
import { buildTimedDrawtext } from "../lib/ffmpeg.js";
import { assertSafeUrl } from "../lib/net.js";
import type { MediaMeta } from "../types.js";
import { loadMeta, writeMediaFromBuffer } from "./media.js";
import { saveRender } from "./publish.js";

const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;

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

export type AudioMixMode = "replace" | "mix";

interface AudioMuxOptions {
  mode: AudioMixMode;
  volume: number;
  existingVolume: number;
  loop: boolean;
}

// ffmpeg args to mux an audio track onto a video, stream-copying the video. -stream_loop repeats a
// short track so it covers the whole video; amix's duration=first already caps a mix at the video,
// so -shortest is only needed to bound an otherwise-endless looped replace track.
function audioMuxArgs(
  videoPath: string,
  audioPath: string,
  opts: AudioMuxOptions,
  outFile: string,
): string[] {
  const filter =
    opts.mode === "mix"
      ? `[0:a]volume=${opts.existingVolume}[a0];[1:a]volume=${opts.volume}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]`
      : `[1:a]volume=${opts.volume}[a]`;
  const args = ["-y", "-i", videoPath];
  if (opts.loop) args.push("-stream_loop", "-1");
  args.push(
    "-i",
    audioPath,
    "-filter_complex",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
  );
  if (opts.loop && opts.mode !== "mix") args.push("-shortest");
  args.push(outFile);
  return args;
}

// Loop background music under a freshly-rendered silent video so a short track fills the whole
// clip. Lets the math/manim render tools bake in music without a separate video_add_audio round-trip.
export async function muxLoopedMusic(
  videoBuffer: Buffer,
  ext: string,
  musicMediaId: string,
  volume: number,
): Promise<Buffer> {
  const music = await loadMeta(musicMediaId);
  if (!music) {
    throw new Error(
      `Unknown music media_id "${musicMediaId}" — download it with video_download_media first.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "vcm-music-"));
  try {
    const videoPath = join(dir, `in${ext}`);
    await writeFile(videoPath, videoBuffer);
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      audioMuxArgs(
        videoPath,
        music.path,
        { mode: "replace", volume, existingVolume: 1, loop: true },
        outFile,
      ),
      { timeoutMs: 300_000 },
    );
    return readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mux an audio track onto a video. "replace" makes it the sole audio (TTS narration over muted
// footage); "mix" blends it UNDER the video's existing audio (background music/ambient — the
// video must already have an audio stream). The video keeps its full length; with `loop` a track
// shorter than the video repeats to cover it (background music), otherwise it simply ends. Video
// is stream-copied, only the audio is re-encoded.
export async function addAudioTrack(params: {
  videoId: string;
  audioId: string;
  mode: AudioMixMode;
  volume: number;
  existingVolume: number;
  loop: boolean;
}): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const video = await loadMeta(params.videoId);
  if (!video) {
    throw new Error(`Unknown video media_id "${params.videoId}" — render or download it first.`);
  }
  const audio = await loadMeta(params.audioId);
  if (!audio) {
    throw new Error(
      `Unknown audio media_id "${params.audioId}" — get it from video_tts or video_download_media.`,
    );
  }
  if (params.mode === "mix" && !video.hasAudio) {
    throw new Error(
      `Video ${params.videoId} has no audio to mix under — use mode "replace" for the first track.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "vcm-audio-"));
  try {
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      audioMuxArgs(
        video.path,
        audio.path,
        {
          mode: params.mode,
          volume: params.volume,
          existingVolume: params.existingVolume,
          loop: params.loop,
        },
        outFile,
      ),
      { timeoutMs: 300_000 },
    );
    const buffer = await readFile(outFile);
    const meta = await writeMediaFromBuffer({
      idSeed: `addaudio:${params.videoId}:${params.audioId}:${params.mode}:${params.volume}:${params.existingVolume}:${params.loop}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `addaudio://${params.videoId}`,
    });
    return { buffer, meta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Burn timed text onto a clip with a single ffmpeg drawtext pass — the cheap path for
// "loop a clip and talk to the viewer with rotating subtitles": libx264 re-encodes once
// in roughly real time, versus a headless-chrome composition rendering every frame in
// software GL at ~3x real time.
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
    const filters: string[] = [];
    for (const [index, caption] of params.captions.entries()) {
      const textFile = join(dir, `cap${index}.txt`);
      await writeFile(textFile, caption.text);
      filters.push(
        buildTimedDrawtext({
          textFile,
          start: caption.start,
          end: caption.start + caption.duration,
          position: params.position,
          fontSize,
          color: params.color,
          box: params.box,
        }),
      );
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

// hyperframes' linter checks a standalone project, so some of its findings never apply to a
// composition rendered through this server, and acting on them makes an author rewrite a scene
// that already works: renderComposition wraps a bare composition in a full HTML document and
// injects the animation libraries, and the hyperframes runtime seeks anime.js timelines
// registered on window.__hfAnime — which the GSAP-only registry check cannot see.
const ADAPTER_REGISTRIES = ["__hfAnime", "__hfLottie"];
const ALWAYS_INAPPLICABLE = ["root_composition_missing_html_wrapper", "missing_gsap_script"];
const GSAP_ONLY_FINDING = "missing_timeline_registry";
const FINDING_START_RE = /^\s*([\u2717\u26a0])\s/;
const CONTINUATION_RE = /^\s{4,}\S/;
const SUMMARY_RE = /^(\s*\u25c7\s+)\d+( error\(s\), )\d+( warning\(s\))/;

export function dropInapplicableFindings(lintOutput: string, html: string): string {
  const drivenByAdapter = ADAPTER_REGISTRIES.some((registry) => html.includes(registry));
  const inapplicable = (line: string): boolean =>
    ALWAYS_INAPPLICABLE.some((finding) => line.includes(finding)) ||
    (drivenByAdapter && line.includes(GSAP_ONLY_FINDING));

  const kept: string[] = [];
  let errors = 0;
  let warnings = 0;
  let skipping = false;
  for (const line of lintOutput.split("\n")) {
    const finding = FINDING_START_RE.exec(line);
    if (finding) {
      skipping = inapplicable(line);
      if (!skipping) {
        if (finding[1] === "\u2717") errors += 1;
        else warnings += 1;
      }
    } else if (skipping && !CONTINUATION_RE.test(line)) {
      // the finding's indented "Fix:" lines are its only continuation; anything else
      // (the summary, a blank line) belongs to the report, not to the dropped finding.
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept
    .map((line) =>
      line.replace(SUMMARY_RE, (_m, head, mid, tail) => `${head}${errors}${mid}${warnings}${tail}`),
    )
    .join("\n");
}

export async function lintComposition(htmlBase64: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-lint-"));
  try {
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");
    await writeFile(join(dir, "index.html"), html);
    const { stdout, stderr } = await run("hyperframes", ["lint", dir], {
      timeoutMs: 30_000,
      allowNonZero: true,
    });
    const report = dropInapplicableFindings(stdout || stderr, html);
    const extra = checkComposition(html);
    const combined = [report.trimEnd(), ...extra.map((finding) => `  ${finding}`)]
      .filter(Boolean)
      .join("\n");
    return combined || "Lint passed — no issues found.";
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
    await run("hyperframes", ["remove-background", "-o", outputPath, inputFile], {
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

export async function extractFrame(params: {
  mediaId: string;
  timeSec: number;
}): Promise<{ buffer: Buffer; meta: MediaMeta; url: string; filename: string }> {
  const meta = await loadMeta(params.mediaId);
  if (!meta) {
    throw new Error(`Unknown media_id "${params.mediaId}" — download it first.`);
  }
  const time = Math.max(0, Math.min(params.timeSec, Math.max(0, meta.duration - 0.05)));
  const dir = await mkdtemp(join(tmpdir(), "vcm-frame-"));
  try {
    const out = join(dir, "frame.png");
    await run(
      "ffmpeg",
      ["-y", "-ss", String(time), "-i", meta.path, "-frames:v", "1", "-vsync", "0", out],
      { timeoutMs: 60_000 },
    );
    const buffer = await readFile(out);
    const imageMeta = await writeMediaFromBuffer({
      idSeed: `frame:${params.mediaId}:${time}`,
      buffer,
      ext: ".png",
      sourceUrl: `frame://${params.mediaId}@${time}`,
    });
    const saved = await saveRender(buffer, imageMeta.filename);
    return { buffer, meta: imageMeta, url: saved.url, filename: imageMeta.filename };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A chrome render can "succeed" while its GSAP animations never fire, leaving nothing but the
// page background: no frame ever contains a bright pixel. YMAX, not YAVG, is the discriminator —
// any drawn text or line-work pushes the frame maximum near 255, while a dark backdrop keeps the
// average low whether or not anything was drawn on it.
export const BLACK_OUTPUT_YMAX = 80;
const LUMA_SAMPLE_STRIDE_FRAMES = 15;
const YMAX_RE = /YMAX=(\d+)/g;

// NaN when the probe found no frames, so a caller's `< BLACK_OUTPUT_YMAX` test stays false.
export async function maxFrameLumaOfFile(filePath: string): Promise<number> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      filePath,
      "-vf",
      `select='not(mod(n\\,${LUMA_SAMPLE_STRIDE_FRAMES}))',signalstats,metadata=print:key=lavfi.signalstats.YMAX`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 120_000 },
  );
  let max = Number.NaN;
  for (const match of stderr.matchAll(YMAX_RE)) {
    const value = Number(match[1]);
    if (Number.isNaN(max) || value > max) max = value;
  }
  return max;
}

export async function maxFrameLuma(buffer: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-luma-"));
  try {
    const file = join(dir, "probe.mp4");
    await writeFile(file, buffer);
    return await maxFrameLumaOfFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function blackOutputWarning(maxLuma: number): string | null {
  if (!(maxLuma < BLACK_OUTPUT_YMAX)) return null;
  return `Rendered video looks BLACK/empty: no sampled frame has a pixel brighter than ${Math.round(maxLuma)}/255, so the composition's elements never became visible. Most common cause: GSAP tweens that never fire — give every element its initial state with gsap.set(...) and animate with .to(...) tweens, then re-render. Check a mid-scene frame with video_preview_frame before re-rendering.`;
}

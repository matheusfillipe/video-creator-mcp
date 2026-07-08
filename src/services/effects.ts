import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function lintComposition(htmlBase64: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-lint-"));
  try {
    const html = Buffer.from(htmlBase64, "base64").toString("utf-8");
    await writeFile(join(dir, "index.html"), html);
    const { stdout, stderr } = await run("hyperframes", ["lint", dir], {
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

// A chrome render can "succeed" while its GSAP animations never fire, producing a video where
// no frame ever contains a bright pixel — visually a black screen over the background gradient.
// Sampling the per-frame luma maximum separates that from a legitimately dark scene: text or
// line-work pushes YMAX near 255, a dead composition stays under ~30. The check runs per
// sampled frame (not just video-wide) so a dead SEGMENT inside an otherwise-bright timeline
// is still caught.
const BLACK_OUTPUT_YMAX = 80;
const BLACK_RUN_MIN_S = 3;
const LUMA_SAMPLE_RE = /pts_time:([0-9.]+)[\s\S]*?YMAX=(\d+)/g;

export interface LumaSample {
  time: number;
  ymax: number;
}

export async function lumaProfile(buffer: Buffer): Promise<LumaSample[]> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-luma-"));
  try {
    const file = join(dir, "probe.mp4");
    await writeFile(file, buffer);
    const { stderr } = await run(
      "ffmpeg",
      [
        "-v",
        "info",
        "-i",
        file,
        "-vf",
        "select='not(mod(n\\,15))',signalstats,metadata=print:key=lavfi.signalstats.YMAX",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 120_000 },
    );
    const samples: LumaSample[] = [];
    for (const m of stderr.matchAll(LUMA_SAMPLE_RE)) {
      samples.push({ time: Number(m[1]), ymax: Number(m[2]) });
    }
    return samples;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function longestDarkRun(samples: LumaSample[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let runStart: number | null = null;
  for (const [i, s] of samples.entries()) {
    if (s.ymax < BLACK_OUTPUT_YMAX) {
      runStart ??= s.time;
      const end = samples[i + 1]?.time ?? s.time;
      if (end - runStart >= BLACK_RUN_MIN_S && (!best || end - runStart > best.end - best.start)) {
        best = { start: runStart, end };
      }
    } else {
      runStart = null;
    }
  }
  return best;
}

const GSAP_REMEDY =
  "Most common cause: GSAP tweens that never fire — give every element its initial state with gsap.set(...) and animate with .to(...) tweens, then re-render. Check a mid-scene frame with video_preview_frame before re-rendering.";

export function blackOutputWarning(samples: LumaSample[]): string | null {
  if (samples.length === 0) return null;
  const max = Math.max(...samples.map((s) => s.ymax));
  if (max < BLACK_OUTPUT_YMAX) {
    return `Rendered video looks BLACK/empty: no sampled frame has a pixel brighter than ${Math.round(max)}/255, so the composition's elements never became visible. ${GSAP_REMEDY}`;
  }
  const dark = longestDarkRun(samples);
  if (dark) {
    return `Rendered video has a BLACK/empty stretch from ~${dark.start.toFixed(1)}s to ~${dark.end.toFixed(1)}s: no pixel there gets brighter than ${BLACK_OUTPUT_YMAX}/255, so that segment's elements never became visible. ${GSAP_REMEDY}`;
  }
  return null;
}

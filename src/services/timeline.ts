import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";
import { Limiter } from "../lib/queue.js";
import type { Resolution } from "../types.js";
import { loadMeta } from "./media.js";
import { type RenderOutput, renderComposition } from "./renderer.js";

export interface SegmentMedia {
  media_id: string;
  volume?: number;
  muted?: boolean;
}

// A clip-overlay segment composites the rank badge + name lower-third onto a cached
// clip with ffmpeg directly, skipping the headless-browser capture used for `html`
// segments — frame-accurate video-through-Chrome is ~25x slower per clip.
export interface ClipOverlay {
  media_id: string;
  rankText: string;
  nameText: string;
  accentColor?: string;
}

export interface TimelineSegment {
  duration: number;
  html?: string;
  media?: SegmentMedia[];
  clipOverlay?: ClipOverlay;
}

export interface TimelineAudioTrack {
  media_id: string;
  offset_ms: number;
  volume?: number;
  fade_ms?: number;
}

export interface TimelineParams {
  segments: TimelineSegment[];
  audio?: TimelineAudioTrack[];
  fps: number;
  resolution: Resolution;
}

interface MixTrack {
  media_id: string;
  offset_ms: number;
  volume: number;
  fade_ms: number;
  max_duration_s?: number;
}

const DEFAULT_OVERLAY_VOLUME = 0.6;
const DEFAULT_CLIP_VOLUME = 1.0;
const DEFAULT_FADE_MS = 1000;

// Liberation Sans (metric-compatible with the Arial family the html cards use) ships
// in the image via the fonts-liberation package; ffmpeg drawtext needs a concrete file.
const FONT_FILE = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
const DEFAULT_ACCENT = "#ffd24a";

const RESOLUTION_DIMS: Record<Resolution, { width: number; height: number }> = {
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
  uhd: { width: 3840, height: 2160 },
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

export function dimsFor(resolution: Resolution): { width: number; height: number } {
  return RESOLUTION_DIMS[resolution];
}

export interface ClipOverlayFilterOptions {
  width: number;
  height: number;
  rankTextFile: string;
  nameTextFile: string;
  fontFile: string;
  accentColor: string;
}

// Builds the ffmpeg -vf chain: cover-fit the clip to the canvas, then draw the name
// lower-third and the rank badge (each with an auto-sized background box). Text comes
// from files so names with quotes/colons need no filter-string escaping.
export function buildClipOverlayFilter(options: ClipOverlayFilterOptions): string {
  const accent = options.accentColor.startsWith("#")
    ? `0x${options.accentColor.slice(1)}`
    : options.accentColor;
  return [
    `scale=${options.width}:${options.height}:force_original_aspect_ratio=increase`,
    `crop=${options.width}:${options.height}`,
    "setsar=1",
    `drawtext=fontfile=${options.fontFile}:textfile=${options.nameTextFile}:expansion=none:x=60:y=h-th-90:fontsize=58:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=24`,
    `drawtext=fontfile=${options.fontFile}:textfile=${options.rankTextFile}:expansion=none:x=w-tw-80:y=60:fontsize=104:fontcolor=${accent}:box=1:boxcolor=black@0.55:boxborderw=20`,
    "format=yuv420p",
  ].join(",");
}

async function renderClipOverlay(
  overlay: ClipOverlay,
  duration: number,
  fps: number,
  resolution: Resolution,
  outPath: string,
  scratchDir: string,
  index: number,
): Promise<void> {
  const meta = await loadMeta(overlay.media_id);
  if (!meta) throw new Error(`Media ${overlay.media_id} not found in cache`);

  const rankTextFile = join(scratchDir, `seg_${index}_rank.txt`);
  const nameTextFile = join(scratchDir, `seg_${index}_name.txt`);
  await writeFile(rankTextFile, overlay.rankText);
  await writeFile(nameTextFile, overlay.nameText);

  const { width, height } = dimsFor(resolution);
  const filter = buildClipOverlayFilter({
    width,
    height,
    rankTextFile,
    nameTextFile,
    fontFile: FONT_FILE,
    accentColor: overlay.accentColor ?? DEFAULT_ACCENT,
  });

  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      meta.path,
      "-t",
      String(duration),
      "-vf",
      filter,
      "-an",
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level",
      "4.0",
      "-pix_fmt",
      "yuv420p",
      "-video_track_timescale",
      "15360",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { timeoutMs: 180_000 },
  );
}

export function cumulativeOffsetsMs(durationsSeconds: number[]): number[] {
  const offsets: number[] = [];
  let elapsed = 0;
  for (const duration of durationsSeconds) {
    offsets.push(Math.round(elapsed * 1000));
    elapsed += duration;
  }
  return offsets;
}

async function overlayAudio(dir: string, concatOut: string, tracks: MixTrack[]): Promise<string> {
  const inputs = ["-y", "-i", concatOut];
  const filters = ["[0:v]copy[v]"];
  const mixLabels: string[] = [];
  let audioIndex = 0;

  for (const track of tracks) {
    const meta = await loadMeta(track.media_id);
    if (!meta || !meta.hasAudio) continue;
    inputs.push("-i", meta.path);
    const clipLen = track.max_duration_s
      ? Math.min(meta.duration, track.max_duration_s)
      : meta.duration;
    const fadeSec = track.fade_ms / 1000;
    const startSec = track.offset_ms / 1000;
    const fadeStart = Math.max(startSec, startSec + clipLen - fadeSec);
    const inputIndex = audioIndex + 1;
    filters.push(
      `[${inputIndex}:a]atrim=0:${clipLen.toFixed(3)},` +
        `adelay=${Math.round(track.offset_ms)}|${Math.round(track.offset_ms)},` +
        `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeSec.toFixed(3)},volume=${track.volume.toFixed(2)}[a${audioIndex}]`,
    );
    mixLabels.push(`[a${audioIndex}]`);
    audioIndex += 1;
  }

  if (mixLabels.length === 0) return concatOut;
  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[outa]`,
  );
  const out = join(dir, "final.mp4");
  await run(
    "ffmpeg",
    [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-preset",
      "fast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      out,
    ],
    { timeoutMs: 300_000 },
  );
  return out;
}

function resolveTracks(
  segments: TimelineSegment[],
  audio: TimelineAudioTrack[] | undefined,
): MixTrack[] {
  const offsets = cumulativeOffsetsMs(segments.map((segment) => segment.duration));
  const tracks: MixTrack[] = (audio ?? []).map((track) => ({
    media_id: track.media_id,
    offset_ms: track.offset_ms,
    volume: track.volume ?? DEFAULT_OVERLAY_VOLUME,
    fade_ms: track.fade_ms ?? DEFAULT_FADE_MS,
  }));

  for (const [index, segment] of segments.entries()) {
    for (const ref of segment.media ?? []) {
      if (ref.muted || ref.volume === 0) continue;
      tracks.push({
        media_id: ref.media_id,
        offset_ms: offsets[index] ?? 0,
        volume: ref.volume ?? DEFAULT_CLIP_VOLUME,
        fade_ms: DEFAULT_FADE_MS,
        max_duration_s: segment.duration,
      });
    }
  }
  return tracks;
}

type SegmentResult =
  | { index: number; segment: TimelineSegment; path: string }
  | { index: number; warning: string };

export async function assembleTimeline(params: TimelineParams): Promise<RenderOutput> {
  const jobId = randomUUID().slice(0, 8);
  const dir = join(config.workDir, `timeline-${jobId}`);
  const segDir = join(dir, "segments");
  await mkdir(segDir, { recursive: true });

  try {
    // Segments are independent and rendered concurrently (bounded). A segment that fails to
    // render is dropped — not fatal — so the rest of the video still ships; the failure is
    // reported back as a warning rather than killing the whole job.
    const limiter = new Limiter(config.renderSegmentConcurrency);
    const results = await Promise.all(
      params.segments.map((segment, index) =>
        limiter.run(async (): Promise<SegmentResult> => {
          const segPath = join(segDir, `seg_${String(index).padStart(3, "0")}.mp4`);
          try {
            if (segment.clipOverlay) {
              await renderClipOverlay(
                segment.clipOverlay,
                segment.duration,
                params.fps,
                params.resolution,
                segPath,
                segDir,
                index,
              );
            } else if (segment.html) {
              const { buffer } = await renderComposition({
                htmlBase64: segment.html,
                fps: params.fps,
                resolution: params.resolution,
                ...(segment.media ? { media: segment.media } : {}),
              });
              await writeFile(segPath, buffer);
            } else {
              throw new Error("segment has neither html nor clipOverlay");
            }
            return { index, segment, path: segPath };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { index, warning: `segment ${index} skipped: ${detail}` };
          }
        }),
      ),
    );

    const ok = results
      .filter((r): r is { index: number; segment: TimelineSegment; path: string } => "path" in r)
      .sort((a, b) => a.index - b.index);
    const warnings = results
      .filter((r): r is { index: number; warning: string } => "warning" in r)
      .map((r) => r.warning);
    if (ok.length === 0) {
      throw new Error(
        `all ${params.segments.length} segments failed to render: ${warnings.join("; ")}`,
      );
    }

    const concatList = join(dir, "concat.txt");
    await writeFile(concatList, `${ok.map((r) => `file '${r.path}'`).join("\n")}\n`);
    const concatOut = join(dir, "concat.mp4");
    await run(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-an", "-c:v", "copy", concatOut],
      { timeoutMs: 120_000 },
    );

    const okSegments = ok.map((r) => r.segment);
    const tracks = resolveTracks(okSegments, params.audio);
    const finalOut = tracks.length ? await overlayAudio(dir, concatOut, tracks) : concatOut;
    const buffer = await readFile(finalOut);
    return { buffer, filename: `timeline-${jobId}.mp4`, warnings };
  } finally {
    // Best-effort cleanup of the scratch tree. Parallel renders churn many inodes, so a
    // recursive rmdir can transiently hit ENOTEMPTY — retry, and never let a teardown
    // hiccup discard an already-rendered video.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (error: NodeJS.ErrnoException) => {
        console.error(`[timeline] cleanup of ${dir} failed: ${error.code ?? error.message}`);
      },
    );
  }
}

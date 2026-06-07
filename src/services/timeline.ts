import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";
import type { Resolution } from "../types.js";
import { loadMeta } from "./media.js";
import { type RenderOutput, renderComposition } from "./renderer.js";

export interface SegmentMedia {
  media_id: string;
  volume?: number;
  muted?: boolean;
}

export interface TimelineSegment {
  html: string;
  duration: number;
  media?: SegmentMedia[];
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

function resolveTracks(params: TimelineParams): MixTrack[] {
  const offsets = cumulativeOffsetsMs(params.segments.map((segment) => segment.duration));
  const tracks: MixTrack[] = (params.audio ?? []).map((track) => ({
    media_id: track.media_id,
    offset_ms: track.offset_ms,
    volume: track.volume ?? DEFAULT_OVERLAY_VOLUME,
    fade_ms: track.fade_ms ?? DEFAULT_FADE_MS,
  }));

  for (const [index, segment] of params.segments.entries()) {
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

export async function assembleTimeline(params: TimelineParams): Promise<RenderOutput> {
  const jobId = randomUUID().slice(0, 8);
  const dir = join(config.workDir, `timeline-${jobId}`);
  const segDir = join(dir, "segments");
  await mkdir(segDir, { recursive: true });

  try {
    const segFiles: string[] = [];
    for (const [index, segment] of params.segments.entries()) {
      const { buffer } = await renderComposition({
        htmlBase64: segment.html,
        fps: params.fps,
        resolution: params.resolution,
        ...(segment.media ? { media: segment.media } : {}),
      });
      const segPath = join(segDir, `seg_${String(index).padStart(3, "0")}.mp4`);
      await writeFile(segPath, buffer);
      segFiles.push(segPath);
    }

    const concatList = join(dir, "concat.txt");
    await writeFile(concatList, `${segFiles.map((file) => `file '${file}'`).join("\n")}\n`);
    const concatOut = join(dir, "concat.mp4");
    await run(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-an", "-c:v", "copy", concatOut],
      { timeoutMs: 120_000 },
    );

    const tracks = resolveTracks(params);
    const finalOut = tracks.length ? await overlayAudio(dir, concatOut, tracks) : concatOut;
    const buffer = await readFile(finalOut);
    return { buffer, filename: `timeline-${jobId}.mp4` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

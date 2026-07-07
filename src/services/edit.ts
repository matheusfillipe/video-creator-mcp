import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";
import {
  AAC_ARGS,
  X264_ARGS,
  buildAudioMixFilters,
  buildTimedDrawtext,
  coverFilter,
  validateColor,
} from "../lib/ffmpeg.js";
import type { Resolution } from "../types.js";
import { loadMeta } from "./media.js";
import { dimsFor } from "./timeline.js";

const MAX_SEGMENTS_PER_GROUP = 24;

export type EditLayout = "single" | "vstack" | "hstack" | "pip" | "grid";

export interface EditSegment {
  media_id: string;
  start?: number;
  end?: number;
  speed?: number;
  volume?: number;
}

export interface EditText {
  content: string;
  start: number;
  duration: number;
  position?: "top" | "center" | "bottom";
  size?: number;
  color?: string;
  box?: boolean;
}

export interface EditAudio {
  media_id: string;
  offset?: number;
  volume?: number;
  mode?: "replace" | "mix" | "duck";
}

export interface EditSpec {
  layout?: EditLayout;
  groups: EditSegment[][];
  text?: EditText[];
  audio?: EditAudio[];
  resolution?: Resolution;
  fps?: number;
  fade?: number;
}

export interface EditOutput {
  buffer: Buffer;
  filename: string;
  duration: number;
  warnings: string[];
}

const GROUPS_PER_LAYOUT: Record<EditLayout, number> = {
  single: 1,
  vstack: 2,
  hstack: 2,
  pip: 2,
  grid: 4,
};

// Cell size each group is normalized to before the layout combine.
export function cellDims(
  layout: EditLayout,
  canvas: { width: number; height: number },
): Array<{ width: number; height: number }> {
  const { width, height } = canvas;
  const even = (n: number) => Math.floor(n / 2) * 2;
  switch (layout) {
    case "single":
      return [{ width, height }];
    case "vstack":
      return [
        { width, height: even(height / 2) },
        { width, height: even(height / 2) },
      ];
    case "hstack":
      return [
        { width: even(width / 2), height },
        { width: even(width / 2), height },
      ];
    case "pip":
      return [
        { width, height },
        { width: even(width / 3), height: even(height / 3) },
      ];
    case "grid":
      return Array(4).fill({ width: even(width / 2), height: even(height / 2) });
  }
}

export function validateSpec(spec: EditSpec): string[] {
  const errors: string[] = [];
  const layout = spec.layout ?? "single";
  const expected = GROUPS_PER_LAYOUT[layout];
  if (!spec.groups || spec.groups.length === 0) {
    errors.push("groups must contain at least one group of segments");
    return errors;
  }
  if (spec.groups.length !== expected) {
    errors.push(`layout "${layout}" needs exactly ${expected} group(s), got ${spec.groups.length}`);
  }
  for (const [gi, group] of spec.groups.entries()) {
    if (group.length === 0) errors.push(`group ${gi} is empty`);
    if (group.length > MAX_SEGMENTS_PER_GROUP)
      errors.push(`group ${gi} has ${group.length} segments (max ${MAX_SEGMENTS_PER_GROUP})`);
    for (const [si, seg] of group.entries()) {
      if (seg.start !== undefined && seg.end !== undefined && seg.end <= seg.start)
        errors.push(`group ${gi} segment ${si}: end (${seg.end}) must be > start (${seg.start})`);
      if (seg.speed !== undefined && (seg.speed < 0.25 || seg.speed > 4))
        errors.push(`group ${gi} segment ${si}: speed must be within 0.25-4`);
    }
  }
  if (spec.fade !== undefined && (spec.fade < 0 || spec.fade > 3))
    errors.push("fade must be within 0-3 seconds");
  for (const [ti, t] of (spec.text ?? []).entries()) {
    if (t.color && !validateColor(t.color))
      errors.push(`text ${ti}: color "${t.color}" must be a hex value or a basic color name`);
  }
  return errors;
}

// atempo only accepts 0.5-2.0 per instance; chain instances to cover 0.25-4.
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(",");
}

export function segmentDuration(seg: EditSegment, sourceDuration: number): number {
  const start = seg.start ?? 0;
  const end = seg.end ?? sourceDuration;
  const raw = Math.max(0, Math.min(end, sourceDuration) - start);
  return raw / (seg.speed ?? 1);
}

async function normalizeSegment(
  seg: EditSegment,
  cell: { width: number; height: number },
  fps: number,
  outPath: string,
): Promise<number> {
  const meta = await loadMeta(seg.media_id);
  if (!meta) {
    throw new Error(
      `Media ${seg.media_id} not found in cache — download it first with video_download_media.`,
    );
  }
  const speed = seg.speed ?? 1;
  const volume = seg.volume ?? 1;
  const useSourceAudio = meta.hasAudio && volume > 0;

  const args = ["-y"];
  if (seg.start) args.push("-ss", String(seg.start));
  if (seg.end !== undefined) args.push("-to", String(seg.end));
  args.push("-i", meta.path);
  if (!useSourceAudio) {
    // Synthesize silence so every intermediate has an audio stream — concat and the
    // layout mix then never need to special-case missing audio.
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }

  const vf = [coverFilter(cell.width, cell.height)];
  if (speed !== 1) vf.push(`setpts=PTS/${speed}`);
  vf.push(`fps=${fps}`, "format=yuv420p");
  args.push("-vf", vf.join(","));

  if (useSourceAudio) {
    const af: string[] = [];
    if (speed !== 1) af.push(atempoChain(speed));
    if (volume !== 1) af.push(`volume=${volume}`);
    if (af.length) args.push("-af", af.join(","));
  } else {
    args.push("-map", "0:v", "-map", "1:a", "-shortest");
  }
  args.push(
    ...AAC_ARGS,
    "-ar",
    "48000",
    "-ac",
    "2",
    ...X264_ARGS,
    "-video_track_timescale",
    "15360",
    "-movflags",
    "+faststart",
    outPath,
  );
  await run("ffmpeg", args, { timeoutMs: 300_000 });
  return segmentDuration(seg, meta.duration);
}

async function concatGroup(
  dir: string,
  groupIndex: number,
  parts: string[],
  fade: number,
  fps: number,
  durations: number[],
): Promise<string> {
  const out = join(dir, `group${groupIndex}.mp4`);
  if (parts.length === 1) return parts[0] as string;

  if (fade > 0) {
    // xfade consumes `fade` seconds of overlap per boundary, so offsets accumulate
    // (duration - fade) per part. acrossfade pairs the audio the same way.
    const inputs = parts.flatMap((p) => ["-i", p]);
    const filters: string[] = [];
    let vPrev = "0:v";
    let aPrev = "0:a";
    let offset = (durations[0] as number) - fade;
    for (let i = 1; i < parts.length; i++) {
      const vOut = i === parts.length - 1 ? "vout" : `vx${i}`;
      const aOut = i === parts.length - 1 ? "aout" : `ax${i}`;
      filters.push(
        `[${vPrev}][${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[${vOut}]`,
      );
      filters.push(`[${aPrev}][${i}:a]acrossfade=d=${fade}[${aOut}]`);
      vPrev = vOut;
      aPrev = aOut;
      offset += (durations[i] as number) - fade;
    }
    await run(
      "ffmpeg",
      [
        "-y",
        ...inputs,
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-r",
        String(fps),
        ...X264_ARGS,
        ...AAC_ARGS,
        "-movflags",
        "+faststart",
        out,
      ],
      { timeoutMs: 600_000 },
    );
    return out;
  }

  const listFile = join(dir, `group${groupIndex}.txt`);
  await writeFile(listFile, `${parts.map((p) => `file '${p}'`).join("\n")}\n`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out], {
    timeoutMs: 120_000,
  });
  return out;
}

function layoutFilter(layout: EditLayout, groupCount: number): string {
  switch (layout) {
    case "vstack":
      return "[0:v][1:v]vstack=inputs=2[vout]";
    case "hstack":
      return "[0:v][1:v]hstack=inputs=2[vout]";
    case "pip":
      return "[0:v][1:v]overlay=W-w-40:H-h-40[vout]";
    case "grid":
      return "[0:v][1:v]hstack=inputs=2[top];[2:v][3:v]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[vout]";
    default:
      throw new Error(`layout ${layout} with ${groupCount} groups needs no combine`);
  }
}

export function textFilters(
  overlays: EditText[],
  textFiles: string[],
  canvasHeight: number,
): string[] {
  return overlays.map((t, i) =>
    buildTimedDrawtext({
      textFile: textFiles[i] as string,
      start: t.start,
      end: t.start + t.duration,
      position: t.position ?? "bottom",
      fontSize: t.size ?? Math.max(28, Math.round(canvasHeight / 18)),
      color: t.color ?? "white",
      box: t.box !== false,
    }),
  );
}

export async function renderEdit(spec: EditSpec): Promise<EditOutput> {
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(`Invalid edit spec: ${errors.join("; ")}`);

  const layout = spec.layout ?? "single";
  const resolution = spec.resolution ?? "1080p";
  const fps = spec.fps ?? 30;
  const fade = spec.fade ?? 0;
  const canvas = dimsFor(resolution);
  const cells = cellDims(layout, canvas);
  const warnings: string[] = [];

  const jobId = randomUUID().slice(0, 8);
  const dir = join(config.workDir, `edit-${jobId}`);
  await mkdir(dir, { recursive: true });

  try {
    const groupFiles: string[] = [];
    const groupDurations: number[] = [];
    for (const [gi, group] of spec.groups.entries()) {
      const cell = cells[gi] as { width: number; height: number };
      const parts: string[] = [];
      const durations: number[] = [];
      for (const [si, seg] of group.entries()) {
        const partPath = join(dir, `g${gi}s${si}.mp4`);
        durations.push(await normalizeSegment(seg, cell, fps, partPath));
        parts.push(partPath);
      }
      groupFiles.push(await concatGroup(dir, gi, parts, fade, fps, durations));
      const overlap = fade > 0 ? fade * (group.length - 1) : 0;
      groupDurations.push(durations.reduce((a, b) => a + b, 0) - overlap);
    }

    // Stacked groups almost never sum to identical lengths; cutting to the shortest is
    // what an editor would do, and -shortest below enforces it at combine time.
    const totalDuration = Math.min(...groupDurations);
    if (groupDurations.length > 1) {
      const spread = Math.max(...groupDurations) - totalDuration;
      if (spread > 1) {
        warnings.push(
          `groups differ in length by ${spread.toFixed(1)}s — output is cut to the shortest group (${totalDuration.toFixed(1)}s)`,
        );
      }
    }

    let combined: string;
    if (layout === "single") {
      combined = groupFiles[0] as string;
    } else {
      combined = join(dir, "combined.mp4");
      const inputs = groupFiles.flatMap((f) => ["-i", f]);
      await run(
        "ffmpeg",
        [
          "-y",
          ...inputs,
          "-filter_complex",
          layoutFilter(layout, groupFiles.length),
          "-map",
          "[vout]",
          "-map",
          "0:a",
          "-shortest",
          ...X264_ARGS,
          ...AAC_ARGS,
          "-movflags",
          "+faststart",
          combined,
        ],
        { timeoutMs: 600_000 },
      );
    }

    let withText = combined;
    if (spec.text && spec.text.length > 0) {
      const textFiles: string[] = [];
      for (const [i, t] of spec.text.entries()) {
        const f = join(dir, `text${i}.txt`);
        await writeFile(f, t.content);
        textFiles.push(f);
      }
      withText = join(dir, "texted.mp4");
      await run(
        "ffmpeg",
        [
          "-y",
          "-i",
          combined,
          "-vf",
          textFilters(spec.text, textFiles, canvas.height).join(","),
          "-c:a",
          "copy",
          ...X264_ARGS,
          "-movflags",
          "+faststart",
          withText,
        ],
        { timeoutMs: 600_000 },
      );
    }

    let final = withText;
    if (spec.audio && spec.audio.length > 0) {
      final = join(dir, "final.mp4");
      const inputs = ["-i", withText];
      const tracks = [];
      for (const [i, track] of spec.audio.entries()) {
        const meta = await loadMeta(track.media_id);
        if (!meta) {
          throw new Error(
            `Audio media ${track.media_id} not found in cache — download it first with video_download_media.`,
          );
        }
        if (!meta.hasAudio) {
          throw new Error(`Media ${track.media_id} has no audio stream`);
        }
        inputs.push("-i", meta.path);
        tracks.push({
          inputIndex: i + 1,
          delayMs: Math.round((track.offset ?? 0) * 1000),
          volume: track.volume ?? 0.8,
          mode: track.mode ?? "mix",
        });
      }
      const { filters, mapLabel } = buildAudioMixFilters(tracks, true, totalDuration);
      await run(
        "ffmpeg",
        [
          "-y",
          ...inputs,
          "-filter_complex",
          filters.join(";"),
          "-map",
          "0:v",
          "-map",
          mapLabel,
          ...AAC_ARGS,
          "-c:v",
          "copy",
          "-movflags",
          "+faststart",
          final,
        ],
        { timeoutMs: 300_000 },
      );
    }

    const buffer = await readFile(final);
    return { buffer, filename: `edit-${jobId}.mp4`, duration: totalDuration, warnings };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

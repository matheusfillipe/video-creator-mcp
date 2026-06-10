import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.js";
import { probeInfo } from "./media.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "python", "analyze_static.py");

export interface StaticGridCell {
  row: number;
  col: number;
  staticness: number;
  clutter: number;
  avoid: number;
}

export interface AvoidRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  where: string;
  staticness: number;
}

export interface StaticAnalysis {
  width: number;
  height: number;
  frames_sampled: number;
  grid_size: number;
  static_pct: number;
  avoid_regions: AvoidRegion[];
  grid: StaticGridCell[];
}

// Profiles a downloaded video (opencv + numpy, CPU) for static, structured regions —
// baked logos/watermarks/text bars an overlay should avoid. See python/analyze_static.py.
export async function analyzeStatic(
  mediaPath: string,
  fps: number,
  grid: number,
): Promise<StaticAnalysis> {
  const { stdout } = await run("python3", [SCRIPT, mediaPath, String(fps), String(grid)], {
    timeoutMs: 300_000,
  });
  return JSON.parse(stdout) as StaticAnalysis;
}

export interface SilenceRegion {
  start: number;
  end: number;
  duration: number;
}
export interface ActiveSpan {
  start: number;
  end: number;
}
export interface AudioAnalysis {
  duration: number;
  has_audio: boolean;
  mean_volume_db: number | null;
  max_volume_db: number | null;
  integrated_lufs: number | null;
  loudness_range: number | null;
  silence_threshold_db: number;
  min_silence: number;
  silence_pct: number;
  silences: SilenceRegion[];
  // The complement of `silences` over [0, duration]: where there is actually sound
  // (speech/music) — the spans to caption over, or to keep when trimming dead air.
  active_spans: ActiveSpan[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Invert silence regions into the spans that actually carry sound, clamped to [0, duration].
function activeSpans(silences: SilenceRegion[], duration: number): ActiveSpan[] {
  const spans: ActiveSpan[] = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor) spans.push({ start: round2(cursor), end: round2(silence.start) });
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < duration) spans.push({ start: round2(cursor), end: round2(duration) });
  return spans;
}

function parseSilences(stderr: string, duration: number): SilenceRegion[] {
  const silences: SilenceRegion[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start?.[1] !== undefined) {
      pendingStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/.exec(
      line,
    );
    if (end?.[1] !== undefined && end[2] !== undefined && pendingStart !== null) {
      silences.push({
        start: round2(pendingStart),
        end: round2(Number(end[1])),
        duration: round2(Number(end[2])),
      });
      pendingStart = null;
    }
  }
  // A file that ends mid-silence reports the start but never the end — close it at duration.
  if (pendingStart !== null && duration > pendingStart) {
    silences.push({
      start: round2(pendingStart),
      end: round2(duration),
      duration: round2(duration - pendingStart),
    });
  }
  return silences;
}

// Profile a media file's audio track with one ffmpeg pass: silence regions (silencedetect),
// mean/max volume (volumedetect), and integrated loudness + range (ebur128). The audio analog
// of analyzeStatic — used to learn a clip's length, time captions/cuts to where there is
// speech, or trim dead air. All measurements are read from ffmpeg's stderr.
export async function analyzeAudio(
  mediaPath: string,
  silenceDb: number,
  minSilence: number,
): Promise<AudioAnalysis> {
  const info = await probeInfo(mediaPath);
  const result: AudioAnalysis = {
    duration: round2(info.duration),
    has_audio: info.hasAudio,
    mean_volume_db: null,
    max_volume_db: null,
    integrated_lufs: null,
    loudness_range: null,
    silence_threshold_db: silenceDb,
    min_silence: minSilence,
    silence_pct: 0,
    silences: [],
    active_spans: info.hasAudio ? [{ start: 0, end: round2(info.duration) }] : [],
  };
  if (!info.hasAudio) return result;

  const filter = `silencedetect=noise=${silenceDb}dB:d=${minSilence},ebur128,volumedetect`;
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", mediaPath, "-af", filter, "-f", "null", "-"],
    { timeoutMs: 180_000 },
  );

  const num = (re: RegExp): number | null => {
    const match = re.exec(stderr);
    return match?.[1] !== undefined ? Number(match[1]) : null;
  };
  result.mean_volume_db = num(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  result.max_volume_db = num(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  result.integrated_lufs = num(/^\s+I:\s*(-?\d+(?:\.\d+)?) LUFS/m);
  result.loudness_range = num(/^\s+LRA:\s*(-?\d+(?:\.\d+)?) LU/m);

  result.silences = parseSilences(stderr, info.duration);
  result.active_spans = activeSpans(result.silences, info.duration);
  const silent = result.silences.reduce((sum, region) => sum + region.duration, 0);
  result.silence_pct = info.duration > 0 ? round2((silent / info.duration) * 100) : 0;
  return result;
}

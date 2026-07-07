export const FONT_FILE = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";

export const X264_ARGS = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "21",
  "-pix_fmt",
  "yuv420p",
];

export const AAC_ARGS = ["-c:a", "aac", "-b:a", "192k"];

const CSS_COLOR_NAMES = new Set([
  "white",
  "black",
  "red",
  "green",
  "blue",
  "yellow",
  "cyan",
  "magenta",
  "gray",
  "grey",
  "orange",
  "purple",
  "pink",
  "brown",
  "gold",
  "silver",
  "navy",
  "teal",
  "lime",
  "maroon",
]);

// The color reaches a drawtext filter arg and, for manim, a generated Python string —
// both are injection surfaces, so restrict to hex or a known name rather than escaping.
export function validateColor(color: string): boolean {
  if (/^#?[0-9a-fA-F]{6}$/.test(color) || /^#?[0-9a-fA-F]{8}$/.test(color)) return true;
  return CSS_COLOR_NAMES.has(color.toLowerCase());
}

export function coverFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

export type TextPosition = "top" | "center" | "bottom";

export interface TimedDrawtext {
  textFile: string;
  start: number;
  end: number;
  position: TextPosition;
  fontSize: number;
  color: string;
  box: boolean;
}

function yExpression(position: TextPosition, margin: number): string {
  if (position === "top") return String(margin);
  if (position === "center") return "(h-text_h)/2";
  return `h-text_h-${margin}`;
}

export function buildTimedDrawtext(opts: TimedDrawtext): string {
  const margin = Math.round(opts.fontSize * 0.9);
  const parts = [
    `fontfile=${FONT_FILE}`,
    `textfile=${opts.textFile}`,
    "expansion=none",
    `enable='between(t,${opts.start},${opts.end})'`,
    "x=(w-text_w)/2",
    `y=${yExpression(opts.position, margin)}`,
    `fontsize=${opts.fontSize}`,
    `fontcolor=${opts.color}`,
  ];
  if (opts.box) {
    parts.push("box=1", "boxcolor=black@0.5", `boxborderw=${Math.round(opts.fontSize * 0.35)}`);
  }
  return `drawtext=${parts.join(":")}`;
}

export interface AudioMixTrack {
  inputIndex: number;
  delayMs: number;
  volume: number;
  mode: "replace" | "mix" | "duck";
}

export interface AudioMixGraph {
  filters: string[];
  mapLabel: string;
}

// Builds the amix filtergraph laying tracks over a base audio stream (label "0:a").
// replace drops the base; duck lowers it to 25% under the track; mix layers on top.
// Every track is padded then trimmed to targetDurationSec so a short track can't
// shorten the mix and a long one can't overrun the video. Returns the graph plus
// the [label] to -map.
export function buildAudioMixFilters(
  tracks: AudioMixTrack[],
  baseHasAudio: boolean,
  targetDurationSec: number,
): AudioMixGraph {
  const filters: string[] = [];
  const trackLabels = tracks.map((track, i) => {
    filters.push(
      `[${track.inputIndex}:a]adelay=${track.delayMs}|${track.delayMs},volume=${track.volume},apad,atrim=0:${targetDurationSec.toFixed(3)}[t${i}]`,
    );
    return `[t${i}]`;
  });

  const dropBase = !baseHasAudio || tracks.some((t) => t.mode === "replace");
  const duckBase = !dropBase && tracks.some((t) => t.mode === "duck");
  const baseLabels: string[] = [];
  if (!dropBase) {
    if (duckBase) {
      filters.push("[0:a]volume=0.25[ducked]");
      baseLabels.push("[ducked]");
    } else {
      baseLabels.push("[0:a]");
    }
  }

  const inputs = [...baseLabels, ...trackLabels];
  if (inputs.length === 1) {
    filters.push(`${inputs[0]}anull[aout]`);
  } else {
    filters.push(
      `${inputs.join("")}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0[aout]`,
    );
  }
  return { filters, mapLabel: "[aout]" };
}

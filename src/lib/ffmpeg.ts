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

// A slow Ken-Burns push-in for a still image: cover-fit to the frame, upscale so zoompan's
// integer per-frame crop stays sub-pixel (otherwise the zoom visibly jitters), then zoom linearly
// to ~1.12 over the clip. Without this a still sits frozen at its cover-fit and reads as a static
// "already zoomed" shot. Driven from a SINGLE input frame (the caller must NOT -loop it): zoompan
// emits `frames` outputs from the one input and `zoom` accumulates across them, which also sets the
// clip length (frames / fps). Under -loop the zoom resets every input frame and never progresses.
// The comma inside min() is escaped so it survives the filter chain's own comma splitting.
export function kenBurnsFilter(width: number, height: number, fps: number, durSec: number): string {
  const frames = Math.max(1, Math.round(durSec * fps));
  const maxZoom = 1.12;
  const rate = ((maxZoom - 1) / frames).toFixed(6);
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `scale=${width * 2}:${height * 2}`,
    `zoompan=z='min(zoom+${rate}\\,${maxZoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
    "setsar=1",
  ].join(",");
}

// Fits the whole source inside the cell, letterboxed with black bars, no crop. For split-screen
// cells whose aspect differs sharply from the source (a landscape clip in a half-width column),
// cover would zoom into a tiny center patch; contain keeps the full subject visible.
export function containFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

export type TextPosition = "top" | "center" | "bottom";

export interface TimedDrawtext {
  textFile: string;
  start: number;
  end: number;
  position: TextPosition;
  fontSize: number;
  color: string;
  background: "none" | "box" | "blur";
  shadow: boolean;
  outline: boolean;
  margin?: number;
}

function yExpression(position: TextPosition, margin: number): string {
  if (position === "top") return String(margin);
  if (position === "center") return "(h-text_h)/2";
  return `h-text_h-${margin}`;
}

// Greedy word-wrap so a caption never runs past the frame edge (long lines cropping is the
// most common subtitle defect). ffmpeg drawtext renders the embedded newlines as stacked lines.
export function wrapText(text: string, maxCharsPerLine: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  for (const word of words) {
    let rest = word;
    while (rest.length > maxCharsPerLine) {
      flush();
      lines.push(rest.slice(0, maxCharsPerLine));
      rest = rest.slice(maxCharsPerLine);
    }
    if (!current) current = rest;
    else if (`${current} ${rest}`.length <= maxCharsPerLine) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  flush();
  return lines.join("\n");
}

// Chars that fit on one line for LiberationSans-Bold at the given font size, using ~0.52em average
// glyph width and keeping 90% of the width as a safe margin.
export function charsPerLine(width: number, fontSize: number): number {
  return Math.max(12, Math.floor((width * 0.9) / (fontSize * 0.52)));
}

export function buildTimedDrawtext(opts: TimedDrawtext): string {
  const margin = opts.margin ?? Math.round(opts.fontSize * 0.9);
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
  if (opts.outline) {
    const width = Math.max(2, Math.round(opts.fontSize / 12));
    parts.push(`borderw=${width}`, "bordercolor=black@0.85");
  }
  if (opts.shadow) {
    const offset = Math.max(1, Math.round(opts.fontSize / 22));
    parts.push("shadowcolor=black@0.55", `shadowx=${offset}`, `shadowy=${offset}`);
  }
  // "blur" is drawn as a separate video layer under the text (narratedScenes), so drawtext
  // itself only ever adds the solid box for the "box" background.
  if (opts.background === "box") {
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

import type { AlignedWord } from "./align.js";

export interface Cue {
  text: string;
  start: number;
  end: number;
  words: AlignedWord[];
  // Per-cue style override (a composition can style each segment's captions differently);
  // cues without one render with the track-level style.
  style?: CueStyle;
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_END = /[,;:]["')\]]?$/;

// Group aligned words into readable phrase cues (whole clauses/sentences, NOT word-by-word):
// break at a sentence end, when a length cap is hit, or at a clause end once the line is
// past ~60% full. Each cue spans its first word's start to its last word's end, so it is on
// screen exactly while those words are spoken.
export function groupIntoCues(
  words: AlignedWord[],
  opts: { maxChars: number; maxWords: number },
): Cue[] {
  const cues: Cue[] = [];
  let bucket: AlignedWord[] = [];
  let chars = 0;
  const flush = () => {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) return;
    cues.push({
      text: bucket.map((w) => w.word).join(" "),
      start: first.start,
      end: last.end,
      words: bucket,
    });
    bucket = [];
    chars = 0;
  };
  for (const word of words) {
    bucket.push(word);
    chars += word.word.length + 1;
    const full = bucket.length >= opts.maxWords || chars >= opts.maxChars;
    if (
      SENTENCE_END.test(word.word) ||
      full ||
      (CLAUSE_END.test(word.word) && chars >= opts.maxChars * 0.6)
    ) {
      flush();
    }
  }
  flush();
  return cues;
}

// Shift every cue (and its words) by delta seconds — used to place a per-line cue list onto the
// composed video's global timeline.
export function offsetCues(cues: Cue[], delta: number): Cue[] {
  return cues.map((cue) => ({
    ...cue,
    start: cue.start + delta,
    end: cue.end + delta,
    words: cue.words.map((w) => ({ word: w.word, start: w.start + delta, end: w.end + delta })),
  }));
}

export type CaptionPosition = "bottom" | "center" | "top";

export interface CaptionStyle {
  color: string; // highlight/primary color: hex #RRGGBB or a basic name
  position: CaptionPosition;
  fontScale: number; // multiplier on the resolution-derived base size
  box: boolean;
}

// A cue-level style also picks the render mode, so one video can mix static and karaoke segments.
export interface CueStyle extends CaptionStyle {
  mode: "block" | "karaoke";
}

export type CaptionSize = "small" | "medium" | "large";

export function fontScaleFor(size: CaptionSize): number {
  return size === "small" ? 0.8 : size === "large" ? 1.3 : 1;
}

const NAME_TO_HEX: Record<string, string> = {
  white: "FFFFFF",
  black: "000000",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  orange: "FFA500",
  pink: "FFC0CB",
  gold: "FFD700",
  lime: "00FF00",
};

// ASS colours are &HAABBGGRR (alpha, then blue/green/red). A CSS #RRGGBB or basic name in, an
// opaque ASS colour out.
function toAssColor(color: string): string {
  const named = NAME_TO_HEX[color.toLowerCase()];
  const hex = named ?? color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "&H00FFFFFF";
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function assEscape(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

// Build an ASS subtitle document for the cue track, rendered by ffmpeg's libass `subtitles` filter.
// `karaoke` sweeps each word from the secondary (upcoming) colour to the primary as it is spoken,
// using the per-word timings; otherwise each cue is a static styled phrase. libass owns wrapping
// and the safe-area margins, so text never leaves the frame.
export function buildAss(
  cues: Cue[],
  width: number,
  height: number,
  style: CaptionStyle,
  karaoke: boolean,
): string {
  const marginV = Math.round(height * 0.07);
  const marginLR = Math.round(width * 0.06);
  const styleLine = (name: string, s: CaptionStyle): string => {
    const fontSize = Math.max(18, Math.round((height / 22) * s.fontScale));
    const alignment = s.position === "top" ? 8 : s.position === "center" ? 5 : 2;
    const primary = toAssColor(s.color);
    // Karaoke draws each word in the secondary colour, then fills it to the primary as it is
    // spoken. A dim grey secondary keeps the sweep visible even when the primary (highlight) is
    // the default white, so word-highlight never looks like a static caption.
    const secondary = karaoke ? "&H00B4B4B4" : primary;
    const borderStyle = s.box ? 3 : 1;
    const outline = s.box ? 0 : Math.max(2, Math.round(fontSize / 14));
    return `Style: ${name},Liberation Sans,${fontSize},${primary},${secondary},&H00000000,&H96000000,1,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${marginLR},${marginLR},${marginV},1`;
  };
  // One ASS style per distinct cue override; cues without one use the track style.
  const overrideNames = new Map<string, string>();
  const styleLines: string[] = [styleLine("Cap", style)];
  const nameFor = (s?: CueStyle): string => {
    if (!s) return "Cap";
    const key = `${s.color}|${s.position}|${s.fontScale}|${s.box}`;
    let name = overrideNames.get(key);
    if (!name) {
      name = `Cap${overrideNames.size + 1}`;
      overrideNames.set(key, name);
      styleLines.push(styleLine(name, s));
    }
    return name;
  };
  const events: string[] = [];
  for (const cue of cues) {
    let text: string;
    if (karaoke) {
      const parts: string[] = [];
      for (const [i, word] of cue.words.entries()) {
        const next = cue.words[i + 1];
        const spanSec = (next ? next.start : word.end) - word.start;
        const durCs = Math.max(1, Math.round(spanSec * 100));
        parts.push(`{\\k${durCs}}${assEscape(word.word)} `);
      }
      text = parts.join("").trimEnd();
    } else {
      text = assEscape(cue.text);
    }
    events.push(
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},${nameFor(cue.style)},,0,0,0,,${text}`,
    );
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
  ].join("\n");
}

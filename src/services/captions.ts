import type { AlignedWord } from "./align.js";

export interface Cue {
  text: string;
  start: number;
  end: number;
  words: AlignedWord[];
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
    text: cue.text,
    start: cue.start + delta,
    end: cue.end + delta,
    words: cue.words.map((w) => ({ word: w.word, start: w.start + delta, end: w.end + delta })),
  }));
}

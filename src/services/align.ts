import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModelForCTC, AutoProcessor, AutoTokenizer, env } from "@huggingface/transformers";
import { run } from "../lib/exec.js";

// The image bakes the model into HF_CACHE_DIR at build time; point transformers.js at it so a
// cold pod never fetches from the network on first use.
if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;

// wav2vec2-base: 320-sample stride at 16 kHz -> one emission frame per 20 ms.
const MODEL_ID = process.env.ALIGN_MODEL ?? "Xenova/wav2vec2-base-960h";
const SAMPLE_RATE = 16000;
const FRAME_SEC = 0.02;

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

interface Engine {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForCTC.from_pretrained>>;
  blankId: number;
  delimId: number;
  charToId: Map<string, number>;
}

let enginePromise: Promise<Engine> | null = null;

// Load the CTC model + tokenizer once and derive the id maps. The tokenizer's get_vocab only
// exposes the letters, so ids are recovered by decoding each one: a single-char decode is a
// letter/apostrophe, and the sole non-special id that decodes to "" is the word delimiter ('|').
async function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(MODEL_ID);
      const model = await AutoModelForCTC.from_pretrained(MODEL_ID);
      const tokenizer = processor.tokenizer ?? (await AutoTokenizer.from_pretrained(MODEL_ID));
      const blankId = tokenizer.pad_token_id ?? 0;
      const specials = new Set<number>(tokenizer.all_special_ids ?? [blankId]);
      const charToId = new Map<string, number>();
      let delimId = -1;
      for (let id = 0; id < 96; id++) {
        if (specials.has(id)) continue;
        const decoded = tokenizer.decode([id], { skip_special_tokens: false });
        if (decoded.length === 1) charToId.set(decoded, id);
        else if (delimId < 0) delimId = id;
        if (charToId.size >= 27 && delimId >= 0) break;
      }
      return { processor, model, blankId, delimId, charToId };
    })();
  }
  return enginePromise;
}

async function decodeToMono16k(audioPath: string): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-align-"));
  try {
    const raw = join(dir, "audio.f32");
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-i",
      audioPath,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      raw,
    ]);
    const buf = await readFile(raw);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function logSoftmaxRows(data: Float32Array, frames: number, vocab: number): Float32Array {
  const out = new Float32Array(frames * vocab);
  for (let t = 0; t < frames; t++) {
    const base = t * vocab;
    let max = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < vocab; c++) max = Math.max(max, data[base + c] as number);
    let sum = 0;
    for (let c = 0; c < vocab; c++) sum += Math.exp((data[base + c] as number) - max);
    const logSumExp = max + Math.log(sum);
    for (let c = 0; c < vocab; c++) out[base + c] = (data[base + c] as number) - logSumExp;
  }
  return out;
}

// CTC forced-alignment trellis (Viterbi) + backtrack: returns [startFrame, endFrame] per token.
function trellisAlign(
  emission: Float32Array,
  frames: number,
  vocab: number,
  tokenIds: number[],
  blankId: number,
): Array<[number, number] | null> {
  const numTokens = tokenIds.length;
  const NEG = -1e30;
  const trellis = new Float32Array(frames * numTokens).fill(NEG);
  trellis[0] = 0;
  for (let t = 1; t < frames; t++) {
    trellis[t * numTokens] =
      (trellis[(t - 1) * numTokens] as number) + (emission[t * vocab + blankId] as number);
  }
  for (let t = 0; t < frames - 1; t++) {
    for (let j = 1; j < numTokens; j++) {
      const tok = tokenIds[j] ?? blankId;
      const stay =
        (trellis[t * numTokens + j] as number) + (emission[t * vocab + blankId] as number);
      const change =
        (trellis[t * numTokens + (j - 1)] as number) + (emission[t * vocab + tok] as number);
      trellis[(t + 1) * numTokens + j] = Math.max(stay, change);
    }
  }
  const startFrame = new Int32Array(numTokens).fill(-1);
  const endFrame = new Int32Array(numTokens).fill(-1);
  const record = (idx: number, frame: number) => {
    const s = startFrame[idx] as number;
    if (s < 0 || frame < s) startFrame[idx] = frame;
    if (frame > (endFrame[idx] as number)) endFrame[idx] = frame;
  };
  let t = frames - 1;
  let j = numTokens - 1;
  record(j, t);
  while (j > 0) {
    const tok = tokenIds[j] ?? blankId;
    const stayed =
      (trellis[(t - 1) * numTokens + j] as number) +
      (emission[(t - 1) * vocab + blankId] as number);
    const changed =
      (trellis[(t - 1) * numTokens + (j - 1)] as number) +
      (emission[(t - 1) * vocab + tok] as number);
    t -= 1;
    if (changed > stayed) j -= 1;
    record(j, t);
  }
  const spans: Array<[number, number] | null> = [];
  for (let k = 0; k < numTokens; k++) {
    const end = endFrame[k] as number;
    spans.push(end >= 0 ? [startFrame[k] as number, end] : null);
  }
  return spans;
}

// Align a known transcript to its audio, returning one entry per whitespace-delimited display
// word (original punctuation/casing preserved). Words with no alignable letters (pure digits or
// punctuation) inherit a zero-width timing from the previous word so cue math never breaks.
export async function alignWords(audioPath: string, text: string): Promise<AlignedWord[]> {
  const engine = await getEngine();
  const audio = await decodeToMono16k(audioPath);
  const inputs = await engine.processor(audio);
  const { logits } = await engine.model(inputs);
  const [, frames, vocab] = logits.dims as [number, number, number];
  const emission = logSoftmaxRows(logits.data as Float32Array, frames, vocab);

  const displayWords = text.split(/\s+/).filter(Boolean);
  const normalized = displayWords.map((w) => w.toUpperCase().replace(/[^A-Z']/g, ""));
  const tokenIds: number[] = [];
  const isDelim: boolean[] = [];
  const displayIndexForAlignWord: number[] = [];
  normalized.forEach((form, displayIndex) => {
    const letters = [...form].filter((c) => engine.charToId.has(c));
    if (!letters.length) return;
    if (tokenIds.length) {
      tokenIds.push(engine.delimId);
      isDelim.push(true);
    }
    displayIndexForAlignWord.push(displayIndex);
    for (const c of letters) {
      tokenIds.push(engine.charToId.get(c) as number);
      isDelim.push(false);
    }
  });
  if (!tokenIds.length) {
    return displayWords.map((word) => ({ word, start: 0, end: 0 }));
  }

  const spans = trellisAlign(emission, frames, vocab, tokenIds, engine.blankId);
  const alignTimings: Array<{ start: number; end: number }> = [];
  let curStart = -1;
  let curEnd = -1;
  const flush = () => {
    if (curStart >= 0) alignTimings.push({ start: curStart * FRAME_SEC, end: curEnd * FRAME_SEC });
    curStart = -1;
    curEnd = -1;
  };
  for (let k = 0; k < tokenIds.length; k++) {
    if (isDelim[k]) {
      flush();
      continue;
    }
    const span = spans[k];
    if (!span) continue;
    if (curStart < 0) curStart = span[0];
    curEnd = span[1];
  }
  flush();

  const timingForDisplay = new Map<number, { start: number; end: number }>();
  alignTimings.forEach((timing, k) => {
    const displayIndex = displayIndexForAlignWord[k];
    if (displayIndex !== undefined) timingForDisplay.set(displayIndex, timing);
  });

  const out: AlignedWord[] = [];
  let lastEnd = 0;
  for (const [i, word] of displayWords.entries()) {
    const timing = timingForDisplay.get(i);
    if (timing) {
      out.push({ word, start: timing.start, end: timing.end });
      lastEnd = timing.end;
    } else {
      out.push({ word, start: lastEnd, end: lastEnd });
    }
  }
  return out;
}

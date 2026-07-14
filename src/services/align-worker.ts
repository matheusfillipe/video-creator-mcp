import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoModelForCTC, AutoProcessor, AutoTokenizer, env } from "@huggingface/transformers";
import { run } from "../lib/exec.js";
import type { AlignedWord } from "./align.js";

// Standalone force-alignment worker. Loads the ~1.5GB transformers.js CTC model, aligns one
// narration, writes the word timings, and exits — so the model memory dies with the process
// instead of sitting resident in the long-lived render server. Invoked by align.ts's alignWords
// as: node align-worker.js <inputJson> <outputJson>, where inputJson is {audioPath, text}.

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;

const MODEL_ID = process.env.ALIGN_MODEL ?? "Xenova/wav2vec2-base-960h";
const SAMPLE_RATE = 16000;
const FRAME_SEC = 0.02;
// wav2vec2 self-attention is O(frames^2), so a single forward pass over a multi-minute clip
// allocates gigabytes and OOMs the pod. The emission is computed in fixed-length windows instead:
// per-window attention stays bounded, and since the softmax is per-frame the windowed emissions
// concatenate into exactly the same trellis input as a single pass would produce.
const WINDOW_SEC = 20;
const WINDOW_SAMPLES = WINDOW_SEC * SAMPLE_RATE;

interface Engine {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForCTC.from_pretrained>>;
  blankId: number;
  delimId: number;
  charToId: Map<string, number>;
}

// Load the CTC model + tokenizer and derive the id maps. The tokenizer's get_vocab only exposes
// the letters, so ids are recovered by decoding each one: a single-char decode is a letter/
// apostrophe, and the sole non-special id that decodes to "" is the word delimiter ('|').
async function loadEngine(): Promise<Engine> {
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

interface Emission {
  data: Float32Array;
  frames: number;
  vocab: number;
  // Absolute audio time (seconds) of each frame, so a token's frame index maps back to real time
  // even though the emission was assembled from separate windows.
  frameTime: Float32Array;
}

// Run the model window-by-window and concatenate the per-frame log-probabilities. Each window's
// softmax is independent of the others (it is per-frame), so the result is the same emission a
// single pass would produce, minus the O(frames^2) attention blow-up of a long clip.
async function computeEmission(engine: Engine, audio: Float32Array): Promise<Emission> {
  const rows: Float32Array[] = [];
  const frameTimes: number[] = [];
  let vocab = 0;
  let offset = 0;
  while (offset < audio.length) {
    let end = Math.min(offset + WINDOW_SAMPLES, audio.length);
    // Absorb a sub-second trailing remainder into this window so the model never runs on a scrap
    // too short to produce meaningful frames.
    if (audio.length - end < SAMPLE_RATE) end = audio.length;
    const window = audio.subarray(offset, end);
    const inputs = await engine.processor(window);
    const { logits } = await engine.model(inputs);
    const [, windowFrames, windowVocab] = logits.dims as [number, number, number];
    vocab = windowVocab;
    rows.push(logSoftmaxRows(logits.data as Float32Array, windowFrames, windowVocab));
    const windowStartSec = offset / SAMPLE_RATE;
    for (let f = 0; f < windowFrames; f++) frameTimes.push(windowStartSec + f * FRAME_SEC);
    logits.dispose?.();
    inputs.input_values?.dispose?.();
    offset = end;
  }
  const frames = frameTimes.length;
  const data = new Float32Array(frames * vocab);
  let cursor = 0;
  for (const row of rows) {
    data.set(row, cursor);
    cursor += row.length;
  }
  return { data, frames, vocab, frameTime: Float32Array.from(frameTimes) };
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
async function computeAlignment(
  engine: Engine,
  audioPath: string,
  text: string,
): Promise<AlignedWord[]> {
  const audio = await decodeToMono16k(audioPath);
  const { data: emission, frames, vocab, frameTime } = await computeEmission(engine, audio);

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
  const timeOf = (frame: number) => frameTime[Math.max(0, Math.min(frames - 1, frame))] as number;
  const flush = () => {
    if (curStart >= 0) alignTimings.push({ start: timeOf(curStart), end: timeOf(curEnd) });
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

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile || !outputFile) throw new Error("usage: align-worker <input.json> <output.json>");
  const { audioPath, text } = JSON.parse(await readFile(inputFile, "utf8")) as {
    audioPath: string;
    text: string;
  };
  const engine = await loadEngine();
  const words = await computeAlignment(engine, audioPath, text);
  await writeFile(outputFile, JSON.stringify(words));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { loadMeta } from "./media.js";
import { synthesizeChatterbox } from "./tts.js";

const MIN_VOICE_REFERENCE_SEC = 2;
// A clone reference only needs a few seconds of clean speech. Cap the extracted clip so a
// long video's audio track doesn't become a huge upload, and it's enough for a good clone.
const CLONE_CLIP_SECONDS = 20;
// Chatterbox caps a single generation at ~1000 tokens (~17-20s of speech), so anything longer
// truncates. Split into chunks safely under that and stitch, keeping the same voice throughout.
const MAX_TTS_CHUNK_CHARS = 220;
// Chatterbox's measured speaking rate is very steady (~2.84-3.01 words/s across lengths, barely
// moved by cfg_weight), so word count predicts the spoken length within a few tenths of a second.
export const TTS_WORDS_PER_SEC = 2.9;

// All narration audio is normalized to the TTS output format so buffers concat losslessly.
const NARRATION_SAMPLE_RATE = 24000;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return [clean];
  const units = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const raw of units) {
    let unit = raw.trim();
    if (!unit) continue;
    while (unit.length > maxChars) {
      const space = unit.lastIndexOf(" ", maxChars);
      const cut = space > 0 ? space : maxChars;
      flush();
      chunks.push(unit.slice(0, cut).trim());
      unit = unit.slice(cut).trim();
    }
    if (cur && `${cur} ${unit}`.length > maxChars) flush();
    cur = cur ? `${cur} ${unit}` : unit;
  }
  flush();
  return chunks;
}

export async function concatWavs(parts: Buffer[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-tts-"));
  try {
    const files = await Promise.all(
      parts.map(async (part, i) => {
        const p = join(dir, `p${i}.wav`);
        await writeFile(p, part);
        return p;
      }),
    );
    const listPath = join(dir, "list.txt");
    await writeFile(listPath, files.map((f) => `file '${f}'`).join("\n"));
    const out = join(dir, "out.wav");
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ar",
      String(NARRATION_SAMPLE_RATE),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A silent wav in the narration format — used to place gaps (a delayed voice, a held beat)
// inside a concatenated narration track without touching the video pipeline.
export async function silenceWav(seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-sil-"));
  try {
    const out = join(dir, "silence.wav");
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${NARRATION_SAMPLE_RATE}:cl=mono`,
      "-t",
      seconds.toFixed(3),
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SpeechParams {
  text: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  voiceFile?: { buffer: Buffer; filename: string };
}

export async function synthesizeSpeech(params: SpeechParams): Promise<Buffer> {
  const chunks = splitIntoChunks(params.text, MAX_TTS_CHUNK_CHARS);
  if (chunks.length === 1) return synthesizeChatterbox(params);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    parts.push(await synthesizeChatterbox({ ...params, text: chunk }));
  }
  return concatWavs(parts);
}

// Length of a PCM WAV buffer without shelling out: the "data" subchunk size over the byte rate.
export function wavDurationSec(buffer: Buffer): number {
  const dataIdx = buffer.indexOf("data", 12, "ascii");
  const byteRate = buffer.readUInt32LE(28);
  if (dataIdx < 0 || byteRate <= 0) return 0;
  return buffer.readUInt32LE(dataIdx + 4) / byteRate;
}

// A clone reference may be a video / long / huge file, so extract just the leading mono audio:
// Chatterbox always gets clean, small speech.
export async function extractCloneClip(
  voiceReference: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const ref = await loadMeta(voiceReference);
  if (!ref) {
    throw new Error(
      `voice_reference not found: ${voiceReference}. Download the reference clip with video_download_media first and pass its media_id.`,
    );
  }
  if (!(await stat(ref.path).catch(() => null))) {
    throw new Error(
      `voice_reference ${voiceReference} is no longer cached; re-download it with video_download_media.`,
    );
  }
  if (!ref.duration || ref.duration < MIN_VOICE_REFERENCE_SEC) {
    throw new Error(
      `voice_reference is ${ref.duration ? `only ${ref.duration.toFixed(1)}s` : "not usable audio"}; cloning needs at least ${MIN_VOICE_REFERENCE_SEC}s of clear speech (5-15s is ideal).`,
    );
  }
  const clipDir = await mkdtemp(join(tmpdir(), "vcm-clone-"));
  try {
    const clipPath = join(clipDir, "ref.wav");
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-i",
      ref.path,
      "-t",
      String(CLONE_CLIP_SECONDS),
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(NARRATION_SAMPLE_RATE),
      clipPath,
    ]);
    const clip = await readFile(clipPath);
    if (clip.length < 2000) {
      throw new Error(`voice_reference ${voiceReference} has no usable audio track to clone from.`);
    }
    return { buffer: clip, filename: "voice.wav" };
  } finally {
    await rm(clipDir, { recursive: true, force: true });
  }
}

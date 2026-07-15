import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.js";

// Vocal separation loads the MDX model and holds the whole song's spectrograms in memory. Spawn it
// as a short-lived worker (same reasoning as align-worker) so that footprint is reclaimed on exit.
const workerIsTs = import.meta.url.endsWith(".ts");
const WORKER = fileURLToPath(
  new URL(workerIsTs ? "./separate-worker.ts" : "./separate-worker.js", import.meta.url),
);
// Separation is CPU-bound and runs ~real-time, so a few minutes for a long song; give it headroom.
const SEPARATE_TIMEOUT_MS = 600_000;

export interface SeparatedVocals {
  path: string;
  cleanup: () => Promise<void>;
}

// Isolate the sung vocals from a song into a temporary wav. The caller force-aligns the transcript
// to this clean stem (never plays it) and calls cleanup() when done.
export async function separateVocals(audioPath: string): Promise<SeparatedVocals> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-separate-"));
  const stemPath = join(dir, "vocals.wav");
  const args = workerIsTs
    ? ["--import", "tsx", WORKER, audioPath, stemPath]
    : [WORKER, audioPath, stemPath];
  await run("node", args, { timeoutMs: SEPARATE_TIMEOUT_MS });
  return { path: stemPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

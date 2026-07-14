import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.js";

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

// Force-alignment loads a ~1.5GB transformers.js CTC model. Running it in the long-lived render
// server leaves that model resident forever, stacking with every render's peak until the pod OOMs.
// Spawn it as a short-lived worker instead: the model memory is reclaimed the moment the process
// exits, so the server idles lean and a render's real footprint is just its own buffers.
const workerIsTs = import.meta.url.endsWith(".ts");
const WORKER = fileURLToPath(
  new URL(workerIsTs ? "./align-worker.ts" : "./align-worker.js", import.meta.url),
);
const ALIGN_TIMEOUT_MS = 300_000;

// Align a known transcript to its audio, returning one entry per whitespace-delimited display word.
export async function alignWords(audioPath: string, text: string): Promise<AlignedWord[]> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-align-"));
  try {
    const inputFile = join(dir, "in.json");
    const outputFile = join(dir, "out.json");
    await writeFile(inputFile, JSON.stringify({ audioPath, text }));
    // tsx dev runs the .ts worker via node's loader; the built image runs the sibling .js directly.
    const args = workerIsTs
      ? ["--import", "tsx", WORKER, inputFile, outputFile]
      : [WORKER, inputFile, outputFile];
    await run("node", args, { timeoutMs: ALIGN_TIMEOUT_MS });
    return JSON.parse(await readFile(outputFile, "utf8")) as AlignedWord[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

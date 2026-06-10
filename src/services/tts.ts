import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/exec.js";

export async function synthesizeSpeech(
  text: string,
  voice: string,
  speed: number,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-tts-"));
  try {
    const outPath = join(dir, "tts.wav");
    // Invoke the baked global binary directly, not via npx: npx tries to fetch hyperframes
    // from the registry when its cache misses, which fails in the offline image.
    await run("hyperframes", ["tts", "-o", outPath, "-v", voice, "-s", String(speed), text], {
      timeoutMs: 120_000,
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

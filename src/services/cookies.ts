import { copyFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

const COOKIE_PREFIX = "video-mcp-cookies-";
// Longer than the longest yt-dlp run (a download caps at 600s), so a swept copy
// always belongs to a finished call.
const STALE_MS = 20 * 60_000;

let seq = 0;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function sweepStale(dir: string): Promise<void> {
  const now = Date.now();
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(COOKIE_PREFIX))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs > STALE_MS) await unlink(path).catch(() => {});
      }),
  );
}

// yt-dlp rewrites its --cookies file on exit, but YTDLP_COOKIES points at a
// read-only secret mount. Hand yt-dlp a fresh writable copy each call so it can
// persist its session updates to a throwaway path instead of failing on the
// read-only mount. The copy is unique per call so concurrent downloads never
// read one another's half-written file, and re-copied from the mount every time
// so it tracks the cookies the daily refresh rotates into the secret.
export async function cookieArgs(): Promise<string[]> {
  if (!config.ytdlp.cookies) return [];
  try {
    await stat(config.ytdlp.cookies);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    console.error(`[cookies] YTDLP_COOKIES not found at ${config.ytdlp.cookies}, skipping`);
    return [];
  }
  const dir = tmpdir();
  await sweepStale(dir);
  const writable = join(dir, `${COOKIE_PREFIX}${process.pid}-${seq++}.txt`);
  await copyFile(config.ytdlp.cookies, writable);
  return ["--cookies", writable];
}

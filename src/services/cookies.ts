import { copyFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

const WRITABLE_COOKIES = join(tmpdir(), "video-mcp-cookies.txt");

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// yt-dlp rewrites its --cookies file on exit, but YTDLP_COOKIES points at a
// read-only secret mount. Hand yt-dlp a fresh writable copy each call so it can
// persist its session updates to a throwaway path instead of failing on the
// read-only mount. Re-copied per call so it tracks the rotated secret.
export async function cookieArgs(): Promise<string[]> {
  if (!config.ytdlp.cookies) return [];
  try {
    await stat(config.ytdlp.cookies);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    console.error(`[cookies] YTDLP_COOKIES not found at ${config.ytdlp.cookies}, skipping`);
    return [];
  }
  await copyFile(config.ytdlp.cookies, WRITABLE_COOKIES);
  return ["--cookies", WRITABLE_COOKIES];
}

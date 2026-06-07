import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { config } from "../config.js";
import { cacheId } from "../lib/cacheId.js";
import { run } from "../lib/exec.js";
import { unlinkIfExists } from "../lib/fs.js";
import { withLock } from "../lib/lock.js";
import { assertSafeUrl } from "../lib/net.js";
import type { MediaMeta, MediaSummary, ProbeInfo } from "../types.js";

const MIN_VALID_BYTES = 100;
const DIRECT_MEDIA_RE =
  /^(https?:\/\/).+\.(mp4|webm|mov|mkv|avi|mp3|wav|m4a|ogg|flac|jpg|jpeg|png|webp|gif)(\?.*)?$/i;
const TWITTER_RE = /twitter\.com|x\.com|t\.co/i;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}
interface FfprobeOutput {
  format?: { duration?: string; size?: string };
  streams?: FfprobeStream[];
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cachePath(mediaId: string, ext: string): string {
  return join(config.mediaCacheDir, `${mediaId}${ext}`);
}

function metaPath(mediaId: string): string {
  return join(config.mediaCacheDir, `${mediaId}.meta.json`);
}

export function parseFrameRate(raw: string | undefined | null): number {
  if (!raw) return 30;
  const slash = raw.indexOf("/");
  if (slash === -1) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 30;
  }
  const numerator = Number(raw.slice(0, slash));
  const denominator = Number(raw.slice(slash + 1));
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
    return numerator / denominator;
  }
  return 30;
}

export async function probeInfo(filePath: string): Promise<ProbeInfo> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as FfprobeOutput;
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(data.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    codec: video?.codec_name ?? "",
    fps: parseFrameRate(video?.r_frame_rate),
    hasAudio: audio !== undefined,
    size: Number(data.format?.size ?? 0),
  };
}

export async function saveMeta(mediaId: string, meta: MediaMeta): Promise<void> {
  await writeFile(metaPath(mediaId), JSON.stringify(meta, null, 2));
}

export async function loadMeta(mediaId: string): Promise<MediaMeta | null> {
  try {
    const raw = await readFile(metaPath(mediaId), "utf-8");
    return JSON.parse(raw) as MediaMeta;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getCached(mediaId: string): Promise<MediaMeta | null> {
  const meta = await loadMeta(mediaId);
  if (!meta) return null;
  try {
    await stat(meta.path);
    return meta;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fetchRaw(url: string, mediaId: string, rawId: string): Promise<string> {
  if (DIRECT_MEDIA_RE.test(url) && !TWITTER_RE.test(url)) {
    const ext = extname(url.split("?")[0] ?? "").toLowerCase() || ".mp4";
    const rawFile = join(config.mediaCacheDir, `raw_${mediaId}${ext}`);
    await run("curl", ["-sL", "--max-redirs", "5", "-o", rawFile, "--max-time", "300", url]);
    return rawFile;
  }

  const rawFile = join(config.mediaCacheDir, `raw_${rawId}.mp4`);
  const args = [
    "-f",
    config.ytdlp.format,
    "--merge-output-format",
    "mp4",
    "-o",
    rawFile,
    "--max-filesize",
    "500M",
    "--no-playlist",
    "--concurrent-fragments",
    "4",
  ];
  if (config.ytdlp.cookies) {
    try {
      await stat(config.ytdlp.cookies);
      args.push("--cookies", config.ytdlp.cookies);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      console.error(`[media] YTDLP_COOKIES not found at ${config.ytdlp.cookies}, skipping`);
    }
  }
  if (TWITTER_RE.test(url)) {
    args.push("--extractor-args", "twitter:api=syndication");
  }
  args.push(url);
  try {
    await run(config.ytdlp.path, args, { timeoutMs: 600_000 });
  } catch (error) {
    const files = await readdir(config.mediaCacheDir);
    for (const name of files) {
      if (name.startsWith(`raw_${rawId}`)) {
        await unlinkIfExists(join(config.mediaCacheDir, name));
      }
    }
    throw error;
  }
  return rawFile;
}

async function trimMedia(
  rawFile: string,
  mediaId: string,
  start: number | undefined,
  end: number | undefined,
): Promise<string> {
  const outFile = cachePath(mediaId, ".mp4");
  const args = ["-y", "-i", rawFile];
  if (start !== undefined && start > 0) args.push("-ss", String(start));
  if (end !== undefined) args.push("-to", String(end));
  args.push("-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", outFile);
  await run("ffmpeg", args, { timeoutMs: 300_000 });
  if (outFile !== rawFile) {
    await unlinkIfExists(rawFile);
  }
  return outFile;
}

export async function downloadMedia(params: {
  url: string;
  start?: number;
  end?: number;
}): Promise<MediaMeta> {
  const { url, start, end } = params;
  await assertSafeUrl(url);
  const mediaId = cacheId(url, start ?? null, end ?? null);
  const rawId = cacheId(url);

  return withLock(rawId, async () => {
    const cached = await getCached(mediaId);
    if (cached) return cached;

    await mkdir(config.mediaCacheDir, { recursive: true });
    const rawFile = await fetchRaw(url, mediaId, rawId);

    const rawStat = await stat(rawFile).catch(() => null);
    if (!rawStat) {
      throw new Error(`Download failed: no output file at ${rawFile}`);
    }
    if (rawStat.size < MIN_VALID_BYTES) {
      await unlinkIfExists(rawFile);
      throw new Error(`Download produced an empty file (${rawStat.size} bytes) from ${url}`);
    }

    const needTrim = (start !== undefined && start > 0) || end !== undefined;
    let outFile = rawFile;
    if (needTrim) {
      outFile = await trimMedia(rawFile, mediaId, start, end);
    } else {
      const finalPath = cachePath(mediaId, extname(rawFile) || ".mp4");
      if (rawFile !== finalPath) {
        await rename(rawFile, finalPath);
        outFile = finalPath;
      }
    }

    const info = await probeInfo(outFile);
    const meta: MediaMeta = {
      media_id: mediaId,
      filename: basename(outFile),
      path: outFile,
      url,
      start: start ?? null,
      end: end ?? null,
      duration: info.duration,
      width: info.width,
      height: info.height,
      codec: info.codec,
      fps: info.fps,
      hasAudio: info.hasAudio,
      size: info.size,
    };
    await saveMeta(mediaId, meta);
    return meta;
  });
}

export async function writeMediaFromBuffer(params: {
  idSeed: string;
  buffer: Buffer;
  ext: string;
  sourceUrl: string;
}): Promise<MediaMeta> {
  const { idSeed, buffer, ext, sourceUrl } = params;
  await mkdir(config.mediaCacheDir, { recursive: true });
  const mediaId = cacheId(idSeed);
  const filename = `${mediaId}${ext}`;
  const filePath = join(config.mediaCacheDir, filename);
  await writeFile(filePath, buffer);
  const info = await probeInfo(filePath);
  const meta: MediaMeta = {
    media_id: mediaId,
    filename,
    path: filePath,
    url: sourceUrl,
    start: null,
    end: null,
    duration: info.duration,
    width: info.width,
    height: info.height,
    codec: info.codec,
    fps: info.fps,
    hasAudio: info.hasAudio,
    size: info.size,
  };
  await saveMeta(mediaId, meta);
  return meta;
}

export async function linkMediaToWorkdir(mediaId: string, workdir: string): Promise<string> {
  const meta = await loadMeta(mediaId);
  if (!meta) throw new Error(`Media ${mediaId} not found in cache`);

  const assetsDir = join(workdir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const workPath = join(assetsDir, meta.filename);

  try {
    await symlink(meta.path, workPath);
  } catch (error) {
    if (!isErrnoException(error)) throw error;
    if (error.code === "EEXIST") {
      // already linked from a prior segment in the same job
    } else if (error.code === "EPERM" || error.code === "EXDEV") {
      await copyFile(meta.path, workPath);
    } else {
      throw error;
    }
  }
  return `assets/${meta.filename}`;
}

export async function listCachedMedia(): Promise<MediaSummary[]> {
  await mkdir(config.mediaCacheDir, { recursive: true });
  const files = await readdir(config.mediaCacheDir);
  const items: MediaSummary[] = [];
  for (const name of files) {
    if (!name.endsWith(".meta.json")) continue;
    const raw = await readFile(join(config.mediaCacheDir, name), "utf-8");
    const meta = JSON.parse(raw) as MediaMeta;
    items.push({
      media_id: meta.media_id,
      url: meta.url,
      filename: meta.filename,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      size: meta.size,
      start: meta.start,
      end: meta.end,
    });
  }
  return items;
}

export async function removeCachedMedia(mediaId: string): Promise<{ removed: string }> {
  const meta = await loadMeta(mediaId);
  if (!meta) throw new Error(`Media ${mediaId} not found in cache`);
  await unlinkIfExists(meta.path);
  await unlinkIfExists(metaPath(mediaId));
  return { removed: mediaId };
}

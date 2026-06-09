import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";
import { unlinkIfExists } from "../lib/fs.js";
import { assertSafeUrl } from "../lib/net.js";
import type { MediaMeta } from "../types.js";
import { cookieArgs } from "./cookies.js";
import { writeMediaFromBuffer } from "./media.js";

const BARE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const MAX_THUMBNAIL_RESULTS = 5;
const MAX_HEATMAP_PEAKS = 5;
const DESCRIPTION_LIMIT = 500;

interface YtdlpThumbnail {
  url?: string;
  width?: number;
  height?: number;
}
interface YtdlpSubtitleTrack {
  ext?: string;
}
interface YtdlpHeatmapEntry {
  start_time: number;
  end_time: number;
  value: number;
}
interface YtdlpEntry {
  id?: string;
  title?: string;
  webpage_url?: string;
  channel?: string;
  channel_url?: string;
  channel_is_verified?: boolean;
  channel_follower_count?: number;
  duration?: number;
  view_count?: number;
  like_count?: number;
  average_rating?: number;
  description?: string;
  upload_date?: string;
  categories?: string[];
  tags?: string[];
  comment_count?: number;
  chapters?: unknown;
  heatmap?: YtdlpHeatmapEntry[];
  subtitles?: Record<string, YtdlpSubtitleTrack[]>;
  automatic_captions?: Record<string, YtdlpSubtitleTrack[]>;
  thumbnails?: YtdlpThumbnail[];
  thumbnail?: string;
}

export interface HeatmapPeak {
  start: number;
  end: number;
  intensity: number;
}
export interface VideoInfo {
  id: string | undefined;
  title: string | undefined;
  url: string | undefined;
  channel: string | undefined;
  channel_verified: boolean;
  channel_subscribers: number;
  duration: string;
  duration_seconds: number;
  views: number;
  likes: number;
  description: string;
  upload_date: string | undefined;
  categories: string[];
  tags: string[];
  heatmap_peaks: HeatmapPeak[] | null;
  subtitles: Record<string, { type: "manual" | "auto"; formats: string[] }>;
  thumbnails: YtdlpThumbnail[];
}
export interface SearchResult {
  id: string | undefined;
  title: string | undefined;
  url: string;
  channel: string | undefined;
  duration: string;
  duration_seconds: number;
  views: number;
  upload_date: string | undefined;
  thumbnail: string | undefined;
}
export interface SubtitleResult {
  language: string;
  auto: boolean;
  format: string;
  content: string;
}

export function normalizeYouTubeUrl(url: string): string {
  return BARE_ID_RE.test(url) ? `https://www.youtube.com/watch?v=${url}` : url;
}

async function dumpJson(target: string): Promise<YtdlpEntry[]> {
  const args = ["--no-download", "--dump-json", ...(await cookieArgs()), target];
  const { stdout } = await run(config.ytdlp.path, args, { timeoutMs: 60_000 });
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as YtdlpEntry);
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function bestThumbnailUrl(entry: YtdlpEntry): string | undefined {
  if (entry.thumbnail) return entry.thumbnail;
  const sorted = [...(entry.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url;
}

export async function getVideoInfo(url: string): Promise<YtdlpEntry> {
  const normalized = normalizeYouTubeUrl(url);
  await assertSafeUrl(normalized);
  const entries = await dumpJson(normalized);
  const entry = entries[0];
  if (!entry) throw new Error(`No video information returned for ${url}`);
  return entry;
}

export function formatVideoInfo(entry: YtdlpEntry): VideoInfo {
  const durationSeconds = entry.duration ? Math.round(entry.duration) : 0;

  const subtitles: VideoInfo["subtitles"] = {};
  for (const [lang, tracks] of Object.entries(entry.subtitles ?? {})) {
    subtitles[lang] = { type: "manual", formats: tracks.map((track) => track.ext ?? "?") };
  }
  for (const [lang, tracks] of Object.entries(entry.automatic_captions ?? {})) {
    if (!subtitles[lang]) {
      subtitles[lang] = { type: "auto", formats: tracks.map((track) => track.ext ?? "?") };
    }
  }

  let heatmapPeaks: HeatmapPeak[] | null = null;
  if (entry.heatmap && entry.heatmap.length > 0) {
    heatmapPeaks = [...entry.heatmap]
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_HEATMAP_PEAKS)
      .map((peak) => ({
        start: Math.round(peak.start_time),
        end: Math.round(peak.end_time),
        intensity: Number((peak.value * 100).toFixed(1)),
      }));
  }

  const thumbnails = [...(entry.thumbnails ?? [])]
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    .slice(0, MAX_THUMBNAIL_RESULTS);

  return {
    id: entry.id,
    title: entry.title,
    url: entry.webpage_url,
    channel: entry.channel,
    channel_verified: entry.channel_is_verified ?? false,
    channel_subscribers: entry.channel_follower_count ?? 0,
    duration: formatDuration(durationSeconds),
    duration_seconds: durationSeconds,
    views: entry.view_count ?? 0,
    likes: entry.like_count ?? 0,
    description: (entry.description ?? "").slice(0, DESCRIPTION_LIMIT),
    upload_date: entry.upload_date,
    categories: entry.categories ?? [],
    tags: entry.tags ?? [],
    heatmap_peaks: heatmapPeaks,
    subtitles,
    thumbnails,
  };
}

export async function searchYouTube(query: string, maxResults: number): Promise<SearchResult[]> {
  const entries = await dumpJson(`ytsearch${maxResults}:${query}`);
  return entries.map((entry) => {
    const durationSeconds = entry.duration ? Math.round(entry.duration) : 0;
    return {
      id: entry.id,
      title: entry.title,
      url: entry.webpage_url ?? `https://www.youtube.com/watch?v=${entry.id}`,
      channel: entry.channel,
      duration: formatDuration(durationSeconds),
      duration_seconds: durationSeconds,
      views: entry.view_count ?? 0,
      upload_date: entry.upload_date,
      thumbnail: bestThumbnailUrl(entry),
    };
  });
}

export async function getSubtitles(
  url: string,
  lang: string,
  auto: boolean,
): Promise<SubtitleResult> {
  const normalized = normalizeYouTubeUrl(url);
  await assertSafeUrl(normalized);
  const dir = await mkdtemp(join(tmpdir(), "vcm-subs-"));
  const args = ["--skip-download", "--sub-lang", lang, "--sub-format", "srt"];
  args.push(auto ? "--write-auto-sub" : "--write-sub");
  args.push(...(await cookieArgs()));
  args.push("-o", join(dir, "sub"), normalized);
  await run(config.ytdlp.path, args, { timeoutMs: 60_000 });

  const files = await readdir(dir);
  const subtitleFile = files.find((name) => name.endsWith(".srt")) ?? files[0];
  if (!subtitleFile) {
    throw new Error(`No ${auto ? "auto-" : ""}subtitles found for language "${lang}"`);
  }
  const filePath = join(dir, subtitleFile);
  const content = await readFile(filePath, "utf-8");
  for (const name of files) {
    await unlinkIfExists(join(dir, name));
  }
  return { language: lang, auto, format: extname(subtitleFile).slice(1) || "srt", content };
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface SubtitleSearch {
  available: boolean;
  language?: string;
  total_cues?: number;
  matches?: SubtitleCue[];
  cues?: SubtitleCue[];
  note?: string;
}

function srtTimeToSeconds(stamp: string): number {
  const m = stamp.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  const [, h = "0", mi = "0", s = "0", ms = "0"] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
}

function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of content.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim());
    const timing = lines.find((line) => line.includes("-->"));
    if (!timing) continue;
    const [from, to] = timing.split("-->");
    if (!from || !to) continue;
    const text = lines
      .filter((line) => line !== timing && !/^\d+$/.test(line.trim()))
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) continue;
    // Auto-captions repeat the rolling line across cues; collapse exact consecutive dups,
    // extending the previous cue's end so a phrase keeps one continuous [start, end].
    const last = cues[cues.length - 1];
    if (last && last.text === text) {
      last.end = srtTimeToSeconds(to);
    } else {
      cues.push({ start: srtTimeToSeconds(from), end: srtTimeToSeconds(to), text });
    }
  }
  return cues;
}

// Fetch a video's timed captions (manual or auto) and optionally find a phrase. Returns
// available:false instead of throwing when the video has none — so the agent can "just try".
export async function searchSubtitles(
  url: string,
  query: string,
  lang: string,
): Promise<SubtitleSearch> {
  const normalized = normalizeYouTubeUrl(url);
  await assertSafeUrl(normalized);
  const dir = await mkdtemp(join(tmpdir(), "vcm-subsearch-"));
  try {
    const args = [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      lang,
      "--convert-subs",
      "srt",
      ...(await cookieArgs()),
      "-o",
      join(dir, "sub"),
      normalized,
    ];
    await run(config.ytdlp.path, args, { timeoutMs: 60_000 });
    const subs = (await readdir(dir)).filter(
      (name) => name.endsWith(".srt") || name.endsWith(".vtt"),
    );
    // Prefer a converted .srt and the manual `en` track over auto/translated variants.
    const file =
      subs.find((name) => /\.en\.srt$/.test(name)) ??
      subs.find((name) => name.endsWith(".srt")) ??
      subs.find((name) => /\.en\.vtt$/.test(name)) ??
      subs[0];
    if (!file) return { available: false };
    const content = await readFile(join(dir, file), "utf-8");
    const cues = parseSrt(content);
    const language = file.match(/sub\.([\w-]+)\.(?:srt|vtt)$/)?.[1] ?? lang;
    if (query.trim()) {
      const needle = query.toLowerCase();
      const matches = cues.filter((cue) => cue.text.toLowerCase().includes(needle)).slice(0, 25);
      return { available: true, language, total_cues: cues.length, matches };
    }
    const CAP = 400;
    const result: SubtitleSearch = {
      available: true,
      language,
      total_cues: cues.length,
      cues: cues.slice(0, CAP),
    };
    if (cues.length > CAP) {
      result.note = `Transcript truncated to ${CAP} of ${cues.length} cues; pass a query to find a specific phrase.`;
    }
    return result;
  } finally {
    for (const name of await readdir(dir)) {
      await unlinkIfExists(join(dir, name));
    }
  }
}

export async function getThumbnail(url: string, maxWidth: number): Promise<MediaMeta> {
  const normalized = normalizeYouTubeUrl(url);
  const entry = await getVideoInfo(normalized);
  const sorted = [...(entry.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const pick = sorted.find((thumb) => (thumb.width ?? 0) <= maxWidth) ?? sorted[sorted.length - 1];
  if (!pick?.url) throw new Error("No thumbnails available for this video");

  await assertSafeUrl(pick.url);
  const ext = extname(pick.url.split("?")[0] ?? "").toLowerCase() || ".jpg";
  const dir = await mkdtemp(join(tmpdir(), "vcm-thumb-"));
  const tmpFile = join(dir, `thumb${ext}`);
  await run("curl", ["-sL", "--max-redirs", "5", "-o", tmpFile, "--max-time", "30", pick.url]);
  const buffer = await readFile(tmpFile);
  await unlinkIfExists(tmpFile);
  if (buffer.byteLength < 100) {
    throw new Error(`Thumbnail download produced an empty file from ${pick.url}`);
  }
  return writeMediaFromBuffer({
    idSeed: `thumb:${normalized}:${maxWidth}`,
    buffer,
    ext,
    sourceUrl: pick.url,
  });
}

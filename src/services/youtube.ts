import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { config } from "../config.js";
import { ExecError, run } from "../lib/exec.js";
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

export type SubtitlePrecision = "word" | "cue";
export type SubtitlePrefer = "word" | "text";

export interface WordToken {
  text: string;
  start: number;
  end: number;
}

export interface SubtitleSearch {
  available: boolean;
  language?: string;
  // Which track answered: "auto" = ASR (carries word timing), "manual" = uploaded (accurate text).
  track?: "auto" | "manual";
  // "word" = tight per-word start/end (auto/ASR only); "cue" = phrase-block timing (~1-6s).
  precision?: SubtitlePrecision;
  total_cues?: number;
  total_words?: number;
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

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}
interface Json3Doc {
  events?: Json3Event[];
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
}

// YouTube auto-caption json3: each event has a tStartMs and segs[], each seg a token at
// tOffsetMs from the event start (the first seg's offset is null = 0). A seg can hold more
// than one word ("from what"); split those, sharing the seg's start. Words flatten into one
// sorted timeline with each word's end set to the next word's start, so a phrase match
// yields a tight [first-word.start, last-word.end] window.
function parseJson3(content: string): WordToken[] {
  const doc = JSON.parse(content) as Json3Doc;
  const raw: Array<{ text: string; start: number }> = [];
  for (const event of doc.events ?? []) {
    if (!event.segs) continue;
    const base = event.tStartMs ?? 0;
    for (const seg of event.segs) {
      const start = (base + (seg.tOffsetMs ?? 0)) / 1000;
      for (const piece of (seg.utf8 ?? "").split(/\s+/)) {
        if (piece) raw.push({ text: piece, start });
      }
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const words: WordToken[] = [];
  for (const item of raw) {
    const prev = words[words.length - 1];
    // The append/rolling caption variant re-emits a word at its original time; drop exact repeats.
    if (prev && prev.text === item.text && Math.abs(prev.start - item.start) < 0.04) continue;
    words.push({ text: item.text, start: item.start, end: item.start });
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    const next = words[i + 1];
    word.end = next ? next.start : word.start + 0.6;
  }
  return words;
}

// Casual contractions ASR and humans spell differently. Expanding both the query and the
// transcript to the same form lets a "never gonna give you up" query match an ASR track that
// wrote "never going to give you up".
const CONTRACTIONS: Record<string, string> = {
  gonna: "going to",
  wanna: "want to",
  gotta: "got to",
  gimme: "give me",
  lemme: "let me",
  kinda: "kind of",
  sorta: "sort of",
  tryna: "trying to",
  outta: "out of",
  dunno: "dont know",
  yall: "you all",
};

function expandToken(norm: string): string[] {
  const expanded = CONTRACTIONS[norm];
  return expanded ? expanded.split(" ") : [norm];
}

interface FlatToken {
  norm: string;
  wordIndex: number;
}

// Flatten words into normalized comparison tokens (contractions expanded). Each token keeps
// the index of the word it came from, so a match maps back to that word's real start/end for
// a tight clip window even when one spoken token expanded into several.
function flattenWords(words: WordToken[]): FlatToken[] {
  const flat: FlatToken[] = [];
  words.forEach((word, wordIndex) => {
    for (const token of expandToken(normalizeToken(word.text))) {
      if (token) flat.push({ norm: token, wordIndex });
    }
  });
  return flat;
}

function queryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .flatMap((token) => expandToken(normalizeToken(token)))
    .filter(Boolean);
}

function spanCue(words: WordToken[], startIndex: number, endIndex: number): SubtitleCue | null {
  const first = words[startIndex];
  const last = words[endIndex];
  if (!first || !last) return null;
  const text = words
    .slice(startIndex, endIndex + 1)
    .map((word) => word.text.trim())
    .join(" ");
  return { start: first.start, end: last.end, text };
}

// Exact phrase match on the contraction-normalized token stream → tight per-word spans.
function matchWordSpans(words: WordToken[], query: string): SubtitleCue[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const flat = flattenWords(words);
  const matches: SubtitleCue[] = [];
  for (let i = 0; i + tokens.length <= flat.length; i++) {
    let hit = true;
    for (let k = 0; k < tokens.length; k++) {
      if (flat[i + k]?.norm !== tokens[k]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const startTok = flat[i];
    const endTok = flat[i + tokens.length - 1];
    if (!startTok || !endTok) continue;
    const cue = spanCue(words, startTok.wordIndex, endTok.wordIndex);
    if (cue) matches.push(cue);
    i += tokens.length - 1;
  }
  return matches;
}

// Fallback when ASR wording drifts from the query (a wrong/missing word): the best windows
// matching >=70% of the query tokens in order, anchored at the first or last token so the
// span boundaries stay meaningful. Marked approximate so the caller can verify the text.
function fuzzyWordSpans(words: WordToken[], query: string): SubtitleCue[] {
  const tokens = queryTokens(query);
  if (tokens.length < 3) return [];
  const flat = flattenWords(words);
  const need = Math.max(2, Math.ceil(tokens.length * 0.7));
  const scored: Array<{ score: number; startIndex: number; endIndex: number }> = [];
  for (let i = 0; i + tokens.length <= flat.length; i++) {
    let score = 0;
    for (let k = 0; k < tokens.length; k++) {
      if (flat[i + k]?.norm === tokens[k]) score++;
    }
    const startTok = flat[i];
    const endTok = flat[i + tokens.length - 1];
    if (!startTok || !endTok || score < need) continue;
    if (startTok.norm !== tokens[0] && endTok.norm !== tokens[tokens.length - 1]) continue;
    scored.push({ score, startIndex: startTok.wordIndex, endIndex: endTok.wordIndex });
  }
  scored.sort((a, b) => b.score - a.score);
  const matches: SubtitleCue[] = [];
  const seen = new Set<number>();
  for (const entry of scored) {
    if (seen.has(entry.startIndex)) continue;
    seen.add(entry.startIndex);
    const cue = spanCue(words, entry.startIndex, entry.endIndex);
    if (cue) matches.push(cue);
    if (matches.length >= 8) break;
  }
  return matches;
}

// Group a word stream into readable transcript lines (<=10 words, or break on a >1.2s gap).
function wordsToCues(words: WordToken[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let current: WordToken[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    cues.push({
      start: first.start,
      end: last.end,
      text: current.map((word) => word.text.trim()).join(" "),
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    current.push(word);
    const next = words[i + 1];
    const gap = next ? next.start - word.end : 0;
    if (current.length >= 10 || (next && gap > 1.2)) flush();
  }
  flush();
  return cues;
}

async function ytdlpSubFetch(
  dir: string,
  normalized: string,
  prefix: string,
  extra: string[],
): Promise<string[]> {
  const args = [
    "--skip-download",
    ...extra,
    ...(await cookieArgs()),
    "-o",
    join(dir, prefix),
    normalized,
  ];
  try {
    await run(config.ytdlp.path, args, { timeoutMs: 60_000 });
  } catch (error) {
    if (error instanceof ExecError) return [];
    throw error;
  }
  return (await readdir(dir)).filter((name) => name.startsWith(prefix));
}

async function fetchAutoWords(
  dir: string,
  normalized: string,
  lang: string,
): Promise<{ words: WordToken[]; language: string } | null> {
  const files = await ytdlpSubFetch(dir, normalized, "word", [
    "--write-auto-subs",
    "--sub-langs",
    lang,
    "--sub-format",
    "json3",
  ]);
  const json3 = files.filter((name) => name.endsWith(".json3"));
  const file = json3.find((name) => /\.en\.json3$/.test(name)) ?? json3[0];
  if (!file) return null;
  const words = parseJson3(await readFile(join(dir, file), "utf-8"));
  if (words.length === 0) return null;
  const language = file.match(/word\.([\w-]+)\.json3$/)?.[1] ?? "en";
  return { words, language };
}

async function fetchCues(
  dir: string,
  normalized: string,
  lang: string,
  track: "auto" | "manual",
): Promise<{ cues: SubtitleCue[]; language: string } | null> {
  const prefix = track === "manual" ? "manual" : "autoc";
  const files = await ytdlpSubFetch(dir, normalized, prefix, [
    track === "manual" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    lang,
    "--convert-subs",
    "srt",
  ]);
  const subs = files.filter((name) => name.endsWith(".srt") || name.endsWith(".vtt"));
  const file =
    subs.find((name) => /\.en\.srt$/.test(name)) ??
    subs.find((name) => name.endsWith(".srt")) ??
    subs.find((name) => /\.en\.vtt$/.test(name)) ??
    subs[0];
  if (!file) return null;
  const cues = parseSrt(await readFile(join(dir, file), "utf-8"));
  if (cues.length === 0) return null;
  const language = file.match(/(?:manual|autoc)\.([\w-]+)\.(?:srt|vtt)$/)?.[1] ?? lang;
  return { cues, language };
}

const WORD_NOTE =
  'Word-level timing from auto-captions (ASR): tight per-word start/end. ASR wording can differ slightly from what is said — pass prefer:"text" for the manual transcript wording (cue-level timing).';
const WORD_NOTE_FUZZY =
  'Word-level timing, APPROXIMATE phrase match — the auto-caption (ASR) wording differs from your query, so these are the closest spans. Check each match\'s `text`; pass prefer:"text" for the manual transcript.';
const CUE_NOTE =
  'Cue-level timing: phrase blocks ~1-6s, snapped to caption lines. For word-tight start/end pass prefer:"word" to use auto-caption word timing.';
const CUE_CAP = 400;

function cueResult(
  cues: SubtitleCue[],
  language: string,
  track: "auto" | "manual",
  query: string,
): SubtitleSearch {
  if (query) {
    const needle = query.toLowerCase();
    const matches = cues.filter((cue) => cue.text.toLowerCase().includes(needle)).slice(0, 25);
    return {
      available: true,
      language,
      track,
      precision: "cue",
      total_cues: cues.length,
      matches,
      note: CUE_NOTE,
    };
  }
  const result: SubtitleSearch = {
    available: true,
    language,
    track,
    precision: "cue",
    total_cues: cues.length,
    cues: cues.slice(0, CUE_CAP),
  };
  if (cues.length > CUE_CAP) {
    result.note = `Transcript truncated to ${CUE_CAP} of ${cues.length} cues; pass a query to find a phrase.`;
  }
  return result;
}

function wordResult(words: WordToken[], language: string, query: string): SubtitleSearch | null {
  if (query) {
    let matches = matchWordSpans(words, query).slice(0, 25);
    let note = WORD_NOTE;
    if (matches.length === 0) {
      matches = fuzzyWordSpans(words, query).slice(0, 10);
      if (matches.length === 0) return null;
      note = WORD_NOTE_FUZZY;
    }
    return {
      available: true,
      language,
      track: "auto",
      precision: "word",
      total_words: words.length,
      matches,
      note,
    };
  }
  return {
    available: true,
    language,
    track: "auto",
    precision: "word",
    total_words: words.length,
    cues: wordsToCues(words).slice(0, CUE_CAP),
    note: WORD_NOTE,
  };
}

// Fetch a video's timed captions and optionally find a phrase. Two caption kinds exist and
// trade off: AUTO (ASR) carries word-level timing but its wording can be wrong; MANUAL is
// accurate text but only cue-level (~1-6s blocks). `prefer` picks which to try first —
// "word" for the tightest loop window, "text" for faithful wording — and each falls back to
// the other so a result returns whenever any captions exist. The result always reports
// `precision` ("word"/"cue") and `track`, so the caller knows what it got. Returns
// available:false (no error) when the video has no captions, so the agent can just try.
export async function searchSubtitles(
  url: string,
  query: string,
  lang: string,
  prefer: SubtitlePrefer = "word",
): Promise<SubtitleSearch> {
  const normalized = normalizeYouTubeUrl(url);
  await assertSafeUrl(normalized);
  const dir = await mkdtemp(join(tmpdir(), "vcm-subsearch-"));
  const q = query.trim();
  try {
    if (prefer === "word") {
      const auto = await fetchAutoWords(dir, normalized, lang);
      const word = auto ? wordResult(auto.words, auto.language, q) : null;
      if (word) return word;
      const manual = await fetchCues(dir, normalized, lang, "manual");
      if (manual) return cueResult(manual.cues, manual.language, "manual", q);
      const autoCue = await fetchCues(dir, normalized, lang, "auto");
      if (autoCue) return cueResult(autoCue.cues, autoCue.language, "auto", q);
      return { available: false };
    }
    const manual = await fetchCues(dir, normalized, lang, "manual");
    if (manual) {
      const result = cueResult(manual.cues, manual.language, "manual", q);
      if (!q || (result.matches && result.matches.length > 0)) return result;
    }
    const auto = await fetchAutoWords(dir, normalized, lang);
    const word = auto ? wordResult(auto.words, auto.language, q) : null;
    if (word) return word;
    const autoCue = await fetchCues(dir, normalized, lang, "auto");
    if (autoCue) return cueResult(autoCue.cues, autoCue.language, "auto", q);
    return { available: false };
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

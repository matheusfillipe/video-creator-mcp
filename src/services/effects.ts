import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeComposition } from "../lib/composition-checks.js";
import { checkComposition } from "../lib/composition-checks.js";
import { ExecError, run } from "../lib/exec.js";
import { buildTimedDrawtext, charsPerLine, coverFilter, wrapText } from "../lib/ffmpeg.js";
import { assertSafeUrl } from "../lib/net.js";
import type { MediaMeta } from "../types.js";
import { type CaptionStyle, type Cue, buildAss } from "./captions.js";
import { loadMeta, writeMediaFromBuffer } from "./media.js";
import { saveRender } from "./publish.js";

const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;

// Sidechain-compressor settings that duck a music bed under a narration — the tuned "feel" that
// keeps the voice on top. Shared by every narration-over-music mux so it only lives in one place.
const SIDECHAIN_DUCK = "sidechaincompress=threshold=0.04:ratio=8:attack=15:release=400";
// Trim a music track's leading silence so a bed that fades in from quiet still fills a lead-in
// (otherwise the intro's silence lands exactly where the footage/music are meant to breathe).
const MUSIC_HEAD_TRIM = "silenceremove=start_periods=1:start_threshold=-50dB";

interface Caption {
  text: string;
  start: number;
  duration: number;
}
type CaptionPosition = "top" | "center" | "bottom";

interface CaptionParams {
  mediaId: string;
  captions: Caption[];
  position: CaptionPosition;
  fontSize?: number;
  color: string;
  box: boolean;
}

export type AudioMixMode = "replace" | "mix";

interface AudioMuxOptions {
  mode: AudioMixMode;
  volume: number;
  existingVolume: number;
  loop: boolean;
  startSec: number;
}

// ffmpeg args to mux an audio track onto a video, stream-copying the video. -stream_loop repeats a
// short track so it covers the whole video; amix's duration=first already caps a mix at the video,
// so -shortest is only needed to bound an otherwise-endless looped replace track. `padVideoSeconds`
// (a replace narration that outlasts the footage) freezes the last frame for that long so the whole
// narration stays audible instead of being cut — that path re-encodes, since tpad can't stream-copy.
function audioMuxArgs(
  videoPath: string,
  audioPath: string,
  opts: AudioMuxOptions,
  outFile: string,
  padVideoSeconds = 0,
): string[] {
  const delay = opts.startSec > 0 ? `adelay=${Math.round(opts.startSec * 1000)}:all=1,` : "";
  const audioFilter =
    opts.mode === "mix"
      ? `[0:a]volume=${opts.existingVolume}[a0];[1:a]${delay}volume=${opts.volume}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]`
      : `[1:a]${delay}volume=${opts.volume}[a]`;
  const args = ["-y", "-i", videoPath];
  if (opts.loop) args.push("-stream_loop", "-1");
  args.push("-i", audioPath);
  if (padVideoSeconds > 0) {
    args.push(
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${padVideoSeconds.toFixed(3)}[v];${audioFilter}`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
    );
  } else {
    args.push(
      "-filter_complex",
      audioFilter,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
    );
    if (opts.loop && opts.mode !== "mix") args.push("-shortest");
  }
  args.push(outFile);
  return args;
}

// Loop background music under a freshly-rendered silent video so a short track fills the whole
// clip. Lets the math/manim render tools bake in music without a separate video_add_audio round-trip.
export async function muxLoopedMusic(
  videoBuffer: Buffer,
  ext: string,
  musicMediaId: string,
  volume: number,
): Promise<Buffer> {
  const music = await loadMeta(musicMediaId);
  if (!music) {
    throw new Error(
      `Unknown music media_id "${musicMediaId}" — download it with video_download_media first.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "vcm-music-"));
  try {
    const videoPath = join(dir, `in${ext}`);
    await writeFile(videoPath, videoBuffer);
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      audioMuxArgs(
        videoPath,
        music.path,
        { mode: "replace", volume, existingVolume: 1, loop: true, startSec: 0 },
        outFile,
      ),
      { timeoutMs: 300_000 },
    );
    return readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Mux an audio track onto a video. "replace" makes it the sole audio (TTS narration over muted
// footage); "mix" blends it UNDER the video's existing audio (background music/ambient — the
// video must already have an audio stream). The video keeps its full length; with `loop` a track
// shorter than the video repeats to cover it (background music), otherwise it simply ends. Video
// is stream-copied, only the audio is re-encoded.
export async function addAudioTrack(params: {
  videoId: string;
  audioId: string;
  mode: AudioMixMode;
  volume: number;
  existingVolume: number;
  loop: boolean;
  startSec?: number;
}): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const video = await loadMeta(params.videoId);
  if (!video) {
    throw new Error(`Unknown video media_id "${params.videoId}" — render or download it first.`);
  }
  const audio = await loadMeta(params.audioId);
  if (!audio) {
    throw new Error(
      `Unknown audio media_id "${params.audioId}" — get it from video_tts or video_download_media.`,
    );
  }
  if (params.mode === "mix" && !video.hasAudio) {
    throw new Error(
      `Video ${params.videoId} has no audio to mix under — use mode "replace" for the first track.`,
    );
  }
  // A narration (replace, not a looped background track) that runs past the footage would be cut
  // to the video length; hold the last frame so the whole voiceover plays. A lead-in delay pushes
  // the track's end out too, so account for it.
  const startSec = params.startSec ?? 0;
  const audioEnd = startSec + audio.duration;
  const padVideoSeconds =
    params.mode === "replace" && !params.loop && audioEnd > video.duration + 0.1
      ? audioEnd - video.duration
      : 0;
  const dir = await mkdtemp(join(tmpdir(), "vcm-audio-"));
  try {
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      audioMuxArgs(
        video.path,
        audio.path,
        {
          mode: params.mode,
          volume: params.volume,
          existingVolume: params.existingVolume,
          loop: params.loop,
          startSec,
        },
        outFile,
        padVideoSeconds,
      ),
      { timeoutMs: 300_000 },
    );
    const buffer = await readFile(outFile);
    const meta = await writeMediaFromBuffer({
      idSeed: `addaudio:${params.videoId}:${params.audioId}:${params.mode}:${params.volume}:${params.existingVolume}:${params.loop}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `addaudio://${params.videoId}`,
    });
    return { buffer, meta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Compose a narration over a music bed in ONE deterministic pass: the music plays from 0:00 at a low
// level and is sidechain-ducked whenever the narration speaks, so the voice is always clearly on top
// and the lead-in keeps the music. Avoids the ordering traps of chaining two separate mux calls. The
// video is held on its last frame if the narration runs past it, so nothing is cut.
export async function narrateOverMusic(params: {
  videoId: string;
  narrationId: string;
  musicId: string;
  leadInSec: number;
  musicVolume: number;
  narrationVolume: number;
}): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const video = await loadMeta(params.videoId);
  if (!video) {
    throw new Error(`Unknown video media_id "${params.videoId}" — render or download it first.`);
  }
  const narration = await loadMeta(params.narrationId);
  if (!narration) {
    throw new Error(`Unknown narration media_id "${params.narrationId}" — get it from video_tts.`);
  }
  const music = await loadMeta(params.musicId);
  if (!music) {
    throw new Error(
      `Unknown music media_id "${params.musicId}" — download it with video_download_media first.`,
    );
  }

  const leadMs = Math.round(params.leadInSec * 1000);
  const narrationEnd = params.leadInSec + narration.duration;
  const total = Math.max(video.duration, narrationEnd);
  const padVideo = narrationEnd > video.duration + 0.1 ? total - video.duration : 0;
  const filter = [
    `[1:a]${MUSIC_HEAD_TRIM},volume=${params.musicVolume}[mus]`,
    `[2:a]adelay=${leadMs}:all=1,volume=${params.narrationVolume},asplit=2[nar1][nar2]`,
    `[mus][nar1]${SIDECHAIN_DUCK}[musd]`,
    "[musd][nar2]amix=inputs=2:duration=longest:normalize=0[a]",
  ].join(";");

  const args = [
    "-y",
    "-i",
    video.path,
    "-stream_loop",
    "-1",
    "-i",
    music.path,
    "-i",
    narration.path,
  ];
  if (padVideo > 0) {
    args.push(
      "-filter_complex",
      `[0:v]tpad=stop_mode=clone:stop_duration=${padVideo.toFixed(3)}[v];${filter}`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
    );
  } else {
    args.push("-filter_complex", filter, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy");
  }
  args.push("-c:a", "aac", "-t", total.toFixed(3), "-movflags", "+faststart");

  const dir = await mkdtemp(join(tmpdir(), "vcm-narr-"));
  try {
    const outFile = join(dir, "out.mp4");
    args.push(outFile);
    await run("ffmpeg", args, { timeoutMs: 300_000 });
    const buffer = await readFile(outFile);
    const meta = await writeMediaFromBuffer({
      idSeed: `narrate:${params.videoId}:${params.narrationId}:${params.musicId}:${params.leadInSec}:${params.musicVolume}:${params.narrationVolume}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `narrate://${params.videoId}`,
    });
    return { buffer, meta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface NarratedScene {
  footagePath: string;
  duration: number;
  // Fade this scene's own clip in/out (to/from black), independent of duration: a scene
  // transition, not a crossfade, so no time is borrowed from either scene and narration sync
  // is unaffected.
  fadeInSec?: number;
  fadeOutSec?: number;
}

// Build a narrated montage that stays in sync BY CONSTRUCTION: each scene's footage is cut to the
// exact length of its own narration line, so when scene N is on screen, line N is heard — no
// timestamps, no alignment, works at any length. `narration` is the lines already stitched into one
// track; a lead-in delays it so the footage/music breathe first, and an optional music bed is
// sidechain-ducked under the voice.
export async function narratedScenes(params: {
  scenes: NarratedScene[];
  narration: Buffer;
  leadInSec: number;
  music?: { path: string; volume: number };
  captions?: Cue[];
  captionStyle?: CaptionStyle;
  captionMode?: "block" | "karaoke";
  tailSec?: number;
  width: number;
  height: number;
  fps: number;
}): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const { width: w, height: h, fps } = params;
  const tailSec = params.tailSec ?? 0;
  const lastIndex = params.scenes.length - 1;
  const total = params.leadInSec + params.scenes.reduce((sum, s) => sum + s.duration, 0) + tailSec;
  const dir = await mkdtemp(join(tmpdir(), "vcm-scenes-"));
  try {
    const sceneFiles: string[] = [];
    for (const [i, scene] of params.scenes.entries()) {
      // The last scene holds a little longer than its line so the video (and music) breathe out
      // instead of hard-cutting the instant the last word ends.
      const clipDur =
        (i === 0 ? scene.duration + params.leadInSec : scene.duration) +
        (i === lastIndex ? tailSec : 0);
      const out = join(dir, `scene${i}.mp4`);
      // -stream_loop repeats a real video source to cover clipDur; a still image has nothing to
      // loop and needs the image demuxer's own -loop instead.
      const inputArgs = IMAGE_RE.test(scene.footagePath)
        ? ["-loop", "1", "-i", scene.footagePath, "-t", clipDur.toFixed(3)]
        : ["-stream_loop", "-1", "-i", scene.footagePath, "-t", clipDur.toFixed(3)];
      const fadeFilters: string[] = [];
      if (scene.fadeInSec !== undefined) {
        fadeFilters.push(`fade=t=in:st=0:d=${scene.fadeInSec.toFixed(3)}`);
      }
      if (scene.fadeOutSec !== undefined) {
        const fadeStart = Math.max(0, clipDur - scene.fadeOutSec);
        fadeFilters.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${scene.fadeOutSec.toFixed(3)}`);
      }
      await run(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          ...inputArgs,
          "-vf",
          [coverFilter(w, h), `fps=${fps}`, ...fadeFilters].join(","),
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          out,
        ],
        { timeoutMs: 300_000 },
      );
      sceneFiles.push(out);
    }
    const videoList = join(dir, "videos.txt");
    await writeFile(videoList, sceneFiles.map((f) => `file '${f}'`).join("\n"));
    const silentVideo = join(dir, "video.mp4");
    await run(
      "ffmpeg",
      ["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", videoList, "-c", "copy", silentVideo],
      { timeoutMs: 300_000 },
    );

    const narration = join(dir, "narration.wav");
    await writeFile(narration, params.narration);
    const leadMs = Math.round(params.leadInSec * 1000);
    const delay = leadMs > 0 ? `adelay=${leadMs}:all=1,` : "";

    // Captions burn in the same pass as the audio mux (one re-encode), pinned in a safe band above
    // which the scene content lives. "block" = static phrase cues via drawtext; "karaoke" = ASS
    // (libass) that sweeps each word to the highlight colour as it is spoken, using per-word times.
    const captionStyle: CaptionStyle = params.captionStyle ?? {
      color: "white",
      position: "bottom",
      fontScale: 1,
      background: "box",
      shadow: true,
      outline: true,
    };
    let captionChain = "";
    let blurCues: Cue[] = [];
    if (params.captions?.length) {
      // A cue-level style may pick its own mode, so one video can mix segments: karaoke cues go
      // through libass, block cues through drawtext, chained in the same filter pass.
      const defaultMode = params.captionMode ?? "block";
      const modeOf = (cue: Cue) => cue.style?.mode ?? defaultMode;
      const karaokeCues = params.captions.filter((cue) => modeOf(cue) === "karaoke");
      const blockCues = params.captions.filter((cue) => modeOf(cue) === "block");
      const chains: string[] = [];
      if (karaokeCues.length) {
        chains.push(await karaokeSubtitleFilter(dir, karaokeCues, w, h, captionStyle));
      }
      if (blockCues.length) {
        chains.push(await captionFilterChain(dir, blockCues, w, h, captionStyle));
      }
      captionChain = chains.join(",");
      blurCues = params.captions.filter((cue) => (cue.style ?? captionStyle).background === "blur");
    }
    const videoPre = blurCues.length
      ? blurBandPre(blurCues, captionStyle, w, h, captionChain)
      : captionChain
        ? `[0:v]${captionChain}[v];`
        : "";
    const videoMap = captionChain ? "[v]" : "0:v:0";

    const outFile = join(dir, "out.mp4");
    const args = ["-nostdin", "-y", "-i", silentVideo];
    if (params.music) {
      args.push(
        "-stream_loop",
        "-1",
        "-i",
        params.music.path,
        "-i",
        narration,
        "-filter_complex",
        `${videoPre}[1:a]${MUSIC_HEAD_TRIM},volume=${params.music.volume}[mus];[2:a]${delay}asplit=2[nar1][nar2];[mus][nar1]${SIDECHAIN_DUCK}[musd];[musd][nar2]amix=inputs=2:duration=longest:normalize=0[a]`,
        "-map",
        videoMap,
        "-map",
        "[a]",
      );
    } else {
      args.push(
        "-i",
        narration,
        "-filter_complex",
        `${videoPre}[1:a]${delay}anull[a]`,
        "-map",
        videoMap,
        "-map",
        "[a]",
      );
    }
    args.push(
      ...(captionChain
        ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]
        : ["-c:v", "copy"]),
      "-c:a",
      "aac",
      "-t",
      total.toFixed(3),
      "-movflags",
      "+faststart",
      outFile,
    );
    await run("ffmpeg", args, { timeoutMs: 300_000 });

    const buffer = await readFile(outFile);
    const meta = await writeMediaFromBuffer({
      idSeed: `scenes:${w}x${h}:${params.leadInSec}:${tailSec}:${params.music?.volume ?? "none"}:${params.captionMode ?? "block"}:${JSON.stringify(params.captionStyle ?? {})}:${params.narration.length}:${params.scenes.map((s) => `${s.footagePath}@${s.duration.toFixed(2)}:${s.fadeInSec ?? ""}:${s.fadeOutSec ?? ""}`).join(",")}:${(params.captions ?? []).map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)}:${c.text}:${c.style ? JSON.stringify(c.style) : ""}`).join("|")}`,
      buffer,
      ext: ".mp4",
      sourceUrl: "scenes://narrated",
    });
    return { buffer, meta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A "blur" caption background is drawn as a second video layer, not a drawtext flag: split the
// frame, blur + darken a horizontal band at the caption's position, and composite that band back
// under the caption chain so the text renders on top of it. The band's enable window is the union
// of every blur cue's [start,end], so it only darkens the footage while a blur cue is actually on
// screen. All blur cues share one band (the track's position), so pick the first one's style.
function blurBandPre(
  blurCues: Cue[],
  trackStyle: CaptionStyle,
  width: number,
  height: number,
  captionChain: string,
): string {
  const first = blurCues[0] as Cue;
  const style = first.style ?? trackStyle;
  // The band must hug the text, so it is sized from the same font the caption renders at and
  // from how many lines the longest blur cue actually wraps to, not a fixed multiple.
  const capFont = Math.max(20, Math.round((height / 23) * style.fontScale));
  const cpl = Math.max(1, charsPerLine(width, capFont));
  const lines = Math.min(
    3,
    Math.max(1, ...blurCues.map((cue) => Math.ceil(cue.text.length / cpl))),
  );
  const lineH = Math.round(capFont * 1.3);
  const pad = Math.round(capFont * 0.55);
  const textH = lineH * lines;
  const bandH = textH + pad * 2;
  // The caption text sits this far from its edge (matches the drawtext/ASS margins), so the band
  // is placed to bracket the text with `pad` above and below rather than floating over it.
  const textMargin = Math.round(height * 0.075);
  const bandY =
    style.position === "top"
      ? Math.max(0, textMargin - pad)
      : style.position === "center"
        ? Math.round((height - bandH) / 2)
        : Math.max(0, height - textMargin - textH - pad);
  // between()'s own comma-separated arguments must be escaped inside the enable expression,
  // otherwise ffmpeg's option parser reads them as filter-option separators instead.
  const windows = blurCues
    .map((cue) => `between(t\\,${cue.start.toFixed(3)}\\,${cue.end.toFixed(3)})`)
    .join("+");
  return (
    `[0:v]split=2[cb0][cb1];[cb1]crop=iw:${bandH}:0:${bandY},` +
    `boxblur=luma_radius=14:luma_power=1,drawbox=x=0:y=0:w=iw:h=${bandH}:color=black@0.22:t=fill[cbb];` +
    `[cb0][cbb]overlay=0:${bandY}:enable='${windows}'[cbg];[cbg]${captionChain}[v];`
  );
}

// Comma-joined drawtext chain for a static ("block") caption cue track: each cue wrapped to the
// frame width and shown only over its own [start,end], sized to the frame and pinned in a safe band.
async function captionFilterChain(
  dir: string,
  cues: Cue[],
  width: number,
  height: number,
  style: CaptionStyle,
): Promise<string> {
  const filters: string[] = [];
  for (const [i, cue] of cues.entries()) {
    const cueStyle = cue.style ?? style;
    const fontSize = Math.max(20, Math.round((height / 26) * cueStyle.fontScale));
    const file = join(dir, `cue${i}.txt`);
    await writeFile(file, wrapText(cue.text, charsPerLine(width, fontSize)));
    filters.push(
      buildTimedDrawtext({
        textFile: file,
        start: cue.start,
        end: cue.end,
        position: cueStyle.position,
        fontSize,
        color: cueStyle.color,
        background: cueStyle.background,
        shadow: cueStyle.shadow,
        outline: cueStyle.outline,
        margin: Math.round(height * 0.08),
      }),
    );
  }
  return filters.join(",");
}

// Write the cue track as an ASS document and return the libass `subtitles` filter for it. Used for
// karaoke: libass sweeps each word to the highlight colour as it is spoken (per-word timings) and
// owns wrapping + safe margins itself.
async function karaokeSubtitleFilter(
  dir: string,
  cues: Cue[],
  width: number,
  height: number,
  style: CaptionStyle,
): Promise<string> {
  const assPath = join(dir, "captions.ass");
  await writeFile(assPath, buildAss(cues, width, height, style, true));
  const escaped = assPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return `subtitles=${escaped}`;
}

// Burn timed text onto a clip with a single ffmpeg drawtext pass — the cheap path for
// "loop a clip and talk to the viewer with rotating subtitles": libx264 re-encodes once
// in roughly real time, versus a headless-chrome composition rendering every frame in
// software GL at ~3x real time.
export async function captionMedia(
  params: CaptionParams,
): Promise<{ buffer: Buffer; meta: MediaMeta }> {
  const meta = await loadMeta(params.mediaId);
  if (!meta) {
    throw new Error(
      `Unknown media_id "${params.mediaId}" — download it first with video_download_media.`,
    );
  }
  if (params.captions.length === 0) {
    throw new Error("captions must contain at least one entry");
  }
  const dir = await mkdtemp(join(tmpdir(), "vcm-caption-"));
  try {
    const fontSize = params.fontSize ?? Math.max(24, Math.round((meta.height || 1080) / 20));
    const filters: string[] = [];
    for (const [index, caption] of params.captions.entries()) {
      const textFile = join(dir, `cap${index}.txt`);
      await writeFile(textFile, caption.text);
      filters.push(
        buildTimedDrawtext({
          textFile,
          start: caption.start,
          end: caption.start + caption.duration,
          position: params.position,
          fontSize,
          color: params.color,
          background: params.box ? "box" : "none",
          shadow: false,
          outline: false,
        }),
      );
    }
    const outFile = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      [
        "-y",
        "-i",
        meta.path,
        "-vf",
        filters.join(","),
        "-c:a",
        "copy",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outFile,
      ],
      { timeoutMs: 300_000 },
    );
    const buffer = await readFile(outFile);
    const captionedMeta = await writeMediaFromBuffer({
      idSeed: `caption:${params.mediaId}:${params.position}:${fontSize}:${params.color}:${params.box}:${JSON.stringify(params.captions)}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `caption://${params.mediaId}`,
    });
    return { buffer, meta: captionedMeta };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type BackgroundFormat = "webm" | "mov" | "png";

// hyperframes' linter checks a standalone project, so some of its findings never apply to a
// composition rendered through this server, and acting on them makes an author rewrite a scene
// that already works: renderComposition wraps a bare composition in a full HTML document and
// injects the animation libraries, and the hyperframes runtime seeks anime.js timelines
// registered on window.__hfAnime — which the GSAP-only registry check cannot see.
const ADAPTER_REGISTRIES = ["__hfAnime", "__hfLottie"];
const ALWAYS_INAPPLICABLE = ["root_composition_missing_html_wrapper", "missing_gsap_script"];
const GSAP_ONLY_FINDING = "missing_timeline_registry";
const FINDING_START_RE = /^\s*([\u2717\u26a0])\s/;
const CONTINUATION_RE = /^\s{4,}\S/;
const SUMMARY_RE = /^(\s*\u25c7\s+)\d+( error\(s\), )\d+( warning\(s\))/;

export function dropInapplicableFindings(lintOutput: string, html: string): string {
  const drivenByAdapter = ADAPTER_REGISTRIES.some((registry) => html.includes(registry));
  const inapplicable = (line: string): boolean =>
    ALWAYS_INAPPLICABLE.some((finding) => line.includes(finding)) ||
    (drivenByAdapter && line.includes(GSAP_ONLY_FINDING));

  const kept: string[] = [];
  let errors = 0;
  let warnings = 0;
  let skipping = false;
  for (const line of lintOutput.split("\n")) {
    const finding = FINDING_START_RE.exec(line);
    if (finding) {
      skipping = inapplicable(line);
      if (!skipping) {
        if (finding[1] === "\u2717") errors += 1;
        else warnings += 1;
      }
    } else if (skipping && !CONTINUATION_RE.test(line)) {
      // the finding's indented "Fix:" lines are its only continuation; anything else
      // (the summary, a blank line) belongs to the report, not to the dropped finding.
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept
    .map((line) =>
      line.replace(SUMMARY_RE, (_m, head, mid, tail) => `${head}${errors}${mid}${warnings}${tail}`),
    )
    .join("\n");
}

export async function lintComposition(htmlBase64: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-lint-"));
  try {
    const html = decodeComposition(htmlBase64);
    await writeFile(join(dir, "index.html"), html);
    const { stdout, stderr } = await run("hyperframes", ["lint", dir], {
      timeoutMs: 30_000,
      allowNonZero: true,
    });
    const report = dropInapplicableFindings(stdout || stderr, html);
    const extra = checkComposition(html);
    const combined = [report.trimEnd(), ...extra.map((finding) => `  ${finding}`)]
      .filter(Boolean)
      .join("\n");
    return combined || "Lint passed — no issues found.";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeBackground(
  input: string,
  format: BackgroundFormat,
): Promise<MediaMeta> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-rmbg-"));
  try {
    let inputFile: string;
    if (input.startsWith("http")) {
      await assertSafeUrl(input);
      inputFile = join(dir, "input.mp4");
      await run("curl", ["-sL", "--max-redirs", "5", "-o", inputFile, "--max-time", "120", input], {
        timeoutMs: 130_000,
      });
    } else {
      const meta = await loadMeta(input);
      if (!meta) throw new Error(`Media ${input} not found in cache`);
      inputFile = meta.path;
    }

    const isImage = IMAGE_RE.test(inputFile);
    if (!isImage && format === "png") {
      throw new Error("PNG output is only valid for image input; use 'webm' or 'mov' for video");
    }
    const outFormat: BackgroundFormat = isImage ? "png" : format;
    const outputPath = join(dir, `out.${outFormat}`);
    await run("hyperframes", ["remove-background", "-o", outputPath, inputFile], {
      timeoutMs: 300_000,
    });
    const buffer = await readFile(outputPath);
    return writeMediaFromBuffer({
      idSeed: `rmbg:${input}:${outFormat}`,
      buffer,
      ext: `.${outFormat}`,
      sourceUrl: `rmbg://${input}`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Extracts ONE frame from an already-resolved local file, no media_id lookup: the shared
// primitive behind extractFrame (a cached clip) and the composition frame preview (a scene's
// resolved visual, before it's ever muxed into a full render). The requested time is clamped
// to the source's own length so a seek past the end (a preview offset longer than an untrimmed
// clip, which the real render would cover by looping) returns the last frame instead of failing.
export async function frameBufferFromPath(path: string, timeSec: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-frame-"));
  try {
    const seek = Math.max(0, Math.min(timeSec, await sourceDurationSec(path)));
    const out = join(dir, "frame.png");
    await run(
      "ffmpeg",
      ["-y", "-ss", String(seek), "-i", path, "-frames:v", "1", "-vsync", "0", out],
      { timeoutMs: 60_000 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A still image (or an unreadable duration) reports 0 so the seek clamps to the single frame.
async function sourceDurationSec(path: string): Promise<number> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { timeoutMs: 30_000, allowNonZero: true },
  );
  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : 0;
}

export async function extractFrame(params: {
  mediaId: string;
  timeSec: number;
}): Promise<{ buffer: Buffer; meta: MediaMeta; url: string; filename: string }> {
  const meta = await loadMeta(params.mediaId);
  if (!meta) {
    throw new Error(`Unknown media_id "${params.mediaId}" — download it first.`);
  }
  const time = Math.max(0, Math.min(params.timeSec, Math.max(0, meta.duration - 0.05)));
  const buffer = await frameBufferFromPath(meta.path, time);
  const imageMeta = await writeMediaFromBuffer({
    idSeed: `frame:${params.mediaId}:${time}`,
    buffer,
    ext: ".png",
    sourceUrl: `frame://${params.mediaId}@${time}`,
  });
  const saved = await saveRender(buffer, imageMeta.filename);
  return { buffer, meta: imageMeta, url: saved.url, filename: imageMeta.filename };
}

// A chrome render can "succeed" while its GSAP animations never fire, leaving nothing but the
// page background: no frame ever contains a bright pixel. YMAX, not YAVG, is the discriminator —
// any drawn text or line-work pushes the frame maximum near 255, while a dark backdrop keeps the
// average low whether or not anything was drawn on it.
export const BLACK_OUTPUT_YMAX = 80;
const LUMA_SAMPLE_STRIDE_FRAMES = 15;
const YMAX_RE = /YMAX=(\d+)/g;

// NaN when the probe found no frames, so a caller's `< BLACK_OUTPUT_YMAX` test stays false.
export async function maxFrameLumaOfFile(filePath: string): Promise<number> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      filePath,
      "-vf",
      `select='not(mod(n\\,${LUMA_SAMPLE_STRIDE_FRAMES}))',signalstats,metadata=print:key=lavfi.signalstats.YMAX`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 120_000 },
  );
  let max = Number.NaN;
  for (const match of stderr.matchAll(YMAX_RE)) {
    const value = Number(match[1]);
    if (Number.isNaN(max) || value > max) max = value;
  }
  return max;
}

export function blackOutputWarning(maxLuma: number): string | null {
  if (!(maxLuma < BLACK_OUTPUT_YMAX)) return null;
  return `Rendered video looks BLACK/empty: no sampled frame has a pixel brighter than ${Math.round(maxLuma)}/255, so the composition's elements never became visible. Most common cause: GSAP tweens that never fire — give every element its initial state with gsap.set(...) and animate with .to(...) tweens, then re-render. Check a mid-scene frame with video_preview_frame before re-rendering.`;
}

// A composition whose timeline never ran still renders: the browser paints the CSS start state for
// every frame. The output is bright, so the black-frame check passes, and the model reports success
// on a still image. freezedetect reports the frozen spans; a span covering the whole clip means
// nothing ever moved.
const FREEZE_NOISE_TOLERANCE = 0.003;
const FREEZE_START_RE = /freeze_start:\s*([0-9.]+)/g;
const STATIC_COVERAGE = 0.9;

export function staticRenderWarning(
  freezeStarts: number[],
  durationSeconds: number,
): string | null {
  const fromTheStart = freezeStarts.some(
    (start) => start <= durationSeconds * (1 - STATIC_COVERAGE),
  );
  if (!fromTheStart) return null;
  return "Rendered video NEVER CHANGES — every frame is identical, so the timeline never drove anything. Check that the timeline is registered (window.__timelines for GSAP, window.__hfAnime for anime.js) and that the whole document survived base64 encoding. Re-render after fixing.";
}

export async function freezeStarts(filePath: string): Promise<number[]> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      filePath,
      "-vf",
      `freezedetect=n=${FREEZE_NOISE_TOLERANCE}:d=2`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 120_000 },
  );
  return [...stderr.matchAll(FREEZE_START_RE)].map((match) => Number(match[1]));
}

export const DURATION_RE = /data-duration="([0-9.]+)"/;

// These probes run after the video is uploaded, so a probe failure must never fail the job.
// A composition can fail two ways that still produce a valid mp4: nothing was ever drawn (black),
// or nothing ever moved (the timeline never ran).
export async function renderWarnings(buffer: Buffer, durationSeconds: number): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-verify-"));
  try {
    const file = join(dir, "render.mp4");
    await writeFile(file, buffer);
    const warnings = [
      blackOutputWarning(await maxFrameLumaOfFile(file)),
      staticRenderWarning(await freezeStarts(file), durationSeconds),
    ];
    return warnings.filter((warning): warning is string => warning !== null);
  } catch (error) {
    if (error instanceof ExecError) return [];
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

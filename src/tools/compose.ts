import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../lib/exec.js";
import { charsPerLine, validateColor } from "../lib/ffmpeg.js";
import { contentTypeForExt } from "../lib/mime.js";
import { alignWords } from "../services/align.js";
import {
  type Cue,
  type CueStyle,
  fontScaleFor,
  groupIntoCues,
  offsetCues,
} from "../services/captions.js";
import { combineSceneVisuals, containVisual, sequenceSceneVisuals } from "../services/edit.js";
import { type NarratedScene, frameBufferFromPath, narratedScenes } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderMathShortCached } from "../services/manim.js";
import { fetchMediaToId, loadMeta, writeMediaFromBuffer } from "../services/media.js";
import {
  TTS_WORDS_PER_SEC,
  concatWavs,
  countWords,
  extractCloneClip,
  silenceWav,
  synthesizeSpeechCached,
  wavDurationSec,
} from "../services/narration.js";
import { saveRender } from "../services/publish.js";
import { separateVocals } from "../services/separate.js";
import { storage } from "../services/storage.js";
import { dimsFor } from "../services/timeline.js";
import type { MediaMeta } from "../types.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, metadataArg } from "./shared.js";

// ---------------------------------------------------------------------------
// The composition language (narrated subset).
//
// A composition is tracks of clips; tracks are parallel layers, clips on a track
// run in sequence. A clip can itself be a composition (a scene). Styling cascades:
// root `defaults` -> scene `defaults` -> the clip itself, nearest wins per key.
// ---------------------------------------------------------------------------

const CAPTION_STYLE_FIELDS = z
  .object({
    mode: z
      .enum(["block", "karaoke"])
      .optional()
      .describe("block = static phrase cues; karaoke = words highlight as spoken."),
    color: z
      .string()
      .optional()
      .describe(
        "Karaoke: colour of the ACTIVE word as it is spoken. Block: the text colour. Hex #RRGGBB or a basic name.",
      ),
    spoken_color: z
      .string()
      .optional()
      .describe(
        "Karaoke only: colour of words already spoken (behind the highlight). Hex or name. Defaults to a warm gold.",
      ),
    upcoming_color: z
      .string()
      .optional()
      .describe(
        "Karaoke only: colour of words not yet spoken (greyed ahead of the highlight). Hex or name. Defaults to grey.",
      ),
    position: z.enum(["bottom", "center", "top"]).optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
    background: z
      .enum(["none", "box", "blur"])
      .optional()
      .describe(
        "Backing behind the text: none = text only, box = translucent solid panel, blur = a frosted blurred strip. Preferred over the legacy `box` field.",
      ),
    shadow: z.boolean().optional().describe("Drop shadow under the text, for legibility."),
    outline: z.boolean().optional().describe("Dark outline around the glyphs, for legibility."),
    box: z
      .boolean()
      .optional()
      .describe(
        'Legacy shorthand for background: true = "box", false = "none". Ignored when background is also set.',
      ),
  })
  .strict();

const VOICE_FIELDS = z
  .object({
    reference_media_id: z
      .string()
      .optional()
      .describe("media_id of a clip to clone the narrator voice from."),
    exaggeration: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("Acting intensity: 0.3 calm, 0.55 natural, 0.9 dramatic."),
    cfg_weight: z.number().min(0).max(1).optional().describe("Pacing: lower = slower."),
    temperature: z.number().min(0.1).max(1.5).optional().describe("Delivery variation."),
  })
  .strict();

const DEFAULTS_FIELDS = z
  .object({
    caption: CAPTION_STYLE_FIELDS.optional(),
    voice: VOICE_FIELDS.optional(),
  })
  .strict();

const VIDEO_CLIP = z
  .object({
    type: z.literal("video"),
    media_id: z
      .string()
      .min(1)
      .describe("Footage/image from video_download_media, fitted to the scene length."),
    in: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Seconds into the source to start playing from (a source trim), independent of the scene's own duration.",
      ),
    out: z.number().positive().optional().describe("Seconds into the source to stop playing at."),
    fit: z
      .enum(["cover", "contain"])
      .optional()
      .describe(
        "How a still image fills the frame: cover (default) crops it to fill with a slow zoom-in; contain shows the WHOLE image (no crop) centered over a blurred fill of itself, with a gentle push-in. Use contain for screenshots/text where cropping the borders loses the point. Only applies to a single-visual still-image scene.",
      ),
  })
  .strict();

const GRAPHIC_CLIP = z
  .object({
    type: z.literal("graphic"),
    kind: z.literal("math"),
    latex: z.string().min(1).describe("LaTeX formula, e.g. 'a^2 + b^2 = c^2'."),
    plot_expr: z.string().optional().describe("Optional numpy expression to graph, e.g. 'sin(x)'."),
    x_range: z.array(z.number()).length(2).optional().describe("[min, max] x-axis."),
    y_range: z.array(z.number()).length(2).optional().describe("[min, max] y-axis."),
    title: z.string().optional().describe("Heading above the formula."),
    accent_color: z.string().optional().describe("Hex or basic color for the formula/graph."),
  })
  .strict();

const VOICE_CLIP = z
  .object({
    type: z.literal("voice"),
    text: z.string().min(1).describe("The narration spoken during this scene."),
    start: z
      .number()
      .min(0)
      .max(30)
      .default(0)
      .describe("Seconds into the scene before the voice starts (footage/music play first)."),
    voice: VOICE_FIELDS.optional().describe("Override the inherited voice for this scene."),
  })
  .strict();

const CAPTION_CLIP = z
  .object({
    type: z.literal("caption"),
    from: z
      .literal("voice")
      .default("voice")
      .describe("Captions are force-aligned to this scene's voice clip."),
    offset: z
      .number()
      .min(-5)
      .max(5)
      .default(0)
      .describe("Shift this scene's cues in seconds (negative = appear early)."),
    style: CAPTION_STYLE_FIELDS.optional().describe("Override the inherited caption style."),
  })
  .strict();

const AUDIO_CLIP = z
  .object({
    type: z.literal("audio"),
    media_id: z.string().min(1).describe("Music bed from video_download_media."),
    volume: z
      .number()
      .min(0)
      .max(2)
      .default(0.25)
      .describe("Bed volume; it is also sidechain-ducked under the voice."),
  })
  .strict();

const SCENE_TRACK = z
  .object({
    clips: z
      .array(z.discriminatedUnion("type", [VIDEO_CLIP, GRAPHIC_CLIP, VOICE_CLIP, CAPTION_CLIP]))
      .min(1),
  })
  .strict();

// Duration-preserving: a crossfade would eat overlap time from both scenes and break narration
// sync, so this fades the outgoing scene to black and fades the next one in from black instead;
// no scene's length changes.
const TRANSITION_OUT = z
  .object({
    kind: z.literal("fade"),
    sec: z.number().min(0.1).max(1.5).default(0.4),
  })
  .strict();

const SCENE_LAYOUT = z
  .enum(["single", "vstack", "hstack", "grid", "pip", "sequence"])
  .default("single")
  .describe(
    "How this scene's visual clips are arranged: single = one visual (default). sequence = 2-6 visuals played one after another, each for an equal share of the scene, while the scene's single voice + captions keep going (the picture cuts without cutting the narration). vstack/hstack need exactly 2 (top/bottom or left/right). grid takes 2-4. pip needs exactly 2 (first = fullscreen base, second = corner inset).",
  );

const SCENE = z
  .object({
    type: z.literal("composition"),
    id: z.string().optional().describe("Stable handle for this scene (used in the timeline)."),
    duration: z
      .union([z.literal("fit"), z.number().positive()])
      .default("fit")
      .describe('"fit" = as long as its voice; a number holds the scene that many seconds.'),
    layout: SCENE_LAYOUT,
    defaults: DEFAULTS_FIELDS.optional().describe("Style defaults for this scene's clips."),
    tracks: z.array(SCENE_TRACK).min(1).describe("Parallel layers inside the scene."),
    transition_out: TRANSITION_OUT.optional().describe(
      "Fade this scene to black at its end and fade the next scene in from black at its start; does not change either scene's duration.",
    ),
  })
  .strict();

const OUTER_TRACK = z
  .object({
    clips: z.array(z.discriminatedUnion("type", [SCENE, AUDIO_CLIP])).min(1),
  })
  .strict();

const TRANSCRIPT = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(
        "The words in the order they are spoken/sung (line breaks are fine). Force-aligned to the audio so each word lights up as it is heard — karaoke-style captions over the whole video. Works for song lyrics or a plain speech/narration transcript.",
      ),
    media_id: z
      .string()
      .optional()
      .describe(
        "Audio to align the words to. Omit to use the audio track's media_id (the usual case: the same clip you play IS what the words align to).",
      ),
    audio_kind: z
      .enum(["speech", "sung"])
      .default("speech")
      .describe(
        "sung = the audio is a SONG (vocals over music); the vocals are isolated before aligning so the words land on the beat (use this for karaoke over a real song). speech = plain spoken audio, aligned directly. Sung adds a separation pass (~real-time, CPU).",
      ),
    caption: CAPTION_STYLE_FIELDS.optional().describe(
      "Style for the words. Defaults to karaoke highlight, centered.",
    ),
  })
  .strict();

export const COMPOSITION = z
  .object({
    version: z.literal(1).default(1),
    output: z
      .object({
        resolution: RESOLUTION.default("landscape"),
        fps: z.number().int().min(24).max(60).default(30),
        tail_sec: z
          .number()
          .min(0)
          .max(5)
          .default(0.6)
          .describe("Hold after the final word so the video breathes out."),
      })
      .strict()
      .default({ resolution: "landscape", fps: 30, tail_sec: 0.6 }),
    defaults: DEFAULTS_FIELDS.optional().describe(
      "Cascading style defaults inherited by every scene unless overridden.",
    ),
    tracks: z
      .array(OUTER_TRACK)
      .min(1)
      .describe("One track of scene compositions (sequential) + optionally one music track."),
    media: z
      .record(z.string(), z.string().url())
      .optional()
      .describe(
        "media_id -> durable url, copied from a prior render's recipe sidecar. Lets media_ids this composition references be fetched back into the cache when they're missing locally (e.g. a reopened recipe on a fresh pod).",
      ),
    transcript: TRANSCRIPT.optional().describe(
      "Word-synced captions over the whole video, aligned to a provided audio clip (song lyrics OR a plain speech/narration transcript). Put the audio on an audio track (volume ~1.0, it is the main track not a background bed) and its words here; each word highlights as heard. For a SONG set audio_kind:'sung' (the vocals are isolated before aligning, or the backing music throws the sync off). Size the scenes to sum to the audio's length (video_analyze_audio reports it).",
    ),
  })
  .strict();

export type Composition = z.infer<typeof COMPOSITION>;
type SceneClip = z.infer<typeof SCENE>;
type SceneLayout = z.infer<typeof SCENE_LAYOUT>;
type MathGraphic = z.infer<typeof GRAPHIC_CLIP>;
type CaptionSpec = z.infer<typeof CAPTION_STYLE_FIELDS>;
type VoiceSpec = z.infer<typeof VOICE_FIELDS>;

export interface Finding {
  path: string;
  severity: "error" | "warning";
  message: string;
  hint?: string;
}

interface ResolvedVoice {
  text: string;
  start: number;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  referenceId?: string;
}

type ResolvedVisual =
  | { kind: "video"; mediaId: string; in?: number; out?: number; fit?: "cover" | "contain" }
  | { kind: "math"; math: MathGraphic };

// Minimum/maximum visual clip count each layout accepts; "single" is checked separately so its
// finding message stays exactly what it was before layouts existed.
const LAYOUT_VISUAL_COUNTS: Record<Exclude<SceneLayout, "single">, { min: number; max: number }> = {
  vstack: { min: 2, max: 2 },
  hstack: { min: 2, max: 2 },
  pip: { min: 2, max: 2 },
  grid: { min: 2, max: 4 },
  sequence: { min: 2, max: 6 },
};

interface ResolvedScene {
  index: number;
  id: string;
  layout: SceneLayout;
  visuals: ResolvedVisual[];
  voice?: ResolvedVoice;
  caption?: { offset: number; style: CueStyle };
  explicitDuration?: number;
  transitionOutSec?: number;
}

interface ResolvedComposition {
  findings: Finding[];
  scenes: ResolvedScene[];
  music?: { mediaId: string; volume: number };
  transcript?: { text: string; mediaId: string; style: CueStyle; audioKind: "speech" | "sung" };
  leadInSec: number;
  resolution: z.infer<typeof RESOLUTION>;
  fps: number;
  tailSec: number;
  width: number;
  height: number;
}

// The cascaded, fully-resolved style; `box` is only ever an input shorthand (see mergeCaption),
// never a resolved property, so it's excluded here.
type ResolvedCaptionSpec = Required<Omit<CaptionSpec, "box">>;

const BASE_CAPTION: ResolvedCaptionSpec = {
  mode: "block",
  color: "white",
  spoken_color: "#FFD24D",
  upcoming_color: "#8A8A8A",
  position: "bottom",
  size: "medium",
  background: "box",
  shadow: true,
  outline: true,
};

function mergeCaption(...layers: (CaptionSpec | undefined)[]): ResolvedCaptionSpec {
  const merged = { ...BASE_CAPTION };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode !== undefined) merged.mode = layer.mode;
    if (layer.color !== undefined) merged.color = layer.color;
    if (layer.spoken_color !== undefined) merged.spoken_color = layer.spoken_color;
    if (layer.upcoming_color !== undefined) merged.upcoming_color = layer.upcoming_color;
    if (layer.position !== undefined) merged.position = layer.position;
    if (layer.size !== undefined) merged.size = layer.size;
    // `box` is a back-compat shorthand for `background`; at each layer it only takes effect
    // when that same layer doesn't also set `background` explicitly.
    if (layer.background !== undefined) merged.background = layer.background;
    else if (layer.box !== undefined) merged.background = layer.box ? "box" : "none";
    if (layer.shadow !== undefined) merged.shadow = layer.shadow;
    if (layer.outline !== undefined) merged.outline = layer.outline;
  }
  return merged;
}

function toCueStyle(spec: ResolvedCaptionSpec): CueStyle {
  return {
    mode: spec.mode,
    color: spec.color,
    spokenColor: spec.spoken_color,
    upcomingColor: spec.upcoming_color,
    position: spec.position,
    fontScale: fontScaleFor(spec.size),
    background: spec.background,
    shadow: spec.shadow,
    outline: spec.outline,
  };
}

function validateCaptionColors(
  spec: ResolvedCaptionSpec,
  pathPrefix: string,
  findings: Finding[],
): void {
  for (const [field, value] of [
    ["color", spec.color],
    ["spoken_color", spec.spoken_color],
    ["upcoming_color", spec.upcoming_color],
  ] as const) {
    if (!validateColor(value)) {
      findings.push({
        path: `${pathPrefix}.${field}`,
        severity: "error",
        message: `"${value}" is not a hex (#RRGGBB) or basic color name`,
      });
    }
  }
}

function mergeVoice(...layers: (VoiceSpec | undefined)[]): Omit<ResolvedVoice, "text" | "start"> {
  const merged = { exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 } as Omit<
    ResolvedVoice,
    "text" | "start"
  >;
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.reference_media_id !== undefined) merged.referenceId = layer.reference_media_id;
    if (layer.exaggeration !== undefined) merged.exaggeration = layer.exaggeration;
    if (layer.cfg_weight !== undefined) merged.cfgWeight = layer.cfg_weight;
    if (layer.temperature !== undefined) merged.temperature = layer.temperature;
  }
  return merged;
}

// The voice span a scene must cover: its start delay plus the spoken length. Scene 0's delay
// is the whole video's lead-in, not part of the scene, so it must not count into the span.
function voiceSpanEstimate(voice: ResolvedVoice | undefined, isFirstScene: boolean): number {
  if (!voice) return 0;
  return (isFirstScene ? 0 : voice.start) + countWords(voice.text) / TTS_WORDS_PER_SEC;
}

function sceneSpanEstimate(scene: ResolvedScene): number {
  return Math.max(voiceSpanEstimate(scene.voice, scene.index === 0), scene.explicitDuration ?? 0);
}

// Resolves a media_id against the local cache, falling back to the composition's `media`
// map (id -> durable url) when it's missing locally: the mechanism that lets a composition
// reopened from a stored recipe re-resolve sources that only ever lived in a since-dead
// pod's cache. Returns null when the id is neither cached nor fetchable.
async function ensureMedia(
  mediaId: string,
  media: Record<string, string> | undefined,
): Promise<MediaMeta | null> {
  const cached = await loadMeta(mediaId);
  if (cached) return cached;
  const url = media?.[mediaId];
  if (!url) return null;
  try {
    return await fetchMediaToId(mediaId, url);
  } catch (error) {
    console.error(`[compose] failed to fetch media "${mediaId}" from recipe url:`, error);
    return null;
  }
}

// Resolve + validate a composition without rendering: cascade the defaults, classify the
// tracks, and collect findings the agent can act on. Shared by video_plan and video_compose.
export async function resolveComposition(comp: Composition): Promise<ResolvedComposition> {
  const findings: Finding[] = [];
  const scenes: ResolvedScene[] = [];
  let music: { mediaId: string; volume: number } | undefined;
  let sceneTrackIndex = -1;

  for (const [ti, track] of comp.tracks.entries()) {
    const sceneClips = track.clips.filter((clip) => clip.type === "composition");
    const audioClips = track.clips.filter((clip) => clip.type === "audio");
    if (sceneClips.length && audioClips.length) {
      findings.push({
        path: `tracks[${ti}]`,
        severity: "error",
        message: "a track cannot mix scene compositions and audio clips",
        hint: "put the music bed on its own track",
      });
    }
    if (sceneClips.length) {
      if (sceneTrackIndex >= 0) {
        findings.push({
          path: `tracks[${ti}]`,
          severity: "error",
          message: "only one track of scene compositions is supported in this version",
          hint: "merge all scenes into a single track; they play in order",
        });
        continue;
      }
      sceneTrackIndex = ti;
    }
    for (const [ci, clip] of track.clips.entries()) {
      if (clip.type !== "audio") continue;
      if (music) {
        findings.push({
          path: `tracks[${ti}].clips[${ci}]`,
          severity: "error",
          message: "only one music bed is supported",
          hint: "keep a single audio clip; it loops and ducks under the voice for the whole video",
        });
        continue;
      }
      if (!(await ensureMedia(clip.media_id, comp.media))) {
        findings.push({
          path: `tracks[${ti}].clips[${ci}].media_id`,
          severity: "error",
          message: `media_id "${clip.media_id}" not found`,
          hint: "download it with video_download_media first",
        });
      }
      music = { mediaId: clip.media_id, volume: clip.volume };
    }
  }

  if (sceneTrackIndex < 0) {
    findings.push({
      path: "tracks",
      severity: "error",
      message: "no scene track: add a track whose clips are compositions (the scenes, in order)",
    });
  } else {
    const sceneTrack = comp.tracks[sceneTrackIndex];
    const sceneClips = (sceneTrack?.clips ?? []).filter(
      (clip): clip is SceneClip => clip.type === "composition",
    );
    for (const [si, scene] of sceneClips.entries()) {
      const path = `tracks[${sceneTrackIndex}].clips[${si}]`;
      const resolved = await resolveScene(comp, scene, si, path, findings);
      scenes.push(resolved);
    }
    if (scenes.length > 12) {
      findings.push({
        path: `tracks[${sceneTrackIndex}]`,
        severity: "warning",
        message: `${scenes.length} scenes: each scene is a separate slow TTS generation, so scene count is the dominant cost`,
        hint: "keep one scene per beat of the brief",
      });
    }
  }

  let transcript: ResolvedComposition["transcript"];
  if (comp.transcript) {
    const transcriptMediaId = comp.transcript.media_id ?? music?.mediaId;
    if (!transcriptMediaId) {
      findings.push({
        path: "transcript.media_id",
        severity: "error",
        message:
          "transcript needs audio to align to: add an audio track, or set transcript.media_id",
      });
    } else {
      if (!(await ensureMedia(transcriptMediaId, comp.media))) {
        findings.push({
          path: "transcript.media_id",
          severity: "error",
          message: `transcript media_id "${transcriptMediaId}" not found`,
          hint: "download the audio with video_download_media first",
        });
      }
      const spec = mergeCaption({ mode: "karaoke", position: "center" }, comp.transcript.caption);
      validateCaptionColors(spec, "transcript.caption", findings);
      transcript = {
        text: comp.transcript.text,
        mediaId: transcriptMediaId,
        style: toCueStyle(spec),
        audioKind: comp.transcript.audio_kind,
      };
    }
  }

  const { width, height } = dimsFor(comp.output.resolution);
  return {
    findings,
    scenes,
    music,
    transcript,
    leadInSec: scenes.at(0)?.voice?.start ?? 0,
    resolution: comp.output.resolution,
    fps: comp.output.fps,
    tailSec: comp.output.tail_sec,
    width,
    height,
  };
}

async function resolveScene(
  comp: Composition,
  scene: SceneClip,
  index: number,
  path: string,
  findings: Finding[],
): Promise<ResolvedScene> {
  const visuals: { path: string; clip: ResolvedVisual }[] = [];
  const voices: { path: string; clip: z.infer<typeof VOICE_CLIP> }[] = [];
  const captions: { path: string; clip: z.infer<typeof CAPTION_CLIP> }[] = [];

  for (const [ti, track] of scene.tracks.entries()) {
    for (const [ci, clip] of track.clips.entries()) {
      const clipPath = `${path}.tracks[${ti}].clips[${ci}]`;
      if (clip.type === "video") {
        const media = await ensureMedia(clip.media_id, comp.media);
        if (!media) {
          findings.push({
            path: `${clipPath}.media_id`,
            severity: "error",
            message: `media_id "${clip.media_id}" not found`,
            hint: "download it with video_download_media first",
          });
        } else {
          const inSec = clip.in ?? 0;
          if (clip.out !== undefined && clip.out <= inSec) {
            findings.push({
              path: `${clipPath}.out`,
              severity: "error",
              message: `out (${clip.out}s) must be greater than in (${inSec}s)`,
            });
          }
          if (clip.in !== undefined && clip.in >= media.duration) {
            findings.push({
              path: `${clipPath}.in`,
              severity: "error",
              message: `in (${clip.in}s) is beyond the source's length`,
              hint: `source "${clip.media_id}" is ${media.duration.toFixed(2)}s long`,
            });
          }
          if (clip.out !== undefined && clip.out > media.duration) {
            findings.push({
              path: `${clipPath}.out`,
              severity: "error",
              message: `out (${clip.out}s) is beyond the source's length`,
              hint: `source "${clip.media_id}" is ${media.duration.toFixed(2)}s long`,
            });
          }
        }
        visuals.push({
          path: clipPath,
          clip: {
            kind: "video",
            mediaId: clip.media_id,
            in: clip.in,
            out: clip.out,
            fit: clip.fit,
          },
        });
      } else if (clip.type === "graphic") {
        if (clip.accent_color && !validateColor(clip.accent_color)) {
          findings.push({
            path: `${clipPath}.accent_color`,
            severity: "error",
            message: `"${clip.accent_color}" is not a hex (#RRGGBB) or basic color name`,
          });
        }
        visuals.push({ path: clipPath, clip: { kind: "math", math: clip } });
      } else if (clip.type === "voice") {
        voices.push({ path: clipPath, clip });
      } else {
        captions.push({ path: clipPath, clip });
      }
    }
  }

  if (scene.layout === "single") {
    if (visuals.length !== 1) {
      findings.push({
        path,
        severity: "error",
        message: `a scene needs exactly one visual clip (video or graphic), got ${visuals.length}`,
        hint: "one visual per scene; make another scene for the next visual",
      });
    }
  } else {
    const need = LAYOUT_VISUAL_COUNTS[scene.layout];
    if (visuals.length < need.min || visuals.length > need.max) {
      const expected = need.min === need.max ? `exactly ${need.min}` : `${need.min}-${need.max}`;
      findings.push({
        path,
        severity: "error",
        message: `layout "${scene.layout}" needs ${expected} visual clips (video or graphic), got ${visuals.length}`,
        hint: "add or remove visual clips (video/graphic) on this scene's tracks to match the layout",
      });
    }
  }
  if (voices.length > 1) {
    findings.push({
      path,
      severity: "error",
      message: `a scene can have at most one voice clip, got ${voices.length}`,
      hint: "join the lines into one text, or split into more scenes",
    });
  }
  if (captions.length > 1) {
    findings.push({
      path,
      severity: "error",
      message: `a scene can have at most one caption clip, got ${captions.length}`,
    });
  }

  const voiceEntry = voices.at(0);
  const captionEntry = captions.at(0);
  if (captionEntry && !voiceEntry) {
    findings.push({
      path: captionEntry.path,
      severity: "error",
      message: "a caption clip needs a voice clip in the same scene to align to",
      hint: "add the scene's voice clip, or remove the caption clip",
    });
  }
  if (!voiceEntry && scene.duration === "fit") {
    findings.push({
      path,
      severity: "error",
      message: 'duration "fit" needs a voice clip to fit to',
      hint: "add a voice clip, or give the scene a numeric duration for a silent beat",
    });
  }

  let voice: ResolvedVoice | undefined;
  if (voiceEntry) {
    const params = mergeVoice(comp.defaults?.voice, scene.defaults?.voice, voiceEntry.clip.voice);
    if (params.referenceId && !(await ensureMedia(params.referenceId, comp.media))) {
      findings.push({
        path: `${voiceEntry.path}.voice.reference_media_id`,
        severity: "error",
        message: `voice reference "${params.referenceId}" not found`,
        hint: "download the reference clip with video_download_media first",
      });
    }
    if (voiceEntry.clip.start > 5) {
      findings.push({
        path: `${voiceEntry.path}.start`,
        severity: "warning",
        message: `${voiceEntry.clip.start}s is a long silence before the voice`,
      });
    }
    voice = { text: voiceEntry.clip.text, start: voiceEntry.clip.start, ...params };
  }

  let caption: ResolvedScene["caption"];
  if (captionEntry && voiceEntry) {
    const spec = mergeCaption(
      comp.defaults?.caption,
      scene.defaults?.caption,
      captionEntry.clip.style,
    );
    validateCaptionColors(spec, `${captionEntry.path}.style`, findings);
    caption = { offset: captionEntry.clip.offset, style: toCueStyle(spec) };
  }

  const explicitDuration = typeof scene.duration === "number" ? scene.duration : undefined;
  if (
    explicitDuration !== undefined &&
    voice &&
    explicitDuration < voiceSpanEstimate(voice, index === 0)
  ) {
    findings.push({
      path: `${path}.duration`,
      severity: "warning",
      message: `duration ${explicitDuration}s is shorter than the narration; the scene will be extended to cover it`,
    });
  }

  return {
    index,
    id: scene.id ?? `scene${index + 1}`,
    layout: scene.layout,
    visuals: visuals.map((v) => v.clip),
    voice,
    caption,
    explicitDuration,
    transitionOutSec: scene.transition_out?.sec,
  };
}

interface PlanScene {
  id: string;
  layout: SceneLayout;
  visual: string;
  line: string | null;
  voice_start: number;
  est_start: number;
  est_end: number;
  captions: (ResolvedCaptionSpec & { offset: number }) | null;
}

function visualLabel(visual: ResolvedVisual): string {
  return visual.kind === "video" ? `video:${visual.mediaId}` : "graphic:math";
}

// The dry-run view both tools share: absolute estimated timeline + effective styles.
function planView(resolved: ResolvedComposition, comp: Composition) {
  const errors = resolved.findings.filter((f) => f.severity === "error");
  let cursor = resolved.leadInSec;
  const planScenes: PlanScene[] = resolved.scenes.map((scene) => {
    const span = sceneSpanEstimate(scene);
    const start = cursor;
    cursor += span;
    let captions: PlanScene["captions"] = null;
    if (scene.caption) {
      const s = scene.caption.style;
      captions = {
        mode: s.mode,
        color: s.color,
        spoken_color: s.spokenColor,
        upcoming_color: s.upcomingColor,
        position: s.position,
        size: s.fontScale < 1 ? "small" : s.fontScale > 1 ? "large" : "medium",
        background: s.background,
        shadow: s.shadow,
        outline: s.outline,
        offset: scene.caption.offset,
      };
    }
    const visual =
      scene.visuals.length === 0
        ? "none"
        : scene.visuals.length === 1
          ? visualLabel(scene.visuals[0] as ResolvedVisual)
          : `${scene.visuals.length} visuals: ${scene.visuals.map(visualLabel).join(" + ")}`;
    return {
      id: scene.id,
      layout: scene.layout,
      visual,
      line: scene.voice?.text ?? null,
      voice_start: scene.voice?.start ?? 0,
      est_start: Number(start.toFixed(2)),
      est_end: Number(cursor.toFixed(2)),
      captions,
    };
  });
  return {
    valid: errors.length === 0,
    findings: resolved.findings,
    output: {
      resolution: resolved.resolution,
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      tail_sec: resolved.tailSec,
      est_duration_sec: Number((cursor + resolved.tailSec).toFixed(1)),
    },
    music: resolved.music
      ? { media_id: resolved.music.mediaId, volume: resolved.music.volume }
      : null,
    scenes: planScenes,
    note: `Scene lengths are estimates (~${TTS_WORDS_PER_SEC} words/s); the render measures the real speech. version=${comp.version}`,
  };
}

const PRESET = `{
  "version": 1,
  "output": { "resolution": "landscape" },
  "defaults": { "caption": { "mode": "karaoke", "color": "yellow" } },
  "tracks": [
    { "clips": [
      { "type": "composition", "id": "scene1", "duration": "fit", "tracks": [
        { "clips": [ { "type": "video", "media_id": "<footage1>" } ] },
        { "clips": [ { "type": "voice", "text": "First beat of the story.", "start": 1 } ] },
        { "clips": [ { "type": "caption" } ] }
      ]},
      { "type": "composition", "id": "scene2", "duration": "fit", "tracks": [
        { "clips": [ { "type": "video", "media_id": "<footage2>" } ] },
        { "clips": [ { "type": "voice", "text": "Second beat." } ] },
        { "clips": [ { "type": "caption", "style": { "color": "red" } } ] }
      ]}
    ]},
    { "clips": [ { "type": "audio", "media_id": "<music>", "volume": 0.25 } ] }
  ]
}`;

const LANGUAGE_RULES = `The composition is declarative: tracks are parallel layers, clips on a track play in order. Scenes are composition clips on one track; each scene has one visual clip (video footage OR graphic math), at most one voice clip (its narration; the scene is cut to its real spoken length), and at most one caption clip (word-synced subtitles aligned to that voice; no caption clip = no captions for that scene). A caption's style also takes background (none, box, or blur; blur is a frosted darkened strip behind the text), shadow, and outline. Put a box or blur behind captions over uncontrolled footage (a YouTube clip that may be bright or busy), and use none over a math or graphic scene, whose dark controlled background already reads text cleanly. Styling cascades: root defaults -> scene defaults -> the clip's own style, nearest wins per key. A voice clip's start delays the speech into the scene (footage/music play first). A numeric scene duration holds a scene longer than its voice (or makes a silent beat). Music is one audio clip on its own track: it loops, plays from 0:00 and ducks under the voice. A video clip's media_id may be footage or a still image; its optional in/out trims which part of the source plays, independent of the scene's own duration. A still image on a single-visual scene takes fit: cover (default, crops to fill with a slow zoom-in) or contain (shows the WHOLE image over a blurred fill of itself, gentle push-in) — use contain for screenshots/text so the borders are not cropped. A scene's transition_out fades it to black and fades the next scene in from black, without changing either scene's duration. A scene's layout (single by default) arranges multiple visual clips: sequence plays 2-6 of them back-to-back, each for an equal share of the scene, while the scene's one voice + captions keep going (the picture cuts without cutting the narration — use it so a scene is not one frozen image); vstack/hstack/pip combine exactly 2 into one simultaneous view (top/bottom, left/right, or corner inset), grid combines 2-4. A composition may include a top-level media map (media_id -> url) copied from a prior render's recipe sidecar, so referenced media_ids missing from the local cache are fetched back in automatically. Fill this preset:
${PRESET}`;

export function registerComposeTools(server: McpServer): void {
  registerTool(server, {
    name: "video_plan",
    title: "Validate a composition (dry-run, instant)",
    description: `ALWAYS call this before video_compose. Resolves and validates a composition WITHOUT rendering (instant, free): returns the estimated absolute timeline (each scene's start/end, effective caption style) plus findings [{path, severity, message, hint}]. Fix every error finding, re-plan until valid, then call video_compose ONCE with the same composition. ${LANGUAGE_RULES}`,
    inputSchema: {
      composition: COMPOSITION.describe("The declarative composition to validate."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ composition }) => {
      const resolved = await resolveComposition(composition);
      return planView(resolved, composition);
    },
  });

  registerTool(server, {
    name: "video_compose",
    title: "Render a composition (narrated video, synced by construction)",
    description: `Render a declarative composition into a finished MP4: narrated scenes stay PERFECTLY in sync (each scene's visual is cut to its line's real spoken length), captions are force-aligned word-synced cues styled per scene, music ducks under the voice. Downloaded footage/screenshots go in scene \`video\` clips and are mixed in by construction — PREFER this over hand-authoring HTML whenever you have real media to include, so nothing silently gets dropped. For a song or a recorded speech you already have the words for, set top-level \`transcript\` (the audio on an audio track + its text): the words are force-aligned to the real audio into karaoke captions, no TTS/CHATTERBOX needed for that path. Validate with video_plan FIRST and call this exactly ONCE when the plan is valid — if the composition has errors this returns the findings instead of rendering. ASYNCHRONOUS: returns a job_id, poll video_render_status; the result has the mp4 url, the real scene timeline, and metadata_url (a JSON sidecar carrying this composition as the recipe, so the video can be edited + re-rendered later; the recipe also carries a durable url for every media_id it references, so it renders anywhere, not just this pod). Narrated (voice) scenes require CHATTERBOX_URL. ${LANGUAGE_RULES}`,
    inputSchema: {
      composition: COMPOSITION.describe("The declarative composition to render."),
      metadata: metadataArg,
    },
    handler: async ({ composition, metadata }) => {
      const resolved = await resolveComposition(composition);
      if (resolved.findings.some((f) => f.severity === "error")) {
        return {
          rendered: false,
          ...planView(resolved, composition),
          hint: "fix the error findings and submit again (validate cheaply with video_plan)",
        };
      }
      const jobId = submitJob("compose", () => renderComposition(resolved, composition, metadata));
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

// Trims a scene's video source to [in, out) before the scene builder ever sees it: the builder
// only controls how much of the (already-trimmed) source plays, not which part of the source it
// is. Re-encoded, not stream-copied, so the cut lands exactly on the requested seconds instead of
// the nearest keyframe.
async function trimVideoSource(
  sourcePath: string,
  mediaId: string,
  inSec: number,
  outSec: number | undefined,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-trim-"));
  try {
    const outFile = join(dir, "trim.mp4");
    const args = ["-nostdin", "-y", "-ss", String(inSec)];
    if (outSec !== undefined) args.push("-to", String(outSec));
    args.push(
      "-i",
      sourcePath,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      outFile,
    );
    await run("ffmpeg", args, { timeoutMs: 300_000 });
    const buffer = await readFile(outFile);
    const trimmed = await writeMediaFromBuffer({
      idSeed: `compose-trim:${mediaId}:${inSec}:${outSec ?? "end"}`,
      buffer,
      ext: ".mp4",
      sourceUrl: `trim://${mediaId}`,
    });
    return trimmed.path;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Resolve one visual clip to a local file path: a math graphic is rendered (or fetched from
// cache) to `onScreen` seconds so a scene-0 lead-in never forces a restart-loop of the reveal
// animation; a video clip is the source media, trimmed to its in/out first if given.
async function resolveVisualPath(
  visual: ResolvedVisual,
  resolution: z.infer<typeof RESOLUTION>,
  onScreen: number,
): Promise<string> {
  if (visual.kind === "math") {
    const math = visual.math;
    const mathIdSeed = `compose-math:${resolution}:${onScreen.toFixed(2)}:${JSON.stringify(math)}`;
    const cachedMath = await renderMathShortCached({
      idSeed: mathIdSeed,
      sourceUrl: "math://compose-scene",
      spec: {
        title: math.title ?? "",
        scenes: [
          {
            latex: math.latex,
            ...(math.plot_expr ? { plot_expr: math.plot_expr } : {}),
            ...(math.x_range ? { x_range: math.x_range } : {}),
            ...(math.y_range ? { y_range: math.y_range } : {}),
            duration: onScreen + 1,
          },
        ],
        resolution,
        quick_reveal: true,
        ...(math.accent_color ? { accent_color: math.accent_color } : {}),
      },
    });
    return cachedMath.path;
  }
  const footage = await loadMeta(visual.mediaId);
  if (!footage) {
    throw new Error(
      `scene footage not found: ${visual.mediaId} — download it with video_download_media first.`,
    );
  }
  return visual.in !== undefined || visual.out !== undefined
    ? await trimVideoSource(footage.path, footage.media_id, visual.in ?? 0, visual.out)
    : footage.path;
}

export interface FrameLocation {
  scene: ResolvedScene;
  sceneStart: number;
  sceneEnd: number;
  withinSceneSec: number;
}

// Lays out the scene timeline the same way planView does: ESTIMATED spans (words/TTS rate, not
// real TTS), cursor starting at the lead-in. Finds which scene `atSec` falls into and the offset
// inside it. A timestamp inside the lead-in (before scene 0 starts) has no scene of its own to
// preview, so it lands on scene 0 at offset 0 instead of erroring.
export function locateSceneAt(resolved: ResolvedComposition, atSec: number): FrameLocation {
  if (resolved.scenes.length === 0) {
    throw new Error("composition has no scenes to preview");
  }
  let cursor = resolved.leadInSec;
  const spans = resolved.scenes.map((scene) => {
    const start = cursor;
    cursor += sceneSpanEstimate(scene);
    return { scene, start, end: cursor };
  });
  const firstSpan = spans[0] as (typeof spans)[number];
  const lastSpan = spans[spans.length - 1] as (typeof spans)[number];
  const clamped = Math.min(Math.max(atSec, 0), cursor);
  if (clamped <= firstSpan.start) {
    return {
      scene: firstSpan.scene,
      sceneStart: firstSpan.start,
      sceneEnd: firstSpan.end,
      withinSceneSec: 0,
    };
  }
  const hit = spans.find((s) => clamped < s.end) ?? lastSpan;
  const withinSceneSec = Math.min(clamped - hit.start, Math.max(hit.end - hit.start - 0.001, 0));
  return { scene: hit.scene, sceneStart: hit.start, sceneEnd: hit.end, withinSceneSec };
}

// Renders ONE frame of a composition at `atSec` WITHOUT synthesizing narration or running a full
// render: it lays out the scene timeline from ESTIMATED spans, then resolves and (if the layout
// needs it) combines only the ONE scene the timestamp lands in, the exact code path
// renderComposition uses for a scene's footage, so math/trim/layout results are cache hits on the
// later real render. Captions are word-synced to real alignment (needs TTS) so this never burns
// them in. Throws on the same error findings video_plan would report, naming the first one.
export async function previewCompositionFrame(
  composition: Composition,
  atSec: number,
): Promise<{
  buffer: Buffer;
  sceneId: string;
  sceneStart: number;
  sceneEnd: number;
  withinSceneSec: number;
  estimated: true;
  findings: Finding[];
}> {
  const resolved = await resolveComposition(composition);
  const errors = resolved.findings.filter((f) => f.severity === "error");
  if (errors.length) {
    const first = errors[0] as Finding;
    throw new Error(
      `composition has ${errors.length} error finding(s), starting with ${first.path}: ${first.message}`,
    );
  }

  const located = locateSceneAt(resolved, atSec);
  const scene = located.scene;
  const onScreen =
    located.sceneEnd - located.sceneStart + (scene.index === 0 ? resolved.leadInSec : 0);

  const visualPaths: string[] = [];
  for (const visual of scene.visuals) {
    visualPaths.push(await resolveVisualPath(visual, resolved.resolution, onScreen));
  }

  let footagePath: string;
  if (scene.layout === "single") {
    const only = visualPaths[0] as string;
    const v0 = scene.visuals[0];
    if (v0?.kind === "video" && v0.fit === "contain" && /\.(jpe?g|png|webp)$/i.test(only)) {
      footagePath = (
        await containVisual({
          image: only,
          durationSec: onScreen,
          width: resolved.width,
          height: resolved.height,
          fps: resolved.fps,
          idSeed: `compose-contain:${resolved.width}x${resolved.height}:${onScreen.toFixed(2)}:${only}`,
        })
      ).path;
    } else {
      footagePath = only;
    }
  } else if (scene.layout === "sequence") {
    const seqIdSeed = `compose-sequence:${resolved.width}x${resolved.height}:${onScreen.toFixed(2)}:${visualPaths.join("|")}`;
    footagePath = (
      await sequenceSceneVisuals({
        visuals: visualPaths,
        durationSec: onScreen,
        width: resolved.width,
        height: resolved.height,
        fps: resolved.fps,
        idSeed: seqIdSeed,
      })
    ).path;
  } else {
    const layoutIdSeed = `compose-layout:${scene.layout}:${resolved.width}x${resolved.height}:${onScreen.toFixed(2)}:${visualPaths.join("|")}`;
    const combined = await combineSceneVisuals({
      layout: scene.layout,
      visuals: visualPaths,
      durationSec: onScreen,
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      idSeed: layoutIdSeed,
    });
    footagePath = combined.path;
  }

  const buffer = await frameBufferFromPath(footagePath, located.withinSceneSec);
  return {
    buffer,
    sceneId: scene.id,
    sceneStart: Number(located.sceneStart.toFixed(2)),
    sceneEnd: Number(located.sceneEnd.toFixed(2)),
    withinSceneSec: Number(located.withinSceneSec.toFixed(2)),
    estimated: true,
    findings: resolved.findings,
  };
}

// Every source media_id a resolved composition actually references: video/image sources by
// their original id (not a derived trim or math render), the music bed, and any voice clone
// reference. These are the same ids that appear in the composition JSON stored as the recipe.
function referencedMediaIds(resolved: ResolvedComposition): Set<string> {
  const ids = new Set<string>();
  for (const scene of resolved.scenes) {
    for (const visual of scene.visuals) {
      if (visual.kind === "video") ids.add(visual.mediaId);
    }
    if (scene.voice?.referenceId) ids.add(scene.voice.referenceId);
  }
  if (resolved.music) ids.add(resolved.music.mediaId);
  if (resolved.transcript) ids.add(resolved.transcript.mediaId);
  return ids;
}

// Uploads every source media the composition references to the bucket under a stable
// `media/<id><ext>` key, so the sidecar recipe can carry a durable url for each one: the
// pod-local cache that produced this render dies with the pod, but the recipe must keep
// resolving. Uploads unconditionally: storage.save is an idempotent put by key, and there's
// no cheap existence check that would make skipping a redundant one worthwhile.
// Never throws: this runs after the expensive render, and a finished video must not be
// discarded because an auxiliary source upload failed; ids that fail just miss the map.
async function publishReferencedMedia(
  resolved: ResolvedComposition,
): Promise<{ media: Record<string, string>; errors: string[] }> {
  const media: Record<string, string> = {};
  const errors: string[] = [];
  for (const mediaId of referencedMediaIds(resolved)) {
    try {
      const meta = await loadMeta(mediaId);
      if (!meta) continue;
      const buffer = await readFile(meta.path);
      const ext = extname(meta.path) || extname(meta.filename);
      media[mediaId] = await storage().save(
        buffer,
        `media/${mediaId}${ext}`,
        contentTypeForExt(ext),
      );
    } catch (error) {
      errors.push(`${mediaId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { media, errors };
}

async function renderComposition(
  resolved: ResolvedComposition,
  composition: Composition,
  metadata: z.infer<typeof metadataArg>,
): Promise<unknown> {
  const { width: w, height: h, fps, leadInSec, tailSec, music: musicRef } = resolved;

  const cloneCache = new Map<string, { buffer: Buffer; filename: string }>();
  const cloneFor = async (referenceId: string | undefined) => {
    if (!referenceId) return undefined;
    let clip = cloneCache.get(referenceId);
    if (!clip) {
      clip = await extractCloneClip(referenceId);
      cloneCache.set(referenceId, clip);
    }
    return clip;
  };

  const segments: Buffer[] = [];
  const sceneInputs: NarratedScene[] = [];
  const sceneSpans: { span: number; voiceAbsStart: number }[] = [];
  let cursor = 0;
  let prevTransitionOutSec: number | undefined;

  for (const scene of resolved.scenes) {
    // Scene 0's voice delay is the whole video's lead-in (the engine delays the narration
    // track); later scenes get their delay as silence inside the narration itself.
    const preSilence = scene.index === 0 ? 0 : (scene.voice?.start ?? 0);
    let voiceWav: Buffer | undefined;
    let spokenSec = 0;
    if (scene.voice) {
      const voiceLabel = scene.voice.referenceId ? `cloned:${scene.voice.referenceId}` : "default";
      const { buffer } = await synthesizeSpeechCached(
        {
          text: scene.voice.text,
          exaggeration: scene.voice.exaggeration,
          cfgWeight: scene.voice.cfgWeight,
          temperature: scene.voice.temperature,
          voiceFile: await cloneFor(scene.voice.referenceId),
        },
        voiceLabel,
      );
      voiceWav = buffer;
      spokenSec = wavDurationSec(voiceWav);
      if (!(spokenSec > 0.1 && spokenSec < 600)) {
        throw new Error(
          `narration for scene "${scene.id}" came out ${spokenSec.toFixed(1)}s (line: "${scene.voice.text.slice(0, 40)}...") — bad audio, aborting.`,
        );
      }
    }
    const voiceSpan = preSilence + spokenSec;
    const span = Math.max(voiceSpan, scene.explicitDuration ?? 0);
    const postSilence = span - voiceSpan;
    if (preSilence > 0.01) segments.push(await silenceWav(preSilence));
    if (voiceWav) segments.push(voiceWav);
    if (postSilence > 0.03) segments.push(await silenceWav(postSilence));

    // A scene-0 lead-in is baked into onScreen so a math visual's own render already covers it
    // (see resolveVisualPath); other scenes only need to cover their own span.
    const onScreen = span + (scene.index === 0 ? leadInSec : 0);
    const visualPaths: string[] = [];
    for (const visual of scene.visuals) {
      visualPaths.push(await resolveVisualPath(visual, resolved.resolution, onScreen));
    }

    let footagePath: string;
    if (scene.layout === "single") {
      const only = visualPaths[0] as string;
      const v0 = scene.visuals[0];
      if (v0?.kind === "video" && v0.fit === "contain" && /\.(jpe?g|png|webp)$/i.test(only)) {
        footagePath = (
          await containVisual({
            image: only,
            durationSec: onScreen,
            width: w,
            height: h,
            fps,
            idSeed: `compose-contain:${w}x${h}:${onScreen.toFixed(2)}:${only}`,
          })
        ).path;
      } else {
        footagePath = only;
      }
    } else if (scene.layout === "sequence") {
      const seqIdSeed = `compose-sequence:${w}x${h}:${onScreen.toFixed(2)}:${visualPaths.join("|")}`;
      footagePath = (
        await sequenceSceneVisuals({
          visuals: visualPaths,
          durationSec: onScreen,
          width: w,
          height: h,
          fps,
          idSeed: seqIdSeed,
        })
      ).path;
    } else {
      const layoutIdSeed = `compose-layout:${scene.layout}:${w}x${h}:${onScreen.toFixed(2)}:${visualPaths.join("|")}`;
      const combined = await combineSceneVisuals({
        layout: scene.layout,
        visuals: visualPaths,
        durationSec: onScreen,
        width: w,
        height: h,
        fps,
        idSeed: layoutIdSeed,
      });
      footagePath = combined.path;
    }
    // A short scene cannot host both fades at their requested length; cap each at half the
    // scene so the fade-in always reaches full brightness before the fade-out starts.
    const fadeCap = span / 2;
    sceneInputs.push({
      footagePath,
      duration: span,
      ...(scene.transitionOutSec !== undefined
        ? { fadeOutSec: Math.min(scene.transitionOutSec, fadeCap) }
        : {}),
      ...(prevTransitionOutSec !== undefined
        ? { fadeInSec: Math.min(prevTransitionOutSec, fadeCap) }
        : {}),
    });
    prevTransitionOutSec = scene.transitionOutSec;
    sceneSpans.push({ span, voiceAbsStart: cursor + preSilence });
    cursor += span;
  }

  const narrationBuf = await concatWavs(segments);

  // One alignment over the whole narration (silence between scenes is fine for CTC), then the
  // word list slices back into scenes by word count so each scene's cues carry its own style.
  const captions: Cue[] = [];
  const scenesWithCaptions = resolved.scenes.filter((s) => s.caption && s.voice);
  if (scenesWithCaptions.length) {
    const fullText = resolved.scenes
      .map((s) => s.voice?.text)
      .filter(Boolean)
      .join(" ");
    const alignDir = await mkdtemp(join(tmpdir(), "vcm-compose-"));
    try {
      const alignWav = join(alignDir, "narration.wav");
      await writeFile(alignWav, narrationBuf);
      const words = await alignWords(alignWav, fullText);
      let wordCursor = 0;
      for (const scene of resolved.scenes) {
        if (!scene.voice) continue;
        const count = countWords(scene.voice.text);
        const sceneWords = words.slice(wordCursor, wordCursor + count);
        wordCursor += count;
        if (!scene.caption || !sceneWords.length) continue;
        const style = scene.caption.style;
        const fontSize = Math.max(22, Math.round((h / 26) * style.fontScale));
        const cues = groupIntoCues(sceneWords, {
          maxChars: 2 * charsPerLine(w, fontSize),
          maxWords: 14,
        });
        for (const cue of offsetCues(cues, scene.caption.offset)) {
          captions.push({ ...cue, style });
        }
      }
    } finally {
      await rm(alignDir, { recursive: true, force: true });
    }
  }
  // A transcript aligns its words to a provided audio clip (a song, a recorded speech) and
  // paints karaoke cues across the whole timeline — no TTS, the audio itself is the voice.
  if (resolved.transcript) {
    const audioMeta = await loadMeta(resolved.transcript.mediaId);
    if (!audioMeta) {
      throw new Error(
        `transcript audio not found: ${resolved.transcript.mediaId} — download it with video_download_media first.`,
      );
    }
    const style = resolved.transcript.style;
    const fontSize = Math.max(22, Math.round((h / 26) * style.fontScale));
    // A song is a bad alignment target (wav2vec2 hears the backing track as noise), so isolate the
    // vocals first; the stem is only the alignment reference, the played audio is still the mix.
    const separated =
      resolved.transcript.audioKind === "sung" ? await separateVocals(audioMeta.path) : undefined;
    try {
      const alignPath = separated?.path ?? audioMeta.path;
      const words = await alignWords(alignPath, resolved.transcript.text);
      const cues = groupIntoCues(words, { maxChars: 2 * charsPerLine(w, fontSize), maxWords: 14 });
      for (const cue of cues) captions.push({ ...cue, style });
    } finally {
      await separated?.cleanup();
    }
  }

  // Clamp only after the cues sit on the final timeline: a negative caption offset may
  // legitimately reach into the lead-in, but an inverted [start,end] never draws at all.
  const placedCues = offsetCues(captions, leadInSec).map((cue) => {
    const start = Math.max(0, cue.start);
    return { ...cue, start, end: Math.max(start + 0.3, cue.end) };
  });

  let music: { path: string; volume: number; trimHead?: boolean } | undefined;
  if (musicRef) {
    const musicMeta = await loadMeta(musicRef.mediaId);
    if (!musicMeta) {
      throw new Error(
        `music media_id not found: ${musicRef.mediaId} — download it with video_download_media first.`,
      );
    }
    // A transcript's cues are timed against the audio from its first sample, so the played track
    // must not have its leading silence trimmed or the words would drift ahead of the audio.
    music = {
      path: musicMeta.path,
      volume: musicRef.volume,
      ...(resolved.transcript ? { trimHead: false } : {}),
    };
  }

  const { buffer, meta } = await narratedScenes({
    scenes: sceneInputs,
    narration: narrationBuf,
    leadInSec,
    music,
    ...(placedCues.length ? { captions: placedCues } : {}),
    tailSec,
    width: w,
    height: h,
    fps,
  });

  // The sidecar's recipe is the project file: the exact composition that made this video,
  // reloadable via video_get_recipe for later (agent or human editor) tweaks + re-renders.
  // Its media map carries a durable url for every source this composition references, since
  // those sources only ever lived in this pod's local cache.
  const referenced = await publishReferencedMedia(resolved);
  const saved = await saveRender(buffer, meta.filename, metadata, {
    tool: "video_compose",
    args: { composition, media: referenced.media },
  });

  let absCursor = leadInSec;
  const timeline = resolved.scenes.map((scene, i) => {
    const span = sceneSpans[i]?.span ?? 0;
    const start = absCursor;
    absCursor += span;
    return {
      id: scene.id,
      line: scene.voice?.text ?? null,
      start: Number(start.toFixed(2)),
      end: Number(absCursor.toFixed(2)),
    };
  });
  return {
    ...saved,
    media_id: meta.media_id,
    duration_sec: Number(meta.duration.toFixed(3)),
    scenes: timeline,
    project:
      "metadata_url holds this render's composition (recipe); fetch it to edit and re-render.",
    ...(referenced.errors.length
      ? {
          media_publish_errors: referenced.errors,
          media_publish_note:
            "some source media could not be mirrored to the bucket; the video is fine, but re-rendering this project on another pod may need those sources re-downloaded",
        }
      : {}),
  };
}

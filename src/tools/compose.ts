import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { charsPerLine, validateColor } from "../lib/ffmpeg.js";
import { alignWords } from "../services/align.js";
import {
  type Cue,
  type CueStyle,
  fontScaleFor,
  groupIntoCues,
  offsetCues,
} from "../services/captions.js";
import { narratedScenes } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderMathShort } from "../services/manim.js";
import { loadMeta, writeMediaFromBuffer } from "../services/media.js";
import {
  TTS_WORDS_PER_SEC,
  concatWavs,
  countWords,
  extractCloneClip,
  silenceWav,
  synthesizeSpeech,
  wavDurationSec,
} from "../services/narration.js";
import { saveRender } from "../services/publish.js";
import { dimsFor } from "../services/timeline.js";
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
    color: z.string().optional().describe("Hex #RRGGBB or a basic color name."),
    position: z.enum(["bottom", "center", "top"]).optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
    box: z.boolean().optional().describe("Translucent box behind the text (else outline only)."),
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

const SCENE = z
  .object({
    type: z.literal("composition"),
    id: z.string().optional().describe("Stable handle for this scene (used in the timeline)."),
    duration: z
      .union([z.literal("fit"), z.number().positive()])
      .default("fit")
      .describe('"fit" = as long as its voice; a number holds the scene that many seconds.'),
    defaults: DEFAULTS_FIELDS.optional().describe("Style defaults for this scene's clips."),
    tracks: z.array(SCENE_TRACK).min(1).describe("Parallel layers inside the scene."),
  })
  .strict();

const OUTER_TRACK = z
  .object({
    clips: z.array(z.discriminatedUnion("type", [SCENE, AUDIO_CLIP])).min(1),
  })
  .strict();

const COMPOSITION = z
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
  })
  .strict();

type Composition = z.infer<typeof COMPOSITION>;
type SceneClip = z.infer<typeof SCENE>;
type MathGraphic = z.infer<typeof GRAPHIC_CLIP>;
type CaptionSpec = z.infer<typeof CAPTION_STYLE_FIELDS>;
type VoiceSpec = z.infer<typeof VOICE_FIELDS>;

interface Finding {
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

interface ResolvedScene {
  index: number;
  id: string;
  visual: { kind: "video"; mediaId: string } | { kind: "math"; math: MathGraphic };
  voice?: ResolvedVoice;
  caption?: { offset: number; style: CueStyle };
  explicitDuration?: number;
}

interface ResolvedComposition {
  findings: Finding[];
  scenes: ResolvedScene[];
  music?: { mediaId: string; volume: number };
  leadInSec: number;
  resolution: z.infer<typeof RESOLUTION>;
  fps: number;
  tailSec: number;
  width: number;
  height: number;
}

const BASE_CAPTION: Required<CaptionSpec> = {
  mode: "block",
  color: "white",
  position: "bottom",
  size: "medium",
  box: true,
};

function mergeCaption(...layers: (CaptionSpec | undefined)[]): Required<CaptionSpec> {
  const merged = { ...BASE_CAPTION };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode !== undefined) merged.mode = layer.mode;
    if (layer.color !== undefined) merged.color = layer.color;
    if (layer.position !== undefined) merged.position = layer.position;
    if (layer.size !== undefined) merged.size = layer.size;
    if (layer.box !== undefined) merged.box = layer.box;
  }
  return merged;
}

function toCueStyle(spec: Required<CaptionSpec>): CueStyle {
  return {
    mode: spec.mode,
    color: spec.color,
    position: spec.position,
    fontScale: fontScaleFor(spec.size),
    box: spec.box,
  };
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

async function mediaExists(mediaId: string): Promise<boolean> {
  return Boolean(await loadMeta(mediaId));
}

// Resolve + validate a composition without rendering: cascade the defaults, classify the
// tracks, and collect findings the agent can act on. Shared by video_plan and video_compose.
async function resolveComposition(comp: Composition): Promise<ResolvedComposition> {
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
      if (!(await mediaExists(clip.media_id))) {
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

  const { width, height } = dimsFor(comp.output.resolution);
  return {
    findings,
    scenes,
    music,
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
  const visuals: { path: string; clip: ResolvedScene["visual"] }[] = [];
  const voices: { path: string; clip: z.infer<typeof VOICE_CLIP> }[] = [];
  const captions: { path: string; clip: z.infer<typeof CAPTION_CLIP> }[] = [];

  for (const [ti, track] of scene.tracks.entries()) {
    for (const [ci, clip] of track.clips.entries()) {
      const clipPath = `${path}.tracks[${ti}].clips[${ci}]`;
      if (clip.type === "video") {
        if (!(await mediaExists(clip.media_id))) {
          findings.push({
            path: `${clipPath}.media_id`,
            severity: "error",
            message: `media_id "${clip.media_id}" not found`,
            hint: "download it with video_download_media first",
          });
        }
        visuals.push({ path: clipPath, clip: { kind: "video", mediaId: clip.media_id } });
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

  if (visuals.length !== 1) {
    findings.push({
      path,
      severity: "error",
      message: `a scene needs exactly one visual clip (video or graphic), got ${visuals.length}`,
      hint: "one visual per scene; make another scene for the next visual",
    });
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
    if (params.referenceId && !(await mediaExists(params.referenceId))) {
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
    if (!validateColor(spec.color)) {
      findings.push({
        path: `${captionEntry.path}.style.color`,
        severity: "error",
        message: `"${spec.color}" is not a hex (#RRGGBB) or basic color name`,
      });
    }
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

  const fallbackVisual: ResolvedScene["visual"] = { kind: "video", mediaId: "" };
  return {
    index,
    id: scene.id ?? `scene${index + 1}`,
    visual: visuals.at(0)?.clip ?? fallbackVisual,
    voice,
    caption,
    explicitDuration,
  };
}

interface PlanScene {
  id: string;
  visual: string;
  line: string | null;
  voice_start: number;
  est_start: number;
  est_end: number;
  captions: (Omit<Required<CaptionSpec>, never> & { offset: number }) | null;
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
        position: s.position,
        size: s.fontScale < 1 ? "small" : s.fontScale > 1 ? "large" : "medium",
        box: s.box,
        offset: scene.caption.offset,
      };
    }
    return {
      id: scene.id,
      visual: scene.visual.kind === "video" ? `video:${scene.visual.mediaId}` : "graphic:math",
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

const LANGUAGE_RULES = `The composition is declarative: tracks are parallel layers, clips on a track play in order. Scenes are composition clips on one track; each scene has one visual clip (video footage OR graphic math), at most one voice clip (its narration; the scene is cut to its real spoken length), and at most one caption clip (word-synced subtitles aligned to that voice; no caption clip = no captions for that scene). Styling cascades: root defaults -> scene defaults -> the clip's own style, nearest wins per key. A voice clip's start delays the speech into the scene (footage/music play first). A numeric scene duration holds a scene longer than its voice (or makes a silent beat). Music is one audio clip on its own track: it loops, plays from 0:00 and ducks under the voice. Fill this preset:
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
    description: `Render a declarative composition into a finished MP4: narrated scenes stay PERFECTLY in sync (each scene's visual is cut to its line's real spoken length), captions are force-aligned word-synced cues styled per scene, music ducks under the voice. Validate with video_plan FIRST and call this exactly ONCE when the plan is valid — if the composition has errors this returns the findings instead of rendering. ASYNCHRONOUS: returns a job_id, poll video_render_status; the result has the mp4 url, the real scene timeline, and metadata_url (a JSON sidecar carrying this composition as the recipe, so the video can be edited + re-rendered later). Requires CHATTERBOX_URL. ${LANGUAGE_RULES}`,
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
  const sceneInputs: { footagePath: string; duration: number }[] = [];
  const sceneSpans: { span: number; voiceAbsStart: number }[] = [];
  let cursor = 0;

  for (const scene of resolved.scenes) {
    // Scene 0's voice delay is the whole video's lead-in (the engine delays the narration
    // track); later scenes get their delay as silence inside the narration itself.
    const preSilence = scene.index === 0 ? 0 : (scene.voice?.start ?? 0);
    let voiceWav: Buffer | undefined;
    let spokenSec = 0;
    if (scene.voice) {
      voiceWav = await synthesizeSpeech({
        text: scene.voice.text,
        exaggeration: scene.voice.exaggeration,
        cfgWeight: scene.voice.cfgWeight,
        temperature: scene.voice.temperature,
        voiceFile: await cloneFor(scene.voice.referenceId),
      });
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

    let footagePath: string;
    if (scene.visual.kind === "math") {
      const math = scene.visual.math;
      const onScreen = span + (scene.index === 0 ? leadInSec : 0);
      const { buffer } = await renderMathShort({
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
        resolution: resolved.resolution,
        quick_reveal: true,
        ...(math.accent_color ? { accent_color: math.accent_color } : {}),
      });
      const mathMeta = await writeMediaFromBuffer({
        idSeed: `compose-math:${resolved.resolution}:${onScreen.toFixed(2)}:${JSON.stringify(math)}`,
        buffer,
        ext: ".mp4",
        sourceUrl: "math://compose-scene",
      });
      footagePath = mathMeta.path;
    } else {
      const footage = await loadMeta(scene.visual.mediaId);
      if (!footage) {
        throw new Error(
          `scene footage not found: ${scene.visual.mediaId} — download it with video_download_media first.`,
        );
      }
      footagePath = footage.path;
    }
    sceneInputs.push({ footagePath, duration: span });
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
        // A negative offset can push a short opening cue past zero; clamp both bounds so the
        // interval stays valid (an inverted [start,end] never draws at all).
        for (const cue of offsetCues(cues, scene.caption.offset)) {
          const start = Math.max(0, cue.start);
          captions.push({ ...cue, start, end: Math.max(start + 0.3, cue.end), style });
        }
      }
    } finally {
      await rm(alignDir, { recursive: true, force: true });
    }
  }
  const placedCues = offsetCues(captions, leadInSec);

  let music: { path: string; volume: number } | undefined;
  if (musicRef) {
    const musicMeta = await loadMeta(musicRef.mediaId);
    if (!musicMeta) {
      throw new Error(
        `music media_id not found: ${musicRef.mediaId} — download it with video_download_media first.`,
      );
    }
    music = { path: musicMeta.path, volume: musicRef.volume };
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
  const saved = await saveRender(buffer, meta.filename, metadata, {
    tool: "video_compose",
    args: { composition },
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
  };
}

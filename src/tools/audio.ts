import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../lib/exec.js";
import { narratedScenes } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderMathShort, validatePlotExpr } from "../services/manim.js";
import { loadMeta, writeMediaFromBuffer } from "../services/media.js";
import { metadataSidecarName, saveRender } from "../services/publish.js";
import { storage } from "../services/storage.js";
import { dimsFor } from "../services/timeline.js";
import { synthesizeChatterbox } from "../services/tts.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, metadataArg } from "./shared.js";

const MIN_VOICE_REFERENCE_SEC = 2;
// A clone reference only needs a few seconds of clean speech. Cap the extracted clip so a
// long video's audio track doesn't become a huge upload, and it's enough for a good clone.
const CLONE_CLIP_SECONDS = 20;
// Chatterbox caps a single generation at ~1000 tokens (~17-20s of speech), so anything longer
// truncates. Split into chunks safely under that and stitch, keeping the same voice throughout.
const MAX_TTS_CHUNK_CHARS = 220;
// Chatterbox's measured speaking rate is very steady (~2.84-3.01 words/s across lengths, barely
// moved by cfg_weight), so word count predicts the spoken length within a few tenths of a second.
const TTS_WORDS_PER_SEC = 2.9;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return [clean];
  const units = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const raw of units) {
    let unit = raw.trim();
    if (!unit) continue;
    while (unit.length > maxChars) {
      const space = unit.lastIndexOf(" ", maxChars);
      const cut = space > 0 ? space : maxChars;
      flush();
      chunks.push(unit.slice(0, cut).trim());
      unit = unit.slice(cut).trim();
    }
    if (cur && `${cur} ${unit}`.length > maxChars) flush();
    cur = cur ? `${cur} ${unit}` : unit;
  }
  flush();
  return chunks;
}

async function concatWavs(parts: Buffer[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vcm-tts-"));
  try {
    const files = await Promise.all(
      parts.map(async (part, i) => {
        const p = join(dir, `p${i}.wav`);
        await writeFile(p, part);
        return p;
      }),
    );
    const listPath = join(dir, "list.txt");
    await writeFile(listPath, files.map((f) => `file '${f}'`).join("\n"));
    const out = join(dir, "out.wav");
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface SpeechParams {
  text: string;
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  voiceFile?: { buffer: Buffer; filename: string };
}

async function synthesizeSpeech(params: SpeechParams): Promise<Buffer> {
  const chunks = splitIntoChunks(params.text, MAX_TTS_CHUNK_CHARS);
  if (chunks.length === 1) return synthesizeChatterbox(params);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    parts.push(await synthesizeChatterbox({ ...params, text: chunk }));
  }
  return concatWavs(parts);
}

function describeActing(exaggeration: number, cfgWeight: number): string {
  const intensity =
    exaggeration < 0.35
      ? "calm, restrained"
      : exaggeration < 0.6
        ? "natural, engaged"
        : exaggeration < 0.85
          ? "expressive, dramatic"
          : "intense, over-the-top";
  const pace =
    cfgWeight < 0.4 ? "slow, deliberate" : cfgWeight > 0.65 ? "brisk, clipped" : "steady";
  return `${intensity}; ${pace} pacing`;
}

// Length of a PCM WAV buffer without shelling out: the "data" subchunk size over the byte rate.
function wavDurationSec(buffer: Buffer): number {
  const dataIdx = buffer.indexOf("data", 12, "ascii");
  const byteRate = buffer.readUInt32LE(28);
  if (dataIdx < 0 || byteRate <= 0) return 0;
  return buffer.readUInt32LE(dataIdx + 4) / byteRate;
}

// A clone reference may be a video / long / huge file, so extract just the leading mono audio:
// Chatterbox always gets clean, small speech. Shared by video_tts and video_narrated_scenes.
async function extractCloneClip(
  voiceReference: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const ref = await loadMeta(voiceReference);
  if (!ref) {
    throw new Error(
      `voice_reference not found: ${voiceReference}. Download the reference clip with video_download_media first and pass its media_id.`,
    );
  }
  if (!(await stat(ref.path).catch(() => null))) {
    throw new Error(
      `voice_reference ${voiceReference} is no longer cached; re-download it with video_download_media.`,
    );
  }
  if (!ref.duration || ref.duration < MIN_VOICE_REFERENCE_SEC) {
    throw new Error(
      `voice_reference is ${ref.duration ? `only ${ref.duration.toFixed(1)}s` : "not usable audio"}; cloning needs at least ${MIN_VOICE_REFERENCE_SEC}s of clear speech (5-15s is ideal).`,
    );
  }
  const clipDir = await mkdtemp(join(tmpdir(), "vcm-clone-"));
  try {
    const clipPath = join(clipDir, "ref.wav");
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-i",
      ref.path,
      "-t",
      String(CLONE_CLIP_SECONDS),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "24000",
      clipPath,
    ]);
    const clip = await readFile(clipPath);
    if (clip.length < 2000) {
      throw new Error(`voice_reference ${voiceReference} has no usable audio track to clone from.`);
    }
    return { buffer: clip, filename: "voice.wav" };
  } finally {
    await rm(clipDir, { recursive: true, force: true });
  }
}

export function registerAudioTools(server: McpServer): void {
  registerTool(server, {
    name: "video_tts",
    title: "Text to Speech (acting voice)",
    description:
      "Generate an expressive narration/voice clip with Chatterbox. Handles long text (a whole paragraph): it splits into chunks and stitches them in one voice. EXPENSIVE AND SLOW: autoregressive on CPU, ~5x realtime, serialized. You direct the acting with `exaggeration` (0.3 calm, 0.55 natural, 0.9 dramatic) and `cfg_weight` (drop to ~0.35 so intense lines don't rush). Clone any voice by passing `voice_reference` (a media_id of a reference clip, including a downloaded video/YouTube clip; its audio is extracted automatically). ASYNCHRONOUS: returns a job_id, poll video_render_status until state is 'done', then read result.url (a downloadable wav), result.duration_sec, and result.media_id. Usable standalone or as a pre-step before a video. Read the `tts` skill for how to pick acting levels and prep the text. Requires the TTS backend configured (CHATTERBOX_URL). To narrate a video: video_tts (take result.media_id) → video_add_audio(media_id:<video>, audio_media_id:<that>, mode:'replace').",
    inputSchema: {
      text: z
        .string()
        .min(1)
        .describe(
          "What the voice should say. Pass the ENTIRE text in one call, however long a paragraph: this tool splits and stitches it in one voice itself. Do NOT split it across multiple video_tts calls. Prep it for delivery: punctuation and short sentences shape the acting.",
        ),
      voice_reference: z
        .string()
        .optional()
        .describe(
          "media_id of a reference clip to clone ('use THIS voice'). Download the clip with video_download_media first. Without it you get the default voice.",
        ),
      exaggeration: z
        .number()
        .min(0)
        .max(2)
        .default(0.5)
        .describe("Acting intensity: 0.3 calm, 0.55 natural, 0.9 dramatic."),
      cfg_weight: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Pacing/guidance: lower = slower and more deliberate; ~0.35 stops intense lines rushing.",
        ),
      temperature: z
        .number()
        .min(0.1)
        .max(1.5)
        .default(0.8)
        .describe("Sampling randomness; higher = more varied delivery."),
    },
    handler: async ({ text, voice_reference, exaggeration, cfg_weight, temperature }) => {
      let voiceFile: { buffer: Buffer; filename: string } | undefined;
      let voiceLabel = "default";
      if (voice_reference) {
        voiceFile = await extractCloneClip(voice_reference);
        voiceLabel = `cloned:${voice_reference}`;
      }

      // Generation is slow (chunked long text is minutes) and would blow the request timeout,
      // so it runs as a background job like the video renders. Voice-reference validation above
      // stays synchronous so bad input still fails fast.
      const jobId = submitJob("tts", async () => {
        const buffer = await synthesizeSpeech({
          text,
          exaggeration,
          cfgWeight: cfg_weight,
          temperature,
          voiceFile,
        });

        const meta = await writeMediaFromBuffer({
          idSeed: `tts:${voiceLabel}:${exaggeration}:${cfg_weight}:${temperature}:${text}`,
          buffer,
          ext: ".wav",
          sourceUrl: `tts://chatterbox/${voiceLabel}`,
        });

        const artifact = {
          kind: "tts-audio" as const,
          media_id: meta.media_id,
          text,
          voice: voiceLabel,
          cloned: Boolean(voiceFile),
          acting: {
            exaggeration,
            cfg_weight,
            temperature,
            description: describeActing(exaggeration, cfg_weight),
          },
          duration_sec: Number(meta.duration.toFixed(3)),
          sample_rate: 24000,
          bytes: buffer.byteLength,
          expensive: true as const,
          note: "Autoregressive ~5x realtime, serialized. Generate lines up front; parallelize independent ones, await when you need duration_sec.",
        };

        // Publish the clip + a distinct audio-only JSON sidecar so it can be used standalone.
        // Storage is optional (local dev without a bucket); the media_id still resolves locally.
        let url: string | null = null;
        let metadata_url: string | null = null;
        let publish_error: string | undefined;
        try {
          const filename = `tts-${meta.media_id}.wav`;
          url = await storage().save(buffer, filename, "audio/wav");
          metadata_url = await storage().save(
            Buffer.from(JSON.stringify({ ...artifact, url }, null, 2)),
            metadataSidecarName(filename),
            "application/json",
          );
        } catch (error) {
          publish_error = error instanceof Error ? error.message : String(error);
        }

        // Deliberately NOT returning audio_base64: a long clip is megabytes of base64 that
        // would bloat an agent's context (and broke a caller's next LLM turn). Callers use
        // the url or the media_id; fetch the url if raw bytes are needed.
        return {
          ...artifact,
          url,
          metadata_url,
          ...(publish_error ? { publish_error } : {}),
          compose_hint: `Standalone: use url. Over a video: video_add_audio(media_id:"<video>", audio_media_id:"${meta.media_id}", mode:"replace"). This clip is ${artifact.duration_sec}s.`,
        };
      });
      return {
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });

  registerTool(server, {
    name: "video_tts_estimate",
    title: "Estimate narration length",
    description:
      "Predict how long a narration will take to speak, WITHOUT generating it (instant, free). Use this to fit a narration to a target length before the slow video_tts call: pass `target_sec` to get a word budget, or pass `text` to get its spoken length, or both to see exactly how many words to trim/add. Chatterbox speaks ~2.9 words/second (steady regardless of the acting dials). Draft → estimate → trim → video_tts, so the video comes out the length you intended.",
    inputSchema: {
      text: z.string().optional().describe("Narration draft to estimate the spoken length of."),
      target_sec: z
        .number()
        .positive()
        .optional()
        .describe("Desired spoken length in seconds; returns the word budget to write to."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ text, target_sec }) => {
      if (!text && target_sec === undefined) {
        throw new Error("Pass text, target_sec, or both.");
      }
      const wordCount = text ? countWords(text) : undefined;
      const estimatedSec =
        wordCount !== undefined ? Number((wordCount / TTS_WORDS_PER_SEC).toFixed(1)) : undefined;
      const targetWords =
        target_sec !== undefined ? Math.round(target_sec * TTS_WORDS_PER_SEC) : undefined;
      const compare =
        wordCount !== undefined && targetWords !== undefined
          ? {
              words_to_trim: wordCount - targetWords,
              fits: Math.abs(wordCount - targetWords) <= Math.max(3, targetWords * 0.1),
            }
          : {};
      return Promise.resolve({
        words_per_sec: TTS_WORDS_PER_SEC,
        ...(wordCount !== undefined ? { word_count: wordCount, estimated_sec: estimatedSec } : {}),
        ...(targetWords !== undefined ? { target_sec, target_words: targetWords } : {}),
        ...compare,
      });
    },
  });

  registerTool(server, {
    name: "video_narrated_scenes",
    title: "Narrated video (any visual, synced by construction)",
    description:
      "THE tool for a narrated video/explainer that stays PERFECTLY in sync — footage documentary, math explainer, or a mix, one call. Give ordered scenes; each has a narration `line` plus a visual that is EITHER `media_id` (footage/image from video_download_media) OR `math` (a formula/graph rendered for you). It narrates each line, measures its real spoken length, fits that scene's visual to it, burns a synced caption, and stitches them — so when scene N is on screen, line N is heard and captioned. No timestamps, no alignment, no cut-off voice, sync guaranteed by construction, any length. Captions wrap and sit in a safe margin (no crop/overlap); output defaults to landscape. Add `music_media_id` for a bed (sidechain-ducked under the voice, plays through a `lead_in_sec` beat first) and `voice_reference` to clone one voice across all lines. Requires CHATTERBOX_URL. Returns the finished MP4 + a `scenes` timeline (each line's real start/end). ASYNCHRONOUS: returns a job_id to poll with video_render_status. Use this instead of hand-chaining video_render_math / video_tts / video_add_audio whenever visuals must line up with narration. Keep the scene count to the request's real scope (one per beat — a short / '3 moments' is ~3-5 scenes, not a dozen): each scene is a separate narration generated one at a time (and a math scene also renders manim), so scene count is the dominant cost.",
    inputSchema: {
      scenes: z
        .array(
          z
            .object({
              line: z.string().min(1).describe("The narration spoken during this scene."),
              media_id: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Footage/image visual for this scene (from video_download_media), cut to the line's length. Give EITHER this OR math.",
                ),
              math: z
                .object({
                  latex: z
                    .string()
                    .min(1)
                    .describe("LaTeX formula shown this scene, e.g. 'a^2 + b^2 = c^2'."),
                  plot_expr: z
                    .string()
                    .optional()
                    .describe("Optional numpy expression to graph, e.g. 'sin(x)' or '3*x**2'."),
                  x_range: z
                    .array(z.number())
                    .length(2)
                    .optional()
                    .describe("[min, max] x-axis. Default [-5, 5]."),
                  y_range: z
                    .array(z.number())
                    .length(2)
                    .optional()
                    .describe("[min, max] y-axis. Default [-3, 3]."),
                  title: z.string().optional().describe("Heading above the formula this scene."),
                  accent_color: z
                    .string()
                    .optional()
                    .describe("Hex (#RRGGBB) or basic color for the formula/graph."),
                })
                .optional()
                .describe(
                  "Render a math visual (formula + optional graph) for this scene INSTEAD of footage. Give EITHER this OR media_id.",
                ),
              caption: z
                .string()
                .optional()
                .describe(
                  'On-screen caption for this scene. Omit to caption with the spoken line verbatim (recommended); set to "" for no caption on this scene.',
                ),
            })
            .refine((scene) => Boolean(scene.media_id) !== Boolean(scene.math), {
              message: "each scene needs exactly one of media_id or math",
            }),
        )
        .min(1)
        .max(40)
        .describe(
          "Ordered beats: each pairs a narration line with the visual (footage or math) shown while it plays.",
        ),
      voice_reference: z
        .string()
        .optional()
        .describe(
          "media_id to clone one narrator voice across every line (download the clip first).",
        ),
      exaggeration: z
        .number()
        .min(0)
        .max(2)
        .default(0.5)
        .describe("Acting intensity: 0.3 calm, 0.55 natural, 0.9 dramatic."),
      cfg_weight: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("Pacing: lower = slower/more deliberate."),
      temperature: z.number().min(0.1).max(1.5).default(0.8).describe("Delivery variation."),
      music_media_id: z
        .string()
        .optional()
        .describe(
          "Background music (from video_download_media); plays from 0:00, ducked under the voice.",
        ),
      music_volume: z
        .number()
        .min(0)
        .max(2)
        .default(0.25)
        .describe("Music bed volume (also ducks under narration)."),
      lead_in_sec: z
        .number()
        .min(0)
        .max(10)
        .default(1)
        .describe("Seconds the footage/music play before the first line comes in."),
      burn_captions: z
        .boolean()
        .default(true)
        .describe(
          "Burn a subtitle of each line onto its scene (synced by construction, wrapped, safe-margin). Default on — leave on for narrated explainers/shorts; set false only for a caption-free montage.",
        ),
      resolution: RESOLUTION.default("landscape").describe(
        "Output resolution/orientation. Default landscape (16:9); use a portrait/vertical value ONLY for a short/reel/TikTok/story.",
      ),
      metadata: metadataArg,
    },
    handler: ({
      scenes,
      voice_reference,
      exaggeration,
      cfg_weight,
      temperature,
      music_media_id,
      music_volume,
      lead_in_sec,
      burn_captions,
      resolution,
      metadata,
    }) => {
      const jobId = submitJob("narrated-scenes", async () => {
        const voiceFile = voice_reference ? await extractCloneClip(voice_reference) : undefined;
        const resolved = [];
        for (const [i, scene] of scenes.entries()) {
          const narrationWav = await synthesizeSpeech({
            text: scene.line,
            exaggeration,
            cfgWeight: cfg_weight,
            temperature,
            voiceFile,
          });
          const duration = wavDurationSec(narrationWav);
          if (!(duration > 0.1 && duration < 600)) {
            throw new Error(
              `narration for a scene came out ${duration.toFixed(1)}s (line: "${scene.line.slice(0, 40)}...") — bad audio, aborting.`,
            );
          }
          // The visual must be at least as long as its on-screen time (the line, plus the lead-in
          // on the first scene) so the synced builder trims it to the line instead of looping it.
          const onScreen = duration + (i === 0 ? lead_in_sec : 0);
          let footagePath: string;
          if (scene.math) {
            if (scene.math.plot_expr) {
              const plotError = validatePlotExpr(scene.math.plot_expr);
              if (plotError) {
                throw new Error(`scene ${i + 1} math plot_expr: ${plotError}`);
              }
            }
            const { buffer } = await renderMathShort({
              title: scene.math.title ?? "",
              scenes: [
                {
                  latex: scene.math.latex,
                  ...(scene.math.plot_expr ? { plot_expr: scene.math.plot_expr } : {}),
                  ...(scene.math.x_range ? { x_range: scene.math.x_range } : {}),
                  ...(scene.math.y_range ? { y_range: scene.math.y_range } : {}),
                  duration: onScreen + 1,
                },
              ],
              resolution,
              ...(scene.math.accent_color ? { accent_color: scene.math.accent_color } : {}),
            });
            const mathMeta = await writeMediaFromBuffer({
              idSeed: `narrated-math:${resolution}:${onScreen.toFixed(2)}:${JSON.stringify(scene.math)}`,
              buffer,
              ext: ".mp4",
              sourceUrl: "math://narrated-scene",
            });
            footagePath = mathMeta.path;
          } else {
            const footage = scene.media_id ? await loadMeta(scene.media_id) : null;
            if (!footage) {
              throw new Error(
                `scene footage not found: ${scene.media_id ?? "(missing)"} — download it with video_download_media first.`,
              );
            }
            footagePath = footage.path;
          }
          const caption = burn_captions ? (scene.caption ?? scene.line) : undefined;
          resolved.push({ footagePath, narrationWav, duration, line: scene.line, caption });
        }
        let music: { path: string; volume: number } | undefined;
        if (music_media_id) {
          const musicMeta = await loadMeta(music_media_id);
          if (!musicMeta) {
            throw new Error(
              `music_media_id not found: ${music_media_id} — download it with video_download_media first.`,
            );
          }
          music = { path: musicMeta.path, volume: music_volume };
        }
        const { width: w, height: h } = dimsFor(resolution);
        const { buffer, meta } = await narratedScenes({
          scenes: resolved.map((s) => ({
            footagePath: s.footagePath,
            duration: s.duration,
            caption: s.caption,
          })),
          narration: await concatWavs(resolved.map((s) => s.narrationWav)),
          leadInSec: lead_in_sec,
          music,
          width: w,
          height: h,
          fps: 30,
        });
        const saved = await saveRender(buffer, meta.filename, metadata);
        let cursor = lead_in_sec;
        const timeline = resolved.map((scene) => {
          const start = cursor;
          cursor += scene.duration;
          return {
            line: scene.line,
            start: Number(start.toFixed(2)),
            end: Number(cursor.toFixed(2)),
          };
        });
        return {
          ...saved,
          media_id: meta.media_id,
          duration_sec: Number(meta.duration.toFixed(3)),
          scenes: timeline,
        };
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { charsPerLine, validateColor } from "../lib/ffmpeg.js";
import { alignWords } from "../services/align.js";
import { type Cue, fontScaleFor, groupIntoCues, offsetCues } from "../services/captions.js";
import { narratedScenes } from "../services/effects.js";
import { submitJob } from "../services/jobs.js";
import { renderMathShort } from "../services/manim.js";
import { loadMeta, writeMediaFromBuffer } from "../services/media.js";
import {
  TTS_WORDS_PER_SEC,
  concatWavs,
  countWords,
  extractCloneClip,
  synthesizeSpeech,
  wavDurationSec,
} from "../services/narration.js";
import { metadataSidecarName, saveRender } from "../services/publish.js";
import { storage } from "../services/storage.js";
import { dimsFor } from "../services/timeline.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, metadataArg } from "./shared.js";

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
      "THE tool for a narrated video/explainer that stays PERFECTLY in sync — footage documentary, math explainer, or a mix, one call. Give ordered scenes; each has a narration `line` plus a visual that is EITHER `media_id` (footage/image from video_download_media) OR `math` (a formula/graph rendered for you). It narrates each line, measures its real spoken length, fits that scene's visual to it, and stitches them — so when scene N is on screen, line N is heard. No cut-off voice, sync guaranteed by construction, any length. Subtitles are ON by default: the narration is force-aligned to the audio and shown as rolling word-synced phrase cues (whole clauses, wrapped) in a bottom safe band — they flow with the speech, not one block per scene, and never overlap the scene content above. Output defaults to landscape. Add `music_media_id` for a bed (sidechain-ducked under the voice, plays through a `lead_in_sec` beat first) and `voice_reference` to clone one voice across all lines. Requires CHATTERBOX_URL. Returns the finished MP4 + a `scenes` timeline (each line's real start/end). ASYNCHRONOUS: returns a job_id to poll with video_render_status. Use this instead of hand-chaining video_render_math / video_tts / video_add_audio whenever visuals must line up with narration. Keep the scene count to the request's real scope (one per beat — a short / '3 moments' is ~3-5 scenes, not a dozen): each scene is a separate narration generated one at a time (and a math scene also renders manim), so scene count is the dominant cost.",
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
          "Burn word-synced subtitles: the narration is force-aligned to the audio and shown as rolling phrase cues in a bottom safe band (wrapped, never overlapping the scene content above). Default on for narrated explainers/shorts; set false only for a caption-free montage.",
        ),
      caption_color: z
        .string()
        .default("white")
        .describe(
          "Caption color — hex (#RRGGBB) or a basic color name. In karaoke mode this is the highlight color words sweep to.",
        ),
      caption_mode: z
        .enum(["block", "karaoke"])
        .default("block")
        .describe(
          "block = static phrase cues (readable subtitles). karaoke = each word highlights to caption_color as it is spoken (word-by-word animation).",
        ),
      caption_position: z
        .enum(["bottom", "center", "top"])
        .default("bottom")
        .describe("Where captions sit. Default bottom."),
      caption_size: z
        .enum(["small", "medium", "large"])
        .default("medium")
        .describe("Caption font size."),
      caption_box: z
        .boolean()
        .default(true)
        .describe("Draw a translucent box behind captions for legibility (else outline only)."),
      tail_sec: z
        .number()
        .min(0)
        .max(5)
        .default(0.6)
        .describe(
          "Seconds the last scene (and music) hold after the final word, so the video breathes out instead of hard-cutting.",
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
      caption_color,
      caption_mode,
      caption_position,
      caption_size,
      caption_box,
      tail_sec,
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
              quick_reveal: true,
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
          resolved.push({ footagePath, narrationWav, duration, line: scene.line });
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
        const narrationBuf = await concatWavs(resolved.map((s) => s.narrationWav));
        let captions: Cue[] | undefined;
        if (burn_captions) {
          if (!validateColor(caption_color)) {
            throw new Error(
              `caption_color must be hex (#RRGGBB) or a basic color name, got "${caption_color}"`,
            );
          }
          const alignDir = await mkdtemp(join(tmpdir(), "vcm-cap-"));
          try {
            const alignWav = join(alignDir, "narration.wav");
            await writeFile(alignWav, narrationBuf);
            const words = await alignWords(alignWav, resolved.map((s) => s.line).join(" "));
            const fontSize = Math.max(22, Math.round(h / 26));
            const cues = groupIntoCues(words, {
              maxChars: 2 * charsPerLine(w, fontSize),
              maxWords: 14,
            });
            captions = offsetCues(cues, lead_in_sec);
          } finally {
            await rm(alignDir, { recursive: true, force: true });
          }
        }
        const fontScale = fontScaleFor(caption_size);
        const { buffer, meta } = await narratedScenes({
          scenes: resolved.map((s) => ({ footagePath: s.footagePath, duration: s.duration })),
          narration: narrationBuf,
          leadInSec: lead_in_sec,
          music,
          captions,
          captionStyle: {
            color: caption_color,
            position: caption_position,
            fontScale,
            box: caption_box,
          },
          captionMode: caption_mode,
          tailSec: tail_sec,
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

  registerTool(server, {
    name: "video_align",
    title: "Align narration to audio (word timings + cues)",
    description:
      "Force-align a KNOWN transcript to its spoken audio and return exact word timings plus grouped phrase cues — the timetable for perfectly-synced subtitles, karaoke word-highlighting, cutting to 'where he says X', or trimming dead air. Runs in-process (wav2vec2 CTC, CPU, ~real-time); it is NOT transcription — you supply the exact text, so the words are always right. Input: the audio's media_id (from video_tts or video_download_media) plus the exact words spoken. ASYNCHRONOUS: returns a job_id to poll with video_render_status; result has words [{word,start,end}] and cues [{text,start,end}].",
    inputSchema: {
      audio_media_id: z
        .string()
        .min(1)
        .describe("media_id of the spoken audio (from video_tts or video_download_media)."),
      text: z.string().min(1).describe("The exact words spoken in the audio."),
      max_words_per_cue: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(12)
        .describe("Cue length cap in words (phrase cues, not word-by-word)."),
      max_chars_per_cue: z
        .number()
        .int()
        .min(10)
        .max(200)
        .default(60)
        .describe("Cue length cap in characters."),
    },
    handler: ({ audio_media_id, text, max_words_per_cue, max_chars_per_cue }) => {
      const jobId = submitJob("align", async () => {
        const audio = await loadMeta(audio_media_id);
        if (!audio) {
          throw new Error(
            `audio_media_id not found: ${audio_media_id} — get it from video_tts or video_download_media first.`,
          );
        }
        const words = await alignWords(audio.path, text);
        const cues = groupIntoCues(words, {
          maxChars: max_chars_per_cue,
          maxWords: max_words_per_cue,
        });
        return {
          words: words.map((w) => ({
            word: w.word,
            start: Number(w.start.toFixed(3)),
            end: Number(w.end.toFixed(3)),
          })),
          cues: cues.map((c) => ({
            text: c.text,
            start: Number(c.start.toFixed(3)),
            end: Number(c.end.toFixed(3)),
            words: c.words.map((w) => ({
              word: w.word,
              start: Number(w.start.toFixed(3)),
              end: Number(w.end.toFixed(3)),
            })),
          })),
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

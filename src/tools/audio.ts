import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { alignWords } from "../services/align.js";
import { groupIntoCues } from "../services/captions.js";
import { submitJob } from "../services/jobs.js";
import { loadMeta } from "../services/media.js";
import {
  TTS_WORDS_PER_SEC,
  countWords,
  extractCloneClip,
  synthesizeSpeechCached,
} from "../services/narration.js";
import { metadataSidecarName } from "../services/publish.js";
import { storage } from "../services/storage.js";
import { registerTool } from "./defineTool.js";

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
      "Generate an expressive narration/voice clip with Chatterbox. Handles long text (a whole paragraph): it splits into chunks and stitches them in one voice. EXPENSIVE AND SLOW: autoregressive on CPU, ~5x realtime, serialized. Repeat calls with identical text, voice and acting settings are served from cache instantly. You direct the acting with `exaggeration` (0.3 calm, 0.55 natural, 0.9 dramatic) and `cfg_weight` (drop to ~0.35 so intense lines don't rush). Clone any voice by passing `voice_reference` (a media_id of a reference clip, including a downloaded video/YouTube clip; its audio is extracted automatically). ASYNCHRONOUS: returns a job_id, poll video_render_status until state is 'done', then read result.url (a downloadable wav), result.duration_sec, and result.media_id. Usable standalone or as a pre-step before a video. Read the `tts` skill for how to pick acting levels and prep the text. Requires the TTS backend configured (CHATTERBOX_URL). To narrate a video: video_tts (take result.media_id) → video_add_audio(media_id:<video>, audio_media_id:<that>, mode:'replace').",
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
        const { buffer, meta, cached } = await synthesizeSpeechCached(
          { text, exaggeration, cfgWeight: cfg_weight, temperature, voiceFile },
          voiceLabel,
        );

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
          expensive: !cached,
          note: cached
            ? "Served from cache: this exact line, voice and acting were already generated, so this came back instantly."
            : "Autoregressive ~5x realtime, serialized. Generate lines up front; parallelize independent ones, await when you need duration_sec.",
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

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { run } from "../lib/exec.js";
import { loadMeta, writeMediaFromBuffer } from "../services/media.js";
import { metadataSidecarName } from "../services/publish.js";
import { storage } from "../services/storage.js";
import { synthesizeChatterbox } from "../services/tts.js";
import { registerTool } from "./defineTool.js";

const MIN_VOICE_REFERENCE_SEC = 2;
// A clone reference only needs a few seconds of clean speech. Cap the extracted clip so a
// long video's audio track doesn't become a huge upload, and it's enough for a good clone.
const CLONE_CLIP_SECONDS = 20;

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
      "Generate an expressive narration/voice clip with Chatterbox. EXPENSIVE AND SLOW: autoregressive on CPU, ~5x realtime (a 3s line takes ~15-20s) and requests serialize one at a time, so never fire dozens blindly. You direct the acting with `exaggeration` (0.3 calm, 0.55 natural, 0.9 dramatic) and `cfg_weight` (drop to ~0.35 so intense lines don't rush). Clone any voice by passing `voice_reference` (a media_id of a reference clip). Usable standalone (returns a downloadable `url` + a `tts-audio` JSON artifact) OR as a pre-step before a video: it returns `duration_sec` so you can size scenes or place the clip. Parallelize independent lines; await this when you need the length. Read the `tts` skill for how to pick acting levels and prep the text. Requires the TTS backend configured (CHATTERBOX_URL) or every call fails. To narrate a video: video_tts → video_add_audio(media_id:<video>, audio_media_id:<this>, mode:'replace').",
    inputSchema: {
      text: z
        .string()
        .min(1)
        .describe(
          "What the voice should say. Prep it for delivery: punctuation and short sentences shape the acting.",
        ),
      voice: z
        .string()
        .default("default")
        .describe(
          "A named voice known to the service, or 'default'. To clone an arbitrary voice use voice_reference instead.",
        ),
      voice_reference: z
        .string()
        .optional()
        .describe(
          "media_id of a reference clip to clone ('use THIS voice'). Download the clip with video_download_media first. Overrides voice.",
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
    handler: async ({ text, voice, voice_reference, exaggeration, cfg_weight, temperature }) => {
      let voiceName: string | undefined;
      let voiceFile: { buffer: Buffer; filename: string } | undefined;
      let voiceLabel = "default";
      if (voice_reference) {
        const ref = await loadMeta(voice_reference);
        if (!ref) {
          throw new Error(
            `voice_reference not found: ${voice_reference}. Download the reference clip with video_download_media first and pass its media_id.`,
          );
        }
        const info = await stat(ref.path).catch(() => null);
        if (!info) {
          throw new Error(
            `voice_reference ${voice_reference} is no longer cached; re-download it with video_download_media.`,
          );
        }
        if (!ref.duration || ref.duration < MIN_VOICE_REFERENCE_SEC) {
          throw new Error(
            `voice_reference is ${ref.duration ? `only ${ref.duration.toFixed(1)}s` : "not usable audio"}; cloning needs at least ${MIN_VOICE_REFERENCE_SEC}s of clear speech (5-15s is ideal).`,
          );
        }
        // The reference can be a video (a downloaded YouTube clip) or a long/huge file, so extract
        // just the leading mono audio: Chatterbox always gets clean, small speech regardless.
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
            throw new Error(
              `voice_reference ${voice_reference} has no usable audio track to clone from.`,
            );
          }
          voiceFile = { buffer: clip, filename: "voice.wav" };
        } finally {
          await rm(clipDir, { recursive: true, force: true });
        }
        voiceLabel = `cloned:${voice_reference}`;
      } else if (voice && voice !== "default") {
        voiceName = voice;
        voiceLabel = voice;
      }

      const buffer = await synthesizeChatterbox({
        text,
        exaggeration,
        cfgWeight: cfg_weight,
        temperature,
        voice: voiceName,
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
    },
  });
}

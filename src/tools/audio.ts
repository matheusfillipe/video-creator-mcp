import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnEngine } from "../services/engine.js";
import { writeMediaFromBuffer } from "../services/media.js";
import { synthesizeSpeech } from "../services/tts.js";
import { registerTool } from "./defineTool.js";

export function registerAudioTools(server: McpServer): void {
  registerTool(server, {
    name: "video_tts",
    title: "Text to Speech",
    description:
      "Generate narration audio from text (Kokoro voices, e.g. am_adam, af_heart, bf_emma, am_michael). Returns a media_id (and its duration in seconds) so you can lay the narration over a finished video with video_add_audio, or feed it into a video_render_timeline audio track. Also returns base64 WAV for video_render's audio_base64. To narrate a video: video_tts → video_add_audio(media_id: <video>, audio_media_id: <this>).",
    inputSchema: {
      text: z.string().min(1).describe("Text to speak."),
      voice: z.string().default("am_adam").describe("Voice id (e.g. am_adam, af_heart, bf_emma)."),
      speed: z.number().min(0.5).max(2).default(1).describe("Speech speed multiplier."),
    },
    handler: async ({ text, voice, speed }) => {
      const buffer = await runOnEngine(() => synthesizeSpeech(text, voice, speed));
      const meta = await writeMediaFromBuffer({
        idSeed: `tts:${voice}:${speed}:${text}`,
        buffer,
        ext: ".wav",
        sourceUrl: `tts://${voice}`,
      });
      return {
        media_id: meta.media_id,
        duration: meta.duration,
        bytes: buffer.byteLength,
        voice,
        audio_base64: buffer.toString("base64"),
        compose_hint: `Lay this narration over a video: video_add_audio(media_id: "<video media_id>", audio_media_id: "${meta.media_id}", mode: "replace"). Add background music after with mode:"mix".`,
      };
    },
  });
}

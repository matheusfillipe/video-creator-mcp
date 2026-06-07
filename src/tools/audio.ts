import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnEngine } from "../services/engine.js";
import { synthesizeSpeech } from "../services/tts.js";
import { registerTool } from "./defineTool.js";

export function registerAudioTools(server: McpServer): void {
  registerTool(server, {
    name: "video_tts",
    title: "Text to Speech",
    description:
      "Generate narration audio from text (Kokoro voices, e.g. am_adam, af_heart, bf_emma, am_michael). Returns base64 WAV to pass as audio_base64 in video_render, or to mix into a timeline.",
    inputSchema: {
      text: z.string().min(1).describe("Text to speak."),
      voice: z.string().default("am_adam").describe("Voice id (e.g. am_adam, af_heart, bf_emma)."),
      speed: z.number().min(0.5).max(2).default(1).describe("Speech speed multiplier."),
    },
    handler: async ({ text, voice, speed }) => {
      const buffer = await runOnEngine(() => synthesizeSpeech(text, voice, speed));
      return { audio_base64: buffer.toString("base64"), bytes: buffer.byteLength, voice };
    },
  });
}

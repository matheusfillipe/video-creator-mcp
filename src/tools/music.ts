import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { submitJob } from "../services/jobs.js";
import { getCached, mediaIdFor, writeMediaFromBuffer } from "../services/media.js";
import { generateMusic, releaseModel } from "../services/tts.js";
import { registerTool } from "./defineTool.js";

export function registerMusicTools(server: McpServer): void {
  registerTool(server, {
    name: "video_music",
    title: "Generate a Music Bed",
    description:
      "Generate an instrumental music bed from a caption (genre, instruments, mood, tempo, ending in 'instrumental') on the LocalAI audio service, for the music track of video_compose. The same caption and length come back from cache instantly, so a few fixed captions act as a channel's music library. ASYNCHRONOUS: returns a job_id; call video_render_status ONCE; the result has the media_id.",
    inputSchema: {
      caption: z
        .string()
        .min(3)
        .max(500)
        .describe(
          "Style, instruments, mood and tempo, e.g. 'upbeat synthwave, arpeggiated synths, curious, 110 bpm, instrumental'.",
        ),
      duration_sec: z
        .number()
        .int()
        .min(10)
        .max(240)
        .default(90)
        .describe("Length of the bed; video_compose loops it under the video."),
      release_gpu: z
        .boolean()
        .default(false)
        .describe(
          "Unload the music model from the GPU as soon as the bed is made, so the narration voice that follows has room. Leave it off when more beds come right after.",
        ),
    },
    handler: async ({ caption, duration_sec, release_gpu }) => {
      const idSeed = `music:${config.speech.musicModel}:${duration_sec}:${caption}`;
      const cached = await getCached(mediaIdFor(idSeed));
      if (cached) return { media_id: cached.media_id, duration: cached.duration, cached: true };
      const jobId = submitJob("music", async () => {
        const buffer = await generateMusic(caption, duration_sec);
        if (release_gpu) await releaseModel(config.speech.musicModel);
        const meta = await writeMediaFromBuffer({
          idSeed,
          buffer,
          ext: ".wav",
          sourceUrl: `music://${config.speech.musicModel}`,
        });
        return { media_id: meta.media_id, duration: meta.duration };
      });
      return {
        job_id: jobId,
        state: "queued",
        finish_with: `video_render_status with job_id "${jobId}"`,
      };
    },
  });
}

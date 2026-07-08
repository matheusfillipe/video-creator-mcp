import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addAudioTrack,
  blackOutputWarning,
  captionMedia,
  maxFrameLuma,
} from "../services/effects.js";
import { engineStatus } from "../services/engine.js";
import { getJob, listJobs, submitJob } from "../services/jobs.js";
import { loopMedia, writeMediaFromBuffer } from "../services/media.js";
import { saveRender } from "../services/publish.js";
import { renderComposition } from "../services/renderer.js";
import { assembleTimeline } from "../services/timeline.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, metadataArg } from "./shared.js";

const mediaRef = z.object({
  media_id: z.string().describe("media_id from video_download_media / video_get_thumbnail."),
});

const segmentMediaRef = z.object({
  media_id: z.string().describe("media_id from video_download_media / video_get_thumbnail."),
  volume: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("This clip's own audio volume 0-1 (default 1.0). 0 mutes it."),
  muted: z.boolean().optional().describe("Mute this clip's own audio entirely."),
});

const RENDER_RULES = `Render an HTML+GSAP composition to MP4. Asynchronous: returns a job_id — poll video_render_status until state is "done", then read result.url.

Authoring rules (run video_lint first):
- html must be base64-encoded and contain <div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">.
- All elements use position:absolute with top/left (never bottom). Canvas 1920x1080 landscape, 1080x1920 portrait — must match resolution.
- GSAP: gsap.timeline({ paused: true }) registered on window.__timelines["main"]; add class="clip" + data-start/data-duration/data-track-index to timed elements.
- No Math.random (use a seeded PRNG), no fetch/async during timeline setup. Animate a wrapper div around <video>; never call .play()/.pause().
- For multiple video clips use video_render_timeline instead (one <video> per composition).
- Reference downloaded media as src="assets/<filename>" and pass its media_id in the media array.
Reference: https://hyperframes.mintlify.app/llms.txt`;

export function registerRenderTools(server: McpServer): void {
  registerTool(server, {
    name: "video_render",
    title: "Render Video",
    description: RENDER_RULES,
    inputSchema: {
      html: z.string().min(1).describe("Base64-encoded HTML+GSAP composition."),
      audio_base64: z.string().optional().describe("Base64 WAV/MP3, injected as an <audio> track."),
      audio_volume: z.number().min(0).max(1).default(0.9).describe("Audio volume 0-1."),
      fps: z.number().int().min(1).max(60).default(30).describe("Frames per second."),
      resolution: RESOLUTION.default("1080p").describe("Output resolution/orientation."),
      media: z.array(mediaRef).optional().describe("Pre-downloaded media to include."),
      metadata: metadataArg,
    },
    handler: ({ metadata, ...args }) => {
      const { html, audio_base64, audio_volume, fps, resolution, media } = args;
      const jobId = submitJob("render", async () => {
        const { buffer, filename } = await renderComposition({
          htmlBase64: html,
          fps,
          resolution,
          audioBase64: audio_base64,
          audioVolume: audio_volume,
          media,
        });
        const saved = await saveRender(buffer, filename, metadata, {
          tool: "video_render",
          args,
        });
        const warning = blackOutputWarning(await maxFrameLuma(buffer));
        return warning ? { ...saved, warnings: [warning] } : saved;
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });

  registerTool(server, {
    name: "video_render_timeline",
    title: "Render Multi-Segment Timeline",
    description:
      "Render a multi-segment video: each segment is a self-contained base64 HTML+GSAP composition (3-15s, one <video> max), rendered independently then concatenated. A clip's own audio plays at full volume by default — set `volume` (0-1) or `muted` on its media ref to control it, no need to hand-author <video muted> or a parallel track. Use the top-level `audio` for external music/voiceover overlaid at offsets. Asynchronous: returns a job_id to poll with video_render_status. Use for tier lists, compilations, montages, or any video with multiple clips.",
    inputSchema: {
      segments: z
        .array(
          z.object({
            html: z.string().min(1).describe("Base64 HTML+GSAP for this segment."),
            duration: z.number().positive().describe("Segment duration, seconds."),
            media: z
              .array(segmentMediaRef)
              .optional()
              .describe("Media in this segment; per-clip volume/muted controls its own audio."),
          }),
        )
        .min(1)
        .describe("Ordered segments."),
      audio: z
        .array(
          z.object({
            media_id: z.string().describe("Cached media to take audio from."),
            offset_ms: z.number().min(0).describe("Start offset from the video start, ms."),
            volume: z.number().min(0).max(1).default(0.6).describe("Track volume 0-1."),
            fade_ms: z.number().min(0).default(1000).describe("Fade-out duration, ms."),
          }),
        )
        .optional()
        .describe("Audio tracks overlaid at offsets."),
      fps: z.number().int().min(1).max(60).default(30).describe("Frames per second."),
      resolution: RESOLUTION.default("1080p").describe("Output resolution/orientation."),
      metadata: metadataArg,
    },
    handler: ({ metadata, ...args }) => {
      const { segments, audio, fps, resolution } = args;
      const jobId = submitJob("timeline", async () => {
        const { buffer, filename, warnings } = await assembleTimeline({
          segments,
          audio,
          fps,
          resolution,
        });
        const saved = await saveRender(buffer, filename, metadata, {
          tool: "video_render_timeline",
          args,
        });
        const allWarnings = [...(warnings ?? [])];
        const blackWarning = blackOutputWarning(await maxFrameLuma(buffer));
        if (blackWarning) allWarnings.push(blackWarning);
        return { ...saved, segments: segments.length, warnings: allWarnings };
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });

  registerTool(server, {
    name: "video_loop",
    title: "Loop a Clip",
    description:
      "Repeat a downloaded clip N times into one MP4, keeping its original audio. Uses ffmpeg stream-copy (no re-render), so it's near-instant — use this for any 'loop/repeat this N times' request instead of building an N-segment timeline. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      media_id: z
        .string()
        .min(1)
        .describe("media_id from video_download_media (the clip/range to loop)."),
      count: z.number().int().min(2).max(200).describe("Total times to play the clip."),
      audio: z.boolean().default(true).describe("Keep the clip's original audio."),
      metadata: metadataArg,
    },
    handler: ({ media_id, count, audio, metadata }) => {
      const jobId = submitJob("loop", async () => {
        const { buffer } = await loopMedia(media_id, count, audio);
        const looped = await writeMediaFromBuffer({
          idSeed: `loop-${media_id}-${count}-${audio}`,
          buffer,
          ext: ".mp4",
          sourceUrl: media_id,
        });
        const saved = await saveRender(buffer, looped.filename, metadata);
        return {
          ...saved,
          media_id: looped.media_id,
          looped: count,
          compose_hint: `To put text/elements over this loop, render ONE composition: <video src="assets/${looped.filename}" muted playsinline> filling the frame, plus your overlay divs, and pass media:[{media_id:"${looped.media_id}"}]. Do NOT rebuild N segments.`,
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
    name: "video_caption",
    title: "Burn Captions onto a Clip",
    description:
      "Burn timed text captions directly onto a clip with ffmpeg — no HTML, no chrome render. Each caption shows only during its own [start, start+duration] window, so this is the right tool for 'loop a clip and show rotating subtitles / talk to the viewer'. Re-encodes once in roughly real time (far faster than a chrome composition). Returns a new media_id (chainable) and a finished MP4 url. Pass the looped clip's media_id (from video_loop) to caption the whole loop in one pass. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      media_id: z
        .string()
        .min(1)
        .describe("media_id of the clip to caption (e.g. a video_loop output)."),
      captions: z
        .array(
          z.object({
            text: z.string().min(1).describe("Caption text shown during this window."),
            start: z.number().min(0).describe("When the caption appears, seconds from clip start."),
            duration: z
              .number()
              .positive()
              .describe("How long the caption stays on screen, seconds."),
          }),
        )
        .min(1)
        .describe("Timed captions; overlap is allowed."),
      position: z
        .enum(["top", "center", "bottom"])
        .default("bottom")
        .describe("Vertical placement of the captions."),
      font_size: z
        .number()
        .int()
        .min(8)
        .max(200)
        .optional()
        .describe("Font size in pixels; defaults to ~1/20 of the video height."),
      color: z.string().default("white").describe("Font color (ffmpeg color name or #RRGGBB)."),
      box: z
        .boolean()
        .default(true)
        .describe("Draw a translucent background box behind the text for readability."),
      metadata: metadataArg,
    },
    handler: ({ media_id, captions, position, font_size, color, box, metadata }) => {
      const jobId = submitJob("caption", async () => {
        const { buffer, meta } = await captionMedia({
          mediaId: media_id,
          captions,
          position,
          fontSize: font_size,
          color,
          box,
        });
        const saved = await saveRender(buffer, meta.filename, metadata);
        return {
          ...saved,
          media_id: meta.media_id,
          duration: meta.duration,
          captions: captions.length,
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
    name: "video_add_audio",
    title: "Add / Mix Audio onto a Video",
    description:
      "Lay an audio track onto a finished video — the audio counterpart to video_caption. mode 'replace' makes it the only audio (use for TTS narration over muted footage); mode 'mix' blends it UNDER the video's existing audio at `volume` (use to add background music or ambient sound to an already-narrated clip — the video must already have audio). The video keeps its full length; shorter audio just ends. Chain to layer: replace the narration first, then mix in music. THIS is how you add a voiceover/soundtrack to a video built with video_caption or video_render_timeline. Returns a new media_id + finished MP4 url. Asynchronous: returns a job_id to poll with video_render_status.",
    inputSchema: {
      media_id: z.string().min(1).describe("Video media_id to add audio to."),
      audio_media_id: z
        .string()
        .min(1)
        .describe(
          "Audio media_id — from video_tts (narration) or video_download_media (music/sfx).",
        ),
      mode: z
        .enum(["replace", "mix"])
        .default("replace")
        .describe(
          "'replace' = this becomes the only audio (narration over muted footage); 'mix' = blend under the video's existing audio (needs the video to already have audio).",
        ),
      volume: z
        .number()
        .min(0)
        .max(4)
        .default(1)
        .describe("Volume of the added track (for 'mix', relative to the existing audio)."),
      existing_volume: z
        .number()
        .min(0)
        .max(4)
        .default(1)
        .describe(
          "For 'mix' only: volume of the video's ORIGINAL audio. Set low (e.g. 0.2) to duck the footage under a narration track so the clip's own sound stays as quiet background.",
        ),
      loop: z
        .boolean()
        .default(false)
        .describe(
          "Repeat the track to cover the whole video if it's shorter. Set true for BACKGROUND MUSIC so the video never goes silent before it ends; leave false for a one-shot voiceover you don't want repeated.",
        ),
      metadata: metadataArg,
    },
    handler: ({ media_id, audio_media_id, mode, volume, existing_volume, loop, metadata }) => {
      const jobId = submitJob("add-audio", async () => {
        const { buffer, meta } = await addAudioTrack({
          videoId: media_id,
          audioId: audio_media_id,
          mode,
          volume,
          existingVolume: existing_volume,
          loop,
        });
        const saved = await saveRender(buffer, meta.filename, metadata);
        return { ...saved, media_id: meta.media_id, duration: meta.duration };
      });
      return Promise.resolve({
        job_id: jobId,
        state: "queued",
        poll_with: `video_render_status with job_id "${jobId}"`,
      });
    },
  });

  registerTool(server, {
    name: "video_render_status",
    title: "Render Job Status",
    description:
      "Check a render/timeline job. When state is 'done', result holds the rendered video url. When 'error', error holds the message.",
    inputSchema: {
      job_id: z
        .string()
        .min(1)
        .describe("job_id returned by video_render / video_render_timeline."),
    },
    annotations: { readOnlyHint: true },
    handler: ({ job_id }) => {
      const job = getJob(job_id);
      if (!job) throw new Error(`No job with id "${job_id}" (it may have expired)`);
      return Promise.resolve(job);
    },
  });

  registerTool(server, {
    name: "video_render_queue",
    title: "Render Queue Status",
    description: "Show the render engine concurrency state and all known jobs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: () => Promise.resolve({ engine: engineStatus(), jobs: listJobs() }),
  });
}

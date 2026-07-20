import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addAudioTrack, captionMedia, narrateOverMusic } from "../services/effects.js";
import { engineStatus } from "../services/engine.js";
import { getJob, listJobs, submitJob } from "../services/jobs.js";
import { loopMedia, writeMediaFromBuffer } from "../services/media.js";
import { saveRender } from "../services/publish.js";
import { assembleTimeline } from "../services/timeline.js";
import { registerTool } from "./defineTool.js";
import { RESOLUTION, compositionHtml, metadataArg } from "./shared.js";

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

export function registerRenderTools(server: McpServer): void {
  registerTool(server, {
    name: "video_render_timeline",
    title: "Render Multi-Segment Timeline",
    description:
      "Render a multi-segment video: each segment is a self-contained base64 HTML+GSAP composition (3-15s, one <video> max), rendered independently then concatenated. A clip's own audio plays at full volume by default — set `volume` (0-1) or `muted` on its media ref to control it, no need to hand-author <video muted> or a parallel track. Use the top-level `audio` for external music/voiceover overlaid at offsets. Asynchronous: returns a job_id to poll with video_render_status. Use for tier lists, compilations, montages, or any video with multiple clips. Only embed a <video> when you need HTML drawn ON TOP of the footage — it re-renders the clip through the browser (slow, and can fail to a black frame on long clips). To simply include or trim an existing clip (e.g. a recording), or stitch clips end to end, use video_compose / video_edit instead.",
    inputSchema: {
      segments: z
        .array(
          z.object({
            html: compositionHtml(
              "This segment's HTML+GSAP markup (plain text; base64 also accepted).",
            ),
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
        return { ...saved, segments: segments.length, warnings: warnings ?? [] };
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
      "Lay an audio track onto a finished video — the audio counterpart to video_caption. mode 'replace' makes it the only audio (use for TTS narration over muted footage); mode 'mix' blends it UNDER the video's existing audio at `volume` (use to add background music or ambient sound to an already-narrated clip — the video must already have audio). The video keeps its full length; shorter audio just ends. To lay a NARRATION AND BACKGROUND MUSIC together, do it in ONE call: pass audio_media_id (the narration) AND music_media_id — the music plays from 0:00, is auto-ducked (sidechain) whenever the voice speaks so the narration stays clearly on top, and start_sec gives the lead-in; the video is held on its last frame if the narration runs longer. Prefer this over chaining a replace + a mix. THIS is how you add a voiceover/soundtrack to a video built with video_caption or video_render_timeline. Returns a new media_id + finished MP4 url. Asynchronous: returns a job_id to poll with video_render_status.",
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
      start_sec: z
        .number()
        .min(0)
        .max(30)
        .default(0)
        .describe(
          "Delay this track by N seconds so it starts a beat in instead of at 0:00. Use a small lead-in (~1s) for a narration so the footage/music breathes before the voice comes in; the video is extended if the delayed track would run past its end.",
        ),
      music_media_id: z
        .string()
        .optional()
        .describe(
          "Optional background music to lay UNDER audio_media_id (the narration) in the same call: music plays from 0:00 and is sidechain-ducked when the voice speaks, so the narration stays clearly on top and the lead-in (start_sec) keeps the music. Download it with video_download_media first.",
        ),
      music_volume: z
        .number()
        .min(0)
        .max(2)
        .default(0.25)
        .describe(
          "Base volume of the music bed (it also ducks under the narration). Only used with music_media_id.",
        ),
      metadata: metadataArg,
    },
    handler: ({
      media_id,
      audio_media_id,
      mode,
      volume,
      existing_volume,
      loop,
      start_sec,
      music_media_id,
      music_volume,
      metadata,
    }) => {
      const jobId = submitJob("add-audio", async () => {
        const { buffer, meta } = music_media_id
          ? await narrateOverMusic({
              videoId: media_id,
              narrationId: audio_media_id,
              musicId: music_media_id,
              leadInSec: start_sec,
              musicVolume: music_volume,
              narrationVolume: volume,
            })
          : await addAudioTrack({
              videoId: media_id,
              audioId: audio_media_id,
              mode,
              volume,
              existingVolume: existing_volume,
              loop,
              startSec: start_sec,
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
        .describe(
          "job_id returned by any asynchronous tool, e.g. video_compose, video_graphic, video_render_timeline.",
        ),
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

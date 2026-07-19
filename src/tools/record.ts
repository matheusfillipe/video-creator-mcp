import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_KEYS,
  MAX_RECORD_SECONDS,
  type RecordAction,
  getRecording,
  startRecording,
} from "../services/record.js";
import { registerTool } from "./defineTool.js";

const ACTION = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      selector: z.string().optional().describe("CSS selector of the element to click (preferred)."),
      x: z.number().optional().describe("Viewport x, if not using a selector."),
      y: z.number().optional().describe("Viewport y, if not using a selector."),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      text: z.string().describe("Text typed into the focused field."),
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.string().describe(`A single control key. One of: ${ALLOWED_KEYS.join(", ")}.`),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      dy: z.number().describe("Vertical wheel delta (positive scrolls down)."),
      dx: z.number().optional().describe("Horizontal wheel delta."),
    })
    .strict(),
  z
    .object({
      type: z.literal("navigate"),
      url: z.string().describe("Navigate to another http/https URL."),
    })
    .strict(),
  z
    .object({ type: z.literal("wait"), ms: z.number().describe("Pause this many ms (max 30000).") })
    .strict(),
]);

export function registerRecordTools(server: McpServer): void {
  registerTool(server, {
    name: "video_record_website",
    title: "Record a website (live browser)",
    description:
      "Open a real browser at a URL and record it to video WITH AUDIO in real time (the page's music/video sound is captured and muxed into the mp4). Public http/https sites only — loopback, LAN, cluster and private IPs are blocked (network + app enforced). Returns a session_id immediately; the recording runs live in the background. Drive it with video_record_input (click / type / key / scroll / navigate — e.g. press Space to start a player) and finish with video_record_stop, which returns an mp4 media_id (with audio) usable anywhere (video_compose, video_edit, captions). Auto-stops at duration_seconds (default 30, MAX 600 = 10 min). EXPENSIVE: recording is real time — a 5 minute capture takes 5 minutes. For a plain grab just start then stop; for an interactive flow interleave video_record_input calls.",
    inputSchema: {
      url: z.string().describe("Public http(s) URL to open and record."),
      duration_seconds: z
        .number()
        .min(1)
        .max(MAX_RECORD_SECONDS)
        .optional()
        .describe(`Auto-stop after this long. Default 30, max ${MAX_RECORD_SECONDS} (10 min).`),
      width: z
        .number()
        .int()
        .min(320)
        .max(1920)
        .optional()
        .describe("Viewport width. Default 1280."),
      height: z
        .number()
        .int()
        .min(240)
        .max(1080)
        .optional()
        .describe("Viewport height. Default 720."),
      fps: z.number().int().min(1).max(60).optional().describe("Frames per second. Default 30."),
    },
    annotations: { openWorldHint: true },
    handler: async ({ url, duration_seconds, width, height, fps }) => {
      const session = await startRecording({
        url,
        width: width ?? 1280,
        height: height ?? 720,
        fps: fps ?? 30,
        maxSeconds: duration_seconds ?? 30,
      });
      return {
        session_id: session.id,
        state: session.state,
        max_seconds: duration_seconds ?? 30,
        note: "Recording live. Use video_record_input to interact, video_record_stop to finish and get the mp4 media_id. It auto-stops at max_seconds.",
      };
    },
  });

  registerTool(server, {
    name: "video_record_input",
    title: "Drive a live recording",
    description:
      "Send interactions to a live recording session while it keeps recording. Actions run in order. Types: click (CSS selector or x/y), type (text into the focused element), key (one control key), scroll, navigate (another http/https URL), wait. No arbitrary JavaScript — only these primitives.",
    inputSchema: {
      session_id: z.string().describe("The id from video_record_website."),
      actions: z.array(ACTION).min(1).describe("Interactions to perform in order."),
    },
    handler: async ({ session_id, actions }) => {
      const session = getRecording(session_id);
      for (const action of actions) {
        await session.act(action as RecordAction);
      }
      return { ok: true, elapsed_sec: session.elapsedSec(), state: session.state };
    },
  });

  registerTool(server, {
    name: "video_record_stop",
    title: "Stop a recording",
    description:
      "Stop a live recording session and finalize the video. Returns the mp4 as a media_id (usable in video_compose / video_edit / captions) plus a downloadable url and the duration. If the session already auto-stopped at its max duration, this returns the finished result.",
    inputSchema: {
      session_id: z.string().describe("The id from video_record_website."),
    },
    handler: async ({ session_id }) => {
      const session = getRecording(session_id);
      const result = await session.finalize("done", "stopped by request");
      if (!result.media_id)
        throw new Error(`recording ${session_id} failed: ${session.status().error ?? "unknown"}`);
      return { kind: "recorded-website", ...result };
    },
  });

  registerTool(server, {
    name: "video_record_status",
    title: "Recording status",
    description:
      "Check a recording session: state (recording / done / error), elapsed seconds, frame count, and (once done) the mp4 media_id.",
    inputSchema: {
      session_id: z.string().describe("The id from video_record_website."),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session_id }) => getRecording(session_id).status(),
  });
}

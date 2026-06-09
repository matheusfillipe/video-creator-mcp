import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { storage } from "../services/storage.js";
import { registerTool } from "./defineTool.js";

// mp4 can't hold YouTube tags/structure, so publish metadata is written as a JSON sidecar
// sharing the rendered video's base name (timeline-ab12.mp4 -> timeline-ab12.json). The
// filename is reduced to its basename and validated so it can't escape the bucket key.
export function metadataSidecarName(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  if (!/^[A-Za-z0-9._-]+$/.test(base) || base.startsWith(".")) {
    throw new Error(
      `Invalid video filename "${filename}" — expected something like "timeline-ab12.mp4".`,
    );
  }
  return `${base.replace(/\.[^.]+$/, "")}.json`;
}

export function registerMetadataTools(server: McpServer): void {
  registerTool(server, {
    name: "video_attach_metadata",
    title: "Attach Publish Metadata",
    description:
      "Write a publish-ready metadata sidecar next to a rendered video in the bucket: a JSON file with the same base name as the video (e.g. timeline-ab12.mp4 → timeline-ab12.json) holding the YouTube title, description and tags. mp4 can't carry tags, so this JSON is the portable metadata package an agent uses at upload time. Returns the sidecar's public URL.",
    inputSchema: {
      filename: z
        .string()
        .min(1)
        .describe(
          "The rendered video's filename from a render result, e.g. 'timeline-ab12cd34.mp4'.",
        ),
      title: z.string().min(1).describe("Video title."),
      description: z
        .string()
        .default("")
        .describe("Video description; may include chapter timestamps."),
      tags: z.array(z.string()).default([]).describe("YouTube tags / keywords."),
      category: z.string().optional().describe("Optional YouTube category, e.g. 'Gaming'."),
    },
    handler: async ({ filename, title, description, tags, category }) => {
      const sidecar = metadataSidecarName(filename);
      const metadata = {
        video: filename.split("/").pop(),
        title,
        description,
        tags,
        ...(category ? { category } : {}),
      };
      const url = await storage().save(
        Buffer.from(JSON.stringify(metadata, null, 2)),
        sidecar,
        "application/json",
      );
      return { metadata_url: url, sidecar, ...metadata };
    },
  });
}

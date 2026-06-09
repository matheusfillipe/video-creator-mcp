import { storage } from "./storage.js";

export interface PublishMetadata {
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
}

export interface SavedRender {
  url: string;
  filename: string;
  size_bytes: number;
  metadata_url?: string;
}

// mp4 can't hold YouTube tags/structure, so publish metadata is written as a JSON sidecar
// sharing the video's base name (timeline-ab12.mp4 -> timeline-ab12.json). Reduced to a
// basename and validated so it can never escape the bucket key.
export function metadataSidecarName(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  if (!/^[A-Za-z0-9._-]+$/.test(base) || base.startsWith(".")) {
    throw new Error(
      `Invalid video filename "${filename}" — expected something like "timeline-ab12.mp4".`,
    );
  }
  return `${base.replace(/\.[^.]+$/, "")}.json`;
}

// Saves a rendered video and, when metadata is supplied, a publish-ready JSON sidecar
// next to it — so one render call yields both the video URL and the metadata URL.
export async function saveRender(
  buffer: Buffer,
  filename: string,
  metadata?: PublishMetadata,
): Promise<SavedRender> {
  const url = await storage().save(buffer, filename);
  const saved: SavedRender = { url, filename, size_bytes: buffer.byteLength };
  if (metadata) {
    const sidecar = metadataSidecarName(filename);
    const body = {
      video: filename.split("/").pop(),
      title: metadata.title,
      description: metadata.description ?? "",
      tags: metadata.tags ?? [],
      ...(metadata.category ? { category: metadata.category } : {}),
    };
    saved.metadata_url = await storage().save(
      Buffer.from(JSON.stringify(body, null, 2)),
      sidecar,
      "application/json",
    );
  }
  return saved;
}

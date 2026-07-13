import { config } from "../config.js";
import { storage } from "./storage.js";

export interface PublishMetadata {
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
  brief?: string;
}

// Args are creative inputs only (code/spec/media_ids/params), never credentials — safe to publish.
export interface RenderRecipe {
  tool: string;
  args: Record<string, unknown>;
}

export interface SidecarBody {
  video?: string;
  title?: string;
  description?: string;
  tags?: string[];
  category?: string;
  brief?: string;
  recipe?: RenderRecipe;
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

// The sidecar carries the recipe alongside publish metadata, so a client can read it back and
// iterate on the render.
export async function saveRender(
  buffer: Buffer,
  filename: string,
  metadata?: PublishMetadata,
  recipe?: RenderRecipe,
): Promise<SavedRender> {
  const url = await storage().save(buffer, filename);
  const saved: SavedRender = { url, filename, size_bytes: buffer.byteLength };
  if (metadata || recipe) {
    const sidecar = metadataSidecarName(filename);
    const body: SidecarBody = {
      video: filename.split("/").pop(),
      ...(metadata
        ? {
            title: metadata.title,
            description: metadata.description ?? "",
            tags: metadata.tags ?? [],
            ...(metadata.category ? { category: metadata.category } : {}),
            ...(metadata.brief ? { brief: metadata.brief } : {}),
          }
        : {}),
      ...(recipe ? { recipe } : {}),
    };
    saved.metadata_url = await storage().save(
      Buffer.from(JSON.stringify(body, null, 2)),
      sidecar,
      "application/json",
    );
  }
  return saved;
}

// Reads the JSON sidecar for one of our own rendered videos. The url is confined to this server's
// public bucket by origin + path prefix (not a bare string match, which a look-alike host defeats),
// so this can never be turned into a fetch of an arbitrary host. Returns null when there's no sidecar.
export async function readSidecar(videoUrl: string): Promise<SidecarBody | null> {
  const base = config.storage.publicUrl;
  if (!base) throw new Error("storage publicUrl is not configured; cannot resolve sidecars");
  const baseUrl = new URL(base);
  const prefix = baseUrl.pathname.replace(/\/?$/, "/");
  let target: URL;
  try {
    target = new URL(videoUrl);
  } catch {
    throw new Error(`Invalid url: ${videoUrl}`);
  }
  if (target.origin !== baseUrl.origin || !target.pathname.startsWith(prefix)) {
    throw new Error(`url must be under this server's bucket (${base}).`);
  }
  const sidecarUrl = target.href.endsWith(".json")
    ? target.href
    : target.href.replace(/\.[^./]+$/, ".json");
  const res = await fetch(sidecarUrl, { redirect: "error" });
  if (!res.ok) return null;
  return (await res.json()) as SidecarBody;
}

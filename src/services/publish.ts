import { config } from "../config.js";
import type { MediaMeta } from "../types.js";
import { getCached, writeMediaFromBuffer } from "./media.js";
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
  media_id?: string;
  duration?: number;
  metadata_url?: string;
}

const PLAYABLE_RE = /\.(mp4|webm|mov|mkv|m4a|mp3|wav)$/i;

// Every finished render enters the media cache, so its media_id can be handed straight to the tools
// that take one (audio, captions, edits, a clip in another composition) with no round trip through
// the bucket. A render whose filename IS a media id is already cached by whoever built it, so its
// bytes are not stored a second time. Stills (preview frames, thumbnails, contact sheets) stay out
// of the cache: nothing downstream consumes them by id.
async function registerRender(
  buffer: Buffer,
  filename: string,
  url: string,
): Promise<MediaMeta | null> {
  const base = filename.split("/").pop() ?? filename;
  if (!PLAYABLE_RE.test(base)) {
    return null;
  }
  const stem = base.replace(/\.[^.]+$/, "");
  const existing = await getCached(stem);
  if (existing) {
    return existing;
  }
  // The published url is kept as the source so the render's own sidecar (and the recipe in it) can
  // be read back from the media id alone.
  return writeMediaFromBuffer({
    idSeed: `render:${base}`,
    buffer,
    ext: base.slice(base.lastIndexOf(".")),
    sourceUrl: url,
  });
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
  const media = await registerRender(buffer, filename, url);
  const saved: SavedRender = {
    url,
    filename,
    size_bytes: buffer.byteLength,
    ...(media ? { media_id: media.media_id, duration: media.duration } : {}),
  };
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

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const SWEEP_INTERVAL_MS = 30 * 60_000;
// The media cache lives on the pod's emptyDir; without eviction it grows until the pod restarts
// or the volume fills. Cap it by age and by total size so downloaded footage never accumulates
// forever. A miss just re-downloads (or re-fetches from a recipe's durable url), so eviction is safe.
const MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_HOURS ?? 6) * 3_600_000;
const MAX_TOTAL_BYTES = Number(process.env.CACHE_MAX_GB ?? 6) * 1024 ** 3;

interface CacheItem {
  base: string;
  paths: string[];
  size: number;
  mtime: number;
}

// A cache item is every file sharing a media_id stem: the media file plus its `.meta.json` sidecar
// (and any leftover trim/loop scratch). They are evicted as a unit so a live render never resolves
// a meta whose media file was already deleted.
function stemOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

async function collect(dir: string): Promise<CacheItem[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const items = new Map<string, CacheItem>();
  for (const name of names) {
    const path = join(dir, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const stem = stemOf(name);
    const item = items.get(stem) ?? { base: stem, paths: [], size: 0, mtime: 0 };
    item.paths.push(path);
    item.size += info.size;
    item.mtime = Math.max(item.mtime, info.mtimeMs);
    items.set(stem, item);
  }
  return [...items.values()];
}

export async function sweepCacheOnce(
  now: number,
  dir: string = config.mediaCacheDir,
): Promise<{ items: number; freedBytes: number }> {
  const all = await collect(dir);
  const doomed = new Map<string, CacheItem>();
  for (const item of all) {
    if (now - item.mtime > MAX_AGE_MS) doomed.set(item.base, item);
  }
  const survivors = all.filter((item) => !doomed.has(item.base)).sort((a, b) => a.mtime - b.mtime);
  let total = survivors.reduce((sum, item) => sum + item.size, 0);
  for (const item of survivors) {
    if (total <= MAX_TOTAL_BYTES) break;
    doomed.set(item.base, item);
    total -= item.size;
  }
  let freedBytes = 0;
  for (const item of doomed.values()) {
    for (const path of item.paths) {
      await rm(path, { force: true }).catch(() => {});
    }
    freedBytes += item.size;
  }
  return { items: doomed.size, freedBytes };
}

export function startCacheGc(): void {
  const tick = () => {
    sweepCacheOnce(Date.now())
      .then(({ items, freedBytes }) => {
        if (items) console.error(`[cache-gc] evicted ${items} item(s), freed ${freedBytes} bytes`);
      })
      .catch((error: unknown) => console.error("[cache-gc] sweep failed:", error));
  };
  tick();
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
}

import { mkdtemp, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepCacheOnce } from "../../src/services/cache-gc.js";

const HOUR_MS = 3_600_000;

describe("sweepCacheOnce", () => {
  let dir: string;
  const NOW = 1_000_000_000_000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vcm-gc-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Writes the media file (sparse, so a multi-GiB size costs no real disk) and its .meta.json
  // sidecar for a stem, and backdates both by ageHours.
  async function seedItem(stem: string, bytes: number, ageHours: number) {
    const media = join(dir, `${stem}.mp4`);
    const meta = join(dir, `${stem}.meta.json`);
    await writeFile(media, "");
    await truncate(media, bytes);
    await writeFile(meta, JSON.stringify({ media_id: stem }));
    const when = new Date(NOW - ageHours * HOUR_MS);
    await utimes(media, when, when);
    await utimes(meta, when, when);
  }

  const exists = async (name: string) =>
    stat(join(dir, name)).then(
      () => true,
      () => false,
    );

  it("evicts an item older than the age limit, keeping media and meta paired", async () => {
    await seedItem("fresh", 100, 1);
    await seedItem("stale", 100, 12);

    const result = await sweepCacheOnce(NOW, dir);

    expect(result.items).toBe(1);
    expect(await exists("fresh.mp4")).toBe(true);
    expect(await exists("fresh.meta.json")).toBe(true);
    expect(await exists("stale.mp4")).toBe(false);
    expect(await exists("stale.meta.json")).toBe(false);
  });

  it("keeps everything when nothing is over the age or size limit", async () => {
    await seedItem("a", 100, 1);
    await seedItem("b", 100, 2);

    const result = await sweepCacheOnce(NOW, dir);

    expect(result.items).toBe(0);
    expect(await exists("a.mp4")).toBe(true);
    expect(await exists("b.mp4")).toBe(true);
  });

  it("evicts the oldest items first when over the size budget", async () => {
    // Two 4 GiB items (default budget is 6 GiB), both past the retain floor so only size triggers.
    const fourGiB = 4 * 1024 ** 3;
    await seedItem("older", fourGiB, 3);
    await seedItem("newer", fourGiB, 2);

    const result = await sweepCacheOnce(NOW, dir);

    expect(result.items).toBe(1);
    expect(await exists("older.mp4")).toBe(false);
    expect(await exists("newer.mp4")).toBe(true);
  });

  it("keeps a fresh working set even over the size budget (a live generation)", async () => {
    // 8 GiB of media, all minutes old — one in-flight generation must not lose any of it.
    const fourGiB = 4 * 1024 ** 3;
    await seedItem("music", fourGiB, 0.2);
    await seedItem("clip", fourGiB, 0.1);

    const result = await sweepCacheOnce(NOW, dir);

    expect(result.items).toBe(0);
    expect(await exists("music.mp4")).toBe(true);
    expect(await exists("clip.mp4")).toBe(true);
  });
});

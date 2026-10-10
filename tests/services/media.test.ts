import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { loadMeta, parseFrameRate, sectionArg, ytdlpFormat } from "../../src/services/media.js";

describe("loadMeta", () => {
  it("refreshes the item's age so the cache sweep keeps what is still used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vcm-media-test-"));
    const previous = config.mediaCacheDir;
    config.mediaCacheDir = dir;
    try {
      const meta = join(dir, "abc.meta.json");
      await writeFile(meta, JSON.stringify({ media_id: "abc" }));
      const longAgo = new Date(Date.now() - 48 * 3_600_000);
      await utimes(meta, longAgo, longAgo);

      expect((await loadMeta("abc"))?.media_id).toBe("abc");
      expect(Date.now() - (await stat(meta)).mtimeMs).toBeLessThan(60_000);
    } finally {
      config.mediaCacheDir = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseFrameRate", () => {
  it("parses rational frame rates", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("60/1")).toBe(60);
  });

  it("parses integer frame rates", () => {
    expect(parseFrameRate("24")).toBe(24);
  });

  it("falls back to 30 for invalid or zero-denominator input", () => {
    expect(parseFrameRate("0/0")).toBe(30);
    expect(parseFrameRate("")).toBe(30);
    expect(parseFrameRate(undefined)).toBe(30);
    expect(parseFrameRate(null)).toBe(30);
  });
});

describe("sectionArg", () => {
  it("returns null when no window is requested", () => {
    expect(sectionArg(undefined, undefined)).toBeNull();
  });

  it("builds a closed window", () => {
    expect(sectionArg(20, 26)).toBe("*20-26");
  });

  it("defaults a missing start to 0 and a missing end to inf", () => {
    expect(sectionArg(undefined, 26)).toBe("*0-26");
    expect(sectionArg(20, undefined)).toBe("*20-inf");
  });
});

describe("ytdlpFormat", () => {
  it("drops the audio stream when audio is false", () => {
    const videoOnly = ytdlpFormat(false);
    expect(videoOnly).toContain("bestvideo");
    expect(videoOnly).not.toBe(ytdlpFormat(true));
  });
});

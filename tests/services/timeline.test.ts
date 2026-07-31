import { describe, expect, it } from "vitest";
import {
  audioClipLenSec,
  buildClipOverlayFilter,
  cumulativeOffsetsMs,
  dimsFor,
  preflightTimeline,
  trackStartMs,
} from "../../src/services/timeline.js";

describe("cumulativeOffsetsMs", () => {
  it("returns the start offset (ms) of each segment", () => {
    expect(cumulativeOffsetsMs([5, 3, 8])).toEqual([0, 5000, 8000]);
  });

  it("handles fractional-second durations", () => {
    expect(cumulativeOffsetsMs([2.5, 1.5, 4])).toEqual([0, 2500, 4000]);
  });

  it("returns an empty list for no segments", () => {
    expect(cumulativeOffsetsMs([])).toEqual([]);
  });
});

describe("audioClipLenSec", () => {
  it("caps a long song to the video length (the tier-list music-tail bug)", () => {
    expect(audioClipLenSec(136, undefined, 32, 0)).toBe(32);
  });

  it("keeps a short track at its own length (silence tail, not truncation)", () => {
    expect(audioClipLenSec(20, undefined, 32, 0)).toBe(20);
  });

  it("accounts for the track's start offset", () => {
    expect(audioClipLenSec(136, undefined, 32, 10_000)).toBe(22);
  });

  it("honours an explicit max_duration_s under the video cap", () => {
    expect(audioClipLenSec(136, 8, 32, 0)).toBe(8);
  });

  it("returns 0 when the track starts at or after the video ends", () => {
    expect(audioClipLenSec(136, undefined, 32, 40_000)).toBe(0);
  });
});

describe("dimsFor", () => {
  it("maps landscape resolutions to 1920x1080", () => {
    expect(dimsFor("1080p")).toEqual({ width: 1920, height: 1080 });
    expect(dimsFor("landscape")).toEqual({ width: 1920, height: 1080 });
  });

  it("maps 4k/uhd to 3840x2160 and portrait to 1080x1920", () => {
    expect(dimsFor("4k")).toEqual({ width: 3840, height: 2160 });
    expect(dimsFor("uhd")).toEqual({ width: 3840, height: 2160 });
    expect(dimsFor("portrait")).toEqual({ width: 1080, height: 1920 });
  });
});

describe("buildClipOverlayFilter", () => {
  const filter = buildClipOverlayFilter({
    width: 1920,
    height: 1080,
    rankTextFile: "/tmp/rank.txt",
    nameTextFile: "/tmp/name.txt",
    fontFile: "/font.ttf",
    accentColor: "#ffd24a",
  });

  it("cover-fits the clip to the canvas and outputs yuv420p", () => {
    expect(filter).toContain("scale=1920:1080:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1920:1080");
    expect(filter).toContain("format=yuv420p");
  });

  it("draws rank and name from text files and converts the accent to 0x form", () => {
    expect(filter).toContain("textfile=/tmp/rank.txt");
    expect(filter).toContain("textfile=/tmp/name.txt");
    expect(filter).toContain("fontcolor=0xffd24a");
    expect(filter).not.toContain("#ffd24a");
  });
});

describe("silent segment warning", () => {
  const seg = (
    duration: number,
    media?: { media_id: string; muted?: boolean; volume?: number }[],
  ) => ({
    duration,
    html: "<div id=root data-composition-id=main><video src=media://x></video></div>",
    ...(media ? { media } : {}),
  });

  it("names a muted segment that no audio track covers", async () => {
    const warnings = await preflightTimeline({
      segments: [seg(3), seg(10, [{ media_id: "clip", muted: true }]), seg(15)],
      audio: [{ media_id: "song", offset_ms: 13_000, volume: 0.85, fade_ms: 800 }],
      fps: 30,
      resolution: "1080p",
    });
    expect(warnings.join()).toMatch(/segment 1 \(3\.0-13\.0s\) mutes its own clip/);
    expect(warnings.join()).toMatch(/COMPLETE SILENCE/);
  });

  it("stays quiet when a track plays over the muted segment", async () => {
    const warnings = await preflightTimeline({
      segments: [seg(3), seg(10, [{ media_id: "clip", muted: true }]), seg(15)],
      audio: [{ media_id: "song", offset_ms: 0, volume: 0.85, fade_ms: 800 }],
      fps: 30,
      resolution: "1080p",
    });
    expect(warnings.join()).not.toMatch(/mutes its own clip/);
  });

  it("stays quiet when the clip keeps its own audio", async () => {
    const warnings = await preflightTimeline({
      segments: [seg(3), seg(10, [{ media_id: "clip", volume: 1 }]), seg(15)],
      audio: [{ media_id: "song", offset_ms: 13_000, volume: 0.85, fade_ms: 800 }],
      fps: 30,
      resolution: "1080p",
    });
    expect(warnings.join()).not.toMatch(/mutes its own clip/);
  });
});

describe("trackStartMs", () => {
  const starts = [0, 3000, 13000];

  it("resolves a named segment against the real durations", () => {
    expect(trackStartMs({ start_segment: 2 }, starts, 3)).toBe(13000);
    expect(trackStartMs({ start_segment: "last" }, starts, 3)).toBe(13000);
    expect(trackStartMs({ start_segment: 0 }, starts, 3)).toBe(0);
  });

  it("prefers the named segment over a hand-computed offset", () => {
    expect(trackStartMs({ start_segment: "last", offset_ms: 4000 }, starts, 3)).toBe(13000);
  });

  it("falls back to the offset, then to zero", () => {
    expect(trackStartMs({ offset_ms: 4000 }, starts, 3)).toBe(4000);
    expect(trackStartMs({}, starts, 3)).toBe(0);
  });

  it("clamps an index past the end", () => {
    expect(trackStartMs({ start_segment: 9 }, starts, 3)).toBe(13000);
  });
});

describe("music over unmuted footage", () => {
  const seg = (
    duration: number,
    media?: { media_id: string; muted?: boolean; volume?: number }[],
  ) => ({
    duration,
    html: "<div id=root data-composition-id=main><video src=media://x></video></div>",
    ...(media ? { media } : {}),
  });

  it("warns that a track across kept footage buries it", async () => {
    const warnings = await preflightTimeline({
      segments: [seg(3), seg(10, [{ media_id: "clip" }]), seg(15)],
      audio: [{ media_id: "song", offset_ms: 0, volume: 0.6, fade_ms: 800 }],
      fps: 30,
      resolution: "1080p",
    });
    expect(warnings.join()).toMatch(/buried under it/);
    expect(warnings.join()).toMatch(/start_segment/);
  });

  it("stays quiet when the track starts on the last segment", async () => {
    const warnings = await preflightTimeline({
      segments: [seg(3), seg(10, [{ media_id: "clip" }]), seg(15)],
      audio: [{ media_id: "song", start_segment: "last", volume: 0.6, fade_ms: 800 }],
      fps: 30,
      resolution: "1080p",
    });
    expect(warnings.join()).not.toMatch(/buried under it/);
  });
});

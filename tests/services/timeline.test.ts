import { describe, expect, it } from "vitest";
import {
  audioClipLenSec,
  buildClipOverlayFilter,
  cumulativeOffsetsMs,
  dimsFor,
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

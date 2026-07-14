import { describe, expect, it } from "vitest";
import {
  buildAudioMixFilters,
  buildTimedDrawtext,
  coverFilter,
  validateColor,
} from "../../src/lib/ffmpeg.js";

describe("validateColor", () => {
  it("accepts 6- and 8-digit hex with or without #", () => {
    expect(validateColor("#ff0000")).toBe(true);
    expect(validateColor("00ff00")).toBe(true);
    expect(validateColor("#112233aa")).toBe(true);
  });

  it("accepts basic color names case-insensitively", () => {
    expect(validateColor("white")).toBe(true);
    expect(validateColor("Cyan")).toBe(true);
  });

  it("rejects injection payloads", () => {
    expect(validateColor('#000"); import os #')).toBe(false);
    expect(validateColor("red:box=1")).toBe(false);
    expect(validateColor("f00")).toBe(false);
    expect(validateColor("rgb(1,2,3)")).toBe(false);
  });
});

describe("buildTimedDrawtext", () => {
  const base = {
    textFile: "/tmp/t.txt",
    start: 0,
    end: 3,
    position: "bottom" as const,
    fontSize: 60,
    color: "white",
    background: "box" as const,
    shadow: false,
    outline: false,
  };

  it("emits enable window, centered x, and box", () => {
    const f = buildTimedDrawtext(base);
    expect(f).toContain("enable='between(t,0,3)'");
    expect(f).toContain("x=(w-text_w)/2");
    expect(f).toContain("box=1");
  });

  it("drops the box when background is not 'box'", () => {
    expect(buildTimedDrawtext({ ...base, background: "none" })).not.toContain("box=1");
    expect(buildTimedDrawtext({ ...base, background: "blur" })).not.toContain("box=1");
  });

  it("adds an outline and a shadow when requested", () => {
    const f = buildTimedDrawtext({ ...base, background: "none", outline: true, shadow: true });
    expect(f).toContain("borderw=5");
    expect(f).toContain("bordercolor=black@0.85");
    expect(f).toContain("shadowcolor=black@0.55");
    expect(f).toContain("shadowx=3");
  });

  it("positions center vs top differently", () => {
    expect(buildTimedDrawtext({ ...base, position: "center" })).toContain("y=(h-text_h)/2");
    expect(buildTimedDrawtext({ ...base, position: "top" })).toContain("y=54");
  });
});

describe("coverFilter", () => {
  it("scales-up then crops to exact cell with square pixels", () => {
    expect(coverFilter(1080, 1920)).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
    );
  });
});

describe("buildAudioMixFilters", () => {
  const track = (i: number, mode: "replace" | "mix" | "duck") => ({
    inputIndex: i,
    delayMs: 0,
    volume: 0.8,
    mode,
  });

  it("pads and trims each track to the target so a short track can't shorten the mix", () => {
    const { filters } = buildAudioMixFilters([track(1, "mix")], true, 30);
    expect(filters[0]).toContain("apad,atrim=0:30.000");
  });

  it("keeps the base first for mix so duration=first yields video length", () => {
    const { filters, mapLabel } = buildAudioMixFilters([track(1, "mix")], true, 30);
    const amix = filters.find((f) => f.includes("amix"));
    expect(amix).toContain("[0:a][t0]amix=inputs=2");
    expect(mapLabel).toBe("[aout]");
  });

  it("drops the base entirely for replace", () => {
    const { filters } = buildAudioMixFilters([track(1, "replace")], true, 30);
    expect(filters.some((f) => f.includes("[0:a]"))).toBe(false);
    expect(filters.at(-1)).toContain("[t0]anull[aout]");
  });

  it("ducks the base once to 25% regardless of track order", () => {
    const { filters } = buildAudioMixFilters([track(1, "mix"), track(2, "duck")], true, 30);
    expect(filters.filter((f) => f.includes("volume=0.25"))).toHaveLength(1);
    expect(filters.find((f) => f.includes("volume=0.25"))).toBe("[0:a]volume=0.25[ducked]");
  });

  it("replace anywhere wins over duck — base dropped, no orphan label", () => {
    const { filters } = buildAudioMixFilters([track(1, "duck"), track(2, "replace")], true, 30);
    expect(filters.some((f) => f.includes("ducked"))).toBe(false);
    expect(filters.some((f) => f.includes("[0:a]"))).toBe(false);
    const amix = filters.at(-1) as string;
    expect(amix).toContain("[t0][t1]amix=inputs=2");
  });

  it("omits the base when the video has no audio", () => {
    const { filters } = buildAudioMixFilters([track(1, "mix")], false, 30);
    expect(filters.some((f) => f.includes("[0:a]"))).toBe(false);
  });
});

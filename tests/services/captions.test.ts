import { describe, expect, it } from "vitest";
import { type CaptionStyle, buildAss } from "../../src/services/captions.js";

const style: CaptionStyle = {
  color: "#FFFFFF",
  spokenColor: "#FFFFFF",
  upcomingColor: "#FFFFFF",
  position: "bottom",
  fontScale: 1,
  background: "none",
  shadow: false,
  outline: true,
};

const marginV = (ass: string): number => Number(ass.match(/^Style: Cap,.*,(\d+),1$/m)?.[1]);

describe("buildAss", () => {
  it("keeps bottom captions near the edge", () => {
    expect(marginV(buildAss([], 1080, 1920, style, false))).toBe(134);
  });

  it("lifts captions above the short-form app buttons when asked", () => {
    expect(marginV(buildAss([], 1080, 1920, { ...style, position: "lifted" }, false))).toBe(480);
  });
});

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
  it("lifts bottom captions above the short-form app buttons in a portrait frame", () => {
    expect(marginV(buildAss([], 1080, 1920, style, false))).toBe(480);
  });

  it("keeps bottom captions near the edge in a landscape frame", () => {
    expect(marginV(buildAss([], 1920, 1080, style, false))).toBe(76);
  });
});

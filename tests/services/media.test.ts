import { describe, expect, it } from "vitest";
import { parseFrameRate } from "../../src/services/media.js";

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

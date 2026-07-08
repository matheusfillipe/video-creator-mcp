import { describe, expect, it } from "vitest";
import { BLACK_OUTPUT_YMAX, blackOutputWarning } from "../../src/services/effects.js";

describe("blackOutputWarning", () => {
  it("flags a render whose brightest sampled pixel never leaves the background", () => {
    expect(blackOutputWarning(26)).toMatch(/BLACK\/empty/);
  });

  it("passes a dark scene whose text pushes the frame maximum high", () => {
    expect(blackOutputWarning(240)).toBeNull();
    expect(blackOutputWarning(BLACK_OUTPUT_YMAX)).toBeNull();
  });

  it("stays silent when the probe found no frames", () => {
    expect(blackOutputWarning(Number.NaN)).toBeNull();
  });
});

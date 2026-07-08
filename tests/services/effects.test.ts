import { describe, expect, it } from "vitest";
import { blackOutputWarning } from "../../src/services/effects.js";

describe("blackOutputWarning", () => {
  it("flags a video whose brightest sampled pixel stays near black", () => {
    expect(blackOutputWarning(26)).toMatch(/BLACK\/empty/);
  });

  it("passes a dark scene whose text pushes luma high", () => {
    expect(blackOutputWarning(240)).toBeNull();
    expect(blackOutputWarning(80)).toBeNull();
  });

  it("stays silent when the probe found no frames (NaN)", () => {
    expect(blackOutputWarning(Number.NaN)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  BLACK_OUTPUT_YMAX,
  blackOutputWarning,
  dropGsapOnlyFindings,
} from "../../src/services/effects.js";

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

describe("dropGsapOnlyFindings", () => {
  const output = [
    "  ✗ missing_timeline_registry: Missing `window.__timelines` registration.",
    "    Fix: Register each composition timeline on `window.__timelines[compositionId]`.",
    "  ✗ non_deterministic_code: Script contains `Math.random()`.",
    "    Fix: Use a seeded PRNG.",
  ].join("\n");

  it("drops the GSAP-only finding for a composition driven by anime.js", () => {
    const kept = dropGsapOnlyFindings(output, "window.__hfAnime = [tl];");
    expect(kept).not.toMatch(/missing_timeline_registry/);
    expect(kept).not.toMatch(/window\.__timelines\[compositionId\]/);
    expect(kept).toMatch(/non_deterministic_code/);
    expect(kept).toMatch(/seeded PRNG/);
  });

  it("leaves a GSAP composition's findings untouched", () => {
    expect(dropGsapOnlyFindings(output, 'window.__timelines["main"] = tl;')).toBe(output);
  });
});

import { describe, expect, it } from "vitest";
import {
  BLACK_OUTPUT_YMAX,
  blackOutputWarning,
  dropInapplicableFindings,
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

describe("dropInapplicableFindings", () => {
  const output = [
    "  ✗ missing_timeline_registry: Missing `window.__timelines` registration.",
    "    Fix: Register each composition timeline on `window.__timelines[compositionId]`.",
    "  ✗ root_composition_missing_html_wrapper: Composition starts with a bare element.",
    "    Fix: Wrap the composition in <!DOCTYPE html>.",
    "  ✗ non_deterministic_code: Script contains `Math.random()`.",
    "    Fix: Use a seeded PRNG.",
    "  ⚠ requestanimationframe_in_composition: rAF runs on wall-clock time.",
    "    Fix: Use timeline callbacks.",
    "  ◇  3 error(s), 1 warning(s)",
  ].join("\n");

  it("keeps real findings and recounts the summary", () => {
    const kept = dropInapplicableFindings(output, "window.__hfAnime = [tl];");
    expect(kept).not.toMatch(/missing_timeline_registry/);
    expect(kept).not.toMatch(/root_composition_missing_html_wrapper/);
    expect(kept).toMatch(/non_deterministic_code/);
    expect(kept).toMatch(/requestanimationframe_in_composition/);
    expect(kept).toMatch(/1 error\(s\), 1 warning\(s\)/);
  });

  it("keeps the GSAP registry finding when no adapter drives the composition", () => {
    const kept = dropInapplicableFindings(output, 'window.__timelines["main"] = tl;');
    expect(kept).toMatch(/missing_timeline_registry/);
    expect(kept).not.toMatch(/root_composition_missing_html_wrapper/);
    expect(kept).toMatch(/2 error\(s\), 1 warning\(s\)/);
  });
});

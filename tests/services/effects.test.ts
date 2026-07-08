import { describe, expect, it } from "vitest";
import {
  BLACK_OUTPUT_YMAX,
  blackOutputWarning,
  dropInapplicableFindings,
  staticRenderWarning,
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
    "  ✗ non_deterministic_code: Script contains `Math.random()`.",
    "    Fix: Use a seeded PRNG.",
    "  ⚠ requestanimationframe_in_composition: rAF runs on wall-clock time.",
    "    Fix: Use timeline callbacks.",
    "  ✗ root_composition_missing_html_wrapper: Composition starts with a bare element.",
    "    Fix: Wrap the composition in <!DOCTYPE html>.",
    "",
    "  ◇  3 error(s), 1 warning(s)",
  ].join("\n");

  it("keeps the report's summary when the last finding is dropped, and recounts it", () => {
    const kept = dropInapplicableFindings(output, "window.__hfAnime = [tl];");
    expect(kept).not.toMatch(/missing_timeline_registry/);
    expect(kept).not.toMatch(/root_composition_missing_html_wrapper/);
    expect(kept).not.toMatch(/Wrap the composition/);
    expect(kept).toMatch(/non_deterministic_code/);
    expect(kept).toMatch(/requestanimationframe_in_composition/);
    expect(kept).toMatch(/1 error\(s\), 1 warning\(s\)/);
  });

  it("keeps the GSAP registry finding when no adapter drives the composition", () => {
    const kept = dropInapplicableFindings(output, 'window.__timelines["main"] = tl;');
    expect(kept).toMatch(/missing_timeline_registry/);
    expect(kept).toMatch(/2 error\(s\), 1 warning\(s\)/);
  });

  it("drops the renderer-injected script finding for either driver", () => {
    const gsapOnly = [
      "  ✗ missing_gsap_script: No GSAP script tag.",
      "  ◇  1 error(s), 0 warning(s)",
    ].join("\n");
    const kept = dropInapplicableFindings(gsapOnly, 'window.__timelines["main"] = tl;');
    expect(kept).not.toMatch(/missing_gsap_script/);
    expect(kept).toMatch(/0 error\(s\), 0 warning\(s\)/);
  });
});

describe("staticRenderWarning", () => {
  it("flags a 5s render frozen from the first frame", () => {
    expect(staticRenderWarning([0.0666], 5)).toMatch(/NEVER CHANGES/);
  });

  it("ignores a freeze that only starts near the end (a held final frame)", () => {
    expect(staticRenderWarning([4.2], 5)).toBeNull();
  });

  it("passes a render with no frozen span at all", () => {
    expect(staticRenderWarning([], 5)).toBeNull();
  });
});

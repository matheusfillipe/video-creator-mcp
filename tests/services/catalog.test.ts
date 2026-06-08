import { describe, expect, it } from "vitest";
import { isValidBlockName, repointGsap } from "../../src/services/catalog.js";

describe("isValidBlockName", () => {
  it("accepts catalog slugs", () => {
    expect(isValidBlockName("data-chart")).toBe(true);
    expect(isValidBlockName("us-map-bubble")).toBe(true);
  });

  it("rejects flags, paths, and empty/odd input", () => {
    expect(isValidBlockName("--dir=/etc")).toBe(false);
    expect(isValidBlockName("../escape")).toBe(false);
    expect(isValidBlockName("Has Space")).toBe(false);
    expect(isValidBlockName("")).toBe(false);
  });
});

describe("repointGsap", () => {
  it("rewrites a CDN gsap tag to the bundled asset", () => {
    const html =
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>';
    expect(repointGsap(html)).toBe('<script src="assets/gsap.min.js"></script>');
  });

  it("leaves non-gsap scripts untouched", () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>';
    expect(repointGsap(html)).toBe(html);
  });
});

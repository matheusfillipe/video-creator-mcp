import { describe, expect, it } from "vitest";
import { extractJson, isValidBlockName, repointGsap } from "../../src/services/catalog.js";

describe("extractJson", () => {
  it("strips a banner before a JSON array", () => {
    const out = 'Hyperframes v0.6.81\n[{"name":"data-chart"}]';
    expect(JSON.parse(extractJson(out, "["))).toEqual([{ name: "data-chart" }]);
  });

  it("strips a banner before a JSON object", () => {
    expect(extractJson('noise\n{"ok":true}', "{")).toBe('{"ok":true}');
  });

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here", "[")).toThrow();
  });
});

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

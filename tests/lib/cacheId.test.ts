import { describe, expect, it } from "vitest";
import { cacheId } from "../../src/lib/cacheId.js";

describe("cacheId", () => {
  it("is stable for the same parts", () => {
    expect(cacheId("https://x", 5, 10)).toBe(cacheId("https://x", 5, 10));
  });

  it("differs for different parts", () => {
    expect(cacheId("https://x", 5, 10)).not.toBe(cacheId("https://x", 5, 11));
  });

  it("treats null and undefined as empty segments", () => {
    expect(cacheId("a", null, undefined)).toBe(cacheId("a", "", ""));
  });

  it("returns a 12-char hex id", () => {
    expect(cacheId("anything")).toMatch(/^[0-9a-f]{12}$/);
  });
});

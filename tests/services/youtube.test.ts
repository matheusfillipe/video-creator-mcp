import { describe, expect, it } from "vitest";
import { parseJsonLines } from "../../src/services/youtube.js";

describe("parseJsonLines", () => {
  it("parses one entry per JSON line", () => {
    const out = '{"id":"a","title":"A"}\n{"id":"b","title":"B"}';
    expect(parseJsonLines(out).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("skips non-JSON lines instead of throwing (intermittent consent/rate page)", () => {
    const out = 'WARNING: something\n{"id":"a","title":"A"}\n<!DOCTYPE html>';
    expect(parseJsonLines(out).map((e) => e.id)).toEqual(["a"]);
  });

  it("returns empty when the whole response is non-JSON", () => {
    expect(parseJsonLines("<html>consent</html>\nRetry later")).toEqual([]);
  });
});

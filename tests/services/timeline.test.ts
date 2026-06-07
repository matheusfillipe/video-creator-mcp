import { describe, expect, it } from "vitest";
import { cumulativeOffsetsMs } from "../../src/services/timeline.js";

describe("cumulativeOffsetsMs", () => {
  it("returns the start offset (ms) of each segment", () => {
    expect(cumulativeOffsetsMs([5, 3, 8])).toEqual([0, 5000, 8000]);
  });

  it("handles fractional-second durations", () => {
    expect(cumulativeOffsetsMs([2.5, 1.5, 4])).toEqual([0, 2500, 4000]);
  });

  it("returns an empty list for no segments", () => {
    expect(cumulativeOffsetsMs([])).toEqual([]);
  });
});

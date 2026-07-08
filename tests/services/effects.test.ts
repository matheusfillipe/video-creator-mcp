import { describe, expect, it } from "vitest";
import { type LumaSample, blackOutputWarning } from "../../src/services/effects.js";

function series(values: Array<[number, number]>): LumaSample[] {
  return values.map(([time, ymax]) => ({ time, ymax }));
}

describe("blackOutputWarning", () => {
  it("flags a video whose brightest sampled pixel stays near black", () => {
    const w = blackOutputWarning(
      series([
        [0, 26],
        [1, 20],
        [2, 29],
      ]),
    );
    expect(w).toMatch(/BLACK\/empty/);
  });

  it("passes a dark scene whose text pushes luma high", () => {
    expect(
      blackOutputWarning(
        series([
          [0, 240],
          [1, 250],
        ]),
      ),
    ).toBeNull();
    expect(
      blackOutputWarning(
        series([
          [0, 80],
          [1, 90],
        ]),
      ),
    ).toBeNull();
  });

  it("flags a dead segment inside an otherwise-bright timeline", () => {
    const w = blackOutputWarning(
      series([
        [0, 30],
        [1, 25],
        [2, 28],
        [3, 26],
        [4, 29],
        [5, 240],
        [6, 255],
      ]),
    );
    expect(w).toMatch(/stretch from ~0\.0s to ~5\.0s/);
  });

  it("ignores a dark stretch shorter than the minimum run", () => {
    const w = blackOutputWarning(
      series([
        [0, 240],
        [1, 20],
        [2, 250],
        [3, 255],
      ]),
    );
    expect(w).toBeNull();
  });

  it("stays silent when the probe found no frames", () => {
    expect(blackOutputWarning([])).toBeNull();
  });
});

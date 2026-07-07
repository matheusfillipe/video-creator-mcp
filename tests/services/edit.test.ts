import { describe, expect, it } from "vitest";
import {
  type EditSpec,
  atempoChain,
  cellDims,
  segmentDuration,
  textFilters,
  validateSpec,
} from "../../src/services/edit.js";

describe("cellDims", () => {
  it("splits portrait canvas into two half-height cells for vstack", () => {
    expect(cellDims("vstack", { width: 1080, height: 1920 })).toEqual([
      { width: 1080, height: 960 },
      { width: 1080, height: 960 },
    ]);
  });

  it("keeps full canvas for single", () => {
    expect(cellDims("single", { width: 1920, height: 1080 })).toEqual([
      { width: 1920, height: 1080 },
    ]);
  });

  it("rounds odd cell sizes down to even (encoder requirement)", () => {
    const cells = cellDims("hstack", { width: 1080, height: 1080 });
    for (const c of cells) {
      expect(c.width % 2).toBe(0);
      expect(c.height % 2).toBe(0);
    }
  });

  it("gives pip a full-canvas base and a third-size inset", () => {
    const [base, inset] = cellDims("pip", { width: 1920, height: 1080 });
    expect(base).toEqual({ width: 1920, height: 1080 });
    expect(inset?.width).toBeLessThan(1920 / 2);
  });

  it("gives grid four quarter cells", () => {
    expect(cellDims("grid", { width: 1920, height: 1080 })).toHaveLength(4);
  });
});

describe("validateSpec", () => {
  const seg = { media_id: "abc" };

  it("accepts a minimal single spec", () => {
    expect(validateSpec({ groups: [[seg]] })).toEqual([]);
  });

  it("rejects group-count/layout mismatch", () => {
    const errors = validateSpec({ layout: "vstack", groups: [[seg]] });
    expect(errors.join(" ")).toMatch(/needs exactly 2/);
  });

  it("rejects end <= start", () => {
    const errors = validateSpec({ groups: [[{ media_id: "a", start: 5, end: 5 }]] });
    expect(errors.join(" ")).toMatch(/end .* must be > start/);
  });

  it("rejects empty groups", () => {
    const errors = validateSpec({ groups: [[]] });
    expect(errors.join(" ")).toMatch(/group 0 is empty/);
  });

  it("rejects out-of-range speed", () => {
    const errors = validateSpec({ groups: [[{ media_id: "a", speed: 10 }]] });
    expect(errors.join(" ")).toMatch(/speed/);
  });
});

describe("atempoChain", () => {
  it("passes normal speeds through as one filter", () => {
    expect(atempoChain(1.5)).toBe("atempo=1.5000");
  });

  it("chains doublings above 2x", () => {
    expect(atempoChain(4)).toBe("atempo=2.0,atempo=2.0000");
  });

  it("chains halvings below 0.5x", () => {
    expect(atempoChain(0.25)).toBe("atempo=0.5,atempo=0.5000");
  });
});

describe("segmentDuration", () => {
  it("uses source duration when no trim points", () => {
    expect(segmentDuration({ media_id: "a" }, 30)).toBe(30);
  });

  it("applies trim window and speed", () => {
    expect(segmentDuration({ media_id: "a", start: 10, end: 20, speed: 2 }, 30)).toBe(5);
  });

  it("clamps end to source duration", () => {
    expect(segmentDuration({ media_id: "a", start: 25, end: 60 }, 30)).toBe(5);
  });
});

describe("textFilters", () => {
  it("builds one drawtext per overlay with enable windows", () => {
    const filters = textFilters(
      [
        { content: "hi", start: 0, duration: 3, position: "top" },
        { content: "bye", start: 3, duration: 2, position: "bottom" },
      ],
      ["/tmp/t0.txt", "/tmp/t1.txt"],
      1920,
    );
    expect(filters).toHaveLength(2);
    expect(filters[0]).toContain("enable='between(t,0,3)'");
    expect(filters[0]).toContain("textfile=/tmp/t0.txt");
    expect(filters[1]).toContain("enable='between(t,3,5)'");
  });

  it("omits the backing box when box=false", () => {
    const [f] = textFilters(
      [{ content: "x", start: 0, duration: 1, box: false }],
      ["/tmp/t.txt"],
      1080,
    );
    expect(f).not.toContain("box=1");
  });
});

describe("EditSpec shape", () => {
  it("matches the documented layout group counts", () => {
    const spec: EditSpec = {
      layout: "vstack",
      groups: [[{ media_id: "top" }], [{ media_id: "bottom" }]],
      audio: [{ media_id: "song", mode: "replace" }],
      text: [{ content: "title", start: 0, duration: 5 }],
    };
    expect(validateSpec(spec)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { metadataSidecarName } from "../../src/services/publish.js";

describe("metadataSidecarName", () => {
  it("swaps the video extension for .json", () => {
    expect(metadataSidecarName("timeline-ab12cd34.mp4")).toBe("timeline-ab12cd34.json");
    expect(metadataSidecarName("render-x.webm")).toBe("render-x.json");
  });

  it("reduces a path to its basename (no key escape)", () => {
    expect(metadataSidecarName("a/b/timeline-1.mp4")).toBe("timeline-1.json");
    expect(metadataSidecarName("../secret.mp4")).toBe("secret.json");
  });

  it("rejects dotfiles and unsafe names", () => {
    expect(() => metadataSidecarName(".env")).toThrow();
    expect(() => metadataSidecarName("bad name.mp4")).toThrow();
  });
});

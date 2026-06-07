import { describe, expect, it } from "vitest";
import { rankClipHtml, titleCardHtml } from "../../src/templates/tierlist.js";

describe("titleCardHtml", () => {
  it("includes the title, duration, and root composition", () => {
    const html = titleCardHtml({ title: "Top 10", subtitle: "2026", durationSeconds: 3 });
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="3"');
    expect(html).toContain("Top 10");
    expect(html).toContain("2026");
    expect(html).toContain('window.__timelines["main"]');
  });

  it("escapes HTML in user text", () => {
    const html = titleCardHtml({ title: '<script>"x"&', durationSeconds: 2 });
    expect(html).not.toContain('<script>"x"&<');
    expect(html).toContain("&lt;script&gt;&quot;x&quot;&amp;");
  });
});

describe("rankClipHtml", () => {
  it("references the clip by filename and shows the rank + name", () => {
    const html = rankClipHtml({
      rank: 7,
      name: "Cool Game",
      mediaFilename: "abc123.mp4",
      durationSeconds: 6,
    });
    expect(html).toContain('src="assets/abc123.mp4"');
    expect(html).toContain("#7");
    expect(html).toContain("Cool Game");
    expect(html).toContain("muted");
    expect(html).not.toContain("bottom:");
  });
});

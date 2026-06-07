import { describe, expect, it } from "vitest";
import { titleCardHtml } from "../../src/templates/tierlist.js";

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

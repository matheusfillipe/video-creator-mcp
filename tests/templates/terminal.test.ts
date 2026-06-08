import { describe, expect, it } from "vitest";
import { buildOutputLines, terminalHtml } from "../../src/templates/terminal.js";

describe("buildOutputLines", () => {
  it("wraps each line in an output-line span and escapes HTML", () => {
    const html = buildOutputLines(["plain", "<b>x</b> & y"]);
    expect(html).toContain('<span class="output-line">plain</span>');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(html).not.toContain("<b>x</b>");
  });

  it("returns an empty string for no output", () => {
    expect(buildOutputLines([])).toBe("");
  });
});

describe("terminalHtml", () => {
  const html = terminalHtml({
    command: 'echo "hi"',
    output: ["hi"],
    prompt: "me@host % ",
    durationSeconds: 7,
  });

  it("injects the command as a JS string literal and uses the local gsap asset", () => {
    expect(html).toContain('const command = "echo \\"hi\\"";');
    expect(html).toContain('src="assets/gsap.min.js"');
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("carries the composition root with duration and the injected prompt + output", () => {
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="7"');
    expect(html).toContain("me@host % ");
    expect(html).toContain('<span class="output-line">hi</span>');
    expect(html).toContain('window.__timelines["main"]');
  });
});

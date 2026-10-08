import { describe, expect, it } from "vitest";
import { parseArxivFigures, parseArxivText, parseProjectVideos } from "../../src/services/paper.js";

describe("parseArxivText", () => {
  it("keeps the article body with formulas as LaTeX and drops the bibliography", () => {
    const html = `<nav>arXiv menu</nav><article><h1>Title</h1><p>Loss is <math alttext="x^{2}"><mi>x</mi></math> lower.</p>
      <section class="ltx_bibliography"><p>[1] Someone 2020</p></section></article>`;
    expect(parseArxivText(html)).toBe("Title Loss is x^{2} lower.");
  });
});

describe("parseArxivFigures", () => {
  const page = "https://arxiv.org/html/2610.10524";

  it("resolves each raster figure against the paper page and keeps its caption", () => {
    const html = `
      <figure id="S1.F1"><img src="2610.10524v1/teaser.png"><figcaption>Figure 1: <b>Teaser</b> &amp; overview.</figcaption></figure>
      <figure id="S2.F2"><img src="2610.10524v1/arch.svg"><figcaption>Figure 2: vector</figcaption></figure>
      <figure id="S3.F3"><img src="https://cdn.example.org/plot.png"><figcaption>Figure 3: plot</figcaption></figure>`;
    expect(parseArxivFigures(html, page)).toEqual([
      {
        id: "fig1",
        url: "https://arxiv.org/html/2610.10524v1/teaser.png",
        caption: "Figure 1: Teaser & overview.",
      },
      { id: "fig2", url: "https://cdn.example.org/plot.png", caption: "Figure 3: plot" },
    ]);
  });

  it("returns nothing for a paper without an HTML version", () => {
    expect(parseArxivFigures("", page)).toEqual([]);
  });
});

describe("parseProjectVideos", () => {
  it("collects direct clips and embedded YouTube players once each", () => {
    const html = `
      <video src="static/videos/demo.mp4"></video>
      <a href="/media/reel.webm">reel</a>
      <source src="static/videos/demo.mp4">
      <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
    expect(parseProjectVideos(html, "https://lab.github.io/proj/")).toEqual([
      "https://lab.github.io/proj/static/videos/demo.mp4",
      "https://lab.github.io/media/reel.webm",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
  });
});

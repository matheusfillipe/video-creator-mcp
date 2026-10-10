import { describe, expect, it } from "vitest";
import {
  focusTablePage,
  parseArxivFigures,
  parseArxivTables,
  parseArxivText,
  parseProjectVideos,
  parseTableGrid,
} from "../../src/services/paper.js";

describe("parseTableGrid", () => {
  it("lines columns up across rows when a header cell spans several", () => {
    const html = `<table><tr><th>Model</th><th colspan="2">Score</th></tr>
      <tr><td>Ours</td><td>71.4</td><td><b>70.1</b></td></tr><tr><td></td><td></td><td></td></tr></table>`;
    expect(parseTableGrid(html)).toEqual([
      ["Model", "Score", ""],
      ["Ours", "71.4", "70.1"],
    ]);
  });

  it("keeps a formula's symbol and drops its LaTeX source and citation marks", () => {
    const html = `<table><tr><td>RoMa <cite>[<a>5</a>]</cite></td><td>MSE <math><semantics><mo>↓</mo><annotation encoding="application/x-tex">\\downarrow</annotation></semantics></math></td></tr></table>`;
    expect(parseTableGrid(html)).toEqual([["RoMa", "MSE ↓"]]);
  });

  it("repeats a cell spanning several rows in each of them", () => {
    const html = `<table><tr><td rowspan="2">Brief</td><td>A</td><td>1</td></tr>
      <tr><td>B</td><td>2</td></tr><tr><td>Edit</td><td>C</td><td>3</td></tr></table>`;
    expect(parseTableGrid(html)).toEqual([
      ["Brief", "A", "1"],
      ["Brief", "B", "2"],
      ["Edit", "C", "3"],
    ]);
  });
});

describe("focusTablePage", () => {
  const grid = [
    ["Model", "A", "B", "C"],
    ["Base", "1", "2", "3"],
    ["Ours", "4", "5", "6"],
  ];

  it("keeps the header and first column, the chosen rows and columns, and marks cited cells", () => {
    const page = focusTablePage(grid, { rows: [2], cols: [2], highlight: [{ row: 2, col: 2 }] });
    expect(page).toContain(
      '<tr><th>Model</th><th>B</th></tr><tr><td>Ours</td><td class="hit">5</td></tr>',
    );
    expect(page).not.toContain("Base");
  });
});

describe("parseArxivTables", () => {
  const html = `
    <figure class="ltx_figure"><img src="teaser.png"><figcaption>Figure 1: teaser</figcaption></figure>
    <figure id="S4.T2" class="ltx_table"><figcaption>Table 2: Main results</figcaption>
      <table><tr><td><img src="star.png">Ours</td><td>71.4</td></tr></table></figure>`;

  it("returns table figures as tables with cell icons removed", () => {
    expect(parseArxivTables(html)).toEqual([
      {
        id: "tab1",
        html: "<table><tr><td>Ours</td><td>71.4</td></tr></table>",
        caption: "Table 2: Main results",
      },
    ]);
  });

  it("leaves table figures out of the figures", () => {
    expect(parseArxivFigures(html, "https://arxiv.org/html/1").map((f) => f.caption)).toEqual([
      "Figure 1: teaser",
    ]);
  });
});

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

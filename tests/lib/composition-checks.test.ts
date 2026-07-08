import { describe, expect, it } from "vitest";
import {
  base64CompositionError,
  checkComposition,
  compositionInputError,
  decodeComposition,
} from "../../src/lib/composition-checks.js";

describe("checkComposition", () => {
  it("flags a non-zero length that lost its unit", () => {
    const findings = checkComposition('<div style="left:190;top:40px"></div>');
    expect(findings.join()).toMatch(/css_length_missing_unit: left:190/);
  });

  it("accepts zero and genuinely unitless properties", () => {
    const html = '<div style="left:0;opacity:1;z-index:5;line-height:1.2;flex:1"></div>';
    expect(checkComposition(html)).toEqual([]);
  });

  it("flags an attribute that misspells data-*", () => {
    expect(checkComposition('<div daturation="5"></div>').join()).toMatch(
      /misspelled_data_attribute: daturation/,
    );
  });

  it("accepts real data-* attributes", () => {
    expect(checkComposition('<div data-duration="5" data-start="0"></div>')).toEqual([]);
  });

  it("flags an anime.js easing that does not exist", () => {
    const html = "<script>anime.timeline({easing:'easeOutExponential'})</script>";
    expect(checkComposition(html).join()).toMatch(/unknown_anime_easing: easeOutExponential/);
  });

  it("accepts real anime easings and parametric ones", () => {
    const html =
      "<script>anime.timeline({easing:'easeOutExpo'});anime({easing:'cubicBezier(.5,0,.5,1)'})</script>";
    expect(checkComposition(html)).toEqual([]);
  });

  it("ignores easing strings when the composition is not driven by anime.js", () => {
    expect(
      checkComposition("<script>gsap.to(x,{ease:'power2.out',easing:'nonsense'})</script>"),
    ).toEqual([]);
  });
});

describe("base64CompositionError", () => {
  const good = Buffer.from('<div data-composition-id="main"></div>').toString("base64");

  it("accepts a well-formed document", () => {
    expect(base64CompositionError(good)).toBeNull();
  });

  it("accepts a valid document encoded without padding", () => {
    expect(base64CompositionError(good.replace(/=+$/, ""))).toBeNull();
  });

  it("rejects a string that decodes with data loss (the truncating-decode case)", () => {
    const lossy = good.replace(/=+$/, "").slice(0, -2);
    expect(base64CompositionError(lossy)).toMatch(/data loss/);
  });

  it("rejects characters outside the base64 alphabet", () => {
    expect(base64CompositionError("not base64!!")).toMatch(/outside the base64 alphabet/);
  });

  it("rejects a document with no composition root", () => {
    const noRoot = Buffer.from("<div>hello</div>").toString("base64");
    expect(base64CompositionError(noRoot)).toMatch(/data-composition-id/);
  });
});

describe("plain-html input", () => {
  const markup = '<div id="root" data-composition-id="main"></div>';

  it("accepts markup passed directly", () => {
    expect(compositionInputError(markup)).toBeNull();
    expect(decodeComposition(markup)).toBe(markup);
  });

  it("still accepts (and decodes) base64", () => {
    const encoded = Buffer.from(markup).toString("base64");
    expect(compositionInputError(encoded)).toBeNull();
    expect(decodeComposition(encoded)).toBe(markup);
  });

  it("rejects markup with no composition root", () => {
    expect(compositionInputError("<div>hi</div>")).toMatch(/data-composition-id/);
  });
});

describe("unbalanced css braces", () => {
  it("flags the stray brace that discards the next rule", () => {
    const html = "<style>body{margin:0}}\n#card{width:760px}</style>";
    expect(checkComposition(html).join()).toMatch(/unbalanced_css_braces/);
  });

  it("accepts a balanced stylesheet", () => {
    expect(checkComposition("<style>body{margin:0}\n#card{width:760px}</style>")).toEqual([]);
  });
});

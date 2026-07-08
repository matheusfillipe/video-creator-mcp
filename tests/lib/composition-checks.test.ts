import { describe, expect, it } from "vitest";
import { checkComposition } from "../../src/lib/composition-checks.js";

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

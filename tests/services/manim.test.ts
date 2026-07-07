import { describe, expect, it } from "vitest";
import { mathShortScene, useOpenGl, validatePlotExpr } from "../../src/services/manim.js";

describe("useOpenGl (renderer auto-selection)", () => {
  it("auto: GPU for 3D, CPU for 2D", () => {
    expect(useOpenGl("auto", "class S(ThreeDScene):\n  pass")).toBe(true);
    expect(useOpenGl("auto", "class S(Scene):\n  pass")).toBe(false);
  });

  it("honors an explicit override either way", () => {
    expect(useOpenGl("cairo", "class S(ThreeDScene):\n  pass")).toBe(false);
    expect(useOpenGl("opengl", "class S(Scene):\n  pass")).toBe(true);
  });
});

describe("validatePlotExpr", () => {
  it("accepts plain math in x", () => {
    expect(validatePlotExpr("3*exp(-x**2)*sin(15*x)")).toBeNull();
    expect(validatePlotExpr("2.5*sin(10*log(abs(x) + 1))")).toBeNull();
    expect(validatePlotExpr("x")).toBeNull();
  });

  it("rejects unknown names", () => {
    expect(validatePlotExpr("__import__('os')")).toMatch(/unsupported characters/);
    expect(validatePlotExpr("open(x)")).toMatch(/unknown function/);
    expect(validatePlotExpr("eval(x)")).toMatch(/unknown function/);
    expect(validatePlotExpr("y + 1")).toMatch(/unknown function/);
  });

  it("rejects quotes, brackets and attribute access chains", () => {
    expect(validatePlotExpr("x['a']")).toMatch(/unsupported characters/);
    expect(validatePlotExpr('sin("x")')).toMatch(/unsupported characters/);
  });

  it("rejects oversized expressions", () => {
    expect(validatePlotExpr(`x+${"1+".repeat(150)}1`)).toMatch(/too long/);
  });
});

describe("mathShortScene", () => {
  const spec = {
    title: "Mathematical Graphs",
    scenes: [{ latex: "f(x) = \\sin(x)", plot_expr: "sin(x)" }, { latex: "g(x) = e^{-x^2}" }],
  };

  it("emits one Scene class with per-scene sections", () => {
    const code = mathShortScene(spec);
    expect(code).toContain("class MathShort(Scene):");
    expect(code).toContain('MathTex(r"f(x) = \\sin(x)"');
    expect(code).toContain("lambda x: np.sin(x)");
    expect(code).toContain("MoveAlongPath");
  });

  it("skips plot code for formula-only scenes", () => {
    const code = mathShortScene(spec);
    expect(code.match(/Axes\(/g)).toHaveLength(1);
  });

  it("uses portrait pixel dimensions by default", () => {
    const code = mathShortScene(spec);
    expect(code).toContain("config.pixel_width = 1080");
    expect(code).toContain("config.pixel_height = 1920");
  });

  it("maps bare math names onto numpy", () => {
    const code = mathShortScene({
      title: "t",
      scenes: [{ latex: "h", plot_expr: "abs(x)*pi + e" }],
    });
    expect(code).toContain("np.abs(x)*np.pi + np.e");
  });
});

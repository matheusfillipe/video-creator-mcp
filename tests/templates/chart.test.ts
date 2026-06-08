import { describe, expect, it } from "vitest";
import { buildLinePlot, lineChartHtml } from "../../src/templates/chart.js";

describe("buildLinePlot", () => {
  const geo = buildLinePlot([{ value: 0 }, { value: 10 }]);

  it("spans the plot width across points", () => {
    expect(geo.coords).toHaveLength(2);
    expect(geo.coords[0]?.x).toBe(geo.plotLeft);
    expect(geo.coords[1]?.x).toBe(geo.plotRight);
  });

  it("places higher values higher (smaller y) and pads the range", () => {
    expect(geo.coords[0]?.y ?? 0).toBeGreaterThan(geo.coords[1]?.y ?? 0);
    expect(geo.min).toBeLessThan(0);
    expect(geo.max).toBeGreaterThan(10);
  });

  it("centers a single point", () => {
    const one = buildLinePlot([{ value: 5 }]);
    expect(one.coords[0]?.x).toBe((one.plotLeft + one.plotRight) / 2);
  });
});

describe("lineChartHtml", () => {
  const html = lineChartHtml({
    title: "MAU",
    points: [
      { label: "Jan", value: 12 },
      { label: "Feb", value: 19 },
    ],
    accentColor: "#ff0000",
    valueSuffix: "k",
    durationSeconds: 8,
  });

  it("uses the local gsap asset and the composition root", () => {
    expect(html).toContain('src="assets/gsap.min.js"');
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="8"');
  });

  it("includes the title, accent color, x-labels and data values", () => {
    expect(html).toContain("MAU");
    expect(html).toContain("#ff0000");
    expect(html).toContain("Jan");
    expect(html).toContain("[12,19]");
  });
});

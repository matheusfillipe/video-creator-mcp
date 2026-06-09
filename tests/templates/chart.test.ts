import { describe, expect, it } from "vitest";
import { buildSeriesGeometry, lineChartHtml } from "../../src/templates/chart.js";

describe("buildSeriesGeometry", () => {
  const geo = buildSeriesGeometry(
    [
      { name: "A", color: "#111", values: [0, 10] },
      { name: "B", color: "#222", values: [5, 5] },
    ],
    8,
  );

  it("keeps both series and counts the longest", () => {
    expect(geo.series).toHaveLength(2);
    expect(geo.count).toBe(2);
    expect(geo.series[0]?.coords[0]?.x).toBe(geo.plotLeft);
  });

  it("scales y across all series and pads the range", () => {
    expect(geo.min).toBeLessThan(0);
    expect(geo.max).toBeGreaterThan(10);
  });
});

describe("lineChartHtml", () => {
  const html = lineChartHtml({
    title: "Two",
    series: [
      {
        name: "Revenue",
        color: "#ff0000",
        points: [
          { label: "Jan", value: 1 },
          { label: "Feb", value: 9 },
        ],
      },
      { name: "Cost", color: "#00ff00", points: [{ value: 2 }, { value: 4 }] },
    ],
    valueSuffix: "k",
    durationSeconds: 10,
  });

  it("renders both series, legend, local gsap and the scroller", () => {
    expect(html).toContain("#ff0000");
    expect(html).toContain("#00ff00");
    expect(html).toContain("Revenue");
    expect(html).toContain("Cost");
    expect(html).toContain('id="scroller"');
    expect(html).toContain('src="assets/gsap.min.js"');
    expect(html).toContain('data-composition-id="main"');
  });

  it("embeds each series' values for tip interpolation", () => {
    expect(html).toContain("[[1,9],[2,4]]");
  });
});

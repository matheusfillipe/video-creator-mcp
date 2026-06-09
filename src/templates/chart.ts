// Hand-authored side-scrolling multi-line chart. Each series plots left-to-right; once the
// data fills the visible window the whole plot scrolls so the leading edge stays in view,
// and every series carries a value label pinned to its tip. A reveal clip (window rect that
// widens, then a translate that scrolls the content under it) gives the draw-then-scroll
// motion and also hides not-yet-reached points. Driven from `series` so an agent passes data.

import { escapeHtml } from "./html.js";

export interface ChartPoint {
  label?: string;
  value: number;
}

export interface ChartSeries {
  name?: string;
  color?: string;
  points: ChartPoint[];
}

export interface ChartOptions {
  title?: string;
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  valueSuffix?: string;
  windowSize?: number;
  durationSeconds: number;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const MARGIN = { left: 170, right: 130, top: 250, bottom: 170 };
const PALETTE = ["#34e3a4", "#7fd1ff", "#ffd24a", "#ff7a90", "#c08bff", "#f0883e"];
const DEFAULT_WINDOW = 8;

interface ResolvedSeries {
  name: string;
  color: string;
  values: number[];
}

export interface SeriesGeometry {
  name: string;
  color: string;
  values: number[];
  polyline: string;
  coords: { x: number; y: number }[];
}

export interface ScrollGeometry {
  series: SeriesGeometry[];
  min: number;
  max: number;
  count: number;
  xStep: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
}

export function buildSeriesGeometry(series: ResolvedSeries[], windowSize: number): ScrollGeometry {
  const plotLeft = MARGIN.left;
  const plotRight = WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const count = Math.max(...series.map((s) => s.values.length));
  const allValues = series.flatMap((s) => s.values);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const pad = (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.1;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const win = Math.max(2, Math.min(windowSize, count));
  const xStep = plotW / (win - 1);
  const xAt = (i: number): number => plotLeft + i * xStep;
  const yAt = (value: number): number => plotBottom - ((value - min) / (max - min)) * plotH;

  const geo = series.map((s) => {
    const coords = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
    return {
      name: s.name,
      color: s.color,
      values: s.values,
      coords,
      polyline: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" "),
    };
  });

  return { series: geo, min, max, count, xStep, plotLeft, plotRight, plotTop, plotBottom };
}

function resolveSeries(series: ChartSeries[]): ResolvedSeries[] {
  return series.map((s, i) => ({
    name: s.name ?? `Series ${i + 1}`,
    color: s.color ?? PALETTE[i % PALETTE.length] ?? "#7fd1ff",
    values: s.points.map((p) => p.value),
  }));
}

export function lineChartHtml(options: ChartOptions): string {
  const suffix = options.valueSuffix ?? "";
  const resolved = resolveSeries(options.series);
  const geo = buildSeriesGeometry(resolved, options.windowSize ?? DEFAULT_WINDOW);
  const labels = (options.series[0]?.points ?? []).map((p) => p.label);
  const fmt = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);
  const showLegend = options.series.some((s) => s.name) || options.series.length > 1;

  const polylines = geo.series
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" points="${s.polyline}" />`,
    )
    .join("\n        ");

  const dots = geo.series
    .flatMap((s) =>
      s.coords.map(
        (c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="6" fill="${s.color}" />`,
      ),
    )
    .join("\n        ");

  const xLabels = labels
    .map((label, i) =>
      label
        ? `<text class="x-label" x="${(geo.plotLeft + i * geo.xStep).toFixed(1)}" y="${geo.plotBottom + 44}" text-anchor="middle">${escapeHtml(label)}</text>`
        : "",
    )
    .join("\n        ");

  const legend = showLegend
    ? geo.series
        .map((s, i) => {
          const x = geo.plotLeft + i * 320;
          return `<rect x="${x}" y="158" width="34" height="10" rx="5" fill="${s.color}" /><text class="legend" x="${x + 46}" y="168">${escapeHtml(s.name)}</text>`;
        })
        .join("\n      ")
    : "";

  const tipDots = geo.series
    .map((s, i) => `<circle class="tip-dot" id="tip-${i}" r="11" fill="${s.color}" opacity="0" />`)
    .join("\n      ");
  const tipLabels = geo.series
    .map(
      (s, i) =>
        `<text class="tip-label" id="tiplabel-${i}" text-anchor="middle" fill="${s.color}" opacity="0"></text>`,
    )
    .join("\n      ");

  const seriesJson = JSON.stringify(geo.series.map((s) => s.values));
  const title = options.title ? escapeHtml(options.title) : "";
  const yTop = `${fmt(geo.max)}${suffix}`;
  const yBottom = `${fmt(geo.min)}${suffix}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Chart</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0a0a0a; font-family: Arial, Helvetica, sans-serif; }
      #scene { width: 1920px; height: 1080px; position: relative; background: #0a0a0a; }
      .title { fill: #ffffff; font-size: 64px; font-weight: 800; }
      .legend { fill: #c8ccd0; font-size: 30px; font-weight: 600; }
      .axis { stroke: #3a3a3a; stroke-width: 2; }
      .axis-label { fill: #9aa0a6; font-size: 30px; }
      .y-tick { fill: #9aa0a6; font-size: 28px; }
      .x-label { fill: #c8ccd0; font-size: 28px; }
      .now-line { stroke: #2a2a2a; stroke-width: 2; }
      .tip-label { font-size: 42px; font-weight: 800; }
    </style>
  </head>
  <body>
    <div id="scene" data-composition-id="main" data-start="0" data-duration="${options.durationSeconds}" data-width="1920" data-height="1080">
      <svg width="1920" height="1080" viewBox="0 0 1920 1080">
        ${title ? `<text class="title" x="${geo.plotLeft}" y="120">${title}</text>` : ""}
        ${legend}
        <line class="axis" x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" />
        <line class="axis" x1="${geo.plotLeft}" y1="${geo.plotBottom}" x2="${geo.plotRight}" y2="${geo.plotBottom}" />
        <text class="y-tick" x="${geo.plotLeft - 20}" y="${geo.plotTop + 10}" text-anchor="end">${escapeHtml(yTop)}</text>
        <text class="y-tick" x="${geo.plotLeft - 20}" y="${geo.plotBottom + 10}" text-anchor="end">${escapeHtml(yBottom)}</text>
        ${options.yLabel ? `<text class="axis-label" x="${geo.plotLeft}" y="${geo.plotTop - 30}">${escapeHtml(options.yLabel)}</text>` : ""}
        ${options.xLabel ? `<text class="axis-label" x="${geo.plotRight}" y="${geo.plotBottom + 90}" text-anchor="end">${escapeHtml(options.xLabel)}</text>` : ""}
        <clipPath id="window"><rect id="window-rect" x="${geo.plotLeft}" y="0" width="0" height="1080" /></clipPath>
        <g clip-path="url(#window)">
          <g id="scroller">
        ${polylines}
        ${dots}
        ${xLabels}
          </g>
        </g>
        <line class="now-line" id="now-line" x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" opacity="0" />
        ${tipDots}
        ${tipLabels}
      </svg>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const SERIES = ${seriesJson};
      const PLOT_LEFT = ${geo.plotLeft}, PLOT_W = ${geo.plotRight - geo.plotLeft};
      const PLOT_TOP = ${geo.plotTop}, PLOT_BOTTOM = ${geo.plotBottom};
      const X_STEP = ${geo.xStep}, COUNT = ${geo.count};
      const MIN = ${geo.min}, MAX = ${geo.max}, SUFFIX = ${JSON.stringify(suffix)};
      const rect = document.getElementById("window-rect");
      const scroller = document.getElementById("scroller");
      const nowLine = document.getElementById("now-line");
      const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
      const yAt = (v) => PLOT_BOTTOM - ((v - MIN) / (MAX - MIN)) * (PLOT_BOTTOM - PLOT_TOP);
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

      const tl = gsap.timeline({ paused: true });
      tl.fromTo(".title", { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.5 }, 0);
      tl.fromTo([".axis", ".y-tick", ".axis-label", ".legend", "rect[fill]"], { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.2);

      const drawStart = 0.8;
      const drawDur = Math.max(1, ${options.durationSeconds} - drawStart - 0.6);
      tl.to("#now-line", { opacity: 1, duration: 0.3 }, drawStart);
      tl.to(".tip-dot", { opacity: 1, duration: 0.3 }, drawStart);
      tl.to(".tip-label", { opacity: 1, duration: 0.3 }, drawStart);

      const progress = { t: 0 };
      tl.to(progress, {
        t: 1,
        duration: drawDur,
        ease: "none",
        onUpdate: () => {
          const p = progress.t * (COUNT - 1);
          const reveal = Math.min(p * X_STEP, PLOT_W);
          const tx = Math.min(0, PLOT_W - p * X_STEP);
          rect.setAttribute("width", String(reveal));
          scroller.setAttribute("transform", "translate(" + tx + ",0)");
          const tipX = PLOT_LEFT + reveal;
          nowLine.setAttribute("x1", String(tipX));
          nowLine.setAttribute("x2", String(tipX));
          const labelX = clamp(tipX, PLOT_LEFT + 70, PLOT_LEFT + PLOT_W - 80);
          const i0 = Math.min(COUNT - 1, Math.floor(p));
          const i1 = Math.min(COUNT - 1, i0 + 1);
          const frac = p - i0;
          SERIES.forEach((values, k) => {
            const v = values[i0] + (values[i1] - values[i0]) * frac;
            const y = yAt(v);
            const dot = document.getElementById("tip-" + k);
            const lbl = document.getElementById("tiplabel-" + k);
            dot.setAttribute("cx", String(tipX));
            dot.setAttribute("cy", String(y));
            lbl.setAttribute("x", String(labelX));
            lbl.setAttribute("y", String(y - 22));
            lbl.textContent = fmt(v) + SUFFIX;
          });
        },
      }, drawStart);

      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
}

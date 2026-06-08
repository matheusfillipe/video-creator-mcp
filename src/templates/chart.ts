// Hand-authored animated line-plot composition: the line draws left-to-right (a clip-path
// rect sweeps across) while a marker + value label track the leading edge and x-axis labels
// reveal as the line reaches them. Driven from a `points` array so an agent passes data, not
// markup. The Hyperframes catalog has no pure line-plot block, so this one is original.

import { escapeHtml } from "./html.js";

export interface ChartPoint {
  label?: string;
  value: number;
}

export interface ChartOptions {
  title?: string;
  points: ChartPoint[];
  xLabel?: string;
  yLabel?: string;
  accentColor?: string;
  valueSuffix?: string;
  durationSeconds: number;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const MARGIN = { left: 170, right: 120, top: 210, bottom: 170 };

export interface PlotGeometry {
  coords: { x: number; y: number }[];
  polyline: string;
  min: number;
  max: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
}

export function buildLinePlot(points: ChartPoint[]): PlotGeometry {
  const plotLeft = MARGIN.left;
  const plotRight = WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.1;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const xAt = (i: number): number =>
    points.length === 1 ? plotLeft + plotW / 2 : plotLeft + (i / (points.length - 1)) * plotW;
  const yAt = (value: number): number => plotBottom - ((value - min) / (max - min)) * plotH;

  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.value) }));
  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  return { coords, polyline, min, max, plotLeft, plotRight, plotTop, plotBottom };
}

export function lineChartHtml(options: ChartOptions): string {
  const accent = options.accentColor ?? "#7fd1ff";
  const suffix = options.valueSuffix ?? "";
  const geo = buildLinePlot(options.points);
  const plotW = geo.plotRight - geo.plotLeft;

  const fmt = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);

  const xLabels = options.points
    .map((p, i) => {
      if (!p.label) return "";
      return `<text class="x-label" data-i="${i}" x="${geo.coords[i]?.x.toFixed(1)}" y="${geo.plotBottom + 44}" text-anchor="middle">${escapeHtml(p.label)}</text>`;
    })
    .join("\n      ");

  const dots = geo.coords
    .map(
      (c, i) =>
        `<circle class="dot" data-i="${i}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="7" fill="${accent}" opacity="0" />`,
    )
    .join("\n      ");

  const valuesJson = JSON.stringify(options.points.map((p) => p.value));
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
      .axis { stroke: #3a3a3a; stroke-width: 2; }
      .axis-label { fill: #9aa0a6; font-size: 30px; }
      .y-tick { fill: #9aa0a6; font-size: 28px; }
      .x-label { fill: #c8ccd0; font-size: 30px; opacity: 0; }
      .plot-line { fill: none; stroke: ${accent}; stroke-width: 6; stroke-linejoin: round; stroke-linecap: round; }
      .head { fill: ${accent}; }
      .head-value { fill: #ffffff; font-size: 44px; font-weight: 800; }
    </style>
  </head>
  <body>
    <div id="scene" data-composition-id="main" data-start="0" data-duration="${options.durationSeconds}" data-width="1920" data-height="1080">
      <svg width="1920" height="1080" viewBox="0 0 1920 1080">
        ${title ? `<text class="title" x="${geo.plotLeft}" y="120">${title}</text>` : ""}
        <line class="axis" x1="${geo.plotLeft}" y1="${geo.plotTop}" x2="${geo.plotLeft}" y2="${geo.plotBottom}" />
        <line class="axis" x1="${geo.plotLeft}" y1="${geo.plotBottom}" x2="${geo.plotRight}" y2="${geo.plotBottom}" />
        <text class="y-tick" x="${geo.plotLeft - 20}" y="${geo.plotTop + 10}" text-anchor="end">${escapeHtml(yTop)}</text>
        <text class="y-tick" x="${geo.plotLeft - 20}" y="${geo.plotBottom + 10}" text-anchor="end">${escapeHtml(yBottom)}</text>
        ${options.yLabel ? `<text class="axis-label" x="${geo.plotLeft}" y="${geo.plotTop - 30}">${escapeHtml(options.yLabel)}</text>` : ""}
        ${options.xLabel ? `<text class="axis-label" x="${geo.plotRight}" y="${geo.plotBottom + 90}" text-anchor="end">${escapeHtml(options.xLabel)}</text>` : ""}
        ${xLabels}
        <clipPath id="reveal"><rect id="reveal-rect" x="${geo.plotLeft}" y="0" width="0" height="1080" /></clipPath>
        <polyline class="plot-line" points="${geo.polyline}" clip-path="url(#reveal)" />
        ${dots}
        <circle class="head" id="head" cx="${geo.coords[0]?.x.toFixed(1)}" cy="${geo.coords[0]?.y.toFixed(1)}" r="11" opacity="0" />
        <text class="head-value" id="head-value" x="0" y="0" text-anchor="middle" opacity="0"></text>
      </svg>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const values = ${valuesJson};
      const PLOT_LEFT = ${geo.plotLeft}, PLOT_W = ${plotW};
      const PLOT_TOP = ${geo.plotTop}, PLOT_BOTTOM = ${geo.plotBottom};
      const MIN = ${geo.min}, MAX = ${geo.max};
      const SUFFIX = ${JSON.stringify(suffix)};
      const rect = document.getElementById("reveal-rect");
      const head = document.getElementById("head");
      const headVal = document.getElementById("head-value");
      const dots = document.querySelectorAll(".dot");
      const xLabelEls = document.querySelectorAll(".x-label");
      const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
      const yAt = (v) => PLOT_BOTTOM - ((v - MIN) / (MAX - MIN)) * (PLOT_BOTTOM - PLOT_TOP);

      const tl = gsap.timeline({ paused: true });
      tl.fromTo(".title", { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.5 }, 0);
      tl.fromTo([".axis", ".y-tick", ".axis-label"], { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.2);

      const drawStart = 0.8;
      const drawDur = Math.max(1, ${options.durationSeconds} - drawStart - 0.6);
      const progress = { t: 0 };
      tl.to(head, { opacity: 1, duration: 0.2 }, drawStart);
      tl.to(headVal, { opacity: 1, duration: 0.2 }, drawStart);
      tl.to(progress, {
        t: 1,
        duration: drawDur,
        ease: "none",
        onUpdate: () => {
          const t = progress.t;
          rect.setAttribute("width", String(t * PLOT_W));
          const n = values.length;
          const f = t * (n - 1);
          const i0 = Math.min(n - 1, Math.floor(f));
          const i1 = Math.min(n - 1, i0 + 1);
          const frac = f - i0;
          const v = values[i0] + (values[i1] - values[i0]) * frac;
          const x = PLOT_LEFT + t * PLOT_W;
          const y = yAt(v);
          head.setAttribute("cx", String(x));
          head.setAttribute("cy", String(y));
          headVal.setAttribute("x", String(x));
          headVal.setAttribute("y", String(y - 28));
          headVal.textContent = fmt(v) + SUFFIX;
          dots.forEach((d, i) => {
            if (n > 1 && i / (n - 1) <= t + 1e-6) d.setAttribute("opacity", "1");
          });
          xLabelEls.forEach((el) => {
            const i = Number(el.getAttribute("data-i"));
            if (n > 1 && i / (n - 1) <= t + 1e-6) el.setAttribute("opacity", "1");
          });
        },
      }, drawStart);

      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`;
}

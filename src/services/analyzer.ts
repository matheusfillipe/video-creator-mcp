import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "python", "analyze_static.py");

export interface StaticGridCell {
  row: number;
  col: number;
  staticness: number;
  clutter: number;
  avoid: number;
}

export interface AvoidRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  where: string;
  staticness: number;
}

export interface StaticAnalysis {
  width: number;
  height: number;
  frames_sampled: number;
  grid_size: number;
  static_pct: number;
  avoid_regions: AvoidRegion[];
  grid: StaticGridCell[];
}

// Profiles a downloaded video (opencv + numpy, CPU) for static, structured regions —
// baked logos/watermarks/text bars an overlay should avoid. See python/analyze_static.py.
export async function analyzeStatic(
  mediaPath: string,
  fps: number,
  grid: number,
): Promise<StaticAnalysis> {
  const { stdout } = await run("python3", [SCRIPT, mediaPath, String(fps), String(grid)], {
    timeoutMs: 300_000,
  });
  return JSON.parse(stdout) as StaticAnalysis;
}

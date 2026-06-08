import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { run } from "../lib/exec.js";

export interface CatalogItem {
  name: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  duration?: number;
}

interface AddResult {
  written: string[];
}

// Catalog block names are simple slugs; reject anything else so a name can never be
// smuggled in as a CLI flag (e.g. "--dir=/etc").
export function isValidBlockName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

// Catalog blocks load GSAP from a CDN; the render pod bundles it locally, so point every
// gsap script tag at the asset the renderer copies in (other CDN deps are left untouched).
export function repointGsap(html: string): string {
  return html.replace(/https?:\/\/[^"']*gsap[^"']*?\.js/gi, "assets/gsap.min.js");
}

export interface CatalogQuery {
  query?: string;
  type?: "block" | "component";
  tag?: string;
}

export async function listCatalog(opts: CatalogQuery = {}): Promise<CatalogItem[]> {
  const args = ["catalog", "--json"];
  if (opts.type) args.push("--type", opts.type);
  if (opts.tag) args.push("--tag", opts.tag);
  const { stdout } = await run("hyperframes", args, { timeoutMs: 60_000 });
  const items = JSON.parse(stdout) as CatalogItem[];
  if (!opts.query) return items;
  const needle = opts.query.toLowerCase();
  return items.filter((item) =>
    `${item.name} ${item.title} ${item.description} ${item.tags.join(" ")}`
      .toLowerCase()
      .includes(needle),
  );
}

// Installs a catalog block into a throwaway project and returns its composition HTML,
// gsap repointed to the bundled asset and (optionally) its duration overridden. Only
// single-file blocks are supported — multi-asset blocks (3D, html-in-canvas) are rejected.
export async function fetchBlockComposition(
  name: string,
  durationSeconds?: number,
): Promise<string> {
  if (!isValidBlockName(name)) {
    throw new Error(`Invalid block name "${name}" — use a catalog slug like "data-chart".`);
  }
  const dir = join(config.workDir, `block-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    await run("hyperframes", ["init", "--yes"], { cwd: dir, timeoutMs: 60_000 });
    const { stdout } = await run("hyperframes", ["add", name, "--json"], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    const result = JSON.parse(stdout) as AddResult;
    const composition = result.written.find((path) => path.endsWith(".html"));
    if (!composition) throw new Error(`Block "${name}" produced no composition file.`);
    if (result.written.length > 1) {
      throw new Error(
        `Block "${name}" needs ${result.written.length} files (extra assets); render_block supports single-composition blocks only.`,
      );
    }
    let html = repointGsap(await readFile(composition, "utf-8"));
    if (durationSeconds !== undefined) {
      html = html.replace(/data-duration="[^"]*"/, `data-duration="${durationSeconds}"`);
    }
    return html;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (error: NodeJS.ErrnoException) => {
        console.error(`[catalog] cleanup of ${dir} failed: ${error.code ?? error.message}`);
      },
    );
  }
}

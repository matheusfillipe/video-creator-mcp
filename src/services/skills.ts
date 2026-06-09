import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, "..", "..", "skills");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".md")) {
      out.push(relative(SKILLS_DIR, full));
    }
  }
  return out;
}

// Relative paths of every bundled HyperFrames skill doc, e.g.
// "hyperframes/references/techniques.md". The skill trees ship in the image.
export function listSkillDocs(): string[] {
  return walk(SKILLS_DIR).sort();
}

// Reads one bundled skill doc by its relative path. The path comes from a model,
// so anything escaping the skills directory or not ending in .md is rejected.
export function readSkillDoc(docPath: string): string {
  const full = join(SKILLS_DIR, docPath);
  const rel = relative(SKILLS_DIR, full);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || !full.endsWith(".md")) {
    throw new Error(`Invalid skill doc path: ${docPath}`);
  }
  return readFileSync(full, "utf-8");
}

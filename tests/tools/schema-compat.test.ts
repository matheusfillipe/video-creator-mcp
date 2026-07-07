import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/registry.js";

// Some LLM function-calling backends (z.ai's GLM among them) reject JSON Schema arrays
// that use positional item schemas — `prefixItems`, or `items` as an array. z.tuple()
// compiles to exactly that. Catch it before it ships and 400s the whole subagent.
function hasPositionalItems(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasPositionalItems);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("prefixItems" in obj) return true;
    if (Array.isArray(obj.items)) return true;
    return Object.values(obj).some(hasPositionalItems);
  }
  return false;
}

function collectSchemas(): Map<string, z.ZodRawShape> {
  const schemas = new Map<string, z.ZodRawShape>();
  const server = {
    registerTool(name: string, def: { inputSchema?: z.ZodRawShape }) {
      if (def.inputSchema) schemas.set(name, def.inputSchema);
    },
  };
  // MANIM_SCENES gates one tool; register it too so the check covers everything.
  process.env.MANIM_SCENES = "true";
  registerAllTools(server as never);
  return schemas;
}

describe("tool schema LLM compatibility", () => {
  const schemas = collectSchemas();

  it("registers every tool with an input schema", () => {
    expect(schemas.size).toBeGreaterThan(20);
  });

  it("no tool schema uses positional-items arrays (tuples)", () => {
    const offenders: string[] = [];
    for (const [name, shape] of schemas) {
      const json = z.toJSONSchema(z.object(shape));
      if (hasPositionalItems(json)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

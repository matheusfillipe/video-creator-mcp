import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSkillDocs, readSkillDoc } from "../services/skills.js";
import { registerTool } from "./defineTool.js";

const INDEX_HEADER = `# HyperFrames authoring skill — document index

Start with \`hyperframes/SKILL.md\`. Read \`hyperframes/references/video-composition.md\`, \`hyperframes/references/motion-principles.md\` and \`hyperframes/references/typography.md\` before any non-trivial composition; add \`hyperframes/references/beat-direction.md\` and \`hyperframes/references/transitions.md\` for multi-scene pieces. GSAP patterns live under \`gsap/\`.

Two adaptations for THIS server (it renders HTML you author via \`video_render\` / \`video_render_timeline\`):
- The skill's CLI commands (init/preview/render, design.md, inspect/validate) map to this server's tools — use \`video_lint\` then \`video_render\`; ignore raw \`npx hyperframes\` invocations.
- GSAP is provided by the renderer: reference \`assets/gsap.min.js\` (never a CDN \`<script>\`, renders have no internet) or omit the script tag entirely.

Call \`video_skill\` with one of these \`doc\` paths to read it:
`;

export function registerSkillTools(server: McpServer): void {
  registerTool(server, {
    name: "video_skill",
    title: "HyperFrames Authoring Skill",
    description:
      "Read the bundled HyperFrames authoring skill — the real HeyGen skill docs: composition rules, GSAP motion principles, visual techniques, scene transitions, typography, color palettes, data-in-motion patterns. Call with no `doc` to list every doc, or with a `doc` path to read it. Use this to author correct video_render / video_render_timeline HTML and to explore deeper technique before building a custom composition.",
    inputSchema: {
      doc: z
        .string()
        .optional()
        .describe(
          "Doc path from the index, e.g. 'hyperframes/references/techniques.md'. Omit to list all docs.",
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: ({ doc }) => {
      if (!doc) {
        const list = listSkillDocs()
          .map((d) => `- ${d}`)
          .join("\n");
        return Promise.resolve(`${INDEX_HEADER}${list}`);
      }
      return Promise.resolve(readSkillDoc(doc));
    },
  });
}

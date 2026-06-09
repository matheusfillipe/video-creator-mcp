import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeTools } from "./analyze.js";
import { registerAudioTools } from "./audio.js";
import { registerCatalogTools } from "./catalog.js";
import { registerEffectsTools } from "./effects.js";
import { registerMediaTools } from "./media.js";
import { registerRenderTools } from "./render.js";
import { registerSkillTools } from "./skill.js";
import { registerTemplateTools } from "./templates.js";
import { registerYoutubeTools } from "./youtube.js";

export function registerAllTools(server: McpServer): void {
  registerRenderTools(server);
  registerMediaTools(server);
  registerYoutubeTools(server);
  registerAudioTools(server);
  registerEffectsTools(server);
  registerTemplateTools(server);
  registerCatalogTools(server);
  registerAnalyzeTools(server);
  registerSkillTools(server);
}

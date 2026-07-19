import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeTools } from "./analyze.js";
import { registerAudioTools } from "./audio.js";
import { registerCatalogTools } from "./catalog.js";
import { registerComposeTools } from "./compose.js";
import { registerEditTools } from "./edit.js";
import { registerEffectsTools } from "./effects.js";
import { registerGraphicTools } from "./graphic.js";
import { registerMediaTools } from "./media.js";
import { registerRecipeTools } from "./recipe.js";
import { registerRecordTools } from "./record.js";
import { registerRenderTools } from "./render.js";
import { registerSkillTools } from "./skill.js";
import { registerTemplateTools } from "./templates.js";
import { registerYoutubeTools } from "./youtube.js";

export function registerAllTools(server: McpServer): void {
  registerRenderTools(server);
  registerEditTools(server);
  registerRecipeTools(server);
  registerMediaTools(server);
  registerRecordTools(server);
  registerYoutubeTools(server);
  registerAudioTools(server);
  registerComposeTools(server);
  registerEffectsTools(server);
  registerGraphicTools(server);
  registerTemplateTools(server);
  registerCatalogTools(server);
  registerAnalyzeTools(server);
  registerSkillTools(server);
}

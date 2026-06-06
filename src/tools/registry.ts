import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAudioTools } from "./audio.js";
import { registerEffectsTools } from "./effects.js";
import { registerMediaTools } from "./media.js";
import { registerRenderTools } from "./render.js";
import { registerYoutubeTools } from "./youtube.js";

export function registerAllTools(server: McpServer): void {
  registerRenderTools(server);
  registerMediaTools(server);
  registerYoutubeTools(server);
  registerAudioTools(server);
  registerEffectsTools(server);
}

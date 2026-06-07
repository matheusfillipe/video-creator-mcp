import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "./resources.js";
import { registerAllTools } from "./tools/registry.js";

export const SERVER_NAME = "video-creator-mcp";
export const SERVER_VERSION = "0.1.0";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {}, resources: {} } },
  );
  registerAllTools(server);
  registerResources(server);
  return server;
}

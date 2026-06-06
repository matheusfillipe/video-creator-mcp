import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, z } from "zod";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}

interface ToolConfig {
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
}

type RegisterToolFn = (
  name: string,
  config: ToolConfig,
  callback: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => void;

/**
 * Registers one tool and wraps its handler in the shared response envelope: object results
 * become pretty JSON text, string results pass through, and thrown errors become an actionable
 * { isError: true } result rather than a protocol-level failure. The SDK's tool-callback generic
 * is too strict for a reusable wrapper, so registration is funneled through a narrowed signature;
 * Zod still validates inputs at runtime and the handler stays fully typed against its schema.
 */
export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
): void {
  const register = server.registerTool.bind(server) as unknown as RegisterToolFn;
  register(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: { destructiveHint: false, openWorldHint: true, ...spec.annotations },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await spec.handler(args as z.infer<z.ZodObject<Shape>>);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

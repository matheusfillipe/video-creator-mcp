import { z } from "zod";

const ConfigSchema = z
  .object({
    transport: z.enum(["http", "stdio"]).default("http"),
    port: z.coerce.number().int().positive().max(65535).default(3100),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    transport: env.TRANSPORT,
    port: env.PORT,
    apiKey: env.MCP_API_KEY,
  });
}

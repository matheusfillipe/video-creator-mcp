#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, buildServer } from "./server.js";

async function runStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} running on stdio`);
}

function requireApiKey(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.header("x-api-key") === apiKey) {
      next();
      return;
    }
    res.status(401).json({ error: "invalid or missing x-api-key header" });
  };
}

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  });

  const mcp = express.Router();
  if (config.apiKey) {
    mcp.use(requireApiKey(config.apiKey));
  }
  mcp.post("/", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
    });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.use("/mcp", mcp);

  app.listen(config.port, () => {
    console.error(
      `${SERVER_NAME} HTTP transport on :${config.port}/mcp (auth: ${config.apiKey ? "on" : "off"})`,
    );
  });
}

async function main(): Promise<void> {
  if (config.transport === "stdio") {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error: unknown) => {
  console.error("fatal:", error);
  process.exit(1);
});

# Video Creator MCP

Node.js MCP server that renders HTML+GSAP → MP4 via Hyperframes CLI.

## Key files
- `src/index.js` — Express + MCP StreamableHTTP server, tool definitions, render queue
- `src/renderer.js` — Hyperframes CLI wrapper, base64 decode, audio injection, progress parsing
- `src/storage.js` — Storage abstraction (local fs or S3)

## Adding/modifying MCP tools
Edit `src/index.js` in `getServer()`. Use `server.registerTool()` with zod schema.

## Render flow
1. Base64 HTML decoded, audio injected if provided
2. Files written to temp workdir
3. `npx hyperframes render <workdir>` spawned
4. Progress parsed from stderr (`Streaming frame N/M`)
5. Output MP4 read, saved to storage, URL returned

## Deploy
`./deploy.sh` restarts systemd service. Service file at `video-creator-mcp.service`.

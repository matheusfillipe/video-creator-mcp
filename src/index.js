#!/usr/bin/env node
// MCP Video Renderer Server — StreamableHTTP transport
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createStorage } from './storage.js';
import { renderVideo } from './renderer.js';
import express from 'express';

const PORT = parseInt(process.env.PORT || '3100', 10);
const storage = createStorage();

// Simple render queue — one job at a time to avoid CPU spikes
const queue = {
  current: null,
  waiting: [],
  enqueue(job) {
    this.waiting.push(job);
    this.drain();
  },
  drain() {
    if (this.current || this.waiting.length === 0) return;
    this.current = this.waiting.shift();
    this.current.run().finally(() => {
      this.current = null;
      this.drain();
    });
  },
};

// Create MCP server
const getServer = () => {
  const server = new McpServer(
    { name: 'video-renderer', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );

  // Tool: render_video
  server.registerTool('render_video', {
    title: 'Render Video',
    description: `Render an HTML+GSAP composition to MP4 video via Hyperframes.

⚠️ IMPORTANT: Before authoring HTML, load the skill 'hyperframes-video-generation' for design systems, composition rules, typography, transitions, and craft. Also read official docs at https://hyperframes.mintlify.app/llms.txt for the full reference index.

QUICK RULES (broken compositions = bad video):
- HTML must be base64-encoded.
- Must include <div id="root" data-composition-id="main" data-start="0" data-duration="N" data-width="1920" data-height="1080">.
- GSAP: always use gsap.timeline({ paused: true }), register on window.__timelines["main"].
- class="clip" + data-start + data-duration + data-track-index on ALL timed elements.
- No Math.random() — use seeded PRNG. No async/await during timeline setup. No fetch().
- Animate wrapper divs around <video>, never <video> directly. Never call .play()/.pause().
- All elements: position:absolute with top/left (never bottom — causes clipping).
- Canvas: 1920×1080 for landscape (1080p), 1080×1920 for portrait.
- Audio: pass as base64 WAV/MP3 in 'audio' param — injected as <audio data-start="0" data-duration="N" data-volume="0.8" src="assets/audio.wav">.
- data-width/data-height on #root determines orientation. Must match --resolution.
- Timeline duration = composition duration. Extend with tl.set({}, {}, DURATION) if needed.

Returns a URL to the rendered MP4 file.`,
    annotations: {
      openWorldHint: true,
    },
    inputSchema: {
      html: z.string().describe('Full HTML composition with inline CSS and GSAP animations. Must use position:absolute, top/left (never bottom). Canvas is 1920x1080.'),
      audio: z.string().optional().describe('Base64-encoded audio data (WAV/MP3).'),
      audio_volume: z.number().min(0).max(1).default(0.9).describe('Audio volume 0-1.'),
      fps: z.number().int().min(1).max(60).default(30).describe('Frames per second.'),
      resolution: z.enum(['1080p', '4k', 'uhd', 'landscape', 'portrait', 'square']).default('1080p').describe('Output resolution.'),
      duration: z.number().optional().describe('Expected duration in seconds. Used for progress if Hyperframes doesn\'t report frame counts.'),
    },
  }, async ({ html, audio, audio_volume, fps, resolution, duration }, extra) => {
    const jobId = randomUUID().slice(0, 8);

    // Calculate expected frames for progress
    const totalFrames = duration
      ? Math.ceil((duration || 30) * (fps || 30))
      : null;

    let lastReported = 0;
    const reportProgress = (p) => {
      const progress = totalFrames ? Math.round((p.current / p.total) * 100) : p.current;
      if (progress !== lastReported && extra._meta?.progressToken) {
        lastReported = progress;
        extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: extra._meta.progressToken,
            progress: p.current,
            total: p.total || totalFrames,
            message: `Rendering frame ${p.current}/${p.total || totalFrames || '?'}`,
          },
        }).catch(() => {});
      }
    };

    try {
      // Run render (may queue if another job is running)
      const result = await new Promise((resolve, reject) => {
        queue.enqueue({
          run: async () => {
            try {
              const res = await renderVideo(
                { html, audio, audioVolume: audio_volume, fps, resolution },
                reportProgress
              );
              resolve(res);
            } catch (err) {
              reject(err);
            }
          },
        });
      });

      // Store the video
      const url = await storage.save(result.buffer, result.filename);

      return {
        content: [
          { type: 'text', text: `Render complete: ${url} (${result.size} bytes)` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Render failed: ${err.message}` }],
        isError: true,
      };
    }
  });

  // Tool: render_status (queue info)
  server.registerTool('render_queue', {
    title: 'Render Queue Status',
    description: 'Check current render queue status — how many jobs waiting, current job.',
    inputSchema: {},
  }, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentJob: queue.current ? 'running' : 'idle',
          queued: queue.waiting.length,
        }),
      }],
    };
  });

  return server;
};

// Express + StreamableHTTP setup
const app = express();
const transports = {};

// JSON body parsing with 50MB limit for base64 audio
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// Static file serving for local storage mode
if (storage.type === 'local') {
  const servePath = process.env.STORAGE_PATH || './output';
  app.use('/output', express.static(servePath));
  console.log(`[mcp] Serving local files at /output from ${servePath}`);
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  try {
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          console.log(`[mcp] Session initialized: ${id}`);
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] Error:', err.message || err);
    console.error('[mcp] Stack:', err.stack);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Missing or invalid session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Missing or invalid session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: storage.type,
    queue: {
      current: queue.current ? 'running' : 'idle',
      queued: queue.waiting.length,
    },
  });
});

// Start
app.listen(PORT, () => {
  console.log(`[mcp] Video renderer MCP server on port ${PORT}`);
  console.log(`[mcp] Transport: StreamableHTTP at /mcp`);
  console.log(`[mcp] Storage: ${storage.type}`);
});

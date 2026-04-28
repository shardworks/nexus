/**
 * MCP/SSE proxy server — proxies MCP tool calls to the guild Tool HTTP API.
 *
 * The babysitter spawns this on startup and points claude at it via
 * `--mcp-config`. Claude's MCP client connects via SSE (`GET /sse`) and
 * issues tool calls as `POST /message`; the proxy forwards each call to
 * the guild's Tool HTTP API and returns the response as an MCP tool
 * result.
 *
 * Four sub-machines live behind this single module — they are intentionally
 * coupled because they share the same SSE transport / lifetime:
 *
 *   1. MCP `tools/list` and `tools/call` registration (the protocol surface
 *      claude sees).
 *   2. The `transportReady` SSE promise-gate that closes the SSE-then-POST
 *      race (see doc-block on the POST handler below).
 *   3. The 30s SSE keepalive timer with `res.on('close')` cleanup that
 *      prevents idle proxies from being culled by intermediaries.
 *   4. The diagnostic counters (`sseConnectedAt`, `sseClosedAt`,
 *      `toolCallCount`) and `process.stderr.write` lines used to debug SSE
 *      drops and dead-connection POSTs.
 *
 * The public surface is intentionally narrow: the constructor returns a
 * `{ url, close }` handle. Diagnostics stay internal — there are no
 * observers, getters, or pluggable hooks on this module.
 */

import http from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { toolNameToRoute } from '@shardworks/tools-apparatus';

import { callGuildHttpApi, type SerializedTool } from './runtime.ts';

// ── Public types ────────────────────────────────────────────────────────

export interface McpProxyHandle {
  /** URL for --mcp-config (e.g. "http://127.0.0.1:PORT/sse"). */
  url: string;
  /** Shut down the HTTP server and MCP transport. */
  close(): Promise<void>;
}

// ── Constructor ─────────────────────────────────────────────────────────

/**
 * Create an MCP/SSE HTTP server that proxies tool calls to the guild.
 *
 * For each tool in the config, registers an MCP tool whose handler
 * forwards the call to the guild's Tool HTTP API via HTTP POST.
 *
 * Uses the low-level MCP Server class to register tools with raw
 * JSON Schema (the serialized params from the config).
 */
export async function createProxyMcpHttpServer(
  tools: SerializedTool[],
  guildToolUrl: string,
  sessionId: string,
): Promise<McpProxyHandle> {
  const server = new Server(
    { name: 'nexus-guild-proxy', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  // ── MCP proxy diagnostics ──────────────────────────────────────────
  // Track connection state and tool call metrics for debugging SSE drops.
  let sseConnectedAt: number | null = null;
  let sseClosedAt: number | null = null;
  let toolCallCount = 0;

  // Register tools/list handler — advertises all tools with their JSON Schema.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object' as const,
        ...t.params,
      },
    })),
  }));

  // Build a name → HTTP method lookup so the proxy can route each call to
  // the correct verb (read tools are GET-only on the tool server; POSTing
  // to them 404s).
  const toolMethods = new Map<string, 'GET' | 'POST' | 'DELETE'>();
  for (const t of tools) {
    toolMethods.set(t.name, t.method);
  }

  // Register tools/call handler — proxies each call to the guild HTTP API.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const params = request.params.arguments ?? {};

    const route = toolNameToRoute(toolName);
    const url = `${guildToolUrl}${route}`;
    const method = toolMethods.get(toolName) ?? 'POST';

    toolCallCount++;
    const callNum = toolCallCount;
    const callStart = Date.now();

    try {
      const result = await callGuildHttpApi(url, sessionId, params, undefined, method);
      const elapsed = Date.now() - callStart;
      process.stderr.write(`[babysitter] mcp-proxy: ${toolName} → ${method} ${route} (${elapsed}ms, call #${callNum})\n`);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      const elapsed = Date.now() - callStart;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[babysitter] mcp-proxy: ${toolName} FAILED (${elapsed}ms, call #${callNum}): ${message}\n`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Wrap in HTTP server with SSE transport (same pattern as mcp-server.ts).
  // Promise-gate: POST /message waits for the SSE transport to be fully connected,
  // eliminating the race where a POST arrives before GET /sse completes.
  let resolveTransport!: (t: SSEServerTransport) => void;
  let rejectTransport!: (err: Error) => void;
  const transportReady = new Promise<SSEServerTransport>((resolve, reject) => {
    resolveTransport = resolve;
    rejectTransport = reject;
  });

  // Direct reference for close() — null until connected.
  let transport: SSEServerTransport | null = null;

  // SSE keepalive timer — sends periodic comments to prevent idle timeouts.
  // SSE spec says lines starting with ':' are comments, ignored by clients.
  const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/sse') {
        const t = new SSEServerTransport('/message', res);
        try {
          await server.connect(t);
          transport = t;
          sseConnectedAt = Date.now();
          process.stderr.write(`[babysitter] mcp-proxy: SSE connection established\n`);

          // Start keepalive pings on the SSE response stream
          keepaliveTimer = setInterval(() => {
            try {
              res.write(':keepalive\n\n');
            } catch {
              // Stream already closed — timer will be cleared by close handler
            }
          }, SSE_KEEPALIVE_INTERVAL_MS);

          // Log when SSE connection closes (the key diagnostic for the drop)
          res.on('close', () => {
            const duration = sseConnectedAt ? Date.now() - sseConnectedAt : 0;
            sseClosedAt = Date.now();
            process.stderr.write(
              `[babysitter] mcp-proxy: SSE connection closed after ${duration}ms ` +
              `(${toolCallCount} tool calls proxied)\n`,
            );
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          });

          resolveTransport(t);
        } catch (err) {
          rejectTransport(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      } else if (req.method === 'POST' && req.url?.startsWith('/message')) {
        if (!transport) {
          process.stderr.write(`[babysitter] mcp-proxy: POST /message arrived before SSE transport ready — waiting\n`);
        }
        let t: SSEServerTransport;
        try {
          t = await transportReady;
        } catch {
          res.writeHead(503).end('SSE transport failed to initialize');
          return;
        }

        // Detect and log the "SSE already dead" case before it hits the SDK
        if (sseClosedAt) {
          const ago = Date.now() - sseClosedAt;
          process.stderr.write(
            `[babysitter] mcp-proxy: POST /message on dead SSE connection ` +
            `(closed ${ago}ms ago, after ${toolCallCount} calls)\n`,
          );
        }

        await t.handlePostMessage(req, res);
      } else {
        res.writeHead(404).end('Not found');
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to get MCP proxy server address');
  }

  const url = `http://127.0.0.1:${addr.port}/sse`;
  process.stderr.write(`[babysitter] MCP proxy server listening on port ${addr.port}\n`);

  return {
    url,
    async close() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (transport) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

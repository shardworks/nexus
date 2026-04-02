/**
 * MCP Tool Server — serves guild tools as typed MCP tools during anima sessions.
 *
 * Two entry points:
 *
 * 1. **`createMcpServer(tools)`** — library function. Takes an array of
 *    ToolDefinitions (already resolved by the Instrumentarium) and returns
 *    a configured McpServer.
 *
 * 2. **`startMcpHttpServer(tools)`** — starts an in-process HTTP server
 *    serving the MCP tool set via Streamable HTTP on an ephemeral localhost
 *    port. Returns a handle with the URL (for --mcp-config) and a close()
 *    function for cleanup.
 *
 * The MCP server is one-per-session. The claude-code provider owns the
 * lifecycle — starts before the Claude process, stops after it exits.
 *
 * See: docs/architecture/apparatus/claude-code.md
 */

import http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { VERSION } from '@shardworks/nexus-core';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Handle returned by startMcpHttpServer().
 *
 * Provides the URL for --mcp-config and a close() function for cleanup.
 */
export interface McpHttpHandle {
  /** URL for --mcp-config (e.g. "http://127.0.0.1:PORT/mcp"). */
  url: string;
  /** Shut down the HTTP server and MCP transport. */
  close(): Promise<void>;
}

// ── Library API ─────────────────────────────────────────────────────────

/**
 * Create and configure an MCP server with the given tools.
 *
 * Each tool's Zod param schema is registered directly with the MCP SDK
 * (which handles JSON Schema conversion). The handler is wrapped to
 * validate params via Zod and format the result as MCP tool output.
 *
 * Tools with `callableBy` set that does not include `'anima'` are
 * filtered out. Tools without `callableBy` are included (available
 * to all callers by default).
 */
export async function createMcpServer(tools: ToolDefinition[]): Promise<McpServer> {
  const server = new McpServer({
    name: 'nexus-guild',
    version: VERSION,
  });

  for (const def of tools) {
    // Filter by callableBy — only serve tools callable by animas.
    // Tools with no callableBy default to all callers (available everywhere).
    if (def.callableBy && !def.callableBy.includes('anima')) {
      continue;
    }

    server.tool(
      def.name,
      def.description,
      def.params.shape,
      async (params) => {
        try {
          const validated = def.params.parse(params);
          const result = await def.handler(validated);

          return {
            content: [{
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

// ── HTTP Server ─────────────────────────────────────────────────────────

/**
 * Start an in-process HTTP server serving the MCP tool set via SSE.
 *
 * Uses the MCP SDK's SSE transport: the client GETs /sse to establish
 * the event stream, then POSTs messages to /message. Claude Code's
 * --mcp-config expects `type: "sse"` for HTTP-based MCP servers.
 *
 * The server binds to 127.0.0.1 only — not network-accessible.
 *
 * Returns a handle with the URL (for --mcp-config) and a close() function.
 * The caller is responsible for calling close() after the session exits.
 *
 * Each session gets its own server instance. Concurrent sessions get
 * independent servers on different ports.
 */
export async function startMcpHttpServer(tools: ToolDefinition[]): Promise<McpHttpHandle> {
  const mcpServer = await createMcpServer(tools);

  // SSE transport: the client GETs /sse, the transport tells it to POST
  // messages to /message. One transport per connection (single-session).
  let transport: SSEServerTransport | null = null;

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/sse') {
        // New SSE connection — create transport bound to this response.
        transport = new SSEServerTransport('/message', res);
        await mcpServer.connect(transport);
      } else if (req.method === 'POST' && req.url?.startsWith('/message')) {
        if (!transport) {
          res.writeHead(400).end('No active SSE connection');
          return;
        }
        await transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404).end('Not found');
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    }
  });

  // Listen on ephemeral port, localhost only.
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to get server address');
  }

  const url = `http://127.0.0.1:${addr.port}/sse`;

  return {
    url,
    async close() {
      if (transport) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Session Babysitter — detached process that hosts a claude session.
 *
 * A standalone Node.js script that:
 * 1. Reads config from stdin (spawned by the claude-code provider)
 * 2. Opens the guild's SQLite database for transcript streaming
 * 3. Starts an MCP/SSE server that proxies tool calls to the guild
 * 4. Spawns claude with prepared session files
 * 5. Reports session lifecycle events via the guild's HTTP API
 * 6. Streams transcript data to SQLite in real-time
 * 7. Reports the final result and cleans up
 *
 * The babysitter is a detached process: it survives guild restarts.
 * All guild communication is via HTTP (tool server) and SQLite (transcripts).
 *
 * The single-purpose primitives (stdin parsing, retrying HTTP, DLQ writes,
 * the SQLite trio, lifecycle reporters, stderr redirect) live in
 * `runtime.ts`. This file owns the orchestrator (`runBabysitter`), the
 * MCP/SSE proxy, and the script entry point. The previously-exported
 * primitives are re-exported below to preserve the package's public
 * surface.
 *
 * See: docs/architecture/detached-sessions.md
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { toolNameToRoute } from '@shardworks/tools-apparatus';

import {
  processNdjsonBuffer,
  parseStreamJsonMessage,
  type StreamJsonResult,
} from './index.ts';

import type { SessionTerminationTag } from '@shardworks/animator-apparatus';

import {
  callGuildHttpApi,
  openTranscriptDb,
  readConfigFromStdin,
  redirectStderrToFile,
  reportRunning,
  reportResult,
  STDERR_DIAGNOSTIC_TAIL_LIMIT,
  writeToDlq,
  writeTranscript,
  type BabysitterConfig,
  type SerializedTool,
  type TranscriptDb,
} from './runtime.ts';

// ── Re-exports (preserves the pre-extraction public surface) ────────────

export {
  callGuildHttpApi,
  findRetryableCode,
  initTranscriptDb,
  openTranscriptDb,
  readConfigFromStdin,
  redirectStderrToFile,
  reportResult,
  reportRunning,
  resolveTerminalStatus,
  STDERR_DIAGNOSTIC_TAIL_LIMIT,
  writeToDlq,
  writeTranscript,
} from './runtime.ts';
export type {
  BabysitterConfig,
  SerializedTool,
  TranscriptDb,
} from './runtime.ts';

// ── Public types (proxy-only) ───────────────────────────────────────────

export interface McpProxyHandle {
  /** URL for --mcp-config (e.g. "http://127.0.0.1:PORT/sse"). */
  url: string;
  /** Shut down the HTTP server and MCP transport. */
  close(): Promise<void>;
}

// ── MCP proxy server ────────────────────────────────────────────────────

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

// ── Main babysitter function ────────────────────────────────────────────

/**
 * Run the session babysitter.
 *
 * This is the main orchestration function. It:
 * 1. Opens SQLite for transcript streaming
 * 2. Starts the MCP proxy server
 * 3. Prepares session files (tmpDir, system prompt, mcp-config)
 * 4. Spawns claude
 * 5. Reports "running" status
 * 6. Streams transcript to SQLite
 * 7. Reports result on exit
 * 8. Cleans up
 */
export async function runBabysitter(
  config: BabysitterConfig,
  deps?: {
    /** Injected TranscriptDb for testing (avoids loading better-sqlite3). */
    db?: TranscriptDb;
    /** Override spawn for testing. */
    spawnFn?: typeof spawn;
    /** Override retry timeout for testing (default: 60_000ms). */
    retryTimeoutMs?: number;
  },
): Promise<void> {
  const spawnFn = deps?.spawnFn ?? spawn;
  const retryTimeoutMs = deps?.retryTimeoutMs;
  let db: TranscriptDb | null = null;
  let mcpHandle: McpProxyHandle | null = null;
  let tmpDir: string | null = null;
  let claudeProc: ChildProcess | null = null;

  try {
    // 1. Open SQLite
    db = deps?.db ?? await openTranscriptDb(config.dbPath);

    // 2. Start MCP proxy server
    mcpHandle = await createProxyMcpHttpServer(
      config.tools,
      config.guildToolUrl,
      config.sessionId,
    );

    // 3. Prepare session files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-babysitter-'));

    const args = [...config.claudeArgs];

    // Write system prompt if present in args (already handled by claudeArgs)
    // Write mcp-config pointing to the babysitter's MCP proxy server
    const mcpConfig = {
      mcpServers: {
        'nexus-guild': {
          type: 'sse',
          url: mcpHandle.url,
        },
      },
    };
    const mcpConfigPath = path.join(tmpDir, 'mcp-config.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');

    // Add autonomous mode flags
    args.push(
      '--print', '-',
      '--output-format', 'stream-json',
      '--verbose',
    );

    // 4. Spawn claude
    claudeProc = spawnFn('claude', args, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    // Pipe prompt to claude's stdin, then close
    if (config.prompt) {
      claudeProc.stdin!.write(config.prompt);
    }
    claudeProc.stdin!.end();

    // Forward claude's stderr bytes to the babysitter's redirected
    // stderr log. No detection happens here — rate-limit signals are
    // detected only on structured NDJSON messages inside
    // parseStreamJsonMessage.
    //
    // Also maintain a rolling tail buffer (last
    // STDERR_DIAGNOSTIC_TAIL_LIMIT chars) — used as the `stderrExcerpt`
    // of the passive `terminationDiagnostic` attached when the session
    // ends with `'failed'`. O(1) per chunk: append then slice the tail.
    let stderrTail = '';
    claudeProc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_DIAGNOSTIC_TAIL_LIMIT);
    });

    // 5. Report "running" status (don't await — fire and forget with retry)
    const cancelHandle = { kind: 'local-pgid' as const, pgid: process.pid };
    const runningPromise = reportRunning(config, cancelHandle, retryTimeoutMs).catch((err) => {
      process.stderr.write(`[babysitter] Failed to report running: ${err}\n`);
    });

    // 5b. Heartbeat timer — sends liveness signal every 30s after ready report.
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const HEARTBEAT_TIMEOUT_MS = 10_000;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleHeartbeat() {
      heartbeatTimer = setTimeout(async () => {
        const route = toolNameToRoute('session-heartbeat');
        const hbUrl = `${config.guildToolUrl}${route}`;
        try {
          await callGuildHttpApi(hbUrl, config.sessionId, { sessionId: config.sessionId }, HEARTBEAT_TIMEOUT_MS);
        } catch {
          // Dropped — next heartbeat in 30s. Staleness threshold (90s) tolerates this.
        }
        scheduleHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Start heartbeat after running report completes
    runningPromise.then(() => scheduleHeartbeat());

    // 5c. SIGTERM handler — sets cancelled flag and propagates to claude.
    let cancelledBySignal = false;

    const onSigterm = () => {
      cancelledBySignal = true;
      // Stop heartbeat timer
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Propagate SIGTERM to the claude process
      if (claudeProc && claudeProc.pid && !claudeProc.killed) {
        try {
          claudeProc.kill('SIGTERM');
        } catch { /* already dead */ }
      }
      // The normal claude exit path will run, check cancelledBySignal,
      // and report status 'cancelled' instead of computing from exit code.
    };

    process.on('SIGTERM', onSigterm);

    // 6. Consume stdout, stream transcript
    const acc: {
      transcript: Record<string, unknown>[];
      costUsd?: number;
      tokenUsage?: StreamJsonResult['tokenUsage'];
      providerSessionId?: string;
      /**
       * First rate-limit signal captured from the NDJSON result
       * inspection inside parseStreamJsonMessage. First-wins preserves
       * the order of observation.
       */
      terminationTag?: SessionTerminationTag;
    } = { transcript: [] };

    let buffer = '';

    claudeProc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const prevLength = acc.transcript.length;
      buffer = processNdjsonBuffer(buffer, (msg) => {
        parseStreamJsonMessage(msg, acc);
      });

      // Write transcript to SQLite if new messages were added
      if (acc.transcript.length > prevLength && db) {
        writeTranscript(db, config.sessionId, acc.transcript);
      }
    });

    // 7. Wait for claude to exit
    const { code: exitCode, signal: exitSignal } = await new Promise<{ code: number; signal: string | undefined }>((resolve, reject) => {
      claudeProc!.on('error', (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
      claudeProc!.on('close', (code, signal) => {
        resolve({ code: code ?? 1, signal: signal ?? undefined });
      });
    });

    // Stop heartbeat before terminal report
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }

    // Clean up SIGTERM handler
    process.removeListener('SIGTERM', onSigterm);

    // Ensure running report completed before recording result
    await runningPromise;

    // Build result
    const result: StreamJsonResult = {
      exitCode,
      transcript: acc.transcript,
      costUsd: acc.costUsd,
      tokenUsage: acc.tokenUsage,
      providerSessionId: acc.providerSessionId,
      signal: exitSignal,
      ...(acc.terminationTag ? { terminationTag: acc.terminationTag } : {}),
    };

    // 8. Report result
    await reportResult(
      config,
      result,
      acc.transcript,
      retryTimeoutMs,
      cancelledBySignal ? 'cancelled' : undefined,
      stderrTail,
    );
  } catch (err) {
    // Top-level error: attempt to report failure
    const message = err instanceof Error ? err.message : String(err);

    try {
      const route = toolNameToRoute('session-record');
      const url = `${config.guildToolUrl}${route}`;
      await callGuildHttpApi(url, config.sessionId, {
        sessionId: config.sessionId,
        status: 'failed',
        exitCode: 1,
        error: message,
      }, retryTimeoutMs);
    } catch {
      writeToDlq(config.cwd, `${config.sessionId}.json`, {
        sessionId: config.sessionId,
        status: 'failed',
        exitCode: 1,
        error: message,
      });
    }

    throw err;
  } finally {
    // 9. Cleanup
    process.removeAllListeners('SIGTERM');
    await mcpHandle?.close().catch(() => {});
    db?.close();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (config.systemPromptTmpDir) {
      fs.rmSync(config.systemPromptTmpDir, { recursive: true, force: true });
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Script entry point — reads config from stdin and runs the babysitter.
 *
 * Only executes when this file is run directly (not when imported).
 */
async function main(): Promise<void> {
  let fd: number | undefined;
  try {
    const config = await readConfigFromStdin();
    fd = redirectStderrToFile(config.logDir, config.sessionId);
    await runBabysitter(config);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[babysitter] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

// Check if this module is the entry point
const isEntryPoint = process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
   path.basename(process.argv[1]) === 'babysitter.js' ||
   path.basename(process.argv[1]) === 'babysitter.ts');

if (isEntryPoint) {
  main();
}

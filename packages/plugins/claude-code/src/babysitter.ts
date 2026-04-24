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
  extractFinalAssistantText,
  type StreamJsonResult,
} from './index.ts';

import type { SessionTerminationTag } from '@shardworks/animator-apparatus';

// ── Config types ────────────────────────────────────────────────────────

/** A serialized tool definition as received in the babysitter config. */
export interface SerializedTool {
  /** Tool name (e.g. 'writ-list'). */
  name: string;
  /** Tool description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  params: Record<string, unknown>;
  /**
   * HTTP method the guild tool server routes this tool under. The MCP proxy
   * uses this to avoid POSTing to a GET-only read-tool route (which would
   * 404). Derived from the tool's `permission` by `permissionToMethod()`.
   */
  method: 'GET' | 'POST' | 'DELETE';
}

/** Config written to the babysitter's stdin by the spawning process. */
export interface BabysitterConfig {
  sessionId: string;
  guildToolUrl: string;
  dbPath: string;
  logDir: string;
  claudeArgs: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  tools: SerializedTool[];
  startedAt: string;
  provider: string;
  metadata?: Record<string, unknown>;
  /** Temp directory for the system prompt file. Cleaned up in finally block. */
  systemPromptTmpDir?: string;
}

// ── Retry constants ─────────────────────────────────────────────────────

const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_TIMEOUT_MS = 60_000;
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

/**
 * Walk an error's cause chain looking for a retryable error code.
 * Returns the first retryable code found, or null if none.
 * Caps traversal depth to prevent infinite loops from circular cause chains.
 */
export function findRetryableCode(err: unknown, maxDepth: number = 5): string | null {
  let current: unknown = err;
  for (let i = 0; i < maxDepth && current != null; i++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_CODES.has(code)) {
      return code;
    }
    current = (current as Error).cause;
  }
  return null;
}

// ── Public types ────────────────────────────────────────────────────────

export interface McpProxyHandle {
  /** URL for --mcp-config (e.g. "http://127.0.0.1:PORT/sse"). */
  url: string;
  /** Shut down the HTTP server and MCP transport. */
  close(): Promise<void>;
}

// ── stdin config reader ─────────────────────────────────────────────────

/**
 * Read the babysitter config from stdin.
 *
 * Reads stdin to completion, parses the JSON, and validates required fields.
 * The spawning process writes config and closes the write end.
 */
export async function readConfigFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<BabysitterConfig> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) {
    throw new Error('Empty config received on stdin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON config on stdin: ${raw.slice(0, 200)}`);
  }

  const config = parsed as BabysitterConfig;

  // Validate required fields
  const required: (keyof BabysitterConfig)[] = [
    'sessionId', 'guildToolUrl', 'dbPath', 'logDir', 'claudeArgs',
    'cwd', 'env', 'prompt', 'tools', 'startedAt', 'provider',
  ];
  for (const field of required) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`Missing required config field: ${field}`);
    }
  }

  return config;
}

// ── HTTP retry helper ───────────────────────────────────────────────────

/**
 * Call a guild HTTP API endpoint with exponential backoff retry.
 *
 * Retries on connection errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT).
 * Returns the parsed JSON response on success.
 * Throws after RETRY_TIMEOUT_MS of retrying.
 */
/**
 * Encode a params object as a query string for GET requests.
 *
 * Scalars (string/number/boolean) become their string form. Arrays and
 * objects are JSON-encoded so the tool-server can still parse them after
 * its param coercion pass (though read-tools generally take scalar
 * inputs). null/undefined values are skipped.
 */
function encodeParamsAsQuery(params: unknown): string {
  if (params == null || typeof params !== 'object') return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      usp.set(key, value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      usp.set(key, String(value));
    } else {
      usp.set(key, JSON.stringify(value));
    }
  }
  const s = usp.toString();
  return s.length > 0 ? `?${s}` : '';
}

export async function callGuildHttpApi(
  url: string,
  sessionId: string,
  body: unknown,
  timeoutMs: number = RETRY_TIMEOUT_MS,
  method: 'GET' | 'POST' | 'DELETE' = 'POST',
): Promise<unknown> {
  const startTime = Date.now();
  let delay = RETRY_INITIAL_DELAY_MS;
  let lastError: Error | undefined;

  // GET can't carry a body — encode params as query string instead.
  const targetUrl = method === 'GET' ? `${url}${encodeParamsAsQuery(body)}` : url;
  const requestBody = method === 'GET' ? undefined : JSON.stringify(body);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(targetUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId,
        },
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      return await response.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if the error is retryable (connection-level error in the cause chain)
      const isRetryable = findRetryableCode(err) !== null;

      if (!isRetryable) {
        throw lastError;
      }

      // Wait before retrying
      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
    }
  }

  throw new Error(
    `Guild HTTP API unreachable after ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`,
  );
}

// ── DLQ writer ──────────────────────────────────────────────────────────

/**
 * Write a payload to the Dead Letter Queue.
 *
 * Creates the DLQ directory if it doesn't exist. Writes the payload as
 * pretty-printed JSON. Used as a fallback when the guild HTTP API is
 * unreachable for lifecycle calls.
 */
export function writeToDlq(cwd: string, filename: string, payload: unknown): void {
  const dlqDir = path.join(cwd, '.nexus', 'dlq');
  fs.mkdirSync(dlqDir, { recursive: true });
  fs.writeFileSync(
    path.join(dlqDir, filename),
    JSON.stringify(payload, null, 2),
  );
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

// ── SQLite transcript writer ────────────────────────────────────────────

/** Minimal interface for the SQLite database used by the babysitter. */
export interface TranscriptDb {
  /** Write a transcript entry (id, content JSON). */
  writeTranscript(sessionId: string, content: string): void;
  /** Close the database connection. */
  close(): void;
}

/**
 * Open the guild's SQLite database for transcript streaming.
 *
 * Creates the database file and table if they don't exist.
 * Enables WAL mode for concurrent read access by other processes
 * (Oculus, CLI queries, other agents).
 *
 * Uses dynamic import() to load better-sqlite3 at runtime. This avoids
 * requiring the native module at import time (beneficial for type-checking
 * and testing).
 */
export async function openTranscriptDb(dbPath: string): Promise<TranscriptDb> {
  const { default: Database } = await import('better-sqlite3');
  return initTranscriptDb(Database, dbPath);
}

/**
 * Initialize a TranscriptDb from a Database constructor.
 *
 * Shared logic between openTranscriptDb() and test injection.
 * Exported for testing — allows injecting a mock Database constructor.
 */
export function initTranscriptDb(
  DatabaseConstructor: new (path: string) => {
    pragma(stmt: string): unknown;
    prepare(sql: string): { run(...params: unknown[]): void };
    exec(sql: string): void;
    close(): void;
  },
  dbPath: string,
): TranscriptDb {
  const raw = new DatabaseConstructor(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS books_animator_transcripts (
      id      TEXT PRIMARY KEY,
      content TEXT NOT NULL
    )
  `);
  const stmt = raw.prepare(
    'INSERT OR REPLACE INTO books_animator_transcripts (id, content) VALUES (?, ?)',
  );

  return {
    writeTranscript(sessionId: string, content: string) {
      stmt.run(sessionId, content);
    },
    close() {
      raw.close();
    },
  };
}

/**
 * Write the current transcript to SQLite.
 */
export function writeTranscript(
  db: TranscriptDb,
  sessionId: string,
  messages: Record<string, unknown>[],
): void {
  const content = JSON.stringify({ id: sessionId, messages });
  db.writeTranscript(sessionId, content);
}

// ── Session lifecycle reporting ─────────────────────────────────────────

/**
 * Report "running" status to the guild via the session-running tool.
 *
 * If the guild is unreachable, writes the payload to the DLQ.
 */
export async function reportRunning(
  config: BabysitterConfig,
  cancelHandle: Record<string, unknown>,
  timeoutMs?: number,
): Promise<void> {
  const route = toolNameToRoute('session-running');
  const url = `${config.guildToolUrl}${route}`;
  const payload = {
    sessionId: config.sessionId,
    startedAt: config.startedAt,
    provider: config.provider,
    metadata: config.metadata,
    cancelHandle,
  };

  try {
    await callGuildHttpApi(url, config.sessionId, payload, timeoutMs);
  } catch {
    writeToDlq(config.cwd, `${config.sessionId}-running.json`, payload);
  }
}

/**
 * Resolve the terminal status and error text for a terminated session.
 *
 * Cascade order:
 *   1. A `'cancelled'` override (SIGTERM path) — short-circuits.
 *   2. A `terminationTag` already carried on the StreamJsonResult —
 *      set by the NDJSON detection cascade inside
 *      `parseStreamJsonMessage` (the only active detector).
 *   3. Generic exit-code mapping (0 → completed, non-zero → failed).
 *
 * Generic non-zero exit codes surface as `'failed'`; the Animator's
 * back-off machine only reacts to structured rate-limit terminals, and
 * exit-code-based detection was retired because it produced
 * false-positive pauses.
 *
 * Returns the payload status, a human-readable error string (only
 * populated for the failed branches), and the tag that informed the
 * decision (if any). The tag is forwarded to the guild so the Animator's
 * back-off machine can disambiguate rate-limit terminations without
 * pattern-matching on error text.
 */
export function resolveTerminalStatus(
  result: StreamJsonResult,
  statusOverride?: 'cancelled',
): { status: 'completed' | 'failed' | 'cancelled' | 'rate-limited'; error?: string; terminationTag?: SessionTerminationTag } {
  if (statusOverride === 'cancelled') {
    return { status: 'cancelled' };
  }

  // Second priority: a structural NDJSON tag observed during stream
  // parsing. Fire even on exit code 0 because claude may emit the
  // rate-limit signal and still exit cleanly.
  if (result.terminationTag) {
    return {
      status: 'rate-limited',
      error: result.terminationTag.detail ?? `Anima provider reported a rate limit (source: ${result.terminationTag.source})`,
      terminationTag: result.terminationTag,
    };
  }

  if (result.exitCode === 0) {
    return { status: 'completed' };
  }

  return {
    status: 'failed',
    error: `claude exited with code ${result.exitCode}`,
  };
}

/** Maximum number of characters to retain for the diagnostic stderr tail. */
export const STDERR_DIAGNOSTIC_TAIL_LIMIT = 200;

/**
 * Report the final session result to the guild via the session-record tool.
 *
 * When the resolved terminal status is exactly `'failed'` (non-zero exit,
 * no structured termination tag, no cancel override), attach a passive
 * `terminationDiagnostic: { exitCode, stderrExcerpt? }` to the payload.
 * The diagnostic is informational only — the Animator's back-off
 * machine never consumes it. The stderr excerpt is only present when
 * the caller supplied a non-empty tail.
 *
 * If the guild is unreachable, writes the payload to the DLQ.
 */
export async function reportResult(
  config: BabysitterConfig,
  result: StreamJsonResult,
  transcript: Record<string, unknown>[],
  timeoutMs?: number,
  statusOverride?: 'cancelled',
  stderrTail?: string,
): Promise<void> {
  const route = toolNameToRoute('session-record');
  const url = `${config.guildToolUrl}${route}`;
  const resolved = resolveTerminalStatus(result, statusOverride);
  const output = extractFinalAssistantText(transcript);

  // Only attach the passive diagnostic on a clean `'failed'` bucket —
  // timeout / cancelled / rate-limited are already well-classified.
  const terminationDiagnostic =
    resolved.status === 'failed'
      ? {
          exitCode: result.exitCode,
          ...(stderrTail && stderrTail.length > 0 ? { stderrExcerpt: stderrTail } : {}),
        }
      : undefined;

  const payload = {
    sessionId: config.sessionId,
    status: resolved.status,
    exitCode: result.exitCode,
    signal: result.signal,
    error: resolved.error,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
    output,
    providerSessionId: result.providerSessionId,
    transcript,
    ...(resolved.terminationTag ? { terminationTag: resolved.terminationTag } : {}),
    ...(terminationDiagnostic ? { terminationDiagnostic } : {}),
  };

  try {
    await callGuildHttpApi(url, config.sessionId, payload, timeoutMs);
  } catch {
    writeToDlq(config.cwd, `${config.sessionId}.json`, payload);
  }
}

// ── Stderr redirect ────────────────────────────────────────────────────

/**
 * Open a per-session log file and redirect process.stderr.write to it.
 *
 * Creates the logDir (recursive) and opens `<logDir>/<sessionId>.log`
 * for append-writing. Replaces process.stderr.write with a function
 * that calls fs.writeSync on the owned fd. Writes the startup banner
 * as the first line.
 *
 * Returns the owned fd so the caller can close it in a finally block.
 *
 * @internal Exported for testing only.
 */
export function redirectStderrToFile(logDir: string, sessionId: string): number {
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, `${sessionId}.log`);
  const fd = fs.openSync(logFilePath, 'a');

  // Replace process.stderr.write with a function that writes to our fd.
  process.stderr.write = function (
    chunk: string | Buffer | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ): boolean {
    const encoding: BufferEncoding =
      typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;

    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : chunk;
    fs.writeSync(fd, buffer);

    if (cb) cb();
    return true;
  } as typeof process.stderr.write;

  // Write the startup banner (now goes to the log file).
  const pgid = process.getgid?.() ?? process.pid;
  process.stderr.write(
    `[babysitter] session=${sessionId} pid=${process.pid} pgid=${pgid} log=${logFilePath} started at ${new Date().toISOString()}\n`,
  );

  return fd;
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

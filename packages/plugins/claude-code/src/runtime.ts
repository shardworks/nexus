/**
 * Babysitter runtime toolkit — single-purpose primitives shared by the
 * orchestrator and proxy in `babysitter.ts`.
 *
 * Each export is a small, self-contained piece: stdin parsing, retrying
 * HTTP, the DLQ writer, the SQLite trio, the lifecycle reporters, and
 * the stderr redirector. The orchestrator composes them; this module
 * does not know about the orchestrator.
 *
 * See: docs/architecture/detached-sessions.md
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { toolNameToRoute } from '@shardworks/tools-apparatus';

import { extractFinalAssistantText, type StreamJsonResult } from './index.ts';

import type { CancelHandle, SessionTerminationTag } from '@shardworks/animator-apparatus';

// ── Config types ────────────────────────────────────────────────────────

/**
 * Zod schema for a serialized tool definition received in the babysitter
 * config. The `method` field determines the HTTP verb the MCP proxy uses
 * when forwarding the call to the guild's Tool HTTP API (read tools are
 * GET-only on the tool server; POSTing to them 404s).
 */
const SerializedToolSchema = z.object({
  /** Tool name (e.g. 'writ-list'). */
  name: z.string(),
  /** Tool description. */
  description: z.string(),
  /** JSON Schema for the tool's input parameters. */
  params: z.record(z.string(), z.unknown()),
  /**
   * HTTP method the guild tool server routes this tool under. Derived
   * from the tool's `permission` by `permissionToMethod()` upstream.
   */
  method: z.union([z.literal('GET'), z.literal('POST'), z.literal('DELETE')]),
});

/** A serialized tool definition as received in the babysitter config. */
export type SerializedTool = z.infer<typeof SerializedToolSchema>;

/**
 * Zod schema for the config written to the babysitter's stdin by the
 * spawning process. This is the source of truth for the babysitter's
 * input contract: the {@link BabysitterConfig} type is derived from it
 * via `z.infer`, and `readConfigFromStdin` calls `.parse()` to validate.
 */
const BabysitterConfigSchema = z.object({
  sessionId: z.string(),
  guildToolUrl: z.string(),
  dbPath: z.string(),
  logDir: z.string(),
  claudeArgs: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  prompt: z.string(),
  tools: z.array(SerializedToolSchema),
  startedAt: z.string(),
  provider: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Temp directory for the system prompt file. Cleaned up in finally block. */
  systemPromptTmpDir: z.string().optional(),
});

/** Config written to the babysitter's stdin by the spawning process. */
export type BabysitterConfig = z.infer<typeof BabysitterConfigSchema>;

// ── Source-mode predicate ───────────────────────────────────────────────

/**
 * Is this URL or filesystem path a TypeScript source path (vs. a compiled `.js`)?
 *
 * Three sites in this package branch on "are we running from source or
 * from compiled output?":
 *
 *  1. `resolveBabysitterPath()` picks `babysitter.ts` vs. `babysitter.js`
 *     to match how `detached.ts` itself was loaded.
 *  2. `launchDetached()` decides whether to forward the parent's
 *     `execArgv` (carrying `--experimental-transform-types`) when
 *     spawning the babysitter — only needed for `.ts` source mode.
 *  3. The babysitter's own entry-point check uses it to decide which
 *     basename (`babysitter.ts` vs `babysitter.js`) the argv path is
 *     expected to share.
 *
 * The detection is purely on extension. Accepts a file URL
 * (`file:///.../foo.ts`) or a filesystem path interchangeably — both
 * end with `.ts` in source mode and `.js` in compiled mode.
 */
export function isSourcePath(urlOrPath: string): boolean {
  return urlOrPath.endsWith('.ts');
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

// ── stdin config reader ─────────────────────────────────────────────────

/**
 * Read the babysitter config from stdin.
 *
 * Reads stdin to completion, parses the JSON, and validates the result
 * against {@link BabysitterConfigSchema}. The spawning process writes
 * the config and closes the write end. Validation errors propagate as
 * `ZodError` with the field path and issue named in the default format.
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

  return BabysitterConfigSchema.parse(parsed);
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
  cancelHandle: CancelHandle,
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
 * Status override accepted by `resolveTerminalStatus` and `reportResult`.
 *
 *  - `'cancelled'` — SIGTERM path. Short-circuits to status `'cancelled'`.
 *  - `{ kind: 'orchestrator-error', error }` — an exception escaped the
 *    orchestrator before it could compute its own terminal status.
 *    Short-circuits to status `'failed'` carrying the supplied error
 *    string; the orchestrator funnels through this override instead of
 *    hand-rolling its own session-record + DLQ cascade. Whatever partial
 *    transcript / exit metadata the orchestrator already accumulated
 *    rides through on the `result` argument.
 */
type StatusOverride =
  | 'cancelled'
  | { kind: 'orchestrator-error'; error: string };

/**
 * Resolve the terminal status and error text for a terminated session.
 *
 * Cascade order:
 *   1. A `'cancelled'` override (SIGTERM path) — short-circuits.
 *   2. An `'orchestrator-error'` override — short-circuits to `'failed'`
 *      with the supplied error text (no exit-code cascade, no NDJSON
 *      tag — the orchestrator never reached the point where they could
 *      be trusted).
 *   3. A `terminationTag` already carried on the StreamJsonResult —
 *      set by the NDJSON detection cascade inside
 *      `parseStreamJsonMessage` (the only active detector).
 *   4. Generic exit-code mapping (0 → completed, non-zero → failed).
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
  statusOverride?: StatusOverride,
): { status: 'completed' | 'failed' | 'cancelled' | 'rate-limited'; error?: string; terminationTag?: SessionTerminationTag } {
  if (statusOverride === 'cancelled') {
    return { status: 'cancelled' };
  }

  if (typeof statusOverride === 'object' && statusOverride?.kind === 'orchestrator-error') {
    return { status: 'failed', error: statusOverride.error };
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

/**
 * Maximum number of characters to retain for the diagnostic stderr tail.
 *
 * 2KB comfortably accommodates a typical Node traceback (deep stack +
 * cause chain) with margin, without bloating the SessionDoc payload.
 */
export const STDERR_DIAGNOSTIC_TAIL_LIMIT = 2048;

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
  statusOverride?: StatusOverride,
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

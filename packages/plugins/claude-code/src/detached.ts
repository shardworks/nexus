/**
 * Detached session launch — spawns a babysitter process instead of claude directly.
 *
 * The babysitter runs as a detached process that survives guild restarts.
 * It hosts the MCP server, spawns claude, streams transcripts to SQLite,
 * and reports lifecycle events to the guild via HTTP.
 *
 * See: docs/architecture/detached-sessions.md
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { guild } from '@shardworks/nexus-core';
import type {
  CancelHandle,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
  SessionDoc,
} from '@shardworks/animator-apparatus';
import type { StacksApi, ReadOnlyBook, Book } from '@shardworks/stacks-apparatus';
import type { ResolvedTool } from '@shardworks/tools-apparatus';
import { permissionToMethod } from '@shardworks/tools-apparatus';

import {
  isSourcePath,
  type BabysitterConfig,
  type SerializedTool,
} from './runtime.ts';

// ── Constants ──────────────────────────────────────────────────────────

/** Default poll interval for session status (ms). */
const POLL_INTERVAL_MS = 5_000;
/** Default poll timeout — generous to allow long-running sessions (24h). */
const POLL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
/** Default tool server port (matches Instrumentarium default). */
const DEFAULT_TOOL_SERVER_PORT = 7471;

/** Infrastructure tools added to every detached session's authorized set. */
const INFRASTRUCTURE_TOOLS: readonly string[] = [
  'session-running',
  'session-record',
  'session-heartbeat',
];

/**
 * Compute the tool manifest for a detached session.
 *
 * Filters the resolved tools by callableBy (only tools callable by 'anima'
 * or unrestricted tools pass), then builds the authorized tool names list
 * by appending infrastructure tool names.
 *
 * Returns:
 * - tools: the filtered ResolvedTool[] (for serialization into BabysitterConfig)
 * - authorizedToolNames: filtered tool names + infrastructure tool names (for SessionDoc)
 */
export function computeToolManifest(
  tools: ResolvedTool[] | undefined,
): { tools: ResolvedTool[]; authorizedToolNames: string[] } {
  const input = tools ?? [];
  const filtered = input.filter(
    (rt) => !rt.definition.callableBy || rt.definition.callableBy.includes('anima'),
  );
  const authorizedToolNames = [
    ...filtered.map((rt) => rt.definition.name),
    ...INFRASTRUCTURE_TOOLS,
  ];
  return { tools: filtered, authorizedToolNames };
}

// ── Tool serialization ─────────────────────────────────────────────────

/**
 * Serialize a ResolvedTool's Zod params to a SerializedTool with JSON Schema.
 *
 * Uses Zod 4's built-in `z.toJSONSchema()` to convert the params schema.
 * The resulting JSON Schema is what the babysitter's MCP proxy server
 * advertises to claude via tools/list.
 */
export function serializeTool(rt: ResolvedTool): SerializedTool {
  const def = rt.definition;
  const jsonSchema = z.toJSONSchema(def.params) as Record<string, unknown>;

  // z.toJSONSchema returns a full JSON Schema object with type, properties, etc.
  // We extract the inner properties/required for the MCP tool registration,
  // since the babysitter wraps it in { type: 'object', ...params }.
  const { type: _type, $schema: _schema, ...params } = jsonSchema;

  return {
    name: def.name,
    description: def.description,
    params,
    method: permissionToMethod(def.permission),
  };
}

/**
 * Serialize an array of ResolvedTools to SerializedTools.
 */
export function serializeTools(tools: ResolvedTool[]): SerializedTool[] {
  return tools.map(serializeTool);
}

// ── Guild config resolution ────────────────────────────────────────────

/** Resolve the guild's Tool HTTP API URL. */
function resolveGuildToolUrl(): string {
  const g = guild();
  // Match the Instrumentarium's port resolution logic:
  // guild.json["tools"]["serverPort"] → default 7471
  const toolsConfig = g.config<{ serverPort?: number }>('tools');
  const port = toolsConfig?.serverPort ?? DEFAULT_TOOL_SERVER_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Resolve the path to the guild's SQLite database. */
function resolveDbPath(): string {
  const g = guild();
  return path.join(g.home, '.nexus', 'nexus.db');
}

/** Resolve the path to the guild's session log directory. */
export function resolveLogDir(): string {
  const g = guild();
  return path.join(g.home, 'logs', 'sessions');
}

/**
 * Resolve the babysitter script path, picking the .ts source or .js compiled
 * output to match how this module itself was loaded.
 *
 * - In compiled output (`dist/detached.js`) → returns `dist/babysitter.js`.
 * - In source mode (`src/detached.ts` via --experimental-transform-types) →
 *   returns `src/babysitter.ts`.
 *
 * The detection is by extension of the current module's URL — see
 * {@link isSourcePath}. Without this, source-mode runs (e.g.
 * `nsg start --foreground` in dev) try to spawn a non-existent
 * `babysitter.js` and the babysitter dies with MODULE_NOT_FOUND before
 * it can call session-running.
 */
function resolveBabysitterPath(): string {
  const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  return path.join(dir, isSourcePath(import.meta.url) ? 'babysitter.ts' : 'babysitter.js');
}

// ── BabysitterConfig builder ───────────────────────────────────────────

interface DetachedLaunchOptions {
  /** Override babysitter script path (for testing). */
  babysitterPath?: string;
  /** Override guild tool URL (for testing). */
  guildToolUrl?: string;
  /** Override database path (for testing). */
  dbPath?: string;
  /** Override log directory (for testing). */
  logDir?: string;
  /** Override poll interval in ms (for testing). */
  pollIntervalMs?: number;
  /** Override poll timeout in ms (for testing). */
  pollTimeoutMs?: number;
  /** Override sessions book for polling (for testing). */
  sessionsBook?: ReadOnlyBook<SessionDoc>;
  /** Override writable sessions book for the pending pre-write (for testing). */
  writableSessionsBook?: Book<SessionDoc>;
  /** Override spawn function (for testing). */
  spawnFn?: typeof spawn;
  /** Session metadata from the AnimateRequest. */
  metadata?: Record<string, unknown>;
}

/**
 * Build a BabysitterConfig from the provider's SessionProviderConfig.
 *
 * Serializes tools from Zod schemas to JSON Schema, resolves guild
 * infrastructure paths, and constructs the base CLI args for claude.
 */
export function buildBabysitterConfig(
  config: SessionProviderConfig,
  opts?: DetachedLaunchOptions,
): BabysitterConfig {
  // Build claude CLI args (the babysitter adds --print, --output-format,
  // --verbose, --mcp-config).
  const claudeArgs: string[] = [
    '--setting-sources', 'user',
    '--dangerously-skip-permissions',
    '--model', config.model,
  ];

  // System prompt: write to a temp file and include --system-prompt-file in claudeArgs.
  // The temp directory is passed to the babysitter config for cleanup.
  let systemPromptTmpDir: string | undefined;
  if (config.systemPrompt) {
    systemPromptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-detached-'));
    const systemPromptPath = path.join(systemPromptTmpDir, 'system-prompt.md');
    fs.writeFileSync(systemPromptPath, config.systemPrompt);
    claudeArgs.push('--system-prompt-file', systemPromptPath);
  }

  // Resume support
  if (config.conversationId) {
    claudeArgs.push('--resume', config.conversationId);
  }

  return {
    sessionId: config.sessionId,
    guildToolUrl: opts?.guildToolUrl ?? resolveGuildToolUrl(),
    dbPath: opts?.dbPath ?? resolveDbPath(),
    logDir: opts?.logDir ?? resolveLogDir(),
    claudeArgs,
    cwd: config.cwd,
    env: config.environment ?? {},
    prompt: config.initialPrompt ?? '',
    tools: serializeTools(computeToolManifest(config.tools).tools),
    startedAt: new Date().toISOString(),
    provider: 'claude-code',
    metadata: opts?.metadata,
    ...(systemPromptTmpDir ? { systemPromptTmpDir } : {}),
  };
}

// ── Polling helpers ────────────────────────────────────────────────────

/**
 * Poll the sessions book until the session reaches a terminal status.
 *
 * Returns the SessionDoc when status is no longer 'running'.
 * Throws on timeout.
 */
export async function pollForTerminalStatus(
  sessionsBook: ReadOnlyBook<SessionDoc>,
  sessionId: string,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  pollTimeoutMs: number = POLL_TIMEOUT_MS,
): Promise<SessionDoc> {
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    const doc = await sessionsBook.get(sessionId);

    if (doc && doc.status !== 'running' && doc.status !== 'pending') {
      return doc;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  throw new Error(
    `Session ${sessionId} did not reach terminal status within ${pollTimeoutMs}ms`,
  );
}

/**
 * Poll the sessions book until cancelHandle is available.
 *
 * The babysitter reports the cancel handle via the session-running tool,
 * which writes cancelHandle to the SessionDoc. We poll for it.
 */
export async function pollForProcessInfo(
  sessionsBook: ReadOnlyBook<SessionDoc>,
  sessionId: string,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  pollTimeoutMs: number = 60_000,
): Promise<CancelHandle | null> {
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    const doc = await sessionsBook.get(sessionId);

    if (doc?.cancelHandle) {
      return doc.cancelHandle;
    }

    // If the session already terminated, return null (no process to cancel)
    if (doc && doc.status !== 'running' && doc.status !== 'pending') {
      return null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  // Timeout — return null rather than throwing. The babysitter PID is a
  // fallback anyway, and the session might still be starting up.
  return null;
}

// ── Detached launch ────────────────────────────────────────────────────

/**
 * Build a SessionProviderResult from a terminal SessionDoc.
 */
function docToProviderResult(doc: SessionDoc): SessionProviderResult {
  const status: SessionProviderResult['status'] =
    doc.status === 'running' || doc.status === 'pending'
      ? 'failed'
      : doc.status;
  return {
    status,
    exitCode: doc.exitCode ?? 1,
    error: doc.error,
    providerSessionId: doc.providerSessionId,
    tokenUsage: doc.tokenUsage,
    costUsd: doc.costUsd,
    output: doc.output,
    // Forward any structured termination tag the babysitter recorded on
    // the SessionDoc — load-bearing for the Animator's back-off machine.
    ...(doc.terminationTag ? { terminationTag: doc.terminationTag } : {}),
    // Note: transcript is not included here — it's in the transcripts book.
    // The babysitter writes it directly to SQLite.
  };
}

/**
 * Launch a detached babysitter process.
 *
 * Returns { chunks, result, processInfo } where:
 * - chunks: completes immediately (empty) — transcripts stream to SQLite
 * - result: polls sessions book for terminal status
 * - processInfo: polls SessionDoc for cancelHandle (contains PGID)
 */
export function launchDetached(
  config: SessionProviderConfig,
  opts?: DetachedLaunchOptions,
): {
  chunks: AsyncIterable<SessionChunk>;
  result: Promise<SessionProviderResult>;
  processInfo?: Promise<CancelHandle>;
} {
  const babysitterPath = opts?.babysitterPath ?? resolveBabysitterPath();
  const pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = opts?.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const spawnFn = opts?.spawnFn ?? spawn;

  // Resolve sessions book lazily to avoid import-time guild() calls
  const getSessionsBook = (): ReadOnlyBook<SessionDoc> => {
    if (opts?.sessionsBook) return opts.sessionsBook;
    const stacks = guild().apparatus<StacksApi>('stacks');
    return stacks.readBook<SessionDoc>('animator', 'sessions');
  };
  const getWritableSessionsBook = (): Book<SessionDoc> => {
    if (opts?.writableSessionsBook) return opts.writableSessionsBook;
    const stacks = guild().apparatus<StacksApi>('stacks');
    return stacks.book<SessionDoc>('animator', 'sessions');
  };

  // Build babysitter config
  const babysitterConfig = buildBabysitterConfig(config, opts);

  // Compute the full authorized tool set for this session: every anima-callable
  // tool the session was composed with, plus the infrastructure tools it needs
  // to report its own lifecycle back to the guild.
  const { authorizedToolNames: authorizedTools } = computeToolManifest(config.tools);

  // Shared initialization promise: pre-write the pending record, then
  // spawn the babysitter. Both `result` and `processInfo` await this
  // before proceeding — the pre-write MUST succeed before the babysitter
  // is spawned, because the tool API's authorization reads the session
  // record to decide whether a session host is allowed to make tool calls.
  //
  // See: docs/architecture/detached-sessions.md § Authorization
  const init = (async () => {
    // Pre-write the `pending` SessionDoc. This is the authorization anchor:
    // the record must exist before the babysitter's first tool call arrives.
    // Seeds `lastActivityAt` so the reconciler has a fair starting point
    // for the staleness calculation.
    const sessions = getWritableSessionsBook();
    await sessions.put({
      id: config.sessionId,
      status: 'pending',
      startedAt: new Date().toISOString(),
      provider: 'claude-code',
      authorizedTools,
      lastActivityAt: new Date().toISOString(),
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    });

    // Spawn the babysitter as a detached process.
    // stdio: ['pipe', 'ignore', 'ignore'] — config via stdin, no stdout, no stderr (babysitter logs to its own file)
    //
    // In source mode (.ts babysitter), forward the parent's execArgv so that
    // --experimental-transform-types (and friends) reach the child. Without
    // this, node would try to load a .ts file as plain CommonJS and crash.
    const nodeArgs = isSourcePath(babysitterPath)
      ? [...process.execArgv, babysitterPath]
      : [babysitterPath];
    const proc = spawnFn(process.execPath, nodeArgs, {
      cwd: config.cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env, ...config.environment },
    });

    // Write config to the babysitter's stdin, then close it.
    proc.stdin!.write(JSON.stringify(babysitterConfig));
    proc.stdin!.end();

    // Detach — guild doesn't wait for the babysitter.
    proc.unref();

    return proc;
  })();

  // Empty chunks — real-time output is via the transcripts book, not in-memory.
  const chunks: AsyncIterable<SessionChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: undefined as unknown as SessionChunk, done: true };
        },
      };
    },
  };

  // Result: await init (pre-write + spawn), then poll sessions book.
  const result = (async (): Promise<SessionProviderResult> => {
    try {
      await init;
    } catch (err) {
      return {
        status: 'failed',
        exitCode: 1,
        error: `Failed to initialize detached session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      const sessionsBook = getSessionsBook();
      const doc = await pollForTerminalStatus(
        sessionsBook,
        config.sessionId,
        pollIntervalMs,
        pollTimeoutMs,
      );
      return docToProviderResult(doc);
    } catch (err) {
      return {
        status: 'failed',
        exitCode: 1,
        error: `Detached session polling failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  })();

  // processInfo: await init, then poll for cancelHandle (contains PGID
  // from babysitter). Falls back to the babysitter's own PID as PGID.
  const processInfo = (async (): Promise<CancelHandle> => {
    const proc = await init;
    try {
      const sessionsBook = getSessionsBook();
      const info = await pollForProcessInfo(
        sessionsBook,
        config.sessionId,
        pollIntervalMs,
      );
      if (info) return info;
    } catch {
      // Fall through to babysitter PID
    }
    // Fallback: construct cancel handle from babysitter PID (which is its PGID
    // because it was spawned with detached: true → setsid()). `proc.pid`
    // is typed `number | undefined` because Node only populates it once
    // the spawn succeeds; by the time we get here, `init` has resolved
    // with the same proc, so the pid is always defined — but we still
    // guard so we don't synthesize a `pgid: undefined` handle.
    if (proc.pid === undefined) {
      throw new Error(
        `[claude-code] Cannot construct cancelHandle for ${config.sessionId}: babysitter has no pid`,
      );
    }
    return { kind: 'local-pgid', pgid: proc.pid };
  })();

  return { chunks, result, processInfo };
}

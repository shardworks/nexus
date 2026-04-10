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
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
  SessionDoc,
} from '@shardworks/animator-apparatus';
import type { StacksApi, ReadOnlyBook, Book } from '@shardworks/stacks-apparatus';
import type { ResolvedTool } from '@shardworks/tools-apparatus';

import type { BabysitterConfig, SerializedTool } from './babysitter.ts';

// ── Constants ──────────────────────────────────────────────────────────

/** Default poll interval for session status (ms). */
const POLL_INTERVAL_MS = 5_000;
/** Default poll timeout — generous to allow long-running sessions (24h). */
const POLL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
/** Default tool server port (matches Instrumentarium default). */
const DEFAULT_TOOL_SERVER_PORT = 7471;

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
export function resolveGuildToolUrl(): string {
  const g = guild();
  // Match the Instrumentarium's port resolution logic:
  // guild.json["tools"]["serverPort"] → default 7471
  const toolsConfig = g.config<{ serverPort?: number }>('tools');
  const port = toolsConfig?.serverPort ?? DEFAULT_TOOL_SERVER_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Resolve the path to the guild's SQLite database. */
export function resolveDbPath(): string {
  const g = guild();
  return path.join(g.home, '.nexus', 'nexus.db');
}

/**
 * Resolve the babysitter script path, picking the .ts source or .js compiled
 * output to match how this module itself was loaded.
 *
 * - In compiled output (`dist/detached.js`) → returns `dist/babysitter.js`.
 * - In source mode (`src/detached.ts` via --experimental-transform-types) →
 *   returns `src/babysitter.ts`.
 *
 * The detection is by extension of the current module's URL. Without this,
 * source-mode runs (e.g. `nsg start --foreground` in dev) try to spawn a
 * non-existent `babysitter.js` and the babysitter dies with MODULE_NOT_FOUND
 * before it can call session-running.
 */
export function resolveBabysitterPath(): string {
  const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  const isSource = import.meta.url.endsWith('.ts');
  return path.join(dir, isSource ? 'babysitter.ts' : 'babysitter.js');
}

// ── BabysitterConfig builder ───────────────────────────────────────────

export interface DetachedLaunchOptions {
  /** Override babysitter script path (for testing). */
  babysitterPath?: string;
  /** Override guild tool URL (for testing). */
  guildToolUrl?: string;
  /** Override database path (for testing). */
  dbPath?: string;
  /** Override poll interval in ms (for testing). */
  pollIntervalMs?: number;
  /** Override poll timeout in ms (for testing). */
  pollTimeoutMs?: number;
  /** Override sessions book (for testing). */
  sessionsBook?: ReadOnlyBook<SessionDoc>;
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
  // Build claude CLI args (same as the attached prepareSession() but without
  // --print, --output-format, --verbose, --mcp-config — the babysitter adds those).
  const claudeArgs: string[] = [
    '--setting-sources', 'user',
    '--dangerously-skip-permissions',
    '--model', config.model,
  ];

  // System prompt: write to a temp file and include --system-prompt-file in claudeArgs.
  // The file persists for the session duration — acceptable for detached sessions.
  // The babysitter's tmpDir cleanup doesn't touch this, but OS tmp cleanup handles it.
  if (config.systemPrompt) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-detached-'));
    const systemPromptPath = path.join(tmpDir, 'system-prompt.md');
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
    claudeArgs,
    cwd: config.cwd,
    env: config.environment ?? {},
    prompt: config.initialPrompt ?? '',
    tools: serializeTools(config.tools ?? []),
    startedAt: new Date().toISOString(),
    provider: 'claude-code',
    metadata: opts?.metadata,
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
 * Poll the sessions book until cancelMetadata.pid is available.
 *
 * The babysitter reports the claude PID via the session-running tool,
 * which writes cancelMetadata to the SessionDoc. We poll for it.
 */
export async function pollForProcessInfo(
  sessionsBook: ReadOnlyBook<SessionDoc>,
  sessionId: string,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  pollTimeoutMs: number = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    const doc = await sessionsBook.get(sessionId);

    if (doc?.cancelMetadata) {
      return doc.cancelMetadata;
    }

    // If the session already terminated, return empty (no process to cancel)
    if (doc && doc.status !== 'running' && doc.status !== 'pending') {
      return {};
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  // Timeout — return empty rather than throwing. The babysitter PID is a
  // fallback anyway, and the session might still be starting up.
  return {};
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
    // Note: transcript is not included here — it's in the transcripts book.
    // The babysitter writes it directly to SQLite.
  };
}

/**
 * Launch a detached babysitter process.
 *
 * Returns the same { chunks, result, processInfo } shape as the attached
 * provider, but:
 * - chunks: completes immediately (empty) — transcripts stream to SQLite
 * - result: polls sessions book for terminal status
 * - processInfo: polls SessionDoc for cancelMetadata (contains claude PID)
 */
export function launchDetached(
  config: SessionProviderConfig,
  opts?: DetachedLaunchOptions,
): {
  chunks: AsyncIterable<SessionChunk>;
  result: Promise<SessionProviderResult>;
  processInfo?: Promise<Record<string, unknown>>;
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
    const stacks = guild().apparatus<StacksApi>('stacks');
    return stacks.book<SessionDoc>('animator', 'sessions');
  };

  // Build babysitter config
  const babysitterConfig = buildBabysitterConfig(config, opts);

  // Compute the full authorized tool set for this session: every tool the
  // session was composed with, plus the two infrastructure tools it needs
  // to report its own lifecycle back to the guild.
  const authorizedTools = [
    ...(config.tools?.map((rt) => rt.definition.name) ?? []),
    'session-running',
    'session-record',
  ];

  // Pre-write a `pending` SessionDoc BEFORE spawning the babysitter. This
  // is the source of truth for the tool server's authorize callback: by
  // the time the babysitter's first HTTP call lands, the sessions book
  // already records the session and the tools it's allowed to call.
  //
  // The babysitter's `session-running` call will merge this doc into a
  // `running` one, preserving authorizedTools.
  //
  // Fire-and-forget — spawn must not block on this. In the worst case
  // the babysitter will retry its first HTTP call for up to 60s, which
  // is plenty of time for the SQLite write to land.
  (async () => {
    try {
      const sessions = getWritableSessionsBook();
      await sessions.put({
        id: config.sessionId,
        status: 'pending',
        startedAt: new Date().toISOString(),
        provider: 'claude-code',
        authorizedTools,
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      });
    } catch (err) {
      console.warn(
        `[claude-code] Failed to pre-write pending session ${config.sessionId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  })();

  // Spawn the babysitter as a detached process.
  // stdio: ['pipe', 'ignore', 'inherit'] — config via stdin, no stdout, stderr to parent
  //
  // In source mode (.ts babysitter), forward the parent's execArgv so that
  // --experimental-transform-types (and friends) reach the child. Without
  // this, node would try to load a .ts file as plain CommonJS and crash.
  const isSource = babysitterPath.endsWith('.ts');
  const nodeArgs = isSource
    ? [...process.execArgv, babysitterPath]
    : [babysitterPath];
  const proc = spawnFn(process.execPath, nodeArgs, {
    cwd: config.cwd,
    stdio: ['pipe', 'ignore', 'inherit'],
    detached: true,
    env: { ...process.env, ...config.environment },
  });

  // Write config to the babysitter's stdin, then close it.
  proc.stdin!.write(JSON.stringify(babysitterConfig));
  proc.stdin!.end();

  // Detach — guild doesn't wait for the babysitter.
  proc.unref();

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

  // Result: poll sessions book for terminal status.
  const result = (async (): Promise<SessionProviderResult> => {
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

  // processInfo: poll for cancelMetadata (contains claude PID from babysitter).
  // Falls back to the babysitter's own PID.
  const processInfo = (async (): Promise<Record<string, unknown>> => {
    try {
      const sessionsBook = getSessionsBook();
      const info = await pollForProcessInfo(
        sessionsBook,
        config.sessionId,
        pollIntervalMs,
      );
      if (Object.keys(info).length > 0) return info;
    } catch {
      // Fall through to babysitter PID
    }
    // Fallback: return babysitter PID. Signals to the babysitter process group
    // leader (detached: true) can still reach claude via process group.
    return { pid: proc.pid };
  })();

  return { chunks, result, processInfo };
}

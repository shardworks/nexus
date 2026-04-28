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
 * `runtime.ts`. The MCP/SSE proxy lives in `mcp-proxy.ts`. This file owns
 * the orchestrator (`runBabysitter`) and the script entry point. The
 * previously-exported primitives are re-exported below to preserve the
 * package's public surface.
 *
 * See: docs/architecture/detached-sessions.md
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolNameToRoute } from '@shardworks/tools-apparatus';

import {
  processNdjsonBuffer,
  parseStreamJsonMessage,
  type StreamJsonResult,
} from './index.ts';

import type { CancelHandle, SessionTerminationTag } from '@shardworks/animator-apparatus';

import {
  isSourcePath,
  openTranscriptDb,
  readConfigFromStdin,
  redirectStderrToFile,
  reportRunning,
  reportResult,
  STDERR_DIAGNOSTIC_TAIL_LIMIT,
  writeTranscript,
  callGuildHttpApi,
  type BabysitterConfig,
  type TranscriptDb,
} from './runtime.ts';

import {
  createProxyMcpHttpServer,
  type McpProxyHandle,
} from './mcp-proxy.ts';

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

export { createProxyMcpHttpServer, type McpProxyHandle } from './mcp-proxy.ts';

// ── Main babysitter function ────────────────────────────────────────────

/** Accumulator mutated in-place by `parseStreamJsonMessage`. */
interface BabysitterAccumulator {
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
}

/**
 * Shared mutable state threaded through the three orchestrator phases.
 *
 * The init phase populates the resource handles (`db`, `mcpHandle`,
 * `tmpDir`, `claudeProc`); the steady-state phase fires the lifecycle
 * reports, installs the SIGTERM handler / heartbeat, and consumes stdout
 * into `acc`; the terminal phase reads the populated context to report
 * the result. The orchestrator's finally block closes/removes whatever
 * handles the init phase managed to allocate.
 *
 * `acc` is mutated in place by `parseStreamJsonMessage` — the first-wins
 * `terminationTag` invariant relies on the accumulator being a single
 * object identity from open-of-stream through reportResult.
 */
interface BabysitterRuntimeContext {
  readonly config: BabysitterConfig;
  readonly spawnFn: typeof spawn;
  readonly retryTimeoutMs?: number;
  readonly injectedDb?: TranscriptDb;

  // Resources allocated during init (cleaned up in the finally block)
  db: TranscriptDb | null;
  mcpHandle: McpProxyHandle | null;
  tmpDir: string | null;
  claudeProc: ChildProcess | null;

  // Steady-state state
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  onSigterm: (() => void) | null;
  cancelledBySignal: boolean;
  runningPromise: Promise<void> | null;

  // Accumulator (mutated in place by the stdout listener)
  acc: BabysitterAccumulator;

  // Rolling stderr tail (last STDERR_DIAGNOSTIC_TAIL_LIMIT chars)
  stderrTail: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Init phase: open SQLite, start the MCP proxy, prepare session files,
 * spawn the claude child, attach the stderr forwarder. Populates the
 * resource handles on `ctx`. Throws if any step fails — the orchestrator's
 * finally block cleans up whatever was allocated.
 */
async function runInitPhase(ctx: BabysitterRuntimeContext): Promise<void> {
  const { config } = ctx;

  // 1. Open SQLite
  ctx.db = ctx.injectedDb ?? await openTranscriptDb(config.dbPath);

  // 2. Start MCP proxy server
  ctx.mcpHandle = await createProxyMcpHttpServer(
    config.tools,
    config.guildToolUrl,
    config.sessionId,
  );

  // 3. Prepare session files
  ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-babysitter-'));

  const args = [...config.claudeArgs];

  // Write mcp-config pointing to the babysitter's MCP proxy server
  const mcpConfig = {
    mcpServers: {
      'nexus-guild': {
        type: 'sse',
        url: ctx.mcpHandle.url,
      },
    },
  };
  const mcpConfigPath = path.join(ctx.tmpDir, 'mcp-config.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
  args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');

  // Add autonomous mode flags
  args.push(
    '--print', '-',
    '--output-format', 'stream-json',
    '--verbose',
  );

  // 4. Spawn claude
  const claudeProc = ctx.spawnFn('claude', args, {
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...config.env },
  });
  ctx.claudeProc = claudeProc;

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
  claudeProc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    const text = chunk.toString('utf8');
    ctx.stderrTail = (ctx.stderrTail + text).slice(-STDERR_DIAGNOSTIC_TAIL_LIMIT);
  });
}

/**
 * Steady-state phase: fire the running report, install the SIGTERM
 * handler, start the heartbeat schedule, consume stdout into the
 * accumulator (with first-wins terminationTag), and await claude's
 * exit. Returns the exit code and signal the terminal phase will report.
 */
async function runSteadyStatePhase(
  ctx: BabysitterRuntimeContext,
): Promise<{ exitCode: number; exitSignal: string | undefined }> {
  const { config, claudeProc, db } = ctx;
  if (!claudeProc) {
    throw new Error('runSteadyStatePhase: claudeProc not initialized');
  }

  // 5. Report "running" status (don't await — fire and forget with retry)
  const cancelHandle: CancelHandle = { kind: 'local-pgid', pgid: process.pid };
  const runningPromise = reportRunning(config, cancelHandle, ctx.retryTimeoutMs).catch((err) => {
    process.stderr.write(`[babysitter] Failed to report running: ${err}\n`);
  });
  ctx.runningPromise = runningPromise;

  // 5b. Heartbeat timer — sends liveness signal every 30s after ready report.
  function scheduleHeartbeat() {
    ctx.heartbeatTimer = setTimeout(async () => {
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
  const onSigterm = () => {
    ctx.cancelledBySignal = true;
    // Stop heartbeat timer
    if (ctx.heartbeatTimer) {
      clearTimeout(ctx.heartbeatTimer);
      ctx.heartbeatTimer = null;
    }
    // Propagate SIGTERM to the claude process
    if (ctx.claudeProc && ctx.claudeProc.pid && !ctx.claudeProc.killed) {
      try {
        ctx.claudeProc.kill('SIGTERM');
      } catch { /* already dead */ }
    }
    // The normal claude exit path will run, check cancelledBySignal,
    // and report status 'cancelled' instead of computing from exit code.
  };
  ctx.onSigterm = onSigterm;
  process.on('SIGTERM', onSigterm);

  // 6. Consume stdout, stream transcript. The accumulator is mutated in
  // place by parseStreamJsonMessage; the first-wins terminationTag
  // invariant relies on a single accumulator identity for the whole
  // stream.
  let buffer = '';
  claudeProc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const prevLength = ctx.acc.transcript.length;
    buffer = processNdjsonBuffer(buffer, (msg) => {
      parseStreamJsonMessage(msg, ctx.acc);
    });

    // Write transcript to SQLite if new messages were added
    if (ctx.acc.transcript.length > prevLength && db) {
      writeTranscript(db, config.sessionId, ctx.acc.transcript);
    }
  });

  // 7. Wait for claude to exit
  return await new Promise<{ exitCode: number; exitSignal: string | undefined }>((resolve, reject) => {
    claudeProc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
    claudeProc.on('close', (code, signal) => {
      resolve({ exitCode: code ?? 1, exitSignal: signal ?? undefined });
    });
  });
}

/**
 * Terminal phase: stop the heartbeat, remove the SIGTERM handler, await
 * the running report, build the final StreamJsonResult, and submit it
 * via `reportResult` (which handles both the normal and cancelled-by-
 * signal paths via the StatusOverride contract).
 */
async function runTerminalPhase(
  ctx: BabysitterRuntimeContext,
  exit: { exitCode: number; exitSignal: string | undefined },
): Promise<void> {
  // Stop heartbeat before terminal report
  if (ctx.heartbeatTimer) {
    clearTimeout(ctx.heartbeatTimer);
    ctx.heartbeatTimer = null;
  }

  // Clean up SIGTERM handler (happy path; the finally block in
  // runBabysitter is a defensive no-op when the handler was already
  // removed here).
  if (ctx.onSigterm) {
    process.removeListener('SIGTERM', ctx.onSigterm);
    ctx.onSigterm = null;
  }

  // Ensure running report completed before recording result
  if (ctx.runningPromise) {
    await ctx.runningPromise;
  }

  // Build result
  const result: StreamJsonResult = {
    exitCode: exit.exitCode,
    transcript: ctx.acc.transcript,
    costUsd: ctx.acc.costUsd,
    tokenUsage: ctx.acc.tokenUsage,
    providerSessionId: ctx.acc.providerSessionId,
    signal: exit.exitSignal,
    ...(ctx.acc.terminationTag ? { terminationTag: ctx.acc.terminationTag } : {}),
  };

  // 8. Report result
  await reportResult(
    ctx.config,
    result,
    ctx.acc.transcript,
    ctx.retryTimeoutMs,
    ctx.cancelledBySignal ? 'cancelled' : undefined,
    ctx.stderrTail,
  );
}

/**
 * Run the session babysitter.
 *
 * Three-phase orchestrator threading a {@link BabysitterRuntimeContext}:
 * `runInitPhase` allocates resources, `runSteadyStatePhase` reports
 * lifecycle events and consumes claude's NDJSON stream, `runTerminalPhase`
 * builds and submits the final result. The shared try/catch/finally
 * funnels all error and cleanup handling.
 *
 * The orchestrator-error path goes through `reportResult` via the
 * `StatusOverride` contract (no hand-rolled session-record + DLQ
 * cascade) — `reportResult` is the single sink for both the normal
 * `'failed'` path and the orchestrator-caught error path.
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
  const ctx: BabysitterRuntimeContext = {
    config,
    spawnFn: deps?.spawnFn ?? spawn,
    retryTimeoutMs: deps?.retryTimeoutMs,
    injectedDb: deps?.db,

    db: null,
    mcpHandle: null,
    tmpDir: null,
    claudeProc: null,

    heartbeatTimer: null,
    onSigterm: null,
    cancelledBySignal: false,
    runningPromise: null,

    acc: { transcript: [] },
    stderrTail: '',
  };

  try {
    await runInitPhase(ctx);
    const exit = await runSteadyStatePhase(ctx);
    await runTerminalPhase(ctx, exit);
  } catch (err) {
    // Funnel the orchestrator-caught error through reportResult via the
    // StatusOverride contract. reportResult writes to the DLQ when the
    // guild HTTP API is unreachable, so this single call covers both
    // the happy and degraded paths the legacy hand-rolled cascade
    // covered.
    const message = err instanceof Error ? err.message : String(err);
    const partial: StreamJsonResult = {
      exitCode: 1,
      transcript: ctx.acc.transcript,
      costUsd: ctx.acc.costUsd,
      tokenUsage: ctx.acc.tokenUsage,
      providerSessionId: ctx.acc.providerSessionId,
    };
    try {
      await reportResult(
        ctx.config,
        partial,
        ctx.acc.transcript,
        ctx.retryTimeoutMs,
        { kind: 'orchestrator-error', error: message },
        ctx.stderrTail,
      );
    } catch {
      // reportResult itself failed catastrophically — already DLQ'd
      // internally on HTTP failure; swallow so we still rethrow the
      // original error.
    }
    throw err;
  } finally {
    // 9. Cleanup
    // Targeted SIGTERM-listener removal: the happy path already removes
    // ctx.onSigterm in runTerminalPhase, so this is a defensive no-op
    // when steady-state completed; on a partial-init path where steady-
    // state never installed the listener, ctx.onSigterm is null and the
    // call is skipped. Avoids removeAllListeners which would sweep
    // unrelated listeners installed by hosts of this module.
    if (ctx.onSigterm) {
      process.removeListener('SIGTERM', ctx.onSigterm);
      ctx.onSigterm = null;
    }
    await ctx.mcpHandle?.close().catch(() => {});
    ctx.db?.close();
    if (ctx.tmpDir) {
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
    if (ctx.config.systemPromptTmpDir) {
      fs.rmSync(ctx.config.systemPromptTmpDir, { recursive: true, force: true });
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

// Check if this module is the entry point. The argv-vs-import.meta.url
// equality is the primary check; the basename comparison is a fallback for
// path-resolution differences (symlinks, realpath). The `isSourcePath`
// predicate selects the basename to expect — `babysitter.ts` in source
// mode, `babysitter.js` in compiled output — keeping the extension test in
// step with the other two source-mode branches in this package.
const argv1 = process.argv[1];
const expectedBasename = isSourcePath(import.meta.url) ? 'babysitter.ts' : 'babysitter.js';
const isEntryPoint = argv1 !== undefined &&
  (argv1 === fileURLToPath(import.meta.url) ||
   path.basename(argv1) === expectedBasename);

if (isEntryPoint) {
  main();
}

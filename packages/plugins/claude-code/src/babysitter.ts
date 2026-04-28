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

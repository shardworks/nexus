/**
 * Clockworks daemon — `clockStart`, `clockStop`, `clockStatus`, and the
 * inline foreground daemon entry.
 *
 * Two surfaces:
 *
 * - **Detached lifecycle (`clockStart`/`clockStop`/`clockStatus`)** —
 *   spawn-and-go helpers used by `nsg clock start/stop/status`. They
 *   read and write `<home>/.nexus/clock.pid`, manage `<home>/.nexus/clock.log`,
 *   and treat the daemon as opaque from the outside.
 *
 * - **Foreground daemon body (`runForegroundDaemon`)** — the inline
 *   poll loop. Writes the pidfile with its own pid, registers
 *   SIGTERM/SIGINT handlers that flip a shutdown deferred, calls
 *   `processEvents` every interval, writes timestamped per-dispatch
 *   log lines, and shuts down cleanly. The detached `clockStart`
 *   re-execs the same `nsg` binary with `clock start --foreground …`,
 *   which lands in this function.
 *
 * The two surfaces are exported separately so unit tests can drive the
 * inline daemon without spawning a child process.
 *
 * Mirrors the pattern from `nsg start` (foreground vs. detached two
 * modes selected by a flag) but spawns a separate pidfile/logfile pair
 * so the guild daemon and the clockworks daemon coexist without
 * interfering with each other.
 *
 * See: docs/architecture/clockworks.md (Phase 2),
 * docs/reference/core-api.md (Clockworks).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  clockLogPath,
  clockPidPath,
  guild,
  isProcessAlive,
  readPidFile,
  tryUnlink,
  waitForExit,
} from '@shardworks/nexus-core';

import type { ClockworksApi, DispatchObservation } from './types.ts';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Options accepted by `clockStart`. All fields are optional — the
 * default polling interval is 2000ms (matches Phase 2 of the
 * architecture doc).
 */
export interface ClockStartOptions {
  /** Polling interval in milliseconds (default 2000). */
  interval?: number;
}

/** Result of a successful `clockStart` invocation. */
export interface ClockStartResult {
  /** Process id of the running daemon. */
  pid: number;
  /** Absolute path to `clock.log`. */
  logFile: string;
}

/** Result of a `clockStop` invocation. */
export interface ClockStopResult {
  /**
   * Process id of the daemon that was stopped, or `null` when there
   * was nothing to stop (no pidfile, or the pidfile was stale). The
   * `reason` field discriminates which branch produced the result.
   */
  pid: number | null;
  /**
   * `true` whenever the call resolves without an error — for the
   * `'signaled'` branch the daemon is confirmed dead, and for the
   * `'no-pidfile'` / `'stale'` branches there was nothing alive to
   * stop in the first place.
   */
  stopped: true;
  /**
   * Discriminator describing which branch produced this result.
   *
   *  - `'signaled'` — a live daemon was signaled (SIGTERM, with
   *    SIGKILL escalation if needed) and is now dead.
   *  - `'no-pidfile'` — there was no pidfile at all; nothing to stop.
   *  - `'stale'` — the pidfile pointed at a dead pid; the stale file
   *    was removed and there was nothing else to do.
   */
  reason: 'signaled' | 'no-pidfile' | 'stale';
  /** Human-readable description for the operator. */
  message: string;
}

/** Result of `clockStatus`. */
export interface ClockStatus {
  /** True when a live daemon process is recorded by the pidfile. */
  running: boolean;
  /** Pid of the live daemon (omitted when `running: false`). */
  pid?: number;
  /** Absolute path to `clock.log` (only set when `running: true`). */
  logFile?: string;
  /** Wall-clock ms since the pidfile was created (only set when `running: true`). */
  uptime?: number;
  /**
   * True iff a pidfile existed at probe time but pointed at a dead pid.
   * The function unlinks the file as a side effect; subsequent calls
   * report `stalePidfile: undefined` (omitted entirely).
   */
  stalePidfile?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

/** Default polling interval — 2 seconds. Matches the architecture doc. */
const DEFAULT_INTERVAL_MS = 2000;

/** Deadline for `clockStart` to confirm the daemon is alive before failing. */
const START_DEADLINE_MS = 10_000;

/** SIGTERM grace window before `clockStop` escalates to SIGKILL. */
const STOP_TERM_TIMEOUT_MS = 5_000;

/** Window after SIGKILL during which the daemon must actually disappear. */
const STOP_KILL_TIMEOUT_MS = 2_000;

// ── Public API: clockStatus ──────────────────────────────────────────

/**
 * Read the clockworks daemon status for `home`.
 *
 * Returns `{ running: false }` when there's no pidfile or the pidfile
 * is malformed. When the pidfile points at a dead pid, returns
 * `{ running: false, stalePidfile: true }` and unlinks the pidfile as
 * a side effect — a subsequent call from a fresh process is silent.
 *
 * Uptime is computed from the pidfile's birthtime (`fs.statSync(...).birthtimeMs`)
 * — wall-clock since the pidfile was created.
 */
export function clockStatus(home: string): ClockStatus {
  const pidFile = clockPidPath(home);
  const pid = readPidFile(pidFile);

  if (pid === null) {
    return { running: false };
  }

  if (!isProcessAlive(pid)) {
    // Stale pidfile — clean it up and surface staleness in the return shape.
    tryUnlink(pidFile);
    return { running: false, stalePidfile: true };
  }

  // The pidfile birthtime is our anchor for uptime. statSync may fail
  // (e.g. the file vanished between readPidFile and statSync) — degrade
  // gracefully and report uptime: 0.
  let uptime = 0;
  try {
    const stat = fs.statSync(pidFile);
    uptime = Math.max(0, Date.now() - stat.birthtimeMs);
  } catch {
    // Race condition: pidfile vanished between readPidFile and statSync.
    // Report a 0 uptime rather than throwing.
    uptime = 0;
  }

  return {
    running: true,
    pid,
    logFile: clockLogPath(home),
    uptime,
  };
}

// ── Public API: clockStart ───────────────────────────────────────────

/**
 * Spawn the clockworks daemon as a detached background process.
 *
 * Throws if a daemon is already running (the pidfile points at a live
 * pid). Cleans up a stale pidfile (the pidfile points at a dead pid)
 * and continues. Spawns by re-execing the same `nsg` binary with
 * `clock start --foreground --guild-root <home>` plus `--interval
 * <ms>` if supplied. Both stdout and stderr are piped to a single
 * `clock.log` (append mode). Calls `child.unref()` so the parent
 * terminal can close without taking the daemon down.
 *
 * Blocks polling for pidfile presence + named-pid liveness up to a
 * `START_DEADLINE_MS` deadline. On timeout, tails the log to help
 * debug and throws.
 */
export async function clockStart(
  home: string,
  options: ClockStartOptions = {},
): Promise<ClockStartResult> {
  const pidFile = clockPidPath(home);
  const logFile = clockLogPath(home);

  const intervalMs = validateInterval(options.interval);

  // Refuse if a daemon is already running. Per spec: "If a PID file
  // already exists and the named PID is alive, `start` refuses with a
  // message and exits nonzero." Stale pidfiles (named pid is dead) are
  // cleaned up and we continue with a fresh spawn.
  const existing = readPidFile(pidFile);
  if (existing !== null && isProcessAlive(existing)) {
    throw new Error(
      `Clockworks daemon is already running (pid: ${existing}).`,
    );
  }
  if (existing !== null && !isProcessAlive(existing)) {
    tryUnlink(pidFile);
  }

  const nexusDir = path.dirname(pidFile);
  fs.mkdirSync(nexusDir, { recursive: true });

  // Open the log file for append, then dup the same fd to both stdout
  // and stderr. The brief calls out a single log file; combining
  // stdout+stderr matches that prescription.
  const logFd = fs.openSync(logFile, 'a');

  const nodeArgs = process.execArgv.slice();
  const cliEntry = process.argv[1];

  const childArgs = [
    ...nodeArgs,
    cliEntry,
    'clock',
    'start',
    '--foreground',
    '--guild-root',
    home,
  ];
  if (options.interval !== undefined) {
    childArgs.push('--interval', String(intervalMs));
  }

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: home,
    env: process.env,
  });
  child.unref();

  // Block polling for pidfile + named-pid liveness.
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    const pid = readPidFile(pidFile);
    if (pid !== null && isProcessAlive(pid)) {
      return { pid, logFile };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Startup failed. Tail the log to help debugging.
  const tail = tailFile(logFile, 20);
  const msg = [
    `Clockworks daemon failed to start within ${START_DEADLINE_MS}ms.`,
    tail
      ? `\n--- last 20 lines of ${path.relative(home, logFile)} ---\n${tail}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  throw new Error(msg);
}

// ── Public API: clockStop ────────────────────────────────────────────

/**
 * Stop the running clockworks daemon.
 *
 * Reads the pidfile, sends SIGTERM, polls for exit, escalates to
 * SIGKILL after `STOP_TERM_TIMEOUT_MS`, and unlinks the pidfile once
 * the process is confirmed dead.
 *
 * Per spec, the missing-pidfile and stale-pidfile branches are
 * **non-error** outcomes: there is nothing to stop, so the function
 * returns successfully with a `reason` discriminator
 * (`'no-pidfile'` or `'stale'`) plus a human-readable message. The
 * stale-pidfile branch unlinks the dead-pid pidfile as a side effect.
 *
 * Throws only when the process refuses to exit even after SIGKILL or
 * when the SIGTERM call itself fails for an unexpected reason.
 */
export async function clockStop(home: string): Promise<ClockStopResult> {
  const pidFile = clockPidPath(home);
  const pid = readPidFile(pidFile);

  if (pid === null) {
    return {
      pid: null,
      stopped: true,
      reason: 'no-pidfile',
      message: 'Clockworks daemon is not running (no pidfile).',
    };
  }

  if (!isProcessAlive(pid)) {
    tryUnlink(pidFile);
    return {
      pid,
      stopped: true,
      reason: 'stale',
      message: `Clockworks daemon was not running (stale pidfile for pid ${pid} removed).`,
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new Error(
      `Failed to signal clockworks daemon (pid ${pid}): ${err instanceof Error ? err.message : err}`,
    );
  }

  const exited = await waitForExit(pid, STOP_TERM_TIMEOUT_MS);

  if (!exited) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
    const killed = await waitForExit(pid, STOP_KILL_TIMEOUT_MS);
    tryUnlink(pidFile);
    if (!killed) {
      throw new Error(
        `Clockworks daemon (pid ${pid}) did not exit even after SIGKILL.`,
      );
    }
    return {
      pid,
      stopped: true,
      reason: 'signaled',
      message: `Clockworks daemon stopped (pid: ${pid}).`,
    };
  }

  tryUnlink(pidFile);
  return {
    pid,
    stopped: true,
    reason: 'signaled',
    message: `Clockworks daemon stopped (pid: ${pid}).`,
  };
}

// ── Public API: runForegroundDaemon ──────────────────────────────────

/**
 * Inputs accepted by the inline foreground daemon entry. All
 * dependencies are passed in so unit tests can drive the loop without
 * spawning a child process.
 */
export interface ForegroundDaemonInputs {
  /** Guild root directory. The pidfile and log file are derived from this. */
  home: string;
  /** Polling interval in milliseconds. */
  intervalMs: number;
  /**
   * Function that runs one drain pass over the events queue. In
   * production this is `clockworks.processEvents`. Tests can pass an
   * in-memory fake.
   */
  processEvents: ClockworksApi['processEvents'];
  /**
   * Optional log writer. When omitted, the daemon writes to
   * `clockLogPath(home)` in append mode. Tests pass an in-memory writer
   * to assert log content without touching the filesystem.
   */
  log?: (line: string) => void;
  /**
   * Optional shutdown signal. When provided, resolving this promise
   * triggers the same shutdown path as receiving SIGTERM. Tests use
   * this to drive shutdown without raising real signals.
   */
  shutdown?: Promise<void>;
  /**
   * When true, do not register process-level SIGTERM/SIGINT handlers.
   * Useful for tests so a shared test process is not signaled by the
   * daemon's handlers.
   */
  skipSignalHandlers?: boolean;
  /**
   * Optional exit hook. Called once the shutdown banner is written
   * and the pidfile is removed. Defaults to a no-op so tests can
   * observe the lifecycle without the test process exiting.
   * Production callers that want the daemon to terminate the process
   * pass `() => process.exit(0)`.
   */
  onShutdown?: () => void;
}

/**
 * Run the inline foreground daemon loop until shutdown is triggered.
 *
 * Lifecycle:
 *
 *   1. Write the pidfile with the current process pid.
 *   2. Register SIGTERM/SIGINT handlers (unless `skipSignalHandlers`),
 *      each of which resolves the shutdown deferred.
 *   3. Write the startup banner.
 *   4. Loop: call `processEvents`. Per-dispatch lines are written via
 *      the timestamped formatter. Throws are caught, logged with
 *      `[error]`, and the loop continues. After each tick, sleep
 *      `intervalMs` — the sleep is abortable: when shutdown is
 *      triggered the sleep resolves immediately.
 *   5. On shutdown, write the shutdown banner, unlink the pidfile,
 *      and call `onShutdown` (default no-op).
 *
 * Idle ticks (no dispatches, no error) produce no log output. Banners
 * frame the daemon's lifetime; per-dispatch lines are the only
 * intra-lifetime output under nominal operation.
 */
export async function runForegroundDaemon(
  inputs: ForegroundDaemonInputs,
): Promise<void> {
  const {
    home,
    intervalMs,
    processEvents,
    log: logOverride,
    shutdown: shutdownPromise,
    skipSignalHandlers = false,
    onShutdown,
  } = inputs;

  const pidFile = clockPidPath(home);
  const logFile = clockLogPath(home);

  // Idempotency: refuse to double-start.
  const existing = readPidFile(pidFile);
  if (existing !== null && isProcessAlive(existing)) {
    throw new Error(
      `Clockworks daemon is already running (pid: ${existing}).`,
    );
  }
  if (existing !== null) tryUnlink(pidFile);

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf-8');

  // Default log writer: append to `clock.log`.
  const log = logOverride ?? ((line: string) => {
    fs.appendFileSync(logFile, `${line}\n`);
  });

  // ── Shutdown wiring ────────────────────────────────────────────────

  let shuttingDown = false;
  let resolveAbort!: () => void;
  const abortSleep = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  const triggerShutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[clockworks] ${signal} received — shutting down`);
    resolveAbort();
  };

  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  if (!skipSignalHandlers) {
    sigtermHandler = () => triggerShutdown('SIGTERM');
    sigintHandler = () => triggerShutdown('SIGINT');
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
  }

  if (shutdownPromise) {
    void shutdownPromise.then(() => triggerShutdown('shutdown'));
  }

  // ── Banners ────────────────────────────────────────────────────────

  log(
    `[clockworks] daemon started — pid=${process.pid} intervalMs=${intervalMs} log=${logFile}`,
  );

  // ── Poll loop ──────────────────────────────────────────────────────

  while (!shuttingDown) {
    try {
      await processEvents({
        onDispatch: (obs: DispatchObservation) => {
          log(formatDispatchLogLine(obs));
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`${new Date().toISOString()} [error] processEvents threw: ${reason}`);
    }

    if (shuttingDown) break;

    // Abortable sleep: resolves on either the timeout or the abort
    // promise, whichever fires first. SIGTERM responsiveness comes
    // from the `resolveAbort()` call inside `triggerShutdown`.
    await Promise.race([
      new Promise<void>((r) => setTimeout(r, intervalMs)),
      abortSleep,
    ]);
  }

  // ── Shutdown ───────────────────────────────────────────────────────

  if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
  if (sigintHandler) process.off('SIGINT', sigintHandler);

  tryUnlink(pidFile);
  log(`[clockworks] daemon stopped`);

  if (onShutdown) onShutdown();
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Format one dispatch observation as a log line. Prefixes the CLI's
 * existing dispatch shape with an ISO timestamp and the event id /
 * name so the log is greppable independent of which event id produced
 * the dispatch.
 *
 * Shape (per commission decision D6):
 *
 *   `<ISO timestamp> <eventId> <eventName> [<handlerName>] <status> <durationMs>ms[: <error>]`
 *
 * Loop-guard `'skipped'` rows render with `skipped: <reason>` and no
 * duration — the relay was never invoked, so surfacing `0ms` would
 * mislead operators.
 */
export function formatDispatchLogLine(obs: DispatchObservation): string {
  const ts = new Date().toISOString();
  const head = `${ts} ${obs.eventId} ${obs.eventName}`;
  if (obs.status === 'skipped') {
    const tail = `[${obs.handlerName}] skipped`;
    return obs.error ? `${head} ${tail}: ${obs.error}` : `${head} ${tail}`;
  }
  const tail = `[${obs.handlerName}] ${obs.status} ${obs.durationMs}ms`;
  if (obs.status === 'error' && obs.error) {
    return `${head} ${tail}: ${obs.error}`;
  }
  return `${head} ${tail}`;
}

/**
 * Validate `--interval <ms>`. Mirrors the fail-loud pattern used by
 * the CLI's `parseLimitOption` — non-integer / non-positive values
 * are rejected rather than silently clamped or defaulted.
 *
 * `undefined` returns the default (`DEFAULT_INTERVAL_MS`).
 */
export function validateInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `clock: --interval must be a positive integer (ms), got "${value}".`,
    );
  }
  return value;
}

/** Tail the last `lines` lines of `file`, swallowing any read errors. */
function tailFile(file: string, lines: number): string {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ── Convenience: resolve the live ClockworksApi-driven daemon body ───

/**
 * Helper that resolves `processEvents` from the booted guild's
 * Clockworks apparatus and forwards to `runForegroundDaemon`.
 *
 * The CLI's `clock start --foreground` handler calls this. Tests
 * usually call `runForegroundDaemon` directly with a fake
 * `processEvents` so they can drive the loop without Stacks.
 */
export async function runForegroundDaemonFromGuild(
  options: { intervalMs?: number; onShutdown?: () => void } = {},
): Promise<void> {
  const g = guild();
  const home = g.home;
  const clockworks = g.apparatus<ClockworksApi>('clockworks');
  const intervalMs = validateInterval(options.intervalMs);

  await runForegroundDaemon({
    home,
    intervalMs,
    processEvents: clockworks.processEvents.bind(clockworks),
    ...(options.onShutdown !== undefined ? { onShutdown: options.onShutdown } : {}),
  });
}

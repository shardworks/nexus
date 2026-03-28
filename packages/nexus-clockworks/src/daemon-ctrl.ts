/**
 * Clockworks daemon control — start, stop, and status operations.
 *
 * The daemon is a long-running Node.js process (clock-daemon.ts in this
 * same directory) that polls the event queue at a configurable interval.
 *
 * Lifecycle is managed via a PID file at .nexus/clock.pid:
 *   Line 1: PID
 *   Line 2: ISO-8601 start timestamp
 *
 * This file lives in src/ (not src/lib/) so that clock-daemon.ts — which
 * must be resolved at runtime by clockStart() — can be found at the same
 * directory level.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clockPidPath, clockLogPath } from '@shardworks/nexus-core';

// ── Types ─────────────────────────────────────────────────────────────

/** Options for starting the clockworks daemon. */
export interface ClockStartOptions {
  /** Polling interval in milliseconds. Default: 2000. */
  interval?: number;
}

/** Result of starting the clockworks daemon. */
export interface ClockStartResult {
  pid: number;
  logFile: string;
}

/** Result of stopping the clockworks daemon. */
export interface ClockStopResult {
  pid: number;
  stopped: boolean;
}

/** Current status of the clockworks daemon. */
export interface ClockStatus {
  running: boolean;
  pid?: number;
  logFile?: string;
  /** Uptime in milliseconds, if running. */
  uptime?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(home: string): { pid: number; startedAt: string } | null {
  const pidFile = clockPidPath(home);
  if (!fs.existsSync(pidFile)) return null;
  try {
    const content = fs.readFileSync(pidFile, 'utf-8').trim();
    const lines = content.split('\n');
    const pid = parseInt(lines[0]!, 10);
    const startedAt = lines[1] ?? new Date().toISOString();
    if (isNaN(pid)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

function cleanStalePid(home: string): void {
  try { fs.unlinkSync(clockPidPath(home)); } catch { /* already gone */ }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Start the clockworks daemon as a detached background process.
 *
 * Spawns clock-daemon.ts (or .js) from this same directory. The child
 * process polls the event queue at the given interval, writing to the
 * clock.log file.
 *
 * @throws If the daemon is already running.
 */
export function clockStart(home: string, options?: ClockStartOptions): ClockStartResult {
  const interval = options?.interval ?? 2000;

  const existing = readPidFile(home);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Clockworks daemon is already running (PID ${existing.pid}).`);
  }
  if (existing) cleanStalePid(home);

  const logFile = clockLogPath(home);
  const logFd = fs.openSync(logFile, 'a');

  // Resolve clock-daemon script: same directory as this file at runtime.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const daemonScript = fs.existsSync(path.join(thisDir, 'clock-daemon.ts'))
    ? path.join(thisDir, 'clock-daemon.ts')
    : path.join(thisDir, 'clock-daemon.js');

  const nodeArgs = daemonScript.endsWith('.ts')
    ? ['--disable-warning=ExperimentalWarning', '--experimental-transform-types']
    : [];

  const child = spawn(
    process.execPath,
    [...nodeArgs, daemonScript, home, String(interval)],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    },
  );

  const pid = child.pid!;
  fs.writeFileSync(clockPidPath(home), `${pid}\n${new Date().toISOString()}\n`);
  child.unref();
  fs.closeSync(logFd);

  return { pid, logFile };
}

/**
 * Stop the running clockworks daemon.
 *
 * @throws If no daemon is running (no PID file).
 */
export function clockStop(home: string): ClockStopResult {
  const pidInfo = readPidFile(home);
  if (!pidInfo) {
    throw new Error('Clockworks daemon is not running (no PID file).');
  }

  const alive = isProcessAlive(pidInfo.pid);
  if (alive) process.kill(pidInfo.pid, 'SIGTERM');
  cleanStalePid(home);

  return { pid: pidInfo.pid, stopped: alive };
}

/**
 * Get the current status of the clockworks daemon.
 */
export function clockStatus(home: string): ClockStatus {
  const pidInfo = readPidFile(home);
  if (!pidInfo) return { running: false };

  const alive = isProcessAlive(pidInfo.pid);
  if (!alive) {
    cleanStalePid(home);
    return { running: false };
  }

  return {
    running: true,
    pid: pidInfo.pid,
    logFile: clockLogPath(home),
    uptime: Date.now() - new Date(pidInfo.startedAt).getTime(),
  };
}

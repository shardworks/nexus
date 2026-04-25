/**
 * Shared PID-file and process-liveness helpers for daemon-style commands.
 *
 * Two daemons live in the framework today: `nsg start` (the guild daemon)
 * and `nsg clock start` (the Clockworks daemon). Both share the same
 * lifecycle primitives — read a pidfile, decide whether the pid behind
 * it is still alive, unlink the pidfile when the daemon is gone, and
 * poll until a pid actually exits after a SIGTERM.
 *
 * Centralising these helpers in `@shardworks/nexus-core` lets the CLI
 * (`packages/framework/cli`) and the Clockworks apparatus
 * (`packages/plugins/clockworks`) consume them without either depending
 * on the other.
 */

import fs from 'node:fs';

/**
 * Returns true when a process with the given pid is alive on this host.
 *
 * Uses signal 0 (the existence probe). The corner case worth knowing:
 * `EPERM` means the process exists but we lack permission to signal it —
 * we still treat it as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM → exists but we can't signal it. Treat as alive.
    return true;
  }
}

/**
 * Read a pidfile and parse it into a positive integer pid. Returns null
 * when the file is missing, unreadable, empty, or contains a value that
 * doesn't parse as a positive number.
 */
export function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Delete a file, swallowing any error. Used for pidfile cleanup where
 * a stale or already-deleted file should not be a fatal condition.
 */
export function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/**
 * Poll `isProcessAlive(pid)` every 200ms until the pid exits or the
 * timeout elapses. Returns true if the process exited within the
 * window, false otherwise.
 */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

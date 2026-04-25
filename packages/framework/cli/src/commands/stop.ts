/**
 * nsg stop — terminate the guild daemon.
 *
 * Reads `.nexus/daemon.pid`, sends SIGTERM, polls for exit, and escalates
 * to SIGKILL if the process is still alive after 10s. Removes the pidfile
 * after the process is gone.
 *
 * In-flight detached anima sessions (babysitter processes) are unaffected:
 * they were spawned with `detached: true` and have their own lifecycle. Only
 * the daemon process itself (tool server, oculus, spider crawl loop) stops.
 */

import path from 'node:path';

import { z } from 'zod';
import { tool } from '@shardworks/tools-apparatus';
import {
  guild,
  isProcessAlive,
  readPidFile,
  tryUnlink,
  waitForExit,
} from '@shardworks/nexus-core';

export default tool({
  name: 'stop',
  description: 'Stop the guild daemon (graceful SIGTERM with SIGKILL escalation)',
  callableBy: ['patron'],
  params: {
    timeoutMs: z
      .number()
      .optional()
      .describe('How long to wait for graceful shutdown before SIGKILL (default: 10000)'),
  },
  handler: async (params) => {
    let home: string;
    try {
      home = guild().home;
    } catch {
      throw new Error('Not inside a guild.');
    }

    const pidFile = path.join(home, '.nexus', 'daemon.pid');
    const pid = readPidFile(pidFile);

    if (pid === null) {
      return 'No guild daemon running (no pidfile).';
    }

    if (!isProcessAlive(pid)) {
      tryUnlink(pidFile);
      return `Stale pidfile removed (pid ${pid} was not alive).`;
    }

    // Send SIGTERM and poll.
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      throw new Error(`Failed to signal pid ${pid}: ${err instanceof Error ? err.message : err}`);
    }

    const timeoutMs = params.timeoutMs ?? 10_000;
    const exited = await waitForExit(pid, timeoutMs);

    if (!exited) {
      // Escalate.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
      const killed = await waitForExit(pid, 2000);
      tryUnlink(pidFile);
      if (!killed) {
        throw new Error(`Daemon (pid ${pid}) did not exit even after SIGKILL.`);
      }
      return `Guild daemon stopped (pid: ${pid}, escalated to SIGKILL after ${timeoutMs}ms).`;
    }

    tryUnlink(pidFile);
    return `Guild daemon stopped (pid: ${pid}).`;
  },
});

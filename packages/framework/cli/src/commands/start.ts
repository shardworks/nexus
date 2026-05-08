/**
 * nsg start — guild daemon mode.
 *
 * Two modes selected by --foreground / -f:
 *
 * - **Detached (default):** spawns the same `nsg` binary with `--foreground`
 *   added, fully detached from this terminal, with stdio piped to
 *   `.nexus/logs/daemon.{out,err}`. Returns once startup-sync confirms the
 *   tool HTTP server is reachable.
 *
 * - **Foreground (`--foreground` / `-f`):** the inline daemon loop. Boots the
 *   guild, starts the Tool HTTP Server (with a Stacks-backed authorize
 *   closure), starts the Oculus, runs the Spider continual crawl loop, runs
 *   the Clockworks tick loop (D2), writes the pidfile, installs SIGTERM/SIGINT
 *   handlers, and blocks forever.
 *
 * The foreground mode IS the daemon — there is no separate daemon entry
 * point. `nsg start` (detached) just re-execs itself with --foreground.
 *
 * The Clockworks tick loop (`processSchedules` + `processEvents`, 2000ms
 * interval) runs as a sibling async task alongside the Spider crawl loop.
 * The D4 guard skips it if a standalone `nsg clock start` daemon is already
 * running. The D10 guard skips it if the Clockworks apparatus is not
 * installed. Both are best-effort and non-fatal.
 *
 * The pidfile lives at `.nexus/daemon.pid` relative to the guild home.
 * See: docs/architecture/detached-sessions.md, docs/architecture/clockworks.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { z } from 'zod';
import { tool } from '@shardworks/tools-apparatus';
import type { InstrumentariumApi } from '@shardworks/tools-apparatus';
import {
  clockPidPath,
  guild,
  isProcessAlive,
  readPidFile,
  tryUnlink,
} from '@shardworks/nexus-core';
import { runClockworksTick, type ClockworksTickInputs } from '@shardworks/clockworks-apparatus';

import { getStartedGuild } from '../started-guild.ts';

// ── Local apparatus interface shims ──────────────────────────────────
//
// The CLI package deliberately does not depend on the spider, oculus,
// animator, or stacks plugin packages. We declare the minimum interfaces
// we need here and look them up via guild().apparatus<T>(name).

interface OculusApiLike {
  port(): number;
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
}

interface SpiderApiLike {
  crawl(): Promise<unknown>;
}

interface SpiderConfigLike {
  pollIntervalMs?: number;
}

/**
 * Minimum Clockworks API surface needed by the unified daemon's tick task.
 * Declared locally so the CLI package doesn't need a direct type dependency
 * on the Clockworks plugin's internal ClockworksApi interface. The
 * runtime apparatus is resolved via `g.apparatus<ClockworksApiLike>('clockworks')`.
 *
 * `processEvents` and `processSchedules` mirror the `ClockworksTickInputs`
 * slot types exactly so `buildClockworksTickShims` can forward opts
 * (including `onDispatch`) to the runtime apparatus without a cast.
 */
interface ClockworksApiLike {
  processEvents: ClockworksTickInputs['processEvents'];
  processSchedules?: ClockworksTickInputs['processSchedules'];
}

/**
 * Build the processEvents/processSchedules wrappers for the unified daemon's
 * Clockworks tick task. The wrappers forward all opts — including the
 * `onDispatch` observer — to the runtime apparatus so per-dispatch log
 * lines reach the unified daemon's `[clockworks]`-prefixed log stream.
 *
 * Wrapping rather than binding the methods directly keeps `this` stable
 * and gives unit tests a named, importable boundary to assert the
 * forwarding contract (see `start.test.ts`).
 *
 * @internal Exported for unit testing; not part of the public CLI API surface.
 */
export function buildClockworksTickShims(
  clockworks: ClockworksApiLike,
): Pick<ClockworksTickInputs, 'processEvents' | 'processSchedules'> {
  return {
    processEvents: (opts) => clockworks.processEvents(opts),
    processSchedules: clockworks.processSchedules
      ? (opts) => clockworks.processSchedules!(opts)
      : undefined,
  };
}

interface SessionDocLike {
  id: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'cancelled'
    | 'rate-limited';
  authorizedTools?: string[];
}

interface BookLike<T> {
  get(id: string): Promise<T | undefined>;
}

interface StacksApiLike {
  book<T>(plugin: string, name: string): BookLike<T>;
}

// ── Filesystem layout helpers ────────────────────────────────────────

function paths(home: string): {
  nexusDir: string;
  pidFile: string;
  logsDir: string;
  outLog: string;
  errLog: string;
} {
  const nexusDir = path.join(home, '.nexus');
  return {
    nexusDir,
    pidFile: path.join(nexusDir, 'daemon.pid'),
    logsDir: path.join(nexusDir, 'logs'),
    outLog: path.join(nexusDir, 'logs', 'daemon.out'),
    errLog: path.join(nexusDir, 'logs', 'daemon.err'),
  };
}

function tailFile(file: string, lines: number): string {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ── Detached mode — spawn self with --foreground ─────────────────────

async function startDetached(home: string): Promise<string> {
  const p = paths(home);

  // Idempotency: already-running check.
  const existing = readPidFile(p.pidFile);
  if (existing && isProcessAlive(existing)) {
    return `Guild daemon already running (pid: ${existing})`;
  }
  if (existing && !isProcessAlive(existing)) {
    tryUnlink(p.pidFile);
  }

  fs.mkdirSync(p.logsDir, { recursive: true });

  const outFd = fs.openSync(p.outLog, 'a');
  const errFd = fs.openSync(p.errLog, 'a');

  // Re-exec the same nsg entry point with --foreground appended.
  // process.execPath is node, process.argv[1] is the cli.ts (or compiled
  // cli.js) entry — same one Commander dispatched us from.
  const nodeArgs = process.execArgv.slice();
  const cliEntry = process.argv[1];

  const child = spawn(
    process.execPath,
    [...nodeArgs, cliEntry, 'start', '--foreground', '--guild-root', home],
    {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      cwd: home,
      env: process.env,
    },
  );

  child.unref();

  // Startup sync: poll for pidfile existence + tool server reachability.
  const deadline = Date.now() + 10_000;
  let lastError = '';
  while (Date.now() < deadline) {
    const pid = readPidFile(p.pidFile);
    if (pid && isProcessAlive(pid)) {
      const reached = await pingToolServer(home);
      if (reached.ok) {
        const oculusUrl = await guessOculusUrl(home);
        return [
          `Guild daemon started (pid: ${pid})`,
          `  Tool HTTP Server:  ${reached.url}`,
          `  Oculus:            ${oculusUrl ?? '(starting)'}`,
          `  Spider:            crawling (continual mode)`,
          `  Clockworks:        running (2000ms interval)`,
          `  Logs:              ${path.relative(home, p.outLog)}, ${path.relative(home, p.errLog)}`,
        ].join('\n');
      }
      lastError = reached.error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Startup failed. Tail the err log to help debugging.
  const tail = tailFile(p.errLog, 20);
  const msg = [
    'Guild daemon failed to start within 10s.',
    lastError ? `Last error: ${lastError}` : '',
    tail ? `\n--- last 20 lines of ${path.relative(home, p.errLog)} ---\n${tail}` : '',
  ].filter(Boolean).join('\n');
  throw new Error(msg);
}

async function pingToolServer(
  home: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  // Best-effort port discovery — read guild.json tools.serverPort if present.
  const port = readToolServerPort(home);
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/api/tools/list`);
    if (res.ok) return { ok: true, url };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readToolServerPort(home: string): number {
  try {
    const raw = fs.readFileSync(path.join(home, 'guild.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { tools?: { serverPort?: number } };
    return cfg.tools?.serverPort ?? 7471;
  } catch {
    return 7471;
  }
}

async function guessOculusUrl(home: string): Promise<string | null> {
  try {
    const raw = fs.readFileSync(path.join(home, 'guild.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { oculus?: { port?: number } };
    const port = cfg.oculus?.port ?? 7470;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

// ── Foreground mode — the inline daemon loop ────────────────────────

async function startForeground(home: string): Promise<never> {
  const p = paths(home);

  // Idempotency: refuse to double-start.
  const existing = readPidFile(p.pidFile);
  if (existing && isProcessAlive(existing)) {
    throw new Error(`Guild daemon already running (pid: ${existing})`);
  }
  if (existing) tryUnlink(p.pidFile);

  fs.mkdirSync(p.nexusDir, { recursive: true });

  // The guild is already booted by program.ts before any tool handler runs.
  const g = guild();

  // Build the Stacks-backed authorize closure for the tool server.
  // Looks up the session by id and checks its authorizedTools list.
  const stacks = g.apparatus<StacksApiLike>('stacks');
  const sessionsBook = stacks.book<SessionDocLike>('animator', 'sessions');
  const authorize = async (sessionId: string, toolName: string): Promise<boolean> => {
    const doc = await sessionsBook.get(sessionId);
    if (!doc) return false;
    if (doc.status !== 'pending' && doc.status !== 'running') return false;
    return doc.authorizedTools?.includes(toolName) ?? false;
  };

  // Start the Tool HTTP Server.
  const tools = g.apparatus<InstrumentariumApi>('tools');
  const toolServer = await tools.startToolServer({ authorize });
  console.log(`[daemon] Tool HTTP Server listening at ${toolServer.url}`);

  // Start the Oculus HTTP server (best-effort — only if installed).
  let oculusUrl: string | null = null;
  try {
    const oculus = g.apparatus<OculusApiLike>('oculus');
    await oculus.startServer();
    oculusUrl = `http://127.0.0.1:${oculus.port()}`;
    console.log(`[daemon] Oculus listening at ${oculusUrl}`);
  } catch {
    console.warn('[daemon] Oculus not installed — skipping');
  }

  // Write the pidfile now that the servers are up.
  fs.writeFileSync(p.pidFile, String(process.pid), 'utf-8');

  // ── Shutdown wiring ────────────────────────────────────────────────
  //
  // Teardown order on SIGTERM/SIGINT:
  //   1. Flip `spiderStop` so the crawl loop exits at its next yield.
  //   2. Resolve `clockworksShutdownPromise` (D9) so the Clockworks
  //      tick loop exits cleanly at its next sleep boundary.
  //   3. Close the tool HTTP server (the daemon owns this handle —
  //      it is returned by tools.startToolServer() rather than wired
  //      into the apparatus's stop()).
  //   4. Call guildInstance.shutdown(), which fires guild:shutdown,
  //      walks the started apparatus list in reverse topological
  //      order calling each `stop()` — including Oculus's, so the
  //      explicit oculus.stopServer() call that used to live here is
  //      now redundant and removed.
  //   5. Unlink the pidfile and process.exit(0).
  //
  // shutdown() is itself idempotent, so the local "first signal wins"
  // guard is no longer load-bearing for double-fire safety; we keep
  // `spiderStop` local because the crawl loop reads it directly.

  // D9: clockworks-shutdown deferred. Resolved at the top of the
  // shutdown handler so the tick loop can exit cleanly before the
  // apparatus stop() pass runs. Declared here so it is in scope for
  // both the shutdown handler (resolver) and the tick task (promise).
  let resolveClockworksShutdown!: () => void;
  const clockworksShutdownPromise = new Promise<void>((resolve) => {
    resolveClockworksShutdown = resolve;
  });

  const startedGuild = getStartedGuild();
  let spiderStop = false;

  const shutdown = async (signal: string) => {
    console.log(`[daemon] ${signal} received — shutting down...`);

    spiderStop = true;
    resolveClockworksShutdown(); // D9: signal Clockworks tick loop to stop.
    try {
      await toolServer.close();
    } catch (err) {
      console.warn(`[daemon] tool server close failed: ${err instanceof Error ? err.message : err}`);
    }

    if (startedGuild) {
      try {
        await startedGuild.shutdown();
      } catch (err) {
        // shutdown() throws an aggregate when one or more apparatus
        // stop()s fail. Surface it but still proceed with pidfile
        // cleanup and process exit — partial teardown is better than
        // a stuck process.
        console.warn(
          `[daemon] guild shutdown reported failures: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      // No StartedGuild reference — program.ts never deposited one,
      // which means createGuild() failed during startup. Nothing to
      // tear down.
      console.warn(
        '[daemon] no StartedGuild reference — skipping apparatus stop() pass',
      );
    }

    tryUnlink(p.pidFile);
    console.log('[daemon] stopped');
    // Explicit exit. The crawl loop and other in-flight timers may
    // keep the event loop alive even after apparatus stops; force exit
    // to avoid hangs.
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // ── Clockworks tick task (D2, D7, D8, D9, D10) ────────────────────
  //
  // Runs `processSchedules` (if available) then `processEvents` every
  // 2000ms as a sibling async task alongside the Spider crawl loop.
  //
  // D4: if a standalone `nsg clock start` daemon is already running
  //     (clock.pid is live), skip the tick task — it is already covered.
  // D10: if the Clockworks apparatus is not installed, log and skip.
  // D2: spawned via a fire-and-forget IIFE before the Spider loop
  //     starts; errors are caught and logged without killing the daemon.
  // D7: interval hardcoded at 2000ms — no flag on `nsg start`.
  // D8: every log line is prefixed with [clockworks] at this call site.
  // D9: clockworksShutdownPromise resolves when the shutdown handler
  //     fires, aborting the abortable sleep in the tick loop.

  let clockworksStatus = 'not installed';

  const standalonePid = readPidFile(clockPidPath(home));
  if (standalonePid !== null && isProcessAlive(standalonePid)) {
    // D4: standalone Clockworks daemon is running — skip the tick task.
    clockworksStatus = `standalone daemon (pid ${standalonePid})`;
    console.warn(
      `[daemon] Clockworks standalone daemon is running (pid ${standalonePid}) — skipping tick task`,
    );
  } else {
    try {
      const clockworks = g.apparatus<ClockworksApiLike>('clockworks');
      clockworksStatus = 'running (2000ms interval)';

      // D2: fire-and-forget sibling task. Errors are caught so a
      // Clockworks failure cannot kill the Spider loop or the servers.
      //
      // buildClockworksTickShims wraps processEvents/processSchedules so
      // opts (including onDispatch) are forwarded to the live apparatus,
      // ensuring per-dispatch lines reach the [clockworks] log stream (D8).
      const shims = buildClockworksTickShims(clockworks);
      void (async () => {
        try {
          await runClockworksTick({
            ...shims,
            intervalMs: 2000, // D7
            log: (line) => console.log(`[clockworks] ${line}`), // D8
            shutdown: clockworksShutdownPromise, // D9
          });
        } catch (err) {
          console.error(
            `[daemon] Clockworks tick loop failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      })();
    } catch {
      // D10: best-effort — Clockworks not installed.
      console.warn('[daemon] Clockworks not installed — skipping');
    }
  }

  console.log('[daemon] Guild daemon ready');
  console.log(`  Tool HTTP Server:  ${toolServer.url}`);
  if (oculusUrl) console.log(`  Oculus:            ${oculusUrl}`);
  console.log(`  Spider:            crawling (continual mode)`);
  console.log(`  Clockworks:        ${clockworksStatus}`);
  console.log(`  Pidfile:           ${path.relative(home, p.pidFile)}`);

  // ── Spider continual crawl loop ────────────────────────────────────
  //
  // This is what keeps the daemon alive. If the Spider isn't installed,
  // we still run a sleep loop so the tool/oculus servers stay up.
  //
  // Two loop-body cases:
  //
  // 1. Idle return (null). Spider had nothing dispatchable this tick —
  //    either the queue is empty, or every candidate was gated on
  //    non-terminal blockers. Sleep intervalMs before asking again.
  //
  // 2. Progress return (any non-null CrawlResult). Work happened this
  //    tick. Yield one macrotask via setImmediate so HTTP/timer
  //    handlers run between progress ticks (microtask-only awaits on
  //    steady work would otherwise starve them).
  //
  // The patron-callable `crawl-one` / `crawl-continual` tools were
  // retired — they raced with this loop and produced broken rig state.
  // The daemon now owns the crawl cadence outright.

  let spider: SpiderApiLike | null = null;
  let intervalMs = 5000;
  try {
    spider = g.apparatus<SpiderApiLike>('spider');
    const spiderCfg = (g.guildConfig() as { spider?: SpiderConfigLike }).spider ?? {};
    intervalMs = spiderCfg.pollIntervalMs ?? 5000;
  } catch {
    console.warn('[daemon] Spider not installed — running idle (servers only)');
  }

  while (!spiderStop) {
    if (spider) {
      try {
        const result = await spider.crawl();
        if (result === null) {
          // Idle: nothing dispatchable this tick. Sleep the full interval.
          await new Promise((r) => setTimeout(r, intervalMs));
        } else {
          // Genuine progress: yield one macrotask so HTTP handlers and
          // timers aren't starved by microtask-only awaits on steady work.
          await new Promise<void>((r) => setImmediate(r));
        }
      } catch (err) {
        console.error(`[daemon] crawl() error: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } else {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // Unreachable — shutdown() exits the process.
  return new Promise<never>(() => {});
}

// ── Tool definition ──────────────────────────────────────────────────

export default tool({
  name: 'start',
  description: 'Start the guild daemon (tool server + oculus + spider crawl loop)',
  callableBy: ['patron'],
  params: {
    foreground: z
      .boolean()
      .optional()
      .describe('Run in foreground (the inline daemon loop). Default: detached.'),
  },
  handler: async (params) => {
    // The guild is booted by program.ts before this handler runs, so the
    // singleton already knows the home directory.
    let home: string;
    try {
      home = guild().home;
    } catch {
      throw new Error('Not inside a guild. Run `nsg init` to create one first.');
    }

    if (params.foreground) {
      await startForeground(home);
      // startForeground never returns under normal operation.
      return '';
    }

    return startDetached(home);
  },
});

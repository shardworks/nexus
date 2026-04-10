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
 *   closure), starts the Oculus, runs the Spider continual crawl loop, writes
 *   the pidfile, installs SIGTERM/SIGINT handlers, and blocks forever.
 *
 * The foreground mode IS the daemon — there is no separate daemon entry
 * point. `nsg start` (detached) just re-execs itself with --foreground.
 *
 * The pidfile lives at `.nexus/daemon.pid` relative to the guild home.
 * See: docs/architecture/detached-sessions.md, .scratch/nsg-daemon-mode-brief.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { z } from 'zod';
import { tool } from '@shardworks/tools-apparatus';
import type { InstrumentariumApi } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';

// ── Local apparatus interface shims ──────────────────────────────────
//
// The CLI package deliberately does not depend on the spider, oculus,
// animator, or stacks plugin packages. We declare the minimum interfaces
// we need here and look them up via guild().apparatus<T>(name).

interface OculusApiLike {
  port(): number;
  startServer(): Promise<void>;
}

interface SpiderApiLike {
  crawl(): Promise<unknown>;
}

interface SpiderConfigLike {
  pollIntervalMs?: number;
}

interface SessionDocLike {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
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

function isProcessAlive(pid: number): boolean {
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

function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
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

  let shuttingDown = false;
  let spiderStop = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] ${signal} received — shutting down...`);

    spiderStop = true;
    try {
      await toolServer.close();
    } catch (err) {
      console.warn(`[daemon] tool server close failed: ${err instanceof Error ? err.message : err}`);
    }
    // Oculus has no documented stop hook today — best effort: leave the
    // process exit to tear it down. (TODO: when oculus exposes stop(), call it.)

    tryUnlink(p.pidFile);
    console.log('[daemon] stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  console.log('[daemon] Guild daemon ready');
  console.log(`  Tool HTTP Server:  ${toolServer.url}`);
  if (oculusUrl) console.log(`  Oculus:            ${oculusUrl}`);
  console.log(`  Spider:            crawling (continual mode)`);
  console.log(`  Pidfile:           ${path.relative(home, p.pidFile)}`);

  // ── Spider continual crawl loop ────────────────────────────────────
  //
  // This is what keeps the daemon alive. If the Spider isn't installed,
  // we still run a sleep loop so the tool/oculus servers stay up.

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
          await new Promise((r) => setTimeout(r, intervalMs));
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

/**
 * Tests for the `stop` framework command.
 *
 * Exercises the handler directly. The signal/poll/escalate path is
 * exercised against real spawned subprocesses (small node `-e` snippets)
 * to ensure SIGTERM and SIGKILL behaviour matches what the daemon will
 * see. No actual nsg daemon is launched.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import stopTool from './stop.ts';
import {
  setupGuildAccessor,
  makeTmpDir,
  cleanupTestState,
} from './test-helpers.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Spawn a node subprocess that emits a "ready" marker on stdout once
 * its signal handlers are installed, so tests can avoid racing the
 * spawn against SIGTERM delivery.
 */
function spawnReady(handlerCode: string): Promise<ChildProcess> {
  const code = `${handlerCode}; process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('READY')) {
        child.stdout?.off('data', onData);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited before READY')));
    setTimeout(() => reject(new Error('timed out waiting for READY')), 5000);
  });
}

/** Subprocess that traps SIGTERM and exits cleanly. */
function spawnExitsOnSigterm(): Promise<ChildProcess> {
  return spawnReady("process.on('SIGTERM', () => process.exit(0))");
}

/** Subprocess that ignores SIGTERM (only SIGKILL kills it). */
function spawnIgnoresSigterm(): Promise<ChildProcess> {
  return spawnReady("process.on('SIGTERM', () => {})");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePidFile(home: string, pid: number): string {
  const dir = path.join(home, '.nexus');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'daemon.pid');
  fs.writeFileSync(file, String(pid), 'utf-8');
  return file;
}

afterEach(() => {
  cleanupTestState();
});

// ── Tool metadata ────────────────────────────────────────────────────

describe('stop tool definition', () => {
  it('has the correct name', () => {
    assert.equal(stopTool.name, 'stop');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(stopTool.callableBy, ['patron']);
  });
});

// ── No guild ─────────────────────────────────────────────────────────

describe('stop handler — no guild', () => {
  it('throws when not inside a guild', async () => {
    await assert.rejects(
      async () => stopTool.handler({}),
      /Not inside a guild/,
    );
  });
});

// ── Pidfile state ────────────────────────────────────────────────────

describe('stop handler — pidfile states', () => {
  it('returns "no daemon running" when no pidfile exists', async () => {
    const tmp = makeTmpDir('stop');
    setupGuildAccessor(tmp);
    const result = await stopTool.handler({}) as string;
    assert.match(result, /No guild daemon running/);
  });

  it('cleans up a stale pidfile (process not alive)', async () => {
    const tmp = makeTmpDir('stop');
    // Pid 1 is the init process — usually present, but pid 999999999
    // is virtually guaranteed not to exist.
    const fakePid = 999_999_999;
    const pidFile = writePidFile(tmp, fakePid);
    assert.ok(fs.existsSync(pidFile));

    setupGuildAccessor(tmp);
    const result = await stopTool.handler({}) as string;
    assert.match(result, /Stale pidfile removed/);
    assert.equal(fs.existsSync(pidFile), false);
  });

  it('treats a malformed pidfile as no daemon running', async () => {
    const tmp = makeTmpDir('stop');
    const dir = path.join(tmp, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.pid'), 'not-a-number\n');

    setupGuildAccessor(tmp);
    const result = await stopTool.handler({}) as string;
    assert.match(result, /No guild daemon running/);
  });
});

// ── Graceful SIGTERM path ────────────────────────────────────────────

describe('stop handler — graceful SIGTERM', () => {
  it('signals the daemon and removes the pidfile when it exits', async () => {
    const tmp = makeTmpDir('stop');
    const child = await spawnExitsOnSigterm();
    if (typeof child.pid !== 'number') throw new Error('child has no pid');

    const pidFile = writePidFile(tmp, child.pid);
    setupGuildAccessor(tmp);

    const result = await stopTool.handler({ timeoutMs: 5000 }) as string;
    assert.match(result, /Guild daemon stopped/);
    assert.match(result, new RegExp(`pid: ${child.pid}`));
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(isAlive(child.pid), false);
  });
});

// ── SIGKILL escalation path ──────────────────────────────────────────

describe('stop handler — SIGKILL escalation', () => {
  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const tmp = makeTmpDir('stop');
    const child = await spawnIgnoresSigterm();
    if (typeof child.pid !== 'number') throw new Error('child has no pid');

    const pidFile = writePidFile(tmp, child.pid);
    setupGuildAccessor(tmp);

    // Tight timeout so the test runs fast.
    const result = await stopTool.handler({ timeoutMs: 300 }) as string;
    assert.match(result, /escalated to SIGKILL/);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(isAlive(child.pid), false);
  });
});

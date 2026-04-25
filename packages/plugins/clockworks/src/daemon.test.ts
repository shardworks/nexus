/**
 * Unit tests for the clockworks daemon lifecycle helpers.
 *
 * Three surfaces:
 *
 *  - `clockStatus` — happy/stale/missing pidfile branches.
 *  - `clockStop` — the no-pidfile and stale-pidfile branches plus a
 *    real signal-and-exit path against a tiny node child.
 *  - `formatDispatchLogLine` / `validateInterval` — pure helpers.
 *
 * The detached-spawn path of `clockStart` is integration territory —
 * spawning a real `nsg` child requires a booted guild and is covered
 * separately. Here we test the "already running" idempotency branch
 * which doesn't need to spawn anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  clockStart,
  clockStatus,
  clockStop,
  formatDispatchLogLine,
  validateInterval,
} from './daemon.ts';
import type { DispatchObservation } from './types.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clockworks-daemon-'));
}

function pidFile(home: string): string {
  return path.join(home, '.nexus', 'clock.pid');
}

function logFile(home: string): string {
  return path.join(home, '.nexus', 'clock.log');
}

function writePid(home: string, pid: number): string {
  const dir = path.join(home, '.nexus');
  fs.mkdirSync(dir, { recursive: true });
  const file = pidFile(home);
  fs.writeFileSync(file, String(pid), 'utf-8');
  return file;
}

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

// ── clockStatus ──────────────────────────────────────────────────────

describe('clockStatus', () => {
  it('returns running: false when no pidfile exists', () => {
    const home = makeTmpHome();
    const status = clockStatus(home);
    assert.deepEqual(status, { running: false });
  });

  it('returns running: true with pid/logFile/uptime when the daemon is alive', () => {
    const home = makeTmpHome();
    // process.pid is guaranteed alive — use it as a stand-in.
    writePid(home, process.pid);

    const status = clockStatus(home);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.logFile, logFile(home));
    assert.equal(typeof status.uptime, 'number');
    assert.ok((status.uptime ?? -1) >= 0);
  });

  it('reports stalePidfile and unlinks when the pidfile points at a dead pid', () => {
    const home = makeTmpHome();
    const fakePid = 999_999_999;
    const file = writePid(home, fakePid);
    assert.ok(fs.existsSync(file));

    const status = clockStatus(home);
    assert.equal(status.running, false);
    assert.equal(status.stalePidfile, true);
    assert.equal(fs.existsSync(file), false);

    // Subsequent call is silent — the file is gone.
    const followup = clockStatus(home);
    assert.deepEqual(followup, { running: false });
  });

  it('treats a malformed pidfile as no daemon running', () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFile(home), 'not-a-number\n');

    const status = clockStatus(home);
    assert.deepEqual(status, { running: false });
  });
});

// ── clockStop ────────────────────────────────────────────────────────

describe('clockStop', () => {
  it('throws when no pidfile exists', async () => {
    const home = makeTmpHome();
    await assert.rejects(
      clockStop(home),
      /Clockworks daemon is not running/,
    );
  });

  it('cleans up and throws when the pidfile is stale', async () => {
    const home = makeTmpHome();
    const file = writePid(home, 999_999_999);
    await assert.rejects(
      clockStop(home),
      /stale pidfile/i,
    );
    assert.equal(fs.existsSync(file), false);
  });

  it('signals the daemon and returns once it exits', async () => {
    const home = makeTmpHome();
    const child = await spawnReady("process.on('SIGTERM', () => process.exit(0))");
    if (typeof child.pid !== 'number') throw new Error('child has no pid');

    const file = writePid(home, child.pid);
    const result = await clockStop(home);
    assert.deepEqual(result, { pid: child.pid, stopped: true });
    assert.equal(fs.existsSync(file), false);
  });
});

// ── clockStart (idempotency only) ────────────────────────────────────

describe('clockStart — idempotency', () => {
  it('returns the existing pid when a daemon is already running', async () => {
    const home = makeTmpHome();
    writePid(home, process.pid);

    const result = await clockStart(home);
    assert.equal(result.pid, process.pid);
    assert.equal(result.logFile, logFile(home));
  });
});

// ── formatDispatchLogLine ────────────────────────────────────────────

describe('formatDispatchLogLine', () => {
  const baseObs: DispatchObservation = {
    eventId: 'e-abc-123',
    eventName: 'demo.thing-happened',
    handlerName: 'log-event',
    status: 'success',
    durationMs: 12,
    error: null,
  };

  it('renders a success row with eventId, eventName, handler, status, ms', () => {
    const line = formatDispatchLogLine(baseObs);
    // ISO timestamp prefix.
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    assert.match(line, / e-abc-123 /);
    assert.match(line, / demo\.thing-happened /);
    assert.match(line, /\[log-event\] success 12ms$/);
  });

  it('appends the error message on an error row', () => {
    const line = formatDispatchLogLine({
      ...baseObs,
      status: 'error',
      error: 'kaboom',
    });
    assert.match(line, /\[log-event\] error 12ms: kaboom$/);
  });

  it('renders a skipped row without a duration', () => {
    const line = formatDispatchLogLine({
      ...baseObs,
      status: 'skipped',
      error: 'loop-guard: cascade',
    });
    assert.match(line, /\[log-event\] skipped: loop-guard: cascade$/);
    assert.doesNotMatch(line, /\d+ms/);
  });
});

// ── validateInterval ─────────────────────────────────────────────────

describe('validateInterval', () => {
  it('returns the default for undefined', () => {
    assert.equal(validateInterval(undefined), 2000);
  });

  it('passes through valid positive integers', () => {
    assert.equal(validateInterval(500), 500);
    assert.equal(validateInterval(1), 1);
  });

  it('throws on zero', () => {
    assert.throws(() => validateInterval(0), /positive integer/);
  });

  it('throws on negative', () => {
    assert.throws(() => validateInterval(-5), /positive integer/);
  });

  it('throws on non-integer', () => {
    assert.throws(() => validateInterval(1.5), /positive integer/);
  });
});

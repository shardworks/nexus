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
 * separately. Here we test the "already running" refusal branch
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
  runForegroundDaemon,
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

  it('reports host:guild-daemon when no clock.pid but daemon.pid is live (D5)', () => {
    // The Clockworks loops are hosted by the unified guild daemon.
    // clockStatus should fall back to the daemon.pid and report
    // host:'guild-daemon' with the daemon.out log path.
    const home = makeTmpHome();
    writeDaemonPid(home, process.pid);

    const status = clockStatus(home);
    assert.equal(status.running, true);
    assert.equal(status.host, 'guild-daemon');
    assert.equal(status.pid, process.pid);
    assert.match(status.logFile ?? '', /daemon\.out$/);
    assert.equal(typeof status.uptime, 'number');
    assert.ok((status.uptime ?? -1) >= 0);
  });

  it('reports host:guild-daemon when clock.pid is stale but daemon.pid is live (D5)', () => {
    // A stale clock.pid plus a live daemon.pid: the standalone daemon exited
    // but the unified daemon is now running Clockworks. clockStatus should
    // clean up the stale file and report the guild-daemon as the host.
    const home = makeTmpHome();
    const staleFile = writePid(home, 999_999_999);
    writeDaemonPid(home, process.pid);

    const status = clockStatus(home);
    assert.equal(status.running, true);
    assert.equal(status.host, 'guild-daemon');
    assert.equal(status.pid, process.pid);
    assert.match(status.logFile ?? '', /daemon\.out$/);
    // Stale clock.pid was cleaned up as a side effect.
    assert.equal(
      fs.existsSync(staleFile),
      false,
      'stale clock.pid should be removed',
    );
  });
});

// ── clockStop ────────────────────────────────────────────────────────

describe('clockStop', () => {
  it('returns a no-pidfile result when there is nothing to stop', async () => {
    const home = makeTmpHome();
    const result = await clockStop(home);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'no-pidfile');
    assert.equal(result.pid, null);
    assert.match(result.message, /not running/i);
  });

  it('cleans up and returns a stale result when the pidfile is stale', async () => {
    const home = makeTmpHome();
    const file = writePid(home, 999_999_999);
    const result = await clockStop(home);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'stale');
    assert.equal(result.pid, 999_999_999);
    assert.match(result.message, /stale pidfile/i);
    assert.equal(fs.existsSync(file), false);
  });

  it('signals the daemon and returns once it exits', async () => {
    const home = makeTmpHome();
    const child = await spawnReady("process.on('SIGTERM', () => process.exit(0))");
    if (typeof child.pid !== 'number') throw new Error('child has no pid');

    const file = writePid(home, child.pid);
    const result = await clockStop(home);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'signaled');
    assert.equal(result.pid, child.pid);
    assert.match(result.message, /stopped/i);
    assert.equal(fs.existsSync(file), false);
  });

  it('returns guild-daemon reason when no clock.pid but daemon.pid is live (D11)', async () => {
    // When there is no clock.pid but the unified guild daemon is running,
    // clockStop must return reason:'guild-daemon' and NOT signal it —
    // only nsg stop owns that daemon.
    const home = makeTmpHome();
    writeDaemonPid(home, process.pid);

    const result = await clockStop(home);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'guild-daemon');
    assert.equal(result.pid, process.pid, 'pid should be the guild daemon pid');
    assert.match(result.message, /nsg stop/i);
    // daemon.pid must NOT be removed — clockStop does not own it.
    assert.ok(
      fs.existsSync(daemonPidFile(home)),
      'daemon.pid should remain untouched',
    );
  });

  it('returns guild-daemon reason when clock.pid is stale and daemon.pid is live (D11)', async () => {
    // A stale clock.pid plus a live daemon.pid: the standalone clock daemon
    // was not running, but the unified guild daemon is hosting Clockworks.
    const home = makeTmpHome();
    const staleFile = writePid(home, 999_999_999);
    writeDaemonPid(home, process.pid);

    const result = await clockStop(home);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, 'guild-daemon');
    assert.equal(result.pid, process.pid);
    assert.match(result.message, /nsg stop/i);
    // Stale clock.pid should have been cleaned up as a side effect.
    assert.equal(
      fs.existsSync(staleFile),
      false,
      'stale clock.pid should be removed',
    );
  });
});

// ── clockStart (already-running refusal) ─────────────────────────────

function daemonPidFile(home: string): string {
  return path.join(home, '.nexus', 'daemon.pid');
}

function writeDaemonPid(home: string, pid: number): string {
  const dir = path.join(home, '.nexus');
  fs.mkdirSync(dir, { recursive: true });
  const file = daemonPidFile(home);
  fs.writeFileSync(file, String(pid), 'utf-8');
  return file;
}

describe('clockStart — already-running refusal', () => {
  it('throws when a live daemon is already recorded by the pidfile', async () => {
    const home = makeTmpHome();
    writePid(home, process.pid);

    await assert.rejects(
      clockStart(home),
      /already running/i,
    );
    // The pidfile is left in place — the existing daemon owns it.
    assert.equal(fs.existsSync(pidFile(home)), true);
  });

  it('throws (D3) when the unified guild daemon is running', async () => {
    const home = makeTmpHome();
    // Write daemon.pid pointing at a live process (our test process).
    writeDaemonPid(home, process.pid);

    await assert.rejects(
      clockStart(home),
      /unified guild daemon/i,
    );
  });

  it('does not block clockStatus when daemon.pid is stale (D3 guard only fires for live pids)', () => {
    // Verifies that a stale daemon.pid does not cause clockStatus to
    // report the unified daemon as host. The D3 guard in clockStart
    // also only fires when the named pid is alive — same predicate.
    const home = makeTmpHome();
    writeDaemonPid(home, 999_999_999);
    const status = clockStatus(home);
    // A stale daemon.pid means the unified daemon is NOT running.
    assert.equal(status.running, false, 'stale daemon.pid should not report running');
    assert.notEqual(status.host, 'guild-daemon', 'stale daemon.pid should not report guild-daemon host');
  });
});

// ── runForegroundDaemon D3 guard ────────────────────────────────────

describe('runForegroundDaemon — D3 unified-daemon guard', () => {
  it('throws when the unified guild daemon is running', async () => {
    const home = makeTmpHome();
    writeDaemonPid(home, process.pid);

    const { stub } = buildProcessEventsStub();

    await assert.rejects(
      runForegroundDaemon({
        home,
        intervalMs: 50,
        processEvents: stub,
        skipSignalHandlers: true,
      }),
      /unified guild daemon/i,
    );
  });
});

// ── Helper for D3 guard tests ──────────────────────────────────────

function buildProcessEventsStub() {
  const stub = async (): Promise<{
    processedEvents: number;
    dispatches: number;
    errors: number;
    skipped: number;
  }> => ({ processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 });
  return { stub };
}

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

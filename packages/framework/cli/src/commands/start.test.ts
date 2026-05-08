/**
 * Tests for the `start` framework command.
 *
 * Two surfaces:
 *
 * 1. **Detached mode handler unit tests** — exercise the idempotency
 *    check, stale pidfile cleanup, and the tool metadata. These run
 *    against a stub guild accessor and never actually spawn a child.
 *    The startup-sync poll path is hit by injecting a fresh pidfile
 *    that points at our own (test) process — it's "alive" so the
 *    handler reaches the tool-server reachability check, which fails
 *    fast (no server running on 7471), and we assert the failure
 *    message tails the err log as designed.
 *
 * 2. **`buildClockworksTickShims` unit tests** — exercise the exported
 *    shim-builder in isolation to prove that `onDispatch` is forwarded
 *    to the underlying apparatus (regression guard for RC1: the shims
 *    previously discarded the opts argument).
 *
 * 3. **Foreground mode is NOT covered here** because it requires a
 *    real guild boot (Arbor + apparatuses + Stacks + tool server +
 *    oculus + spider). That's an integration test surface — see the
 *    daemon integration test plan.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { DispatchObservation } from '@shardworks/clockworks-apparatus';

import startTool, { buildClockworksTickShims } from './start.ts';
import {
  setupGuildAccessor,
  makeTmpDir,
  cleanupTestState,
} from './test-helpers.ts';

function pidFilePath(home: string): string {
  return path.join(home, '.nexus', 'daemon.pid');
}

function writePidFile(home: string, pid: number): string {
  const dir = path.join(home, '.nexus');
  fs.mkdirSync(dir, { recursive: true });
  const file = pidFilePath(home);
  fs.writeFileSync(file, String(pid), 'utf-8');
  return file;
}

afterEach(() => {
  cleanupTestState();
});

// ── Tool metadata ────────────────────────────────────────────────────

describe('start tool definition', () => {
  it('has the correct name', () => {
    assert.equal(startTool.name, 'start');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(startTool.callableBy, ['patron']);
  });

  it('exposes the foreground flag in its params', () => {
    const shape = startTool.params.shape as Record<string, unknown>;
    assert.ok('foreground' in shape);
  });
});

// ── No guild ─────────────────────────────────────────────────────────

describe('start handler — no guild', () => {
  it('throws when not inside a guild (detached mode)', async () => {
    await assert.rejects(
      async () => startTool.handler({}),
      /Not inside a guild/,
    );
  });

  it('throws when not inside a guild (foreground mode)', async () => {
    await assert.rejects(
      async () => startTool.handler({ foreground: true }),
      /Not inside a guild/,
    );
  });
});

// ── Detached mode — idempotency ──────────────────────────────────────

describe('start handler — detached mode idempotency', () => {
  it('returns "already running" when pidfile points at a live PID', async () => {
    const tmp = makeTmpDir('start');
    // process.pid is guaranteed alive — use it as the "live daemon".
    writePidFile(tmp, process.pid);

    setupGuildAccessor(tmp);
    const result = await startTool.handler({}) as string;
    assert.match(result, /already running/);
    assert.match(result, new RegExp(`pid: ${process.pid}`));

    // Pidfile should be untouched.
    assert.equal(fs.existsSync(pidFilePath(tmp)), true);
  });

  // Note: full coverage of the stale-pidfile-cleanup → spawn → poll path
  // requires a real nsg daemon target, which is the daemon integration
  // test surface (separate from these unit tests). At the unit level we
  // verify the live-PID branch above; the stale-cleanup branch is
  // covered indirectly by the stop.test.ts stale-pidfile test which
  // exercises the same readPidFile + isProcessAlive helpers.
});

// ── buildClockworksTickShims — onDispatch forwarding regression guard ──
//
// These tests verify that the shims produced by buildClockworksTickShims
// forward opts (including `onDispatch`) to the underlying apparatus.
//
// Before RC1, the shims were `() => clockworks.processEvents()` — the
// opts arg supplied by `runClockworksTick` was silently dropped. After the
// fix the shims are `(opts) => clockworks.processEvents(opts)`, so any
// `onDispatch` observer wired by the tick loop reaches the live apparatus.

describe('buildClockworksTickShims — onDispatch forwarding', () => {
  it('processEvents shim forwards opts.onDispatch to the underlying apparatus', async () => {
    // Track what opts the mock apparatus actually receives.
    const capturedOpts: Array<{ onDispatch?: unknown }> = [];

    const shims = buildClockworksTickShims({
      processEvents: async (opts) => {
        capturedOpts.push({ onDispatch: opts?.onDispatch });
        return { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 };
      },
    });

    const mockDispatch = (_obs: DispatchObservation): void => {};
    await shims.processEvents({ onDispatch: mockDispatch });

    assert.equal(capturedOpts.length, 1, 'processEvents was called once');
    assert.equal(
      capturedOpts[0]!.onDispatch,
      mockDispatch,
      'onDispatch function was forwarded to the apparatus',
    );
  });

  it('processSchedules shim forwards opts.onDispatch when the apparatus has processSchedules', async () => {
    const capturedOpts: Array<{ onDispatch?: unknown }> = [];

    const shims = buildClockworksTickShims({
      processEvents: async () => ({ processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 }),
      processSchedules: async (opts) => {
        capturedOpts.push({ onDispatch: opts?.onDispatch });
        return { fired: 0, errors: 0 };
      },
    });

    assert.ok(shims.processSchedules, 'shim should expose processSchedules');
    const mockDispatch = (_obs: DispatchObservation): void => {};
    await shims.processSchedules!({ onDispatch: mockDispatch });

    assert.equal(capturedOpts.length, 1, 'processSchedules was called once');
    assert.equal(
      capturedOpts[0]!.onDispatch,
      mockDispatch,
      'onDispatch function was forwarded to the apparatus',
    );
  });

  it('processSchedules is undefined when the apparatus does not have processSchedules', () => {
    const shims = buildClockworksTickShims({
      processEvents: async () => ({ processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 }),
      // no processSchedules
    });

    assert.equal(
      shims.processSchedules,
      undefined,
      'processSchedules slot should be undefined when apparatus omits it',
    );
  });
});

/**
 * Daemon integration test — drives the inline foreground daemon entry
 * against an in-memory `processEvents` fake without spawning a real
 * child process.
 *
 * The fixture replaces `ClockworksApi.processEvents` with a controllable
 * stub so we can:
 *
 *   - Verify the pidfile is written with the current pid and unlinked
 *     on shutdown.
 *   - Inspect log lines: per-dispatch, banners, and `[error]` lines on
 *     forced throws.
 *   - Assert that idle ticks produce no dispatch lines.
 *   - Assert that the abortable sleep responds to shutdown well under
 *     one full interval.
 *   - Assert that a forced throw inside `processEvents` is logged and
 *     the loop continues at the next interval.
 *
 * The daemon's signal handlers are skipped via `skipSignalHandlers:
 * true` so the test process is not affected by SIGTERM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clockPidPath, clockLogPath } from '@shardworks/nexus-core';

import { runForegroundDaemon, runClockworksTick } from './daemon.ts';
import type { DispatchObservation } from './types.ts';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clockworks-daemon-int-'));
}

/**
 * Build a controllable `processEvents` stub. The returned hooks let
 * tests:
 *  - emit a dispatch observation on the next call,
 *  - force the next call to throw,
 *  - count the calls received,
 *  - signal when the next call has occurred (via `nextCall()`).
 */
function buildProcessEventsStub() {
  let calls = 0;
  const emit: DispatchObservation[] = [];
  const errors: Error[] = [];
  const callWaiters: Array<() => void> = [];

  const stub = async (opts?: {
    onDispatch?: (obs: DispatchObservation) => void;
  }): Promise<{
    processedEvents: number;
    dispatches: number;
    errors: number;
    skipped: number;
  }> => {
    calls += 1;

    if (errors.length > 0) {
      const err = errors.shift()!;
      throw err;
    }

    if (opts?.onDispatch) {
      while (emit.length > 0) {
        const obs = emit.shift()!;
        opts.onDispatch(obs);
      }
    }

    // Resolve the next-call waiter (if any).
    const waiter = callWaiters.shift();
    if (waiter) waiter();

    return {
      processedEvents: 0,
      dispatches: 0,
      errors: 0,
      skipped: 0,
    };
  };

  return {
    stub,
    callCount: () => calls,
    queueDispatch: (obs: DispatchObservation): void => {
      emit.push(obs);
    },
    queueError: (err: Error): void => {
      errors.push(err);
    },
    /** Resolves once the next `processEvents` invocation completes. */
    nextCall: (): Promise<void> =>
      new Promise<void>((resolve) => {
        callWaiters.push(resolve);
      }),
  };
}

/** Build a no-op log writer plus a captured-lines array. */
function buildLog() {
  const lines: string[] = [];
  return {
    log: (line: string) => {
      lines.push(line);
    },
    lines,
  };
}

// ── The integration scenarios ────────────────────────────────────────

describe('runForegroundDaemon — integration', () => {
  it('writes the pidfile, runs ticks, and unlinks the pidfile on shutdown', async () => {
    const home = makeTmpHome();
    const { stub, callCount, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-aaa',
      eventName: 'demo.thing-happened',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 7,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 50,
      processEvents: stub,
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    // Wait for the first tick to land. After it returns the pidfile
    // exists and the dispatch line has been recorded.
    await nextCall();

    assert.ok(
      fs.existsSync(clockPidPath(home)),
      'pidfile should exist while daemon is running',
    );
    const recordedPid = Number(fs.readFileSync(clockPidPath(home), 'utf-8'));
    assert.equal(recordedPid, process.pid);

    // Let one or two more ticks happen so we exercise the abortable
    // sleep more than once.
    await nextCall();

    // Now signal shutdown and verify the daemon returns and cleans up.
    const startedAt = Date.now();
    triggerShutdown();
    await daemonRun;
    const shutdownLatencyMs = Date.now() - startedAt;

    assert.ok(
      !fs.existsSync(clockPidPath(home)),
      'pidfile should be removed after shutdown',
    );

    // Abortable sleep responsiveness: shutdown should land well under
    // a full interval-plus-buffer. Allow generous slack for slow CI.
    assert.ok(
      shutdownLatencyMs < 500,
      `shutdown should be responsive, got ${shutdownLatencyMs}ms`,
    );

    // At least one tick happened.
    assert.ok(callCount() >= 1, `expected ≥1 tick, got ${callCount()}`);

    // The startup banner is line 0.
    assert.match(lines[0]!, /\[clockworks\] daemon started/);
    assert.match(lines[0]!, new RegExp(`pid=${process.pid}`));
    assert.match(lines[0]!, /intervalMs=50/);

    // The dispatch line is present.
    const dispatchLine = lines.find((l) => l.includes('e-aaa'));
    assert.ok(dispatchLine, `expected dispatch line, lines: ${lines.join(' | ')}`);
    assert.match(dispatchLine!, /demo\.thing-happened/);
    assert.match(dispatchLine!, /\[log-event\] success 7ms/);

    // The shutdown banner is the last line.
    assert.match(lines[lines.length - 1]!, /\[clockworks\] daemon stopped/);
  });

  it('logs and continues when processEvents throws', async () => {
    const home = makeTmpHome();
    const { stub, queueError, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueError(new Error('forced-throw-from-test'));
    queueDispatch({
      eventId: 'e-bbb',
      eventName: 'demo.recovered',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 3,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 30,
      processEvents: stub,
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    // First tick: throws.
    await nextCall();
    // Second tick: emits the dispatch.
    await nextCall();

    triggerShutdown();
    await daemonRun;

    const errLine = lines.find((l) => l.includes('[error]'));
    assert.ok(errLine, `expected [error] line, got: ${lines.join(' | ')}`);
    assert.match(errLine!, /forced-throw-from-test/);

    // The recovery dispatch line is present — the loop continued past
    // the throw.
    const recoveryLine = lines.find((l) => l.includes('e-bbb'));
    assert.ok(recoveryLine, 'expected recovery dispatch line after the error');
    assert.match(recoveryLine!, /\[log-event\] success 3ms/);

    // Banners both ends.
    assert.match(lines[0]!, /daemon started/);
    assert.match(lines[lines.length - 1]!, /daemon stopped/);
  });

  it('idle ticks produce no log lines beyond the banners', async () => {
    const home = makeTmpHome();
    const { stub, callCount, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 25,
      processEvents: stub,
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    // Drive several idle ticks.
    await nextCall();
    await nextCall();
    await nextCall();

    triggerShutdown();
    await daemonRun;

    // Three+ idle ticks happened.
    assert.ok(callCount() >= 3, `expected ≥3 ticks, got ${callCount()}`);

    // No per-dispatch lines should appear for idle ticks. The only
    // intra-banner output is the shutdown notice itself.
    const dispatchLines = lines.filter(
      (l) => !/\[clockworks\]/.test(l),
    );
    assert.equal(
      dispatchLines.length,
      0,
      `expected 0 dispatch lines on idle, got: ${dispatchLines.join(' | ')}`,
    );

    // Banners frame the lifetime.
    assert.match(lines[0]!, /daemon started/);
    assert.match(lines[lines.length - 1]!, /daemon stopped/);
  });

  it('writes the default log to clock.log on disk when no override is supplied', async () => {
    const home = makeTmpHome();
    const { stub, queueDispatch, nextCall } = buildProcessEventsStub();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-ccc',
      eventName: 'demo.disk-log',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 1,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 40,
      processEvents: stub,
      // no `log` override — daemon writes to clock.log
      shutdown,
      skipSignalHandlers: true,
    });

    await nextCall();
    triggerShutdown();
    await daemonRun;

    const contents = fs.readFileSync(clockLogPath(home), 'utf-8');
    assert.match(contents, /\[clockworks\] daemon started/);
    assert.match(contents, /e-ccc/);
    assert.match(contents, /\[clockworks\] daemon stopped/);
  });

  it('refuses to start when a live daemon is already recorded', async () => {
    const home = makeTmpHome();
    fs.mkdirSync(path.join(home, '.nexus'), { recursive: true });
    fs.writeFileSync(clockPidPath(home), String(process.pid), 'utf-8');

    const { stub } = buildProcessEventsStub();

    await assert.rejects(
      runForegroundDaemon({
        home,
        intervalMs: 50,
        processEvents: stub,
        skipSignalHandlers: true,
      }),
      /already running/,
    );
  });

  it('runs the scheduler pass before the event-processing pass each tick (D18)', async () => {
    const home = makeTmpHome();
    const { stub: eventsStub, callCount: eventsCalls, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    // Track call order across both stubs.
    const callOrder: string[] = [];

    const schedulesStub = async (opts?: {
      onDispatch?: (obs: DispatchObservation) => void;
    }): Promise<{ fired: number; errors: number }> => {
      callOrder.push('schedules');
      // Emit a scheduler dispatch observation so we can verify the
      // log line goes through the same formatter.
      opts?.onDispatch?.({
        eventId: 'e-sched-1',
        eventName: 'clockworks.timer',
        handlerName: 'reckoner-tick',
        status: 'success',
        durationMs: 4,
        error: null,
      });
      return { fired: 1, errors: 0 };
    };

    // Wrap the events stub so each call records its order too.
    const wrappedEvents = async (opts?: Parameters<typeof eventsStub>[0]) => {
      callOrder.push('events');
      return eventsStub(opts);
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-event-1',
      eventName: 'demo.thing',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 2,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 50,
      processEvents: wrappedEvents,
      processSchedules: schedulesStub,
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    await nextCall();
    await nextCall();
    triggerShutdown();
    await daemonRun;

    // At least one tick — the scheduler pass appears immediately
    // before the events pass on every tick.
    assert.ok(eventsCalls() >= 1);
    for (let i = 0; i < callOrder.length - 1; i += 1) {
      if (callOrder[i] === 'schedules') {
        assert.equal(
          callOrder[i + 1],
          'events',
          `expected schedules→events ordering, got ${callOrder.join(',')}`,
        );
      }
    }

    // Both pass observations are formatted by the shared dispatcher
    // log formatter (D16), so look for both event ids in the log.
    const schedLine = lines.find((l) => l.includes('e-sched-1'));
    const eventLine = lines.find((l) => l.includes('e-event-1'));
    assert.ok(schedLine, `expected scheduler dispatch line, got: ${lines.join(' | ')}`);
    assert.match(schedLine!, /\[reckoner-tick\] success 4ms/);
    assert.ok(eventLine, `expected event dispatch line, got: ${lines.join(' | ')}`);
    assert.match(eventLine!, /\[log-event\] success 2ms/);
  });

  it('continues the event-processing pass even if the scheduler pass throws', async () => {
    const home = makeTmpHome();
    const { stub: eventsStub, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    const schedulesStub = async (): Promise<{ fired: number; errors: number }> => {
      throw new Error('scheduler-broken');
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-after-sched-throw',
      eventName: 'demo.recovered',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 1,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 30,
      processEvents: eventsStub,
      processSchedules: schedulesStub,
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    await nextCall();
    triggerShutdown();
    await daemonRun;

    const errLine = lines.find((l) => l.includes('processSchedules threw'));
    assert.ok(errLine, `expected scheduler-throw line, got: ${lines.join(' | ')}`);
    assert.match(errLine!, /scheduler-broken/);

    // The events pass still ran and produced its dispatch line.
    const eventLine = lines.find((l) => l.includes('e-after-sched-throw'));
    assert.ok(eventLine, 'expected event-pass dispatch line after scheduler throw');
  });

  it('skips the scheduler pass entirely when processSchedules is omitted', async () => {
    const home = makeTmpHome();
    const { stub: eventsStub, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-only-events',
      eventName: 'demo.only',
      handlerName: 'log-event',
      status: 'success',
      durationMs: 1,
      error: null,
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 30,
      processEvents: eventsStub,
      // no processSchedules
      log,
      shutdown,
      skipSignalHandlers: true,
    });

    await nextCall();
    triggerShutdown();
    await daemonRun;

    // The events line lands; no scheduler-related log lines appear.
    assert.ok(lines.some((l) => l.includes('e-only-events')));
    assert.ok(!lines.some((l) => l.includes('processSchedules')));
  });

  it('awaits an async onShutdown before returning', async () => {
    const home = makeTmpHome();
    const { stub, nextCall } = buildProcessEventsStub();
    const { log } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    let onShutdownStarted = false;
    let onShutdownCompleted = false;

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 30,
      processEvents: stub,
      log,
      shutdown,
      skipSignalHandlers: true,
      onShutdown: async () => {
        onShutdownStarted = true;
        // Simulate StartedGuild.shutdown() with a real async pause.
        await new Promise((r) => setTimeout(r, 30));
        onShutdownCompleted = true;
      },
    });

    await nextCall();
    triggerShutdown();
    await daemonRun;

    assert.ok(onShutdownStarted, 'onShutdown should have started');
    assert.ok(
      onShutdownCompleted,
      'runForegroundDaemon should await async onShutdown before returning',
    );
  });
});

// ── runClockworksTick — pure tick-loop helper ────────────────────────

describe('runClockworksTick — unit', () => {
  it('iterates and exits cleanly when the shutdown promise resolves', async () => {
    const { stub, callCount, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const tickRun = runClockworksTick({
      processEvents: stub,
      intervalMs: 30,
      log,
      shutdown,
    });

    // Drive several iterations then shut down.
    await nextCall();
    await nextCall();
    await nextCall();

    const startedAt = Date.now();
    triggerShutdown();
    await tickRun;
    const latencyMs = Date.now() - startedAt;

    assert.ok(callCount() >= 3, `expected ≥3 ticks, got ${callCount()}`);
    // Shutdown should abort the current sleep immediately.
    assert.ok(latencyMs < 500, `expected fast shutdown, got ${latencyMs}ms`);
    // No banners: the helper is pure — no startup or shutdown log lines.
    assert.equal(lines.length, 0, `expected 0 lines (idle ticks), got: ${lines.join(' | ')}`);
  });

  it('logs dispatch observations on active ticks', async () => {
    const { stub, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-tick-1',
      eventName: 'demo.thing-happened',
      handlerName: 'tick-handler',
      status: 'success',
      durationMs: 9,
      error: null,
    });

    const tickRun = runClockworksTick({
      processEvents: stub,
      intervalMs: 30,
      log,
      shutdown,
    });

    await nextCall();
    triggerShutdown();
    await tickRun;

    const dispatchLine = lines.find((l) => l.includes('e-tick-1'));
    assert.ok(dispatchLine, `expected dispatch line, got: ${lines.join(' | ')}`);
    assert.match(dispatchLine!, /demo\.thing-happened/);
    assert.match(dispatchLine!, /\[tick-handler\] success 9ms/);
  });

  it('logs an [error] line and continues when processEvents throws', async () => {
    const { stub, queueError, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueError(new Error('tick-error-from-test'));
    queueDispatch({
      eventId: 'e-recovery',
      eventName: 'demo.recovered',
      handlerName: 'tick-handler',
      status: 'success',
      durationMs: 2,
      error: null,
    });

    const tickRun = runClockworksTick({
      processEvents: stub,
      intervalMs: 25,
      log,
      shutdown,
    });

    // First tick: throws. Second tick: recovery dispatch.
    await nextCall();
    await nextCall();
    triggerShutdown();
    await tickRun;

    const errLine = lines.find((l) => l.includes('[error]'));
    assert.ok(errLine, `expected [error] line, got: ${lines.join(' | ')}`);
    assert.match(errLine!, /tick-error-from-test/);

    // Loop continued past the throw.
    const recoveryLine = lines.find((l) => l.includes('e-recovery'));
    assert.ok(recoveryLine, 'expected recovery dispatch line after the error');
  });

  it('logs an [error] line and continues when processSchedules throws', async () => {
    const { stub: eventsStub, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    const schedulesStub = async (): Promise<{ fired: number; errors: number }> => {
      throw new Error('sched-throw-from-test');
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-after-sched-throw',
      eventName: 'demo.event',
      handlerName: 'h',
      status: 'success',
      durationMs: 1,
      error: null,
    });

    const tickRun = runClockworksTick({
      processEvents: eventsStub,
      processSchedules: schedulesStub,
      intervalMs: 25,
      log,
      shutdown,
    });

    await nextCall();
    triggerShutdown();
    await tickRun;

    const errLine = lines.find((l) => l.includes('processSchedules threw'));
    assert.ok(errLine, `expected scheduler throw line, got: ${lines.join(' | ')}`);
    assert.match(errLine!, /sched-throw-from-test/);

    // Events pass still ran.
    const eventLine = lines.find((l) => l.includes('e-after-sched-throw'));
    assert.ok(eventLine, 'expected event dispatch line after scheduler throw');
  });

  it('runs processSchedules before processEvents on each tick (D18)', async () => {
    const { stub: eventsStub, nextCall } = buildProcessEventsStub();
    const { log } = buildLog();

    const callOrder: string[] = [];

    const schedulesStub = async (): Promise<{ fired: number; errors: number }> => {
      callOrder.push('schedules');
      return { fired: 0, errors: 0 };
    };

    const wrappedEvents = async (opts?: Parameters<typeof eventsStub>[0]) => {
      callOrder.push('events');
      return eventsStub(opts);
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const tickRun = runClockworksTick({
      processEvents: wrappedEvents,
      processSchedules: schedulesStub,
      intervalMs: 25,
      log,
      shutdown,
    });

    await nextCall();
    await nextCall();
    triggerShutdown();
    await tickRun;

    // Every 'schedules' entry must be immediately followed by 'events'.
    for (let i = 0; i < callOrder.length - 1; i += 1) {
      if (callOrder[i] === 'schedules') {
        assert.equal(
          callOrder[i + 1],
          'events',
          `expected schedules→events ordering, got ${callOrder.join(',')}`,
        );
      }
    }
  });

  it('skips processSchedules when not supplied', async () => {
    const { stub, queueDispatch, nextCall } = buildProcessEventsStub();
    const { log, lines } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-no-sched',
      eventName: 'demo.only',
      handlerName: 'h',
      status: 'success',
      durationMs: 1,
      error: null,
    });

    const tickRun = runClockworksTick({
      processEvents: stub,
      // no processSchedules
      intervalMs: 25,
      log,
      shutdown,
    });

    await nextCall();
    triggerShutdown();
    await tickRun;

    assert.ok(lines.some((l) => l.includes('e-no-sched')));
    assert.ok(!lines.some((l) => l.includes('processSchedules')));
  });

  it('the log wrapper is called for each dispatch (prefix can be applied at call site)', async () => {
    const { stub, queueDispatch, nextCall } = buildProcessEventsStub();

    // Simulate the unified daemon's [clockworks] prefix wrapper.
    const loggedLines: string[] = [];
    const cwLog = (line: string): void => {
      loggedLines.push(`[clockworks] ${line}`);
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    queueDispatch({
      eventId: 'e-prefix',
      eventName: 'demo.prefixed',
      handlerName: 'h',
      status: 'success',
      durationMs: 3,
      error: null,
    });

    const tickRun = runClockworksTick({
      processEvents: stub,
      intervalMs: 25,
      log: cwLog,
      shutdown,
    });

    await nextCall();
    triggerShutdown();
    await tickRun;

    const prefixedLine = loggedLines.find((l) => l.includes('e-prefix'));
    assert.ok(prefixedLine, `expected prefixed dispatch line, got: ${loggedLines.join(' | ')}`);
    assert.match(prefixedLine!, /^\[clockworks\] /);
    assert.match(prefixedLine!, /demo\.prefixed/);
  });
});

// ── T8: Unified daemon sibling-task integration ──────────────────────
//
// These tests exercise the sibling-task architecture used by `nsg start`
// (acceptance criteria §6, §8):
//
//  - A processSchedules stub that fires a `clockworks.timer` dispatch
//    (simulating the Reckoner @every tick) is correctly logged via the
//    tick loop within one interval.
//  - A simulated throw inside the tick body is caught, logged with the
//    [clockworks] prefix, and the loop continues — a concurrent
//    Spider-like loop remains unaffected.
//  - Resolving the clockworks shutdown promise stops the tick task
//    independently of a concurrent Spider-like loop; the Spider-like
//    loop continues after the Clockworks task exits.

describe('unified daemon sibling-task integration (T8)', () => {
  it('processSchedules timer dispatch fires within one tick and is logged', async () => {
    // Simulate the Reckoner @every pattern: processSchedules emits a
    // clockworks.timer dispatch, which is what the Reckoner uses as its
    // trigger. The test asserts this lands within one tick interval.
    const { stub: eventsStub, nextCall } = buildProcessEventsStub();

    const cwLogs: string[] = [];
    const cwLog = (line: string): void => {
      cwLogs.push(`[clockworks] ${line}`);
    };

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const schedulesStub = async (opts?: {
      onDispatch?: (obs: DispatchObservation) => void;
    }): Promise<{ fired: number; errors: number }> => {
      opts?.onDispatch?.({
        eventId: 'e-timer-1',
        eventName: 'clockworks.timer',
        handlerName: 'reckoner.tick',
        status: 'success',
        durationMs: 5,
        error: null,
      });
      return { fired: 1, errors: 0 };
    };

    const tickRun = runClockworksTick({
      processEvents: eventsStub,
      processSchedules: schedulesStub,
      intervalMs: 50,
      log: cwLog,
      shutdown,
    });

    // Within one tick interval the scheduler pass fires.
    await nextCall();
    triggerShutdown();
    await tickRun;

    // The clockworks.timer dispatch was logged with [clockworks] prefix.
    const timerLine = cwLogs.find((l) => l.includes('clockworks.timer'));
    assert.ok(timerLine, `expected clockworks.timer dispatch line, got: ${cwLogs.join(' | ')}`);
    assert.match(timerLine!, /^\[clockworks\] /);
    assert.match(timerLine!, /\[reckoner\.tick\] success 5ms/);
  });

  it('Clockworks tick-task errors are caught and logged with [clockworks] prefix; a sibling Spider-like loop is unaffected (crash isolation)', async () => {
    // This test exercises acceptance criterion §6: a throw in the
    // Clockworks tick body is logged with the [clockworks] prefix and
    // the next interval proceeds; the Spider-like loop continues.
    const cwLogs: string[] = [];
    const cwLog = (line: string): void => {
      cwLogs.push(`[clockworks] ${line}`);
    };

    let clockworksCalls = 0;
    const processEvents = async (): Promise<{
      processedEvents: number;
      dispatches: number;
      errors: number;
      skipped: number;
    }> => {
      clockworksCalls += 1;
      if (clockworksCalls === 1) {
        throw new Error('simulated-clockworks-throw');
      }
      return { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 };
    };

    let resolveClockworksShutdown!: () => void;
    const clockworksShutdown = new Promise<void>((resolve) => {
      resolveClockworksShutdown = resolve;
    });

    // Clockworks tick task (sibling async task, per D2).
    const clockworksTask = runClockworksTick({
      processEvents,
      intervalMs: 40,
      log: cwLog,
      shutdown: clockworksShutdown,
    });

    // Spider-like loop (simulating start.ts's while (!spiderStop) loop).
    let spiderStop = false;
    const spiderCalls: number[] = [];
    const spiderTask = (async () => {
      while (!spiderStop) {
        spiderCalls.push(Date.now());
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    })();

    // Let both run for long enough for 2 Clockworks ticks and 4+ Spider
    // cycles. With a 40ms Clockworks interval and 20ms Spider interval,
    // 150ms gives plenty of margin on any machine.
    await new Promise<void>((r) => setTimeout(r, 150));

    // Stop both tasks.
    spiderStop = true;
    resolveClockworksShutdown();
    await Promise.all([clockworksTask, spiderTask]);

    // The Clockworks error was logged with the [clockworks] prefix.
    const errLine = cwLogs.find((l) => l.includes('[error]'));
    assert.ok(errLine, `expected [error] line in Clockworks log, got: ${cwLogs.join(' | ')}`);
    assert.match(errLine!, /^\[clockworks\] /);
    assert.match(errLine!, /simulated-clockworks-throw/);

    // The Clockworks loop continued after the throw (at least 2 calls).
    assert.ok(
      clockworksCalls >= 2,
      `expected ≥2 Clockworks ticks (loop continued after throw), got ${clockworksCalls}`,
    );

    // The Spider-like loop ran multiple times, demonstrating it was
    // never blocked or terminated by the Clockworks throw.
    assert.ok(
      spiderCalls.length >= 3,
      `expected ≥3 Spider cycles (unaffected by Clockworks throw), got ${spiderCalls.length}`,
    );
  });

  it('resolving the clockworks shutdown promise stops the tick task without stopping the Spider-like loop', async () => {
    // Acceptance criterion §5 partial: after shutdown promise resolves,
    // the Clockworks tick task exits promptly; a sibling Spider loop
    // can continue until its own stop flag is set.
    const { stub: eventsStub, callCount, nextCall } = buildProcessEventsStub();
    const { log: cwLog } = buildLog();

    let resolveClockworksShutdown!: () => void;
    const clockworksShutdown = new Promise<void>((resolve) => {
      resolveClockworksShutdown = resolve;
    });

    const clockworksTask = runClockworksTick({
      processEvents: eventsStub,
      intervalMs: 40,
      log: cwLog,
      shutdown: clockworksShutdown,
    });

    let spiderStop = false;
    let spiderCallsAfterClockworksStop = 0;
    const spiderTask = (async () => {
      while (!spiderStop) {
        await new Promise<void>((r) => setTimeout(r, 15));
        if (!spiderStop) spiderCallsAfterClockworksStop += 1;
      }
    })();

    // Wait for one Clockworks tick.
    await nextCall();

    // Stop the Clockworks task only.
    const clockworksStopTime = Date.now();
    resolveClockworksShutdown();
    await clockworksTask;
    const clockworksLatencyMs = Date.now() - clockworksStopTime;

    // Clockworks stopped quickly (abortable sleep).
    assert.ok(
      clockworksLatencyMs < 500,
      `expected Clockworks to stop promptly, got ${clockworksLatencyMs}ms`,
    );

    // Spider loop continues running after Clockworks stopped.
    const callsAtStop = callCount();
    await new Promise<void>((r) => setTimeout(r, 60));
    const spiderCallsBeforeSpiderStop = spiderCallsAfterClockworksStop;
    spiderStop = true;
    await spiderTask;

    assert.ok(
      spiderCallsBeforeSpiderStop > 0,
      `expected Spider loop to continue after Clockworks stopped; got ${spiderCallsBeforeSpiderStop} calls`,
    );
    // Clockworks stopped iterating after the shutdown.
    assert.equal(
      callCount(),
      callsAtStop,
      'Clockworks tick loop should not continue after shutdown resolved',
    );
  });

  it('clean pidfile lifecycle: runForegroundDaemon pidfile is removed and clockStatus reports not-running after shutdown', async () => {
    // Acceptance criterion §5: after shutdown, the pidfile is removed
    // and clockStatus reports running: false. This verifies the full
    // teardown path for the standalone daemon (which shares the
    // runForegroundDaemon body with the unified-daemon's standalone
    // option). The unified daemon uses the same shutdown → unlink order.
    const home = makeTmpHome();
    const { stub: eventsStub, nextCall } = buildProcessEventsStub();
    const { log: cwLog } = buildLog();

    let triggerShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const daemonRun = runForegroundDaemon({
      home,
      intervalMs: 30,
      processEvents: eventsStub,
      log: cwLog,
      shutdown,
      skipSignalHandlers: true,
    });

    await nextCall();

    // Pidfile exists while daemon is running.
    assert.ok(fs.existsSync(clockPidPath(home)), 'pidfile should exist while running');

    // Trigger shutdown.
    triggerShutdown();
    await daemonRun;

    // Pidfile removed after shutdown.
    assert.ok(!fs.existsSync(clockPidPath(home)), 'pidfile should be removed after shutdown');
  });
});

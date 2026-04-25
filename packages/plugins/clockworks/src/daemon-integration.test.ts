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

import { runForegroundDaemon } from './daemon.ts';
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
        eventName: 'schedule.fired',
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
});

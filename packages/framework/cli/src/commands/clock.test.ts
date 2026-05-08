/**
 * Tests for the hand-written `nsg clock list/tick/run` framework CLI
 * command.
 *
 * Two surfaces:
 *
 * 1. **Handler unit tests** — exercise `runList`, `runTick`, and
 *    `runRun` directly against a stub guild that supplies an in-memory
 *    `ClockworksApi` and `StacksApi`. Cover empty-queue messages,
 *    list rendering with and without null payload, `--include-processed`,
 *    `--limit`, tick missing-id and already-processed-id paths,
 *    exit-code 0 vs nonzero, observer printing, run-loops-until-empty.
 *
 * 2. **Commander integration tier** — build the Command from
 *    `buildClockCommand()` and exercise arg parsing via
 *    `parseAsync(['<args>'], { from: 'user' })`.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import {
  buildClockCommand,
  formatDispatchLine,
  formatEventBlock,
  renderPayloadPreview,
  runList,
  runRun,
  runStatus,
  runTick,
} from './clock.ts';
import { customFrameworkCommands } from './index.ts';

// ── Stub apparatus types ─────────────────────────────────────────────

interface DispatchObservationLike {
  eventId: string;
  eventName: string;
  handlerName: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  error: string | null;
}

interface ProcessEventsOptionsLike {
  eventId?: string;
  max?: number;
  onDispatch?: (observation: DispatchObservationLike) => void;
}

interface StoredEvent {
  id: string;
  name: string;
  payload: unknown;
  emitter: string;
  firedAt: string;
  processed: boolean;
}

interface StubFixture {
  events: StoredEvent[];
  /** Standing-order map: event name → list of (handlerName, status, error) tuples. */
  orders: Map<string, Array<{ handler: string; status: 'success' | 'error' | 'skipped'; error: string | null; durationMs: number }>>;
  /** Total processEvents() invocations — useful for run-loops asserts. */
  processCalls: number;
}

/**
 * Build a temp-dir home — used by tests that exercise the daemon
 * coexistence warning or `runStatus`. `clockStatus` reads
 * `<home>/.nexus/clock.pid`, so the path needs to be a real directory
 * we control.
 */
function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-clock-test-'));
}

function setupStubGuild(fixture: StubFixture, home = '/tmp/test-guild'): void {
  const apparatusMap = new Map<string, unknown>();

  const eventsBook = {
    async get(id: string): Promise<StoredEvent | null> {
      return fixture.events.find((e) => e.id === id) ?? null;
    },
    async find(query: {
      where?: Array<[string, string, unknown]>;
      orderBy?: Array<[string, 'asc' | 'desc']>;
      limit?: number;
    }): Promise<StoredEvent[]> {
      let result = [...fixture.events];
      if (query.where) {
        for (const [field, op, value] of query.where) {
          if (op === '=') {
            result = result.filter(
              (e) => (e as unknown as Record<string, unknown>)[field] === value,
            );
          }
        }
      }
      if (query.orderBy) {
        for (const [field, dir] of query.orderBy) {
          result.sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[field];
            const bv = (b as unknown as Record<string, unknown>)[field];
            if (av === bv) return 0;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
      }
      if (query.limit !== undefined) {
        result = result.slice(0, query.limit);
      }
      return result;
    },
    async list(options?: {
      orderBy?: Array<[string, 'asc' | 'desc']>;
      limit?: number;
    }): Promise<StoredEvent[]> {
      let result = [...fixture.events];
      if (options?.orderBy) {
        for (const [field, dir] of options.orderBy) {
          result.sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[field];
            const bv = (b as unknown as Record<string, unknown>)[field];
            if (av === bv) return 0;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
      }
      if (options?.limit !== undefined) {
        result = result.slice(0, options.limit);
      }
      return result;
    },
  };

  const stacks = {
    book(): typeof eventsBook {
      return eventsBook;
    },
  };
  apparatusMap.set('stacks', stacks);

  const clockworks = {
    async processEvents(opts?: ProcessEventsOptionsLike): Promise<{
      processedEvents: number;
      dispatches: number;
      errors: number;
      skipped: number;
    }> {
      fixture.processCalls += 1;
      let candidates = fixture.events.filter((e) => !e.processed);
      if (opts?.eventId !== undefined) {
        candidates = candidates.filter((e) => e.id === opts.eventId);
      }
      candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (opts?.max !== undefined && opts.max > 0) {
        candidates = candidates.slice(0, opts.max);
      }
      let processedEvents = 0;
      let dispatches = 0;
      let errors = 0;
      let skipped = 0;
      for (const ev of candidates) {
        const matchedOrders = fixture.orders.get(ev.name) ?? [];
        for (const order of matchedOrders) {
          dispatches += 1;
          if (order.status === 'error') errors += 1;
          if (order.status === 'skipped') skipped += 1;
          opts?.onDispatch?.({
            eventId: ev.id,
            eventName: ev.name,
            handlerName: order.handler,
            status: order.status,
            durationMs: order.durationMs,
            error: order.error,
          });
        }
        ev.processed = true;
        processedEvents += 1;
      }
      return { processedEvents, dispatches, errors, skipped };
    },
  };
  apparatusMap.set('clockworks', clockworks);

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home,
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

function makeFixture(): StubFixture {
  return { events: [], orders: new Map(), processCalls: 0 };
}

afterEach(() => clearGuild());

// ── Unit-level helpers (renderers) ───────────────────────────────────

describe('renderPayloadPreview', () => {
  it('returns null for a null payload (D19)', () => {
    assert.equal(renderPayloadPreview(null), null);
  });

  it('returns the JSON string when below the truncation threshold', () => {
    assert.equal(renderPayloadPreview({ a: 1 }), '{"a":1}');
  });

  it('truncates with a trailing ellipsis when the JSON exceeds ~120 chars', () => {
    const big = { value: 'x'.repeat(300) };
    const out = renderPayloadPreview(big);
    assert.ok(out !== null);
    assert.ok(out.endsWith('…'));
    assert.equal(out.length, 120);
  });

  it('renders array payloads', () => {
    assert.equal(renderPayloadPreview([1, 2, 3]), '[1,2,3]');
  });

  it('handles primitive payloads', () => {
    assert.equal(renderPayloadPreview(42), '42');
    assert.equal(renderPayloadPreview('hi'), '"hi"');
    assert.equal(renderPayloadPreview(true), 'true');
  });
});

describe('formatEventBlock', () => {
  it('renders a single line when the payload is null', () => {
    const out = formatEventBlock({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'tester',
      firedAt: '2026-01-01T00:00:00.000Z',
      processed: false,
    });
    assert.equal(out, 'e-1  demo.x  tester  2026-01-01T00:00:00.000Z');
    assert.equal(out.includes('\n'), false);
  });

  it('renders a two-line block when the payload is non-null', () => {
    const out = formatEventBlock({
      id: 'e-2',
      name: 'demo.y',
      payload: { foo: 'bar' },
      emitter: 'tester',
      firedAt: '2026-01-01T00:00:01.000Z',
      processed: false,
    });
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'e-2  demo.y  tester  2026-01-01T00:00:01.000Z');
    assert.equal(lines[1], '  payload: {"foo":"bar"}');
  });
});

describe('formatDispatchLine', () => {
  it('renders the success format (D10)', () => {
    assert.equal(
      formatDispatchLine({
        eventId: 'e-1',
        eventName: 'demo.x',
        handlerName: 'r',
        status: 'success',
        durationMs: 12,
        error: null,
      }),
      '[r] success 12ms',
    );
  });

  it('appends the error message on the same line for failed dispatches', () => {
    assert.equal(
      formatDispatchLine({
        eventId: 'e-1',
        eventName: 'demo.x',
        handlerName: 'r',
        status: 'error',
        durationMs: 4,
        error: 'boom',
      }),
      '[r] error 4ms: boom',
    );
  });

  it('renders skipped dispatches with the loop-guard reason (no durationMs)', () => {
    assert.equal(
      formatDispatchLine({
        eventId: 'e-1',
        eventName: 'clockworks.standing-order.failed',
        handlerName: 'react-to-fail',
        status: 'skipped',
        durationMs: 0,
        error: 'loop-guard: triggering event was a clockworks.standing-order.failed',
      }),
      '[react-to-fail] skipped: loop-guard: triggering event was a clockworks.standing-order.failed',
    );
  });

  it('renders skipped dispatches with no reason when error is null', () => {
    assert.equal(
      formatDispatchLine({
        eventId: 'e-1',
        eventName: 'clockworks.standing-order.failed',
        handlerName: 'react-to-fail',
        status: 'skipped',
        durationMs: 0,
        error: null,
      }),
      '[react-to-fail] skipped',
    );
  });
});

// ── runList ──────────────────────────────────────────────────────────

describe('runList', () => {
  it('prints the empty-queue message and reports empty=true (D13)', async () => {
    setupStubGuild(makeFixture());
    const out = await runList({});
    assert.deepEqual(out.lines, ['No pending events.']);
    assert.equal(out.empty, true);
    assert.equal(out.count, 0);
  });

  it('renders pending events in id order, two-line for non-null payload', async () => {
    const fix = makeFixture();
    fix.events.push(
      {
        id: 'e-001',
        name: 'demo.a',
        payload: null,
        emitter: 'p1',
        firedAt: '2026-01-01T00:00:00.000Z',
        processed: false,
      },
      {
        id: 'e-002',
        name: 'demo.b',
        payload: { v: 1 },
        emitter: 'p2',
        firedAt: '2026-01-01T00:00:01.000Z',
        processed: false,
      },
    );
    setupStubGuild(fix);

    const out = await runList({});
    assert.equal(out.count, 2);
    assert.deepEqual(out.lines, [
      'e-001  demo.a  p1  2026-01-01T00:00:00.000Z',
      'e-002  demo.b  p2  2026-01-01T00:00:01.000Z\n  payload: {"v":1}',
    ]);
  });

  it('omits processed events by default', async () => {
    const fix = makeFixture();
    fix.events.push(
      {
        id: 'e-1',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't1',
        processed: true,
      },
      {
        id: 'e-2',
        name: 'demo.y',
        payload: null,
        emitter: 'p',
        firedAt: 't2',
        processed: false,
      },
    );
    setupStubGuild(fix);

    const out = await runList({});
    assert.equal(out.count, 1);
    assert.match(out.lines[0], /e-2/);
  });

  it('--include-processed shows processed and pending events', async () => {
    const fix = makeFixture();
    fix.events.push(
      {
        id: 'e-1',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't1',
        processed: true,
      },
      {
        id: 'e-2',
        name: 'demo.y',
        payload: null,
        emitter: 'p',
        firedAt: 't2',
        processed: false,
      },
    );
    setupStubGuild(fix);

    const out = await runList({ includeProcessed: true });
    assert.equal(out.count, 2);
  });

  it('--limit caps the output (D12)', async () => {
    const fix = makeFixture();
    for (let i = 0; i < 5; i += 1) {
      fix.events.push({
        id: `e-${i}`,
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: `t${i}`,
        processed: false,
      });
    }
    setupStubGuild(fix);

    const out = await runList({ limit: 2 });
    assert.equal(out.count, 2);
  });

  it('without --limit prints every event', async () => {
    const fix = makeFixture();
    for (let i = 0; i < 7; i += 1) {
      fix.events.push({
        id: `e-${i}`,
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: `t${i}`,
        processed: false,
      });
    }
    setupStubGuild(fix);

    const out = await runList({});
    assert.equal(out.count, 7);
  });

  it('errors out when no guild is loaded', async () => {
    clearGuild();
    await assert.rejects(() => runList({}), /Not inside a guild/);
  });
});

// ── runTick ──────────────────────────────────────────────────────────

describe('runTick', () => {
  it('prints the empty-queue message on an empty queue and exits 0 (D13)', async () => {
    setupStubGuild(makeFixture());
    const out = await runTick({});
    assert.deepEqual(out.lines, ['Queue is empty; nothing to process.']);
    assert.equal(out.empty, true);
    assert.equal(out.hadError, false);
  });

  it('processes the next pending event and prints per-dispatch summaries (D10)', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't1',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r1', status: 'success', error: null, durationMs: 5 },
    ]);
    setupStubGuild(fix);

    const out = await runTick({});
    assert.deepEqual(out.lines, ['[r1] success 5ms']);
    assert.equal(out.hadError, false);
  });

  it('reports the (no matching standing orders) line when applicable (D16)', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'orphan.event',
      payload: null,
      emitter: 'p',
      firedAt: 't1',
      processed: false,
    });
    setupStubGuild(fix);

    const out = await runTick({});
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /e-1 orphan\.event \(no matching standing orders\)/);
    // D20: zero matches is exit 0.
    assert.equal(out.hadError, false);
  });

  it('processes an explicit event id', async () => {
    const fix = makeFixture();
    fix.events.push(
      {
        id: 'e-1',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't1',
        processed: false,
      },
      {
        id: 'e-2',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't2',
        processed: false,
      },
    );
    fix.orders.set('demo.x', [
      { handler: 'r1', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix);

    const out = await runTick({ eventId: 'e-2' });
    assert.equal(out.hadError, false);
    assert.deepEqual(out.lines, ['[r1] success 1ms']);
    // e-1 is still pending.
    assert.equal(fix.events.find((e) => e.id === 'e-1')!.processed, false);
    assert.equal(fix.events.find((e) => e.id === 'e-2')!.processed, true);
  });

  it('errors with the exact missing-id message (D15) and reports notFound', async () => {
    setupStubGuild(makeFixture());
    const out = await runTick({ eventId: 'e-missing' });
    assert.equal(out.notFound, true);
    assert.equal(out.hadError, true);
    assert.deepEqual(out.lines, [
      'Error: clockworks: event "e-missing" not found in events book.',
    ]);
  });

  it('warns when the targeted event is already processed and reports nonzero exit', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-done',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: true,
    });
    setupStubGuild(fix);

    const out = await runTick({ eventId: 'e-done' });
    assert.equal(out.alreadyProcessed, true);
    assert.equal(out.hadError, true);
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /Warning:.*already been processed/);
  });

  it('hadError=true when at least one dispatch records status:error', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.boom',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.boom', [
      { handler: 'r1', status: 'success', error: null, durationMs: 1 },
      { handler: 'r2', status: 'error', error: 'boom!', durationMs: 2 },
    ]);
    setupStubGuild(fix);

    const out = await runTick({});
    assert.equal(out.hadError, true);
    assert.deepEqual(out.lines, [
      '[r1] success 1ms',
      '[r2] error 2ms: boom!',
    ]);
  });

  it('renders a skipped dispatch line and reports hadError=false (loop-guard skip stays exit 0)', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'clockworks.standing-order.failed',
      payload: null,
      emitter: 'framework',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('clockworks.standing-order.failed', [
      {
        handler: 'react-to-fail',
        status: 'skipped',
        error: 'loop-guard: triggering event was a clockworks.standing-order.failed',
        durationMs: 0,
      },
    ]);
    setupStubGuild(fix);

    const out = await runTick({});
    // hadError stays false for a skip-only sweep (exit 0).
    assert.equal(out.hadError, false);
    assert.deepEqual(out.lines, [
      '[react-to-fail] skipped: loop-guard: triggering event was a clockworks.standing-order.failed',
    ]);
  });
});

// ── runRun ───────────────────────────────────────────────────────────

describe('runRun', () => {
  it('prints the empty-queue message and exits 0 (D13)', async () => {
    setupStubGuild(makeFixture());
    const out = await runRun();
    assert.deepEqual(out.lines, ['Queue is empty; processed 0 events.']);
    assert.equal(out.empty, true);
    assert.equal(out.totalProcessed, 0);
    assert.equal(out.hadError, false);
  });

  it('drains the queue and prints the final processed-N-events line', async () => {
    const fix = makeFixture();
    for (let i = 0; i < 3; i += 1) {
      fix.events.push({
        id: `e-${i}`,
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: `t${i}`,
        processed: false,
      });
    }
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix);

    const out = await runRun();
    assert.equal(out.totalProcessed, 3);
    assert.equal(out.hadError, false);
    // Every dispatch line, then the final summary.
    const last = out.lines[out.lines.length - 1];
    assert.equal(last, 'processed 3 events');
    const dispatchLines = out.lines.slice(0, -1);
    assert.equal(dispatchLines.length, 3);
    assert.ok(dispatchLines.every((l) => l === '[r] success 1ms'));
  });

  it('keeps looping until the queue is empty (mid-sweep arrivals are picked up)', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't1',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix);

    // Replace the stub processEvents with one that injects a fresh
    // event after the first sweep, simulating a mid-drain emit.
    let calls = 0;
    const apparatusMap = new Map<string, unknown>();
    const eventsBook = {
      async get(): Promise<null> { return null; },
      async find(): Promise<StoredEvent[]> {
        return fix.events.filter((e) => !e.processed);
      },
      async list(): Promise<StoredEvent[]> { return fix.events; },
    };
    const stacks = { book(): typeof eventsBook { return eventsBook; } };
    apparatusMap.set('stacks', stacks);
    apparatusMap.set('clockworks', {
      async processEvents(opts?: ProcessEventsOptionsLike): Promise<{
        processedEvents: number; dispatches: number; errors: number; skipped: number;
      }> {
        calls += 1;
        const toProcess = fix.events.filter((e) => !e.processed);
        for (const ev of toProcess) {
          const orders = fix.orders.get(ev.name) ?? [];
          for (const order of orders) {
            opts?.onDispatch?.({
              eventId: ev.id, eventName: ev.name, handlerName: order.handler,
              status: order.status, durationMs: order.durationMs, error: order.error,
            });
          }
          ev.processed = true;
        }
        // After the first sweep, simulate a relay emit by appending a
        // brand-new pending event so the next iteration picks it up.
        if (calls === 1) {
          fix.events.push({
            id: 'e-2',
            name: 'demo.x',
            payload: null,
            emitter: 'relay',
            firedAt: 't2',
            processed: false,
          });
        }
        return {
          processedEvents: toProcess.length,
          dispatches: toProcess.reduce(
            (n, e) => n + (fix.orders.get(e.name)?.length ?? 0),
            0,
          ),
          errors: 0,
          skipped: 0,
        };
      },
    });
    setGuild({
      home: '/tmp/test',
      apparatus<T>(name: string): T {
        const api = apparatusMap.get(name);
        if (!api) throw new Error(`Apparatus "${name}" not installed`);
        return api as T;
      },

      tryApparatus<T>(name: string): T | null {
        try { return this.apparatus<T>(name); } catch { return null; }
      },
      config<T>(): T { return {} as T; },
      writeConfig(): void {},
      guildConfig(): GuildConfig {
        return { name: 't', nexus: '0.0.0', plugins: [] };
      },
      kits() { return []; },
      apparatuses() { return []; },
      failedPlugins() { return []; },
      startupWarnings() { return []; },
    });

    const out = await runRun();
    // First sweep processes e-1, second sweep picks up the
    // mid-drain-emitted e-2, third sweep returns zero and breaks.
    assert.equal(calls, 3);
    assert.equal(out.totalProcessed, 2);
    assert.equal(out.lines[out.lines.length - 1], 'processed 2 events');
  });

  it('reports the (no matching standing orders) line during run when an event has no orders', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'orphan.event',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    setupStubGuild(fix);

    const out = await runRun();
    // First the no-match line, then the final summary.
    assert.equal(out.lines.length, 2);
    assert.match(out.lines[0], /e-1 orphan\.event \(no matching standing orders\)/);
    assert.equal(out.lines[1], 'processed 1 events');
    assert.equal(out.hadError, false);
  });

  it('renders a skipped line during run and reports hadError=false (skip-only sweep stays exit 0)', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'clockworks.standing-order.failed',
      payload: null,
      emitter: 'framework',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('clockworks.standing-order.failed', [
      {
        handler: 'react-to-fail',
        status: 'skipped',
        error: 'loop-guard: triggering event was a clockworks.standing-order.failed',
        durationMs: 0,
      },
    ]);
    setupStubGuild(fix);

    const out = await runRun();
    assert.equal(out.hadError, false);
    // Skipped dispatch line followed by the run summary; no error
    // suffix flips the exit code.
    assert.deepEqual(out.lines, [
      '[react-to-fail] skipped: loop-guard: triggering event was a clockworks.standing-order.failed',
      'processed 1 events',
    ]);
  });

  it('hadError=true when any dispatch in any iteration was an error', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'error', error: 'kaboom', durationMs: 1 },
    ]);
    setupStubGuild(fix);

    const out = await runRun();
    assert.equal(out.hadError, true);
    assert.deepEqual(out.lines, [
      '[r] error 1ms: kaboom',
      'processed 1 events',
    ]);
  });
});

// ── Commander Command shape ──────────────────────────────────────────

describe('buildClockCommand', () => {
  it('registers all six subcommands under `clock`', () => {
    const cmd = buildClockCommand();
    assert.equal(cmd.name(), 'clock');
    const subs = cmd.commands.map((c) => c.name()).sort();
    assert.deepEqual(subs, ['list', 'run', 'start', 'status', 'stop', 'tick']);
  });

  it('list exposes --include-processed and --limit', () => {
    const cmd = buildClockCommand();
    const list = cmd.commands.find((c) => c.name() === 'list')!;
    const flags = list.options.map((o) => o.long).sort();
    assert.deepEqual(flags, ['--include-processed', '--limit']);
  });

  it('tick declares [id] as an optional positional', () => {
    const cmd = buildClockCommand();
    const tick = cmd.commands.find((c) => c.name() === 'tick')!;
    assert.equal(tick.registeredArguments.length, 1);
    assert.equal(tick.registeredArguments[0].name(), 'id');
    assert.equal(tick.registeredArguments[0].required, false);
  });

  it('run takes no positional arguments and no flags', () => {
    const cmd = buildClockCommand();
    const run = cmd.commands.find((c) => c.name() === 'run')!;
    assert.equal(run.registeredArguments.length, 0);
    assert.equal(run.options.length, 0);
  });

  it('list parseAsync prints empty-queue line through the action wrapper', async () => {
    setupStubGuild(makeFixture());
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['list'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(lines, ['No pending events.']);
  });

  it('list --limit rejects non-integer values', async () => {
    setupStubGuild(makeFixture());
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]): void => { errs.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(
        () => cmd.parseAsync(['list', '--limit', 'abc'], { from: 'user' }),
      );
    } finally {
      console.error = origErr;
    }
  });

  it('tick parseAsync routes the next-pending mode through processEvents', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['tick'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(lines, ['[r] success 1ms']);
  });

  it('tick <id> parseAsync routes the explicit-id mode through processEvents', async () => {
    const fix = makeFixture();
    fix.events.push(
      {
        id: 'e-A',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't1',
        processed: false,
      },
      {
        id: 'e-B',
        name: 'demo.x',
        payload: null,
        emitter: 'p',
        firedAt: 't2',
        processed: false,
      },
    );
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 7 },
    ]);
    setupStubGuild(fix);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['tick', 'e-B'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(lines, ['[r] success 7ms']);
    assert.equal(fix.events.find((e) => e.id === 'e-A')!.processed, false);
    assert.equal(fix.events.find((e) => e.id === 'e-B')!.processed, true);
  });

  it('run parseAsync drains the queue and prints the summary line', async () => {
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['run'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    assert.equal(lines[lines.length - 1], 'processed 1 events');
  });
});

// ── Daemon coexistence warning ───────────────────────────────────────

describe('daemon coexistence warning', () => {
  /**
   * Write a pidfile pointing at the live test process so
   * `clockStatus(home)` returns `running: true`. Returns the file path
   * for cleanup.
   */
  function fakeRunningDaemon(home: string): string {
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'clock.pid');
    fs.writeFileSync(file, String(process.pid), 'utf-8');
    return file;
  }

  it('runTick emits a warning when the daemon is running', async () => {
    const home = makeTmpHome();
    fakeRunningDaemon(home);
    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix, home);

    const out = await runTick({});
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /clockworks daemon is running/);
    assert.match(out.warnings[0], /pid \d+/);
    // The dispatch still happened.
    assert.deepEqual(out.lines, ['[r] success 1ms']);
  });

  it('runTick emits no warnings when the daemon is not running', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const out = await runTick({});
    assert.deepEqual(out.warnings, []);
  });

  it('runRun emits a warning when the daemon is running', async () => {
    const home = makeTmpHome();
    fakeRunningDaemon(home);
    setupStubGuild(makeFixture(), home);
    const out = await runRun();
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /clockworks daemon is running/);
  });

  it('runRun emits no warnings when the daemon is not running', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const out = await runRun();
    assert.deepEqual(out.warnings, []);
  });
});

// ── runStatus ────────────────────────────────────────────────────────

describe('runStatus', () => {
  function fakeRunningDaemon(home: string): void {
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), String(process.pid), 'utf-8');
  }

  it('plain text when not running', () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const out = runStatus({});
    assert.deepEqual(out.lines, ['Clockworks daemon: not running.']);
    assert.equal(out.status.running, false);
  });

  it('plain text when running shows Host, PID, log file, uptime (standalone)', () => {
    const home = makeTmpHome();
    fakeRunningDaemon(home);
    setupStubGuild(makeFixture(), home);
    const out = runStatus({});
    assert.equal(out.status.running, true);
    assert.equal(out.status.host, 'standalone');
    assert.match(out.lines[0], /running/);
    assert.match(out.lines[1], /Host:.*standalone/);
    assert.match(out.lines[2], new RegExp(`PID:\\s+${process.pid}`));
    assert.match(out.lines[3], /Log file:.*clock\.log/);
    assert.match(out.lines[4], /Uptime:\s+\d+/);
  });

  it('plain text when running under the unified guild daemon shows guild-daemon host', () => {
    const home = makeTmpHome();
    // Write daemon.pid pointing at a live process — no clock.pid.
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid), 'utf-8');
    setupStubGuild(makeFixture(), home);
    const out = runStatus({});
    assert.equal(out.status.running, true);
    assert.equal(out.status.host, 'guild-daemon');
    assert.match(out.lines[0], /running/);
    assert.match(out.lines[1], /Host:.*unified guild daemon/);
    assert.match(out.lines[2], new RegExp(`PID:\\s+${process.pid}`));
    assert.match(out.lines[3], /Log file:.*daemon\.out/);
    assert.match(out.lines[4], /Uptime:\s+\d+/);
  });

  it('--json emits the structured status as JSON', () => {
    const home = makeTmpHome();
    fakeRunningDaemon(home);
    setupStubGuild(makeFixture(), home);
    const out = runStatus({ json: true });
    const parsed = JSON.parse(out.lines[0]);
    assert.equal(parsed.running, true);
    assert.equal(parsed.pid, process.pid);
    assert.match(parsed.logFile, /clock\.log$/);
    assert.equal(typeof parsed.uptime, 'number');
  });

  it('reports stale-pidfile cleanup in the not-running branch', () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), '999999999', 'utf-8');
    setupStubGuild(makeFixture(), home);

    const out = runStatus({});
    assert.equal(out.status.running, false);
    assert.equal(out.status.stalePidfile, true);
    assert.match(out.lines.join('\n'), /Stale pidfile detected and removed/);
    // Subsequent call no longer reports staleness.
    setupStubGuild(makeFixture(), home);
    const followup = runStatus({});
    assert.equal(followup.status.stalePidfile, undefined);
  });
});

// ── Commander integration for new subcommands ────────────────────────

describe('buildClockCommand — start/stop/status', () => {
  it('start exposes --interval and --foreground', () => {
    const cmd = buildClockCommand();
    const start = cmd.commands.find((c) => c.name() === 'start')!;
    const flags = start.options.map((o) => o.long).sort();
    assert.deepEqual(flags, ['--foreground', '--interval']);
  });

  it('start --interval rejects non-integer values', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]): void => { errs.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(
        () => cmd.parseAsync(['start', '--interval', 'abc'], { from: 'user' }),
      );
    } finally {
      console.error = origErr;
    }
  });

  it('status takes no positional and a --json flag', () => {
    const cmd = buildClockCommand();
    const status = cmd.commands.find((c) => c.name() === 'status')!;
    assert.equal(status.registeredArguments.length, 0);
    const flags = status.options.map((o) => o.long);
    assert.deepEqual(flags, ['--json']);
  });

  it('status parseAsync prints the not-running line through the action wrapper', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['status'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(lines, ['Clockworks daemon: not running.']);
  });

  it('status --json parseAsync emits the structured payload', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['status', '--json'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(lines.join('\n'));
    assert.deepEqual(parsed, { running: false });
  });

  it('stop parseAsync exits zero with a guild-daemon message when unified daemon is running', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    // daemon.pid is live; no clock.pid — so clockStop returns 'guild-daemon'.
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid), 'utf-8');
    setupStubGuild(makeFixture(), home);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const stdout: string[] = [];
    const origLog = console.log;
    const origExit = process.exit;
    let exitCode: number | string | undefined | null = null;
    process.exit = ((code?: number | string | null) => {
      exitCode = code;
      throw new Error('process.exit-stub');
    }) as never;
    console.log = (...args: unknown[]): void => { stdout.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['stop'], { from: 'user' });
      assert.equal(exitCode, null, 'process.exit should not be called for guild-daemon branch');
      assert.ok(
        stdout.some((l) => /unified guild daemon/i.test(l)),
        `expected a 'guild daemon' message on stdout, got: ${stdout.join(' | ')}`,
      );
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
  });

  it('stop parseAsync exits zero with a message when no daemon is running', async () => {
    const home = makeTmpHome();
    setupStubGuild(makeFixture(), home);
    const cmd = buildClockCommand();
    cmd.exitOverride();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode: number | string | undefined | null = null;
    // Capture process.exit calls (the action wrapper does not call it
    // on success, but we want to be able to fail the test if it does).
    process.exit = ((code?: number | string | null) => {
      exitCode = code;
      throw new Error('process.exit-stub');
    }) as never;
    console.log = (...args: unknown[]): void => { stdout.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]): void => { stderr.push(args.map(String).join(' ')); };
    try {
      // No throw expected: missing pidfile is exit-zero behavior.
      await cmd.parseAsync(['stop'], { from: 'user' });
      assert.equal(exitCode, null, 'process.exit should not be called on the no-pidfile branch');
      assert.deepEqual(stderr, []);
      assert.ok(
        stdout.some((l) => /not running/i.test(l)),
        `expected a 'not running' message on stdout, got: ${stdout.join(' | ')}`,
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    }
  });

  it('stop parseAsync exits zero with a message when the pidfile is stale', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    const pidFilePath = path.join(dir, 'clock.pid');
    fs.writeFileSync(pidFilePath, '999999999', 'utf-8');
    setupStubGuild(makeFixture(), home);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const stdout: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => { stdout.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['stop'], { from: 'user' });
      assert.ok(
        stdout.some((l) => /stale pidfile/i.test(l)),
        `expected a 'stale pidfile' message, got: ${stdout.join(' | ')}`,
      );
      // The stale pidfile should be cleaned up as a side effect.
      assert.equal(fs.existsSync(pidFilePath), false);
    } finally {
      console.log = origLog;
    }
  });

  it('start parseAsync exits nonzero (D3) when the unified guild daemon is running', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    // daemon.pid is live; no clock.pid — D3 guard fires in clockStart.
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid), 'utf-8');
    setupStubGuild(makeFixture(), home);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const errs: string[] = [];
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode: number | string | undefined | null = null;
    process.exit = ((code?: number | string | null) => {
      exitCode = code;
      throw new Error('process.exit-stub');
    }) as never;
    console.error = (...args: unknown[]): void => { errs.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(
        () => cmd.parseAsync(['start'], { from: 'user' }),
        /process\.exit-stub/,
      );
      assert.equal(exitCode, 1);
      assert.ok(
        errs.some((e) => /unified guild daemon/i.test(e)),
        `expected a 'unified guild daemon' error, got: ${errs.join(' | ')}`,
      );
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
  });

  it('start parseAsync exits nonzero when a daemon is already running', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), String(process.pid), 'utf-8');
    setupStubGuild(makeFixture(), home);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const errs: string[] = [];
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode: number | string | undefined | null = null;
    process.exit = ((code?: number | string | null) => {
      exitCode = code;
      throw new Error('process.exit-stub');
    }) as never;
    console.error = (...args: unknown[]): void => { errs.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(
        () => cmd.parseAsync(['start'], { from: 'user' }),
        /process\.exit-stub/,
      );
      assert.equal(exitCode, 1);
      assert.ok(
        errs.some((e) => /already running/i.test(e)),
        `expected an 'already running' error, got: ${errs.join(' | ')}`,
      );
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
  });

  it('tick parseAsync writes the daemon-coexistence warning to stderr', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), String(process.pid), 'utf-8');

    const fix = makeFixture();
    fix.events.push({
      id: 'e-1',
      name: 'demo.x',
      payload: null,
      emitter: 'p',
      firedAt: 't',
      processed: false,
    });
    fix.orders.set('demo.x', [
      { handler: 'r', status: 'success', error: null, durationMs: 1 },
    ]);
    setupStubGuild(fix, home);

    const cmd = buildClockCommand();
    cmd.exitOverride();
    const stderr: string[] = [];
    const stdout: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...args: unknown[]): void => { stderr.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]): void => { stdout.push(args.map(String).join(' ')); };
    try {
      await cmd.parseAsync(['tick'], { from: 'user' });
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    assert.ok(
      stderr.some((l) => /clockworks daemon is running/.test(l)),
      `expected daemon warning on stderr, got: ${stderr.join(' | ')}`,
    );
    assert.deepEqual(stdout, ['[r] success 1ms']);
  });
});

// ── Custom-command registration ──────────────────────────────────────

describe('customFrameworkCommands export', () => {
  it('includes the clock command builder', () => {
    const names = customFrameworkCommands.map((b) => b().name()).sort();
    assert.ok(names.includes('clock'));
  });
});

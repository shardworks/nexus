/**
 * Scheduler unit tests.
 *
 * The scheduler primitive is pure — every dependency (schedule table,
 * events / dispatches books, relay resolver, home, virtual clock,
 * observer, SOF callback) is parameter-injected. Tests use a real
 * in-memory `MemoryBackend` so the scheduler exercises the production
 * Stacks `put` / `find` semantics, plus a controllable `now()` factory
 * so fire times are deterministic.
 *
 * Coverage:
 *   - empty schedule → no fires
 *   - single `@every` order fires once it becomes due (D8 startup)
 *   - cron order fires at the natural boundary (D9)
 *   - persisted shape: events row has processed=true, payload mirrors
 *     D2, dispatches row goes through the existing helper (D5)
 *   - sequential ordering by orderIndex when multiple are due (D13)
 *   - thrown handler emits SOF and writes an error dispatch row (D15)
 *   - unresolved relay emits SOF and writes an error dispatch row
 *   - in-tick guard: at most one fire per order per tick even when
 *     multiple intervals have elapsed (D10)
 *   - observer hook: fires once per dispatch row, isolated from throws
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearGuild,
  generateId,
  setGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import { computeNextFireTime, parseSchedule } from './schedule-parser.ts';
import {
  runScheduleSweep,
  type ScheduleEntry,
} from './scheduler.ts';
import { relay, type RelayDefinition } from './relay.ts';
import type {
  DispatchObservation,
  EventDispatchDoc,
  EventDoc,
  StandingOrder,
} from './types.ts';
import type { StandingOrderFailedPayload } from './dispatcher.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface SchedulerFixture {
  events: Book<EventDoc>;
  dispatches: Book<EventDispatchDoc>;
  resolveRelay: (name: string) => RelayDefinition | undefined;
  registerRelay: (def: RelayDefinition) => void;
  allEvents: () => Promise<EventDoc[]>;
  allDispatches: () => Promise<EventDispatchDoc[]>;
}

async function buildFixture(): Promise<SchedulerFixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');

  const guildConfig: GuildConfig = { name: 't', nexus: '0.0.0', plugins: [] };
  const fakeGuild: Guild = {
    home: '/tmp/scheduler-test',
    apparatus<T>(name: string): T {
      throw new Error(`Apparatus "${name}" not installed`);
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  await stacksPlugin.apparatus.start({
    on(): void {},
    kits(): never[] { return []; },
  });
  const stacks = stacksPlugin.apparatus.provides as StacksApi;

  backend.ensureBook(
    { ownerId: 'clockworks', book: 'events' },
    { indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']] },
  );
  backend.ensureBook(
    { ownerId: 'clockworks', book: 'event_dispatches' },
    { indexes: ['eventId', 'status', ['eventId', 'status']] },
  );

  const events = stacks.book<EventDoc>('clockworks', 'events');
  const dispatches = stacks.book<EventDispatchDoc>(
    'clockworks',
    'event_dispatches',
  );

  const registry = new Map<string, RelayDefinition>();
  return {
    events,
    dispatches,
    resolveRelay: (name) => registry.get(name),
    registerRelay: (def) => { registry.set(def.name, def); },
    async allEvents(): Promise<EventDoc[]> {
      return events.list({ orderBy: [['id', 'asc']] });
    },
    async allDispatches(): Promise<EventDispatchDoc[]> {
      return dispatches.list({ orderBy: [['startedAt', 'asc']] });
    },
  };
}

/**
 * Build a schedule entry for a `@every` or cron expression. The
 * `nextFireTime` defaults to `start + duration` (matching the
 * apparatus's start-time seeding via `computeNextFireTime`).
 */
function buildEntry(
  orderIndex: number,
  order: StandingOrder,
  start: Date = new Date('2026-01-01T00:00:00Z'),
): ScheduleEntry {
  const expr = (order as { schedule?: string }).schedule;
  if (typeof expr !== 'string') {
    throw new Error('buildEntry expects a `schedule:` field on the order.');
  }
  const result = parseSchedule(expr);
  if (!result.ok) throw new Error(`bad schedule: ${result.error}`);
  // Mirror the apparatus's start-time seeding (D8 / D9): both branches
  // collapse to a single `computeNextFireTime(parsed, start)` call.
  return {
    orderIndex,
    order,
    parsed: result.parsed,
    nextFireTime: computeNextFireTime(result.parsed, start),
  };
}

/**
 * Controllable virtual clock — `advance(ms)` jumps the cursor forward
 * synchronously and `now()` returns the cursor as a Date.
 */
function makeVirtualClock(start: Date): {
  now: () => Date;
  advance: (ms: number) => void;
  setTo: (date: Date) => void;
} {
  let cursor = start.getTime();
  return {
    now: () => new Date(cursor),
    advance: (ms) => {
      cursor += ms;
    },
    setTo: (date: Date) => {
      cursor = date.getTime();
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('runScheduleSweep — empty schedule', () => {
  afterEach(() => clearGuild());

  it('returns zero counts and writes nothing', async () => {
    const fix = await buildFixture();
    const clock = makeVirtualClock(new Date('2026-01-01T00:00:00Z'));
    const summary = await runScheduleSweep({
      schedule: [],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 0, errors: 0 });
    assert.equal((await fix.allEvents()).length, 0);
    assert.equal((await fix.allDispatches()).length, 0);
  });
});

describe('runScheduleSweep — @every fires on cadence', () => {
  afterEach(() => clearGuild());

  it('does not fire before nextFireTime', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let invoked = 0;
    fix.registerRelay(relay({ name: 'r', handler: () => { invoked += 1; } }));

    const entry = buildEntry(0, {
      schedule: '@every 30s',
      run: 'r',
    }, start);

    // tick at t+15s — not due yet (next fire at t+30s).
    clock.advance(15_000);
    const summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 0, errors: 0 });
    assert.equal(invoked, 0);
    assert.equal((await fix.allDispatches()).length, 0);
  });

  it('fires when nextFireTime <= now and advances cadence', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let invoked = 0;
    const captured: string[] = [];
    fix.registerRelay(
      relay({
        name: 'r',
        handler: (event) => {
          invoked += 1;
          captured.push(event?.name ?? '(direct)');
        },
      }),
    );

    const entry = buildEntry(0, {
      schedule: '@every 30s',
      run: 'r',
    }, start);

    // tick at t+30s exactly — fire.
    clock.setTo(new Date('2026-01-01T00:00:30Z'));
    let summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 1, errors: 0 });
    assert.equal(invoked, 1);
    assert.deepEqual(captured, ['schedule.fired']);
    // nextFireTime advanced 30s.
    assert.equal(entry.nextFireTime.toISOString(), '2026-01-01T00:01:00.000Z');

    // tick again at t+45s — not due (next fire at t+60s).
    clock.setTo(new Date('2026-01-01T00:00:45Z'));
    summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 0, errors: 0 });
    assert.equal(invoked, 1);

    // tick at t+60s — fire again.
    clock.setTo(new Date('2026-01-01T00:01:00Z'));
    summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 1, errors: 0 });
    assert.equal(invoked, 2);
  });
});

describe('runScheduleSweep — cron fires on the natural boundary', () => {
  afterEach(() => clearGuild());

  it('does not fire before the next boundary', async () => {
    const fix = await buildFixture();
    // start at 00:01:30 — first 5-minute boundary is 00:05.
    const start = new Date('2026-01-01T00:01:30Z');
    const clock = makeVirtualClock(start);

    let invoked = 0;
    fix.registerRelay(relay({ name: 'r', handler: () => { invoked += 1; } }));

    const entry = buildEntry(0, { schedule: '*/5 * * * *', run: 'r' }, start);
    assert.equal(entry.nextFireTime.toISOString(), '2026-01-01T00:05:00.000Z');

    clock.setTo(new Date('2026-01-01T00:04:59Z'));
    const summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 0, errors: 0 });
    assert.equal(invoked, 0);
  });

  it('fires at the natural 5-minute boundary and advances to the next', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:01:30Z');
    const clock = makeVirtualClock(start);

    let invoked = 0;
    fix.registerRelay(relay({ name: 'r', handler: () => { invoked += 1; } }));

    const entry = buildEntry(0, { schedule: '*/5 * * * *', run: 'r' }, start);

    clock.setTo(new Date('2026-01-01T00:05:00Z'));
    let summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 1, errors: 0 });
    assert.equal(invoked, 1);
    assert.equal(entry.nextFireTime.toISOString(), '2026-01-01T00:10:00.000Z');

    clock.setTo(new Date('2026-01-01T00:10:00Z'));
    summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });
    assert.deepEqual(summary, { fired: 1, errors: 0 });
    assert.equal(invoked, 2);
    assert.equal(entry.nextFireTime.toISOString(), '2026-01-01T00:15:00.000Z');
  });
});

describe('runScheduleSweep — persisted row shapes', () => {
  afterEach(() => clearGuild());

  it('writes a schedule.fired event with processed=true and the D2 payload', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(relay({ name: 'r', handler: () => {} }));

    const order: StandingOrder = {
      schedule: '@every 30s',
      run: 'r',
      with: { mode: 'shallow' },
    };
    const entry = buildEntry(2, order, start);

    clock.setTo(new Date('2026-01-01T00:00:30Z'));
    await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    const events = await fix.allEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, 'schedule.fired');
    assert.equal(events[0]!.processed, true);
    assert.equal(events[0]!.emitter, 'framework');
    assert.equal(events[0]!.firedAt, '2026-01-01T00:00:30.000Z');

    const payload = events[0]!.payload as {
      standingOrder: StandingOrder;
      orderIndex: number;
      fireTime: string;
    };
    assert.equal(payload.orderIndex, 2);
    assert.equal(payload.fireTime, '2026-01-01T00:00:30.000Z');
    // Verbatim — including the with block.
    assert.deepEqual(payload.standingOrder, order);
  });

  it('writes a dispatch row through the existing shape (handlerType=relay)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    const entry = buildEntry(0, { schedule: '@every 1s', run: 'r' }, start);

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    const dispatches = await fix.allDispatches();
    assert.equal(dispatches.length, 1);
    const row = dispatches[0]!;
    assert.match(row.id, /^d-/);
    assert.equal(row.handlerType, 'relay');
    assert.equal(row.handlerName, 'r');
    assert.equal(row.targetRole, null);
    assert.equal(row.noticeType, null);
    assert.equal(row.status, 'success');
    assert.equal(row.error, null);

    // The dispatch row references the synthesized event id.
    const events = await fix.allEvents();
    assert.equal(row.eventId, events[0]!.id);
  });

  it('hands the relay a clean GuildEvent view (no `processed` flag)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let received: unknown = null;
    fix.registerRelay(relay({ name: 'r', handler: (event) => { received = event; } }));
    const entry = buildEntry(0, { schedule: '@every 1s', run: 'r' }, start);

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    const view = received as { processed?: unknown; name: string };
    assert.equal(view.name, 'schedule.fired');
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'processed'), false);
  });

  it('forwards `with:` into RelayContext.params and `home` into RelayContext.home', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let receivedContext: { home?: string; params?: unknown } | null = null;
    fix.registerRelay(
      relay({
        name: 'r',
        handler: (_event, context) => { receivedContext = context; },
      }),
    );
    const entry = buildEntry(
      0,
      { schedule: '@every 1s', run: 'r', with: { hello: 'world' } },
      start,
    );

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    assert.ok(receivedContext);
    assert.equal(receivedContext!.home, '/tmp/scheduler-test');
    assert.deepEqual(receivedContext!.params, { hello: 'world' });
  });

  it('defaults RelayContext.params to {} when `with:` is absent', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let receivedContext: { params?: unknown } | null = null;
    fix.registerRelay(
      relay({
        name: 'r',
        handler: (_event, context) => { receivedContext = context; },
      }),
    );
    const entry = buildEntry(0, { schedule: '@every 1s', run: 'r' }, start);

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    assert.deepEqual(receivedContext!.params, {});
  });
});

describe('runScheduleSweep — multiple due orders', () => {
  afterEach(() => clearGuild());

  it('fires multiple-due orders sequentially in orderIndex order (D13)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    const fireOrder: number[] = [];
    fix.registerRelay(
      relay({
        name: 'tracking',
        handler: async (event) => {
          // Read the orderIndex back out of the synthesized payload.
          const payload = event!.payload as { orderIndex: number };
          fireOrder.push(payload.orderIndex);
        },
      }),
    );

    const entries = [
      buildEntry(0, { schedule: '@every 1s', run: 'tracking' }, start),
      buildEntry(1, { schedule: '@every 1s', run: 'tracking' }, start),
      buildEntry(2, { schedule: '@every 1s', run: 'tracking' }, start),
    ];

    // Reverse them in the array — the scheduler should still iterate
    // in the array order it was given (apparatus populates it in
    // standing-orders array order, so this verifies positional walk).
    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: entries,
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    // Apparatus pushes by ascending index, so we expect [0, 1, 2].
    assert.deepEqual(fireOrder, [0, 1, 2]);
  });
});

describe('runScheduleSweep — error paths', () => {
  afterEach(() => clearGuild());

  it('writes an error dispatch row and emits SOF when the relay throws (D15)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(
      relay({
        name: 'broken',
        handler: () => { throw new Error('boom'); },
      }),
    );

    const sofPayloads: StandingOrderFailedPayload[] = [];
    const order: StandingOrder = { schedule: '@every 1s', run: 'broken' };
    const entry = buildEntry(0, order, start);

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    const summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
      signalStandingOrderFailed: async (p) => { sofPayloads.push(p); },
    });

    assert.deepEqual(summary, { fired: 1, errors: 1 });

    const dispatches = await fix.allDispatches();
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.status, 'error');
    assert.equal(dispatches[0]!.error, 'boom');

    // SOF callback fired exactly once with the verbatim order plus
    // the synthesized triggering event id+name.
    assert.equal(sofPayloads.length, 1);
    assert.deepEqual(sofPayloads[0]!.standingOrder, order);
    assert.equal(sofPayloads[0]!.triggeringEvent.name, 'schedule.fired');
    assert.equal(sofPayloads[0]!.error, 'boom');
  });

  it('writes an error row and emits SOF when the relay name is unresolved', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    const sofPayloads: StandingOrderFailedPayload[] = [];
    const entry = buildEntry(
      3,
      { schedule: '@every 1s', run: 'no-such-relay' },
      start,
    );

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    const summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
      signalStandingOrderFailed: async (p) => { sofPayloads.push(p); },
    });

    assert.deepEqual(summary, { fired: 1, errors: 1 });

    const dispatches = await fix.allDispatches();
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.status, 'error');
    assert.match(dispatches[0]!.error!, /relay "no-such-relay"/);
    assert.match(dispatches[0]!.error!, /scheduled order 3/);

    assert.equal(sofPayloads.length, 1);
  });

  it('isolates a thrown SOF callback (logs warning, sweep continues)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(
      relay({ name: 'broken', handler: () => { throw new Error('x'); } }),
    );

    const originalWarn = console.warn;
    let warns = 0;
    console.warn = () => { warns += 1; };
    try {
      const entry = buildEntry(0, { schedule: '@every 1s', run: 'broken' }, start);
      clock.setTo(new Date('2026-01-01T00:00:01Z'));
      // Make the SOF callback throw too — sweep must still resolve.
      await runScheduleSweep({
        schedule: [entry],
        events: fix.events,
        dispatches: fix.dispatches,
        resolveRelay: fix.resolveRelay,
        home: '/tmp/scheduler-test',
        now: clock.now,
        signalStandingOrderFailed: () => { throw new Error('sof-broken'); },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warns >= 1, 'expected a console.warn from the SOF isolation path');
  });
});

describe('runScheduleSweep — in-tick guard', () => {
  afterEach(() => clearGuild());

  it('fires at most once per order per tick even when many intervals have elapsed', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    let invoked = 0;
    fix.registerRelay(relay({ name: 'r', handler: () => { invoked += 1; } }));

    const entry = buildEntry(0, { schedule: '@every 30s', run: 'r' }, start);

    // Jump the clock 5 minutes (10 intervals) forward — single tick
    // must still fire only once. nextFireTime advances by exactly one
    // duration; the scheduler will catch up over subsequent ticks.
    clock.setTo(new Date('2026-01-01T00:05:00Z'));
    const summary = await runScheduleSweep({
      schedule: [entry],
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
    });

    assert.deepEqual(summary, { fired: 1, errors: 0 });
    assert.equal(invoked, 1);
    // After the fire, nextFireTime should advance by one duration
    // from the prior nextFireTime (00:00:30 + 30s = 00:01:00).
    assert.equal(entry.nextFireTime.toISOString(), '2026-01-01T00:01:00.000Z');
  });
});

describe('runScheduleSweep — observer hook', () => {
  afterEach(() => clearGuild());

  it('notifies the observer once per dispatch row, in fire order', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(relay({ name: 'r', handler: () => {} }));

    const observed: DispatchObservation[] = [];
    const entries = [
      buildEntry(0, { schedule: '@every 1s', run: 'r' }, start),
      buildEntry(1, { schedule: '@every 1s', run: 'r' }, start),
    ];

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    await runScheduleSweep({
      schedule: entries,
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
      onDispatch: (obs) => observed.push(obs),
    });

    assert.equal(observed.length, 2);
    for (const obs of observed) {
      assert.equal(obs.eventName, 'schedule.fired');
      assert.equal(obs.handlerName, 'r');
      assert.equal(obs.status, 'success');
    }
  });

  it('isolates a throwing observer (does not break the loop)', async () => {
    const fix = await buildFixture();
    const start = new Date('2026-01-01T00:00:00Z');
    const clock = makeVirtualClock(start);

    fix.registerRelay(relay({ name: 'r', handler: () => {} }));

    const entries = [
      buildEntry(0, { schedule: '@every 1s', run: 'r' }, start),
      buildEntry(1, { schedule: '@every 1s', run: 'r' }, start),
    ];

    clock.setTo(new Date('2026-01-01T00:00:01Z'));
    const summary = await runScheduleSweep({
      schedule: entries,
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      home: '/tmp/scheduler-test',
      now: clock.now,
      onDispatch: () => { throw new Error('observer broke'); },
    });

    // Both dispatches still happen even though the observer threw.
    assert.deepEqual(summary, { fired: 2, errors: 0 });
    const dispatches = await fix.allDispatches();
    assert.equal(dispatches.length, 2);
  });
});

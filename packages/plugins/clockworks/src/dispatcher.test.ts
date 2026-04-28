/**
 * Dispatcher unit tests.
 *
 * The dispatcher is pure — every dependency (event book, dispatch
 * book, relay resolver, standing orders, home, clock) is passed in.
 * Tests use a real in-memory `MemoryBackend` so the `find` /
 * `put` / `patch` semantics are exercised against the production
 * Stacks core (no fragile fakes), and a deterministic clock fixture
 * so timestamps are predictable.
 *
 * Covers every behavioral case from the acceptance signal:
 *   - empty queue (returns zero counts, no writes)
 *   - one event, one matching order, success
 *   - one event, two matching orders, registration order, both run
 *   - one event, no matching orders (event still flips to processed)
 *   - unresolved relay (one error row, sibling orders still fire,
 *     event still flips)
 *   - throwing relay (one error row, sibling orders still fire,
 *     event still flips, message uses D19 idiom)
 *   - non-Error throw (uses String(err) idiom)
 *   - `with:` present vs absent → `params` shape into RelayContext
 *   - `home` propagation into RelayContext
 *   - GuildEvent view drops the `processed` bookkeeping field
 *   - per-handler isolation: throwing handler does not block sibling
 *   - N events processed in id order; all rows for event k written
 *     before any row for event k+1
 *   - validator runs every sweep; invalid orders throw, no events
 *     processed, no rows written
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, generateId, setGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedApparatus, LoadedKit } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import {
  runDispatchSweep,
  type SourcedStandingOrder,
  type StandingOrderFailedPayload,
} from './dispatcher.ts';
import { relay, type RelayDefinition, type GuildEvent, type RelayContext } from './relay.ts';
import type { EventDispatchDoc, EventDoc, StandingOrder } from './types.ts';

/**
 * Wrap a plain `StandingOrder[]` into the dispatcher's merged-list
 * shape, treating every entry as operator-sourced (the historical
 * shape these unit tests exercise). Apparatus-level tests cover the
 * kit-source path; the dispatcher itself sees both layers as the same
 * `SourcedStandingOrder[]` post-merge.
 */
function asOperatorOrders(
  orders: readonly StandingOrder[],
): SourcedStandingOrder[] {
  return orders.map((order, orderIndex) => ({
    order,
    source: null,
    orderIndex,
  }));
}

// ── Fixture ──────────────────────────────────────────────────────────

interface SweepFixture {
  events: Book<EventDoc>;
  dispatches: Book<EventDispatchDoc>;
  resolveRelay: (name: string) => RelayDefinition | undefined;
  registerRelay: (def: RelayDefinition) => void;
  emitEvent: (
    name: string,
    payload?: unknown,
    emitter?: string,
  ) => Promise<EventDoc>;
  /** Read every dispatch row currently persisted, sorted by id ascending. */
  allDispatches: () => Promise<EventDispatchDoc[]>;
  /** Read every event currently persisted, sorted by id ascending. */
  allEvents: () => Promise<EventDoc[]>;
}

async function buildSweepFixture(): Promise<SweepFixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');

  const guildConfig: GuildConfig = { name: 't', nexus: '0.0.0', plugins: [] };
  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      throw new Error(`Apparatus "${name}" not installed`);
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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
    async emitEvent(
      name: string,
      payload: unknown = null,
      emitter = 'test',
    ): Promise<EventDoc> {
      const doc: EventDoc = {
        id: generateId('e'),
        name,
        payload,
        emitter,
        firedAt: new Date().toISOString(),
        processed: false,
      };
      await events.put(doc);
      return doc;
    },
    async allDispatches(): Promise<EventDispatchDoc[]> {
      // Order by `startedAt` ASC: the controlled clock in tests makes
      // this monotonic and therefore equivalent to invocation order.
      // Sorting by `id` would be wrong because the d-id suffix is
      // random and does not preserve insertion order.
      return dispatches.list({ orderBy: [['startedAt', 'asc']] });
    },
    async allEvents(): Promise<EventDoc[]> {
      return events.list({ orderBy: [['id', 'asc']] });
    },
  };
}

/**
 * Pinned-clock fixture: each successive `now()` call returns the next
 * ISO string in a controllable sequence. The default sequence walks
 * one second forward per call so tests can assert the exact value.
 */
function makeClock(start = '2026-01-01T00:00:00.000Z'): () => string {
  let counter = 0;
  const base = new Date(start).getTime();
  return () => {
    const ts = new Date(base + counter * 1000).toISOString();
    counter += 1;
    return ts;
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('runDispatchSweep — empty queue', () => {
  afterEach(() => clearGuild());

  it('returns zero counts and writes nothing', async () => {
    const fix = await buildSweepFixture();
    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([]),
      home: '/tmp/test-guild',
      now: makeClock(),
    });
    assert.deepEqual(summary, { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 });
    assert.equal((await fix.allDispatches()).length, 0);
    assert.equal((await fix.allEvents()).length, 0);
  });
});

describe('runDispatchSweep — happy path', () => {
  afterEach(() => clearGuild());

  it('one event, one matching order: invokes the relay once and writes one success row', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    let receivedEvent: GuildEvent | null = null;
    let receivedContext: RelayContext | null = null;
    fix.registerRelay(
      relay({
        name: 'r1',
        handler: (event, context) => {
          invoked += 1;
          receivedEvent = event;
          receivedContext = context;
        },
      }),
    );
    const event = await fix.emitEvent('demo.thing', { foo: 'bar' }, 'tester');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.thing', run: 'r1' }]),
      home: '/guild/home',
      now: makeClock('2026-04-25T00:00:00.000Z'),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0, skipped: 0 });
    assert.equal(invoked, 1);
    assert.deepEqual(receivedEvent, {
      id: event.id,
      name: 'demo.thing',
      payload: { foo: 'bar' },
      emitter: 'tester',
      firedAt: event.firedAt,
    });
    // D18: the `processed` bookkeeping flag must NOT leak into the
    // event view handed to the relay handler.
    assert.equal(
      Object.prototype.hasOwnProperty.call(receivedEvent ?? {}, 'processed'),
      false,
      'GuildEvent view must not carry the internal processed flag',
    );
    // D11: home and params (default empty) propagate.
    assert.deepEqual(receivedContext, { home: '/guild/home', params: {} });

    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.eventId, event.id);
    assert.equal(row.handlerType, 'relay');
    assert.equal(row.handlerName, 'r1');
    assert.equal(row.targetRole, null);
    assert.equal(row.noticeType, null);
    assert.equal(row.status, 'success');
    assert.equal(row.error, null);
    assert.equal(row.startedAt, '2026-04-25T00:00:00.000Z');
    assert.equal(row.endedAt, '2026-04-25T00:00:01.000Z');
    assert.match(row.id, /^d-/);

    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });

  it('forwards `with:` block to RelayContext.params', async () => {
    const fix = await buildSweepFixture();
    let received: Record<string, unknown> | null = null;
    fix.registerRelay(
      relay({
        name: 'r1',
        handler: (_event, context) => { received = context.params; },
      }),
    );
    await fix.emitEvent('demo.params');

    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.params', run: 'r1', with: { level: 'info', target: 7 } },
      ]),
      home: '/x',
      now: makeClock(),
    });

    assert.deepEqual(received, { level: 'info', target: 7 });
  });
});

describe('runDispatchSweep — multiple matching orders', () => {
  afterEach(() => clearGuild());

  it('invokes all matching orders in registration order and writes one row per order', async () => {
    const fix = await buildSweepFixture();
    const callLog: string[] = [];
    fix.registerRelay(
      relay({
        name: 'first',
        handler: () => { callLog.push('first'); },
      }),
    );
    fix.registerRelay(
      relay({
        name: 'second',
        handler: () => { callLog.push('second'); },
      }),
    );
    const event = await fix.emitEvent('demo.fanout');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.fanout', run: 'first' },
        { on: 'unrelated', run: 'first' },
        { on: 'demo.fanout', run: 'second' },
      ]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 0, skipped: 0 });
    assert.deepEqual(callLog, ['first', 'second']);
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 2);
    // Both rows reference the event.
    assert.ok(rows.every((r) => r.eventId === event.id));
    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });

  it('flips processed even when no orders match', async () => {
    const fix = await buildSweepFixture();
    const event = await fix.emitEvent('orphan.event');
    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'something.else', run: 'r' }]),
      home: '/h',
      now: makeClock(),
    });
    assert.deepEqual(summary, { processedEvents: 1, dispatches: 0, errors: 0, skipped: 0 });
    assert.equal((await fix.allDispatches()).length, 0);
    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });
});

describe('runDispatchSweep — error paths', () => {
  afterEach(() => clearGuild());

  it('writes a single error row when the relay name is unresolved (D20)', async () => {
    const fix = await buildSweepFixture();
    const event = await fix.emitEvent('demo.unresolved');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.unresolved', run: 'missing-relay' }]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 1, skipped: 0 });
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].handlerName, 'missing-relay');
    assert.equal(
      rows[0].error,
      'clockworks: relay "missing-relay" referenced by standing order 0 is not registered.',
    );
    // Both timestamps must be set even for the unresolved-relay path.
    assert.ok(rows[0].startedAt);
    assert.ok(rows[0].endedAt);
    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });

  it('uses the correct standing-order index in the unresolved-relay message', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'real', handler: () => {} }));
    await fix.emitEvent('demo.event');

    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'irrelevant', run: 'real' }, // index 0, doesn't match
        { on: 'demo.event', run: 'real' }, // index 1, matches
        { on: 'demo.event', run: 'ghost' }, // index 2, matches but ghost
      ]),
      home: '/h',
      now: makeClock(),
    });

    const rows = await fix.allDispatches();
    const errorRow = rows.find((r) => r.status === 'error');
    assert.ok(errorRow);
    assert.equal(
      errorRow!.error,
      'clockworks: relay "ghost" referenced by standing order 2 is not registered.',
    );
  });

  it('an unresolved relay does not block sibling orders or the processed flip', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    fix.registerRelay(
      relay({ name: 'good', handler: () => { invoked += 1; } }),
    );
    const event = await fix.emitEvent('demo.mix');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.mix', run: 'ghost' },
        { on: 'demo.mix', run: 'good' },
      ]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 1, skipped: 0 });
    assert.equal(invoked, 1);
    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });

  it('records a thrown Error from a relay handler with its message (D19)', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        handler: () => { throw new Error('relay exploded'); },
      }),
    );
    await fix.emitEvent('demo.boom');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.boom', run: 'boom' }]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 1, skipped: 0 });
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].error, 'relay exploded');
  });

  it('records a non-Error throw via String(err) (D19)', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        handler: () => { throw 'plain string thrown'; },
      }),
    );
    await fix.emitEvent('demo.boom');

    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.boom', run: 'boom' }]),
      home: '/h',
      now: makeClock(),
    });

    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].error, 'plain string thrown');
  });

  it('a throwing relay does not block sibling orders or the processed flip', async () => {
    const fix = await buildSweepFixture();
    let goodRan = 0;
    fix.registerRelay(
      relay({ name: 'boom', handler: () => { throw new Error('x'); } }),
    );
    fix.registerRelay(
      relay({ name: 'good', handler: () => { goodRan += 1; } }),
    );
    const event = await fix.emitEvent('demo.mixed');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.mixed', run: 'boom' },
        { on: 'demo.mixed', run: 'good' },
      ]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 1, skipped: 0 });
    assert.equal(goodRan, 1);
    const stored = await fix.events.get(event.id);
    assert.equal(stored?.processed, true);
  });
});

describe('runDispatchSweep — N-event ordering', () => {
  afterEach(() => clearGuild());

  it('processes pending events in id order; all rows for event k written before any row for event k+1', async () => {
    const fix = await buildSweepFixture();
    const callOrder: string[] = [];
    fix.registerRelay(
      relay({
        name: 'r',
        handler: (event) => { callOrder.push(event!.id); },
      }),
    );

    // Emit three events. Event ids embed a timestamp prefix and a
    // random hex suffix; rapid emission can put them in any suffix
    // order, so we assert against the lexicographic sort (which is
    // exactly what the dispatcher's `orderBy: id asc` produces).
    const e1 = await fix.emitEvent('demo.x');
    const e2 = await fix.emitEvent('demo.x');
    const e3 = await fix.emitEvent('demo.x');
    const idOrder = [e1.id, e2.id, e3.id].sort();

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.x', run: 'r' },
        { on: 'demo.x', run: 'r' }, // two rows per event
      ]),
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 3, dispatches: 6, errors: 0, skipped: 0 });
    // Each event's two invocations must come before the next event's,
    // walking the queue in id-ascending order.
    assert.deepEqual(callOrder, [
      idOrder[0], idOrder[0],
      idOrder[1], idOrder[1],
      idOrder[2], idOrder[2],
    ]);

    // Same invariant on persisted rows.
    const rows = await fix.allDispatches();
    assert.deepEqual(
      rows.map((r) => r.eventId),
      [
        idOrder[0], idOrder[0],
        idOrder[1], idOrder[1],
        idOrder[2], idOrder[2],
      ],
    );

    // All three events flipped to processed.
    for (const id of idOrder) {
      assert.equal((await fix.events.get(id))?.processed, true);
    }
  });

  it('skips events that are already processed', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    fix.registerRelay(
      relay({ name: 'r', handler: () => { invoked += 1; } }),
    );
    const e1 = await fix.emitEvent('demo.x');
    await fix.events.patch(e1.id, { processed: true }); // pre-marked
    await fix.emitEvent('demo.x');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
    });
    assert.equal(summary.processedEvents, 1);
    assert.equal(invoked, 1);
  });
});

describe('runDispatchSweep — single-event mode (max=1)', () => {
  afterEach(() => clearGuild());

  it('processes only the first pending event when max=1, leaves the rest pending', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    fix.registerRelay(
      relay({ name: 'r', handler: () => { invoked += 1; } }),
    );
    const e1 = await fix.emitEvent('demo.x');
    const e2 = await fix.emitEvent('demo.x');
    const e3 = await fix.emitEvent('demo.x');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      max: 1,
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0, skipped: 0 });
    assert.equal(invoked, 1);
    // First event in id-ascending order is processed; the others stay
    // pending so a follow-up sweep can pick them up.
    const ids = [e1.id, e2.id, e3.id].sort();
    assert.equal((await fix.events.get(ids[0]))?.processed, true);
    assert.equal((await fix.events.get(ids[1]))?.processed, false);
    assert.equal((await fix.events.get(ids[2]))?.processed, false);
  });

  it('treats max=0 as no cap (default-everything), processes the full queue', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');
    await fix.emitEvent('demo.x');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      // max=0 / non-positive falls through to the unlimited path —
      // matches the apparatus's default-everything behavior on
      // explicit-zero callers.
      max: 0,
    });

    assert.equal(summary.processedEvents, 2);
  });

  it('processes a larger queue with max=2, leaves the rest pending', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    for (let i = 0; i < 5; i += 1) {
      await fix.emitEvent('demo.x');
    }

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      max: 2,
    });

    assert.equal(summary.processedEvents, 2);
    const all = await fix.allEvents();
    const processedCount = all.filter((e) => e.processed).length;
    assert.equal(processedCount, 2);
  });
});

describe('runDispatchSweep — eventId filter', () => {
  afterEach(() => clearGuild());

  it('processes only the targeted event', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    fix.registerRelay(
      relay({ name: 'r', handler: () => { invoked += 1; } }),
    );
    const e1 = await fix.emitEvent('demo.x');
    const e2 = await fix.emitEvent('demo.x');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      eventId: e2.id,
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0, skipped: 0 });
    assert.equal(invoked, 1);
    // Only e2 was flipped — e1 must remain pending.
    assert.equal((await fix.events.get(e1.id))?.processed, false);
    assert.equal((await fix.events.get(e2.id))?.processed, true);
  });

  it('returns zero when the targeted event is already processed', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    const e = await fix.emitEvent('demo.x');
    await fix.events.patch(e.id, { processed: true });

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      eventId: e.id,
    });

    assert.deepEqual(summary, { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 });
  });

  it('returns zero when the targeted event id is unknown', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');

    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      eventId: 'e-does-not-exist',
    });

    assert.deepEqual(summary, { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 });
  });
});

describe('runDispatchSweep — observer hook', () => {
  afterEach(() => clearGuild());

  it('invokes the observer once per dispatch row, in dispatch order', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'a', handler: () => {} }));
    fix.registerRelay(relay({ name: 'b', handler: () => {} }));
    const e1 = await fix.emitEvent('demo.x');
    const e2 = await fix.emitEvent('demo.x');

    const observed: Array<{ eventId: string; handlerName: string; status: string }> = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.x', run: 'a' },
        { on: 'demo.x', run: 'b' },
      ]),
      home: '/h',
      now: makeClock(),
      onDispatch: (obs) => {
        observed.push({
          eventId: obs.eventId,
          handlerName: obs.handlerName,
          status: obs.status,
        });
      },
    });

    // Two events × two orders = 4 observer calls; per-event ordering
    // is preserved.
    assert.equal(observed.length, 4);
    const ids = [e1.id, e2.id].sort();
    assert.deepEqual(observed, [
      { eventId: ids[0], handlerName: 'a', status: 'success' },
      { eventId: ids[0], handlerName: 'b', status: 'success' },
      { eventId: ids[1], handlerName: 'a', status: 'success' },
      { eventId: ids[1], handlerName: 'b', status: 'success' },
    ]);
  });

  it('reports error status with the handler error message', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        handler: () => { throw new Error('relay exploded'); },
      }),
    );
    await fix.emitEvent('demo.boom');

    const observed: Array<{ status: string; error: string | null }> = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.boom', run: 'boom' }]),
      home: '/h',
      now: makeClock(),
      onDispatch: (obs) => {
        observed.push({ status: obs.status, error: obs.error });
      },
    });

    assert.deepEqual(observed, [{ status: 'error', error: 'relay exploded' }]);
  });

  it('reports error status for unresolved-relay dispatches', async () => {
    const fix = await buildSweepFixture();
    await fix.emitEvent('demo.x');

    const observed: Array<{ status: string; handlerName: string; error: string | null }> = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'ghost' }]),
      home: '/h',
      now: makeClock(),
      onDispatch: (obs) => {
        observed.push({
          status: obs.status,
          handlerName: obs.handlerName,
          error: obs.error,
        });
      },
    });

    assert.equal(observed.length, 1);
    assert.equal(observed[0].status, 'error');
    assert.equal(observed[0].handlerName, 'ghost');
    assert.match(observed[0].error ?? '', /not registered/);
  });

  it('throwing observer is isolated; loop continues, every row still observed', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'a', handler: () => {} }));
    fix.registerRelay(relay({ name: 'b', handler: () => {} }));
    await fix.emitEvent('demo.x');
    await fix.emitEvent('demo.x');

    let invocations = 0;
    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([
        { on: 'demo.x', run: 'a' },
        { on: 'demo.x', run: 'b' },
      ]),
      home: '/h',
      now: makeClock(),
      onDispatch: () => {
        invocations += 1;
        throw new Error('observer cannot block the loop');
      },
    });

    // Loop completed — both events processed, both rows written for
    // each event, and the observer was called four times despite
    // throwing on every call.
    assert.deepEqual(summary, { processedEvents: 2, dispatches: 4, errors: 0, skipped: 0 });
    assert.equal(invocations, 4);
  });

  it('computes durationMs as endedAt - startedAt for successful dispatches', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');

    const observed: number[] = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      // Each call advances 1 second; startedAt and endedAt straddle
      // exactly one tick → 1000 ms.
      now: makeClock('2026-01-01T00:00:00.000Z'),
      onDispatch: (obs) => { observed.push(obs.durationMs); },
    });

    assert.deepEqual(observed, [1000]);
  });

  it('reports eventName so observers can render headers without re-reading the events book', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.named-event', { x: 1 }, 'tester');

    const observed: string[] = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.named-event', run: 'r' }]),
      home: '/h',
      now: makeClock(),
      onDispatch: (obs) => { observed.push(obs.eventName); },
    });

    assert.deepEqual(observed, ['demo.named-event']);
  });
});

describe('runDispatchSweep — clock fallback', () => {
  afterEach(() => clearGuild());

  // The historical "throws aggregated when an order is malformed" test
  // moved up into the apparatus: per-call operator validation now runs
  // in `clockworks.ts processEvents` before the merged list is built,
  // and the dispatcher trusts its merged input verbatim. The
  // apparatus-level integration tests in `clockworks.test.ts` cover
  // that contract. The dispatcher unit tests still exercise the rest
  // of the runtime contract here.

  it('uses the injected default clock when `now` is omitted', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');

    const before = new Date().toISOString();
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.x', run: 'r' }]),
      home: '/h',
      // intentionally omit `now`
    });
    const after = new Date().toISOString();

    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].startedAt && rows[0].startedAt >= before);
    assert.ok(rows[0].endedAt && rows[0].endedAt <= after);
  });
});

// ── clockworks.standing-order.failed signaling & loop-guard ──────────

describe('runDispatchSweep — clockworks.standing-order.failed signaling', () => {
  afterEach(() => clearGuild());

  it('a thrown relay invokes signalStandingOrderFailed once with the verbatim order, {id,name}-only event, and the row error', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        handler: () => { throw new Error('relay exploded'); },
      }),
    );
    const event = await fix.emitEvent('demo.boom', { foo: 'bar' }, 'tester');

    const signaled: StandingOrderFailedPayload[] = [];
    const order: StandingOrder = {
      on: 'demo.boom',
      run: 'boom',
      with: { level: 'info' },
    };
    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([order]),
      home: '/h',
      now: makeClock(),
      signalStandingOrderFailed: async (payload) => {
        signaled.push(payload);
      },
    });

    // Row + summary contracts unchanged from the existing throw test.
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].error, 'relay exploded');
    assert.deepEqual(summary, {
      processedEvents: 1,
      dispatches: 1,
      errors: 1,
      skipped: 0,
    });

    // SOF payload: verbatim order (D5), {id,name}-only triggering
    // event (D6), error string identical to the dispatch row (D7).
    assert.equal(signaled.length, 1);
    assert.deepEqual(signaled[0].standingOrder, order);
    assert.deepEqual(signaled[0].triggeringEvent, {
      id: event.id,
      name: 'demo.boom',
    });
    assert.equal(signaled[0].error, 'relay exploded');
    // No payload / emitter / firedAt leakage in the projection.
    assert.deepEqual(
      Object.keys(signaled[0].triggeringEvent).sort(),
      ['id', 'name'],
    );
  });

  it('an unresolved relay invokes signalStandingOrderFailed with the canonical unresolved-relay message', async () => {
    const fix = await buildSweepFixture();
    const event = await fix.emitEvent('demo.unresolved');

    const signaled: StandingOrderFailedPayload[] = [];
    const order: StandingOrder = { on: 'demo.unresolved', run: 'missing-relay' };
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([order]),
      home: '/h',
      now: makeClock(),
      signalStandingOrderFailed: async (payload) => {
        signaled.push(payload);
      },
    });

    assert.equal(signaled.length, 1);
    assert.deepEqual(signaled[0].standingOrder, order);
    assert.deepEqual(signaled[0].triggeringEvent, {
      id: event.id,
      name: 'demo.unresolved',
    });
    // The canonical unresolved-relay message — same string as the row.
    assert.equal(
      signaled[0].error,
      'clockworks: relay "missing-relay" referenced by standing order 0 is not registered.',
    );
  });

  it('loop-guard: an event whose payload.triggeringEvent.name is "clockworks.standing-order.failed" produces a skipped row, no relay call, no SOF', async () => {
    const fix = await buildSweepFixture();
    let invoked = 0;
    fix.registerRelay(
      relay({ name: 'react-to-fail', handler: () => { invoked += 1; } }),
    );

    // Construct an event that LOOKS like a SOF event — that is the
    // shape the dispatcher's loop-guard probes for. The payload mirrors
    // what the apparatus's `signalStandingOrderFailed` lambda forwards
    // through `api.emit`.
    const triggering = await fix.emitEvent(
      'clockworks.standing-order.failed',
      {
        standingOrder: { on: 'whatever', run: 'react-to-fail' },
        triggeringEvent: { id: 'e-original', name: 'clockworks.standing-order.failed' },
        error: 'simulated cascade',
      },
      'framework',
    );

    const signaled: StandingOrderFailedPayload[] = [];
    const observed: Array<{ status: string; error: string | null; durationMs: number; handlerName: string }> = [];
    const summary = await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'clockworks.standing-order.failed', run: 'react-to-fail' }]),
      home: '/h',
      now: makeClock('2026-01-01T00:00:00.000Z'),
      onDispatch: (obs) => {
        observed.push({
          status: obs.status,
          error: obs.error,
          durationMs: obs.durationMs,
          handlerName: obs.handlerName,
        });
      },
      signalStandingOrderFailed: async (payload) => {
        signaled.push(payload);
      },
    });

    // Relay was NOT called.
    assert.equal(invoked, 0);
    // Counters: skipped=1, errors=0, dispatches=1.
    assert.deepEqual(summary, {
      processedEvents: 1,
      dispatches: 1,
      errors: 0,
      skipped: 1,
    });
    // Persisted row: status=skipped, handlerName=order.run, error
    // begins with `loop-guard:`, both timestamps equal, durationMs
    // observed as 0.
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'skipped');
    assert.equal(rows[0].handlerName, 'react-to-fail');
    assert.ok(rows[0].error?.startsWith('loop-guard:'));
    assert.equal(rows[0].startedAt, rows[0].endedAt);
    // Observer fires once per skipped row (D12).
    assert.equal(observed.length, 1);
    assert.equal(observed[0].status, 'skipped');
    assert.equal(observed[0].handlerName, 'react-to-fail');
    assert.equal(observed[0].durationMs, 0);
    assert.ok(observed[0].error?.startsWith('loop-guard:'));
    // No fresh SOF (D14).
    assert.equal(signaled.length, 0);
    // Event still flips to processed.
    assert.equal((await fix.events.get(triggering.id))?.processed, true);
  });

  it('loop-guard does not engage on the original failure: a non-SOF event whose handler throws DOES emit SOF', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        handler: () => { throw new Error('one'); },
      }),
    );
    // A regular event whose payload has nothing resembling
    // triggeringEvent — the loop-guard must not engage.
    await fix.emitEvent('demo.regular', { unrelated: true });

    const signaled: StandingOrderFailedPayload[] = [];
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: asOperatorOrders([{ on: 'demo.regular', run: 'boom' }]),
      home: '/h',
      now: makeClock(),
      signalStandingOrderFailed: async (payload) => {
        signaled.push(payload);
      },
    });

    // Failure path emitted SOF; the row is an error, not a skip.
    assert.equal(signaled.length, 1);
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
  });

  it('a throwing signalStandingOrderFailed is caught: the sweep continues, the dispatch row remains persisted, console.warn is called', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(
      relay({
        name: 'boom',
        handler: () => { throw new Error('first explode'); },
      }),
    );
    fix.registerRelay(
      relay({
        name: 'good',
        handler: () => { /* no-op */ },
      }),
    );
    await fix.emitEvent('demo.first');
    await fix.emitEvent('demo.second');

    // Capture console.warn so we can assert the dispatcher logged the
    // emit failure with the triggering event id and the throw message.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };

    let signalCalls = 0;
    let summary;
    try {
      summary = await runDispatchSweep({
        events: fix.events,
        dispatches: fix.dispatches,
        resolveRelay: fix.resolveRelay,
        standingOrders: asOperatorOrders([
          { on: 'demo.first', run: 'boom' },
          { on: 'demo.second', run: 'good' },
        ]),
        home: '/h',
        now: makeClock(),
        signalStandingOrderFailed: async () => {
          signalCalls += 1;
          throw new Error('emit blew up');
        },
      });
    } finally {
      console.warn = origWarn;
    }

    // Sibling event still processed despite the SOF emit failure on
    // the first event.
    assert.deepEqual(summary, {
      processedEvents: 2,
      dispatches: 2,
      errors: 1,
      skipped: 0,
    });
    // Both rows persisted — the emit failure happens AFTER the row
    // write, so the persisted record of the underlying error stays
    // intact.
    const rows = await fix.allDispatches();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.status === 'error').length, 1);
    // Signal callback was invoked exactly once (only the failure path).
    assert.equal(signalCalls, 1);
    // The throw was logged via console.warn.
    assert.ok(
      warnings.some(
        (w) =>
          w.includes('[clockworks]') &&
          w.includes('clockworks.standing-order.failed') &&
          w.includes('emit blew up'),
      ),
      `expected dispatcher console.warn for emit failure; got: ${warnings.join(' | ')}`,
    );
  });
});

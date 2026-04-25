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

import { runDispatchSweep } from './dispatcher.ts';
import { relay, type RelayDefinition, type GuildEvent, type RelayContext } from './relay.ts';
import type { EventDispatchDoc, EventDoc, StandingOrder } from './types.ts';

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
      standingOrders: [],
      home: '/tmp/test-guild',
      now: makeClock(),
    });
    assert.deepEqual(summary, { processedEvents: 0, dispatches: 0, errors: 0 });
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
      standingOrders: [{ on: 'demo.thing', run: 'r1' }],
      home: '/guild/home',
      now: makeClock('2026-04-25T00:00:00.000Z'),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0 });
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
      standingOrders: [
        { on: 'demo.params', run: 'r1', with: { level: 'info', target: 7 } },
      ],
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
      standingOrders: [
        { on: 'demo.fanout', run: 'first' },
        { on: 'unrelated', run: 'first' },
        { on: 'demo.fanout', run: 'second' },
      ],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 0 });
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
      standingOrders: [{ on: 'something.else', run: 'r' }],
      home: '/h',
      now: makeClock(),
    });
    assert.deepEqual(summary, { processedEvents: 1, dispatches: 0, errors: 0 });
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
      standingOrders: [{ on: 'demo.unresolved', run: 'missing-relay' }],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 1 });
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
      standingOrders: [
        { on: 'irrelevant', run: 'real' }, // index 0, doesn't match
        { on: 'demo.event', run: 'real' }, // index 1, matches
        { on: 'demo.event', run: 'ghost' }, // index 2, matches but ghost
      ],
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
      standingOrders: [
        { on: 'demo.mix', run: 'ghost' },
        { on: 'demo.mix', run: 'good' },
      ],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 1 });
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
      standingOrders: [{ on: 'demo.boom', run: 'boom' }],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 1 });
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
      standingOrders: [{ on: 'demo.boom', run: 'boom' }],
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
      standingOrders: [
        { on: 'demo.mixed', run: 'boom' },
        { on: 'demo.mixed', run: 'good' },
      ],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 2, errors: 1 });
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
      standingOrders: [
        { on: 'demo.x', run: 'r' },
        { on: 'demo.x', run: 'r' }, // two rows per event
      ],
      home: '/h',
      now: makeClock(),
    });

    assert.deepEqual(summary, { processedEvents: 3, dispatches: 6, errors: 0 });
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
      standingOrders: [{ on: 'demo.x', run: 'r' }],
      home: '/h',
      now: makeClock(),
    });
    assert.equal(summary.processedEvents, 1);
    assert.equal(invoked, 1);
  });
});

describe('runDispatchSweep — validator integration', () => {
  afterEach(() => clearGuild());

  it('throws aggregated and writes nothing when an order is malformed', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');

    await assert.rejects(
      runDispatchSweep({
        events: fix.events,
        dispatches: fix.dispatches,
        resolveRelay: fix.resolveRelay,
        standingOrders: [
          // A single malformed order is enough to halt the sweep.
          { on: 'demo.x', summon: 'reviewer' } as unknown as StandingOrder,
        ],
        home: '/h',
        now: makeClock(),
      }),
      /sugar form has been removed/,
    );

    // No events processed, no rows written.
    assert.equal((await fix.allDispatches()).length, 0);
    const events = await fix.allEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].processed, false);
  });

  it('uses the injected default clock when `now` is omitted', async () => {
    const fix = await buildSweepFixture();
    fix.registerRelay(relay({ name: 'r', handler: () => {} }));
    await fix.emitEvent('demo.x');

    const before = new Date().toISOString();
    await runDispatchSweep({
      events: fix.events,
      dispatches: fix.dispatches,
      resolveRelay: fix.resolveRelay,
      standingOrders: [{ on: 'demo.x', run: 'r' }],
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

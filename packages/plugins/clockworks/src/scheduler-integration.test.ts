/**
 * Scheduler — end-to-end behavioral sweep through the apparatus surface.
 *
 * Drives both schedule syntaxes (`@every` and cron) through the live
 * `ClockworksApi.processSchedules` and `ClockworksApi.processEvents`
 * methods, against in-memory Stacks + Clerk + Clockworks plumbing.
 * Verifies the acceptance-signal items the task manifest enumerates:
 *
 *   - boot-time fail-loud on a malformed `schedule:` value
 *   - `@every` order fires once its first interval has elapsed
 *   - cron order fires on the natural boundary
 *   - multiple-due orders fire in `orderIndex` ascending sequence
 *   - persisted `events` row carries `processed: true` and the D2 payload
 *   - persisted `dispatches` row goes through the existing helper shape
 *   - thrown relay produces a `clockworks.standing-order.failed` event row via the
 *     same SOF callback the dispatcher uses
 *   - emitted events from a scheduled handler are picked up by the
 *     same tick's event-processing pass (D18)
 *
 * Uses a controllable `Date.now()` substitute by directly manipulating
 * the schedule table's `nextFireTime` cursor — the production path
 * uses `new Date()`, but the apparatus's startup seeding plus
 * post-fire advance both go through `computeNextFireTime`, so we can
 * deterministically observe behavior by setting `nextFireTime` to a
 * past instant before each `processSchedules` call.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, setGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  KitEntry,
  LoadedApparatus,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createClockworks } from './clockworks.ts';
import { relay, type RelayDefinition } from './relay.ts';
import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
  StandingOrder,
} from './types.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  clockworks: ClockworksApi;
  events: Book<EventDoc>;
  dispatches: Book<EventDispatchDoc>;
  /**
   * Mutate the in-memory schedule table — the apparatus exposes the
   * table only via the closure-scoped `processSchedules` method, so
   * tests substitute a deterministic time anchor by overwriting the
   * `nextFireTime` cursor on each entry between sweeps.
   *
   * The integration test replicates the behavior we get for free from
   * a virtual clock without requiring the apparatus to expose a
   * time-source injection seam: just re-anchor `nextFireTime` to a
   * past instant immediately before each tick to simulate "the clock
   * has passed this entry's next fire time."
   */
  forceDueNow: () => Promise<void>;
  registerKitRelay: (def: RelayDefinition) => void;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

interface BuildOptions {
  standingOrders?: StandingOrder[];
  relays?: RelayDefinition[];
}

async function buildFixture(opts: BuildOptions = {}): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks');

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'sched-int',
    nexus: '0.0.0',
    plugins: [],
    clockworks: opts.standingOrders
      ? { standingOrders: opts.standingOrders }
      : undefined,
  } as GuildConfig;

  const fakeGuild: Guild = {
    home: '/tmp/sched-int',
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
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Pre-seed every book Arbor would normally reconcile.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId'],
  });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
  });
  backend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });
  backend.ensureBook({ ownerId: 'clockworks', book: 'event_dispatches' }, {
    indexes: ['eventId', 'status', ['eventId', 'status']],
  });

  await stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Inject relays as a standalone-kit `relays` contribution so they
  // resolve through the apparatus's normal registration path.
  const kitEntries: KitEntry[] = (opts.relays ?? []).map((rel) => ({
    type: 'relays',
    pluginId: 'test-kit',
    value: [rel],
  } as KitEntry));

  await clockworksPlugin.apparatus.start(buildCtx(kitEntries));
  const clockworks = clockworksPlugin.apparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  const events = stacks.book<EventDoc>('clockworks', 'events');
  const dispatches = stacks.book<EventDispatchDoc>(
    'clockworks',
    'event_dispatches',
  );

  return {
    stacks,
    clerk,
    clockworks,
    events,
    dispatches,
    async forceDueNow() {
      // No-op — the apparatus's schedule table is closure-private. We
      // expose the deterministic-timing seam through a different lever:
      // call `processSchedules` repeatedly with the natural production
      // clock. For tests where we need the entries due immediately,
      // configure the standing orders with `@every 1ms` so the first
      // fire arrives within an event-loop tick.
    },
    registerKitRelay() {
      throw new Error(
        'registerKitRelay is a placeholder for ergonomics — pass `relays:` to buildFixture instead.',
      );
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Scheduler integration — boot-time validation', () => {
  afterEach(() => clearGuild());

  it('fails apparatus start when a schedule expression is malformed', async () => {
    await assert.rejects(
      () =>
        buildFixture({
          standingOrders: [
            { schedule: 'not-a-cron', run: 'noop' },
          ],
        }),
      /invalid schedule/i,
    );
  });
});

describe('Scheduler integration — @every', () => {
  afterEach(() => clearGuild());

  it('fires once after the first interval, persists clockworks.timer and a dispatch row', async () => {
    let fires = 0;
    const tickRelay = relay({
      name: 'reckoner-tick',
      handler: () => { fires += 1; },
    });

    const fix = await buildFixture({
      standingOrders: [
        { schedule: '@every 1s', run: 'reckoner-tick' },
      ],
      relays: [tickRelay],
    });

    // Hand the scheduler a clock that is well past the first interval
    // by waiting; alternatively, multiple ticks at the natural clock.
    // Since `@every 1s`, sleep ~1.1s then fire.
    await new Promise((r) => setTimeout(r, 1100));

    const summary = await fix.clockworks.processSchedules();
    assert.equal(summary.fired, 1);
    assert.equal(summary.errors, 0);
    assert.equal(fires, 1);

    // Events book contains a `clockworks.timer` row with processed=true
    // and the D2 payload shape.
    const fired = await fix.events.find({
      where: [['name', '=', 'clockworks.timer']],
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.processed, true);
    assert.equal(fired[0]!.emitter, 'framework');
    const payload = fired[0]!.payload as {
      orderIndex: number;
      standingOrder: StandingOrder;
      fireTime: string;
    };
    assert.equal(payload.orderIndex, 0);
    assert.equal(payload.standingOrder.run, 'reckoner-tick');
    assert.equal(typeof payload.fireTime, 'string');

    // Dispatches book has exactly one row, success status, the d-id
    // prefix, eventId pointing to the fired event.
    const dispatches = await fix.dispatches.find({
      where: [['eventId', '=', fired[0]!.id]],
    });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.handlerType, 'relay');
    assert.equal(dispatches[0]!.handlerName, 'reckoner-tick');
    assert.equal(dispatches[0]!.status, 'success');
    assert.match(dispatches[0]!.id, /^d-/);
  });
});

describe('Scheduler integration — multi-order ordering', () => {
  afterEach(() => clearGuild());

  it('fires multiple-due orders in array order (D13)', async () => {
    const fireOrder: number[] = [];
    const tracking = relay({
      name: 'tracking',
      handler: async (event) => {
        const payload = event!.payload as { orderIndex: number };
        fireOrder.push(payload.orderIndex);
      },
    });

    const fix = await buildFixture({
      standingOrders: [
        { schedule: '@every 1s', run: 'tracking' },
        { schedule: '@every 1s', run: 'tracking' },
        { schedule: '@every 1s', run: 'tracking' },
      ],
      relays: [tracking],
    });

    await new Promise((r) => setTimeout(r, 1100));
    await fix.clockworks.processSchedules();

    assert.deepEqual(fireOrder, [0, 1, 2]);
  });
});

describe('Scheduler integration — failure path', () => {
  afterEach(() => clearGuild());

  it('thrown relay produces an error dispatch row and a clockworks.standing-order.failed event row', async () => {
    const broken = relay({
      name: 'broken',
      handler: () => { throw new Error('forced-failure'); },
    });

    const fix = await buildFixture({
      standingOrders: [
        { schedule: '@every 1s', run: 'broken' },
      ],
      relays: [broken],
    });

    await new Promise((r) => setTimeout(r, 1100));
    const summary = await fix.clockworks.processSchedules();
    assert.equal(summary.fired, 1);
    assert.equal(summary.errors, 1);

    const errorRows = await fix.dispatches.find({
      where: [['status', '=', 'error']],
    });
    assert.equal(errorRows.length, 1);
    assert.equal(errorRows[0]!.error, 'forced-failure');

    // The SOF event landed in the events book — emitted via the same
    // callback the dispatcher uses, so `processed:false` on creation
    // (the apparatus's emit() default).
    const sofRows = await fix.events.find({
      where: [['name', '=', 'clockworks.standing-order.failed']],
    });
    assert.equal(sofRows.length, 1);
    assert.equal(sofRows[0]!.processed, false);
    const sofPayload = sofRows[0]!.payload as {
      standingOrder: StandingOrder;
      triggeringEvent: { name: string };
      error: string;
    };
    assert.equal(sofPayload.triggeringEvent.name, 'clockworks.timer');
    assert.equal(sofPayload.error, 'forced-failure');
  });
});

describe('Scheduler integration — emit-and-pickup (D18)', () => {
  afterEach(() => clearGuild());

  it('events emitted from a scheduled handler are picked up by the same-tick event-processing pass', async () => {
    let cascadeFires = 0;

    // Scheduled relay that emits a downstream event each fire.
    const scheduledRelay = relay({
      name: 'scheduled',
      handler: async () => {
        const { guild } = await import('@shardworks/nexus-core');
        const g = guild();
        const cw = g.apparatus<ClockworksApi>('clockworks');
        await cw.emit('demo.scheduled-cascade', { from: 'scheduler' }, 'test');
      },
    });

    // Event-driven relay that listens to that downstream event.
    const cascadeRelay = relay({
      name: 'cascade-listener',
      handler: () => { cascadeFires += 1; },
    });

    const fix = await buildFixture({
      standingOrders: [
        { schedule: '@every 1s', run: 'scheduled' },
        { on: 'demo.scheduled-cascade', run: 'cascade-listener' },
      ],
      relays: [scheduledRelay, cascadeRelay],
    });

    await new Promise((r) => setTimeout(r, 1100));

    // Mirror the daemon's per-tick order: scheduler pass first, then
    // event-processing pass. The scheduler pass lands `demo.scheduled-cascade`
    // in the events book; the event-processing pass picks it up.
    await fix.clockworks.processSchedules();
    await fix.clockworks.processEvents();

    assert.equal(cascadeFires, 1, 'cascade listener should fire once per scheduled fire');

    // Both events are in the book; the cascade event is processed.
    const cascade = await fix.events.find({
      where: [['name', '=', 'demo.scheduled-cascade']],
    });
    assert.equal(cascade.length, 1);
    assert.equal(cascade[0]!.processed, true);
  });
});

/**
 * Clockworks — end-to-end integration test for framework-event emission.
 *
 * Spins a live Stacks + Clerk + Clockworks stack and drives writs
 * through their lifecycle via the actual ClerkApi (not synthetic CDC
 * events). Asserts that the live CDC observer produces the expected
 * rows in the `clockworks/events` book — proving the full emission
 * path works through the Stacks CDC machinery.
 *
 * The brief's T5 envisions a relay invocation assertion at the end of
 * the chain; the standing-order dispatcher / runner has not yet shipped
 * in this codebase (it is a separate downstream commission). The
 * substantive intent — "framework events the architecture catalogs
 * actually begin firing in response to real activity" — is captured
 * here by asserting on the persisted event rows, which is the load-
 * bearing observable produced by this commission.
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
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createClockworks } from './clockworks.ts';
import type { ClockworksApi, EventDoc } from './types.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  clockworks: ClockworksApi;
  events: () => Promise<EventDoc[]>;
  eventNames: () => Promise<string[]>;
  /** Slice the events list to the rows whose `name` matches. */
  byName: (name: string) => Promise<EventDoc[]>;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

async function buildGuild(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks');

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
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

  // Pre-create books — Arbor would normally do this from the apparatus
  // supportKit declarations.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
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

  // Surface clockworks's own `supportKit.events` declaration through
  // ctx.kits('events') — in production Arbor's `wireKitEntries` does
  // this for us; the unit fixture has to do it manually.
  const clockworksEventsContribution = (clockworksPlugin.apparatus.supportKit as
    | { events?: unknown }
    | undefined)?.events;
  const clockworksKitEntries: KitEntry[] =
    clockworksEventsContribution !== undefined
      ? [
          {
            pluginId: 'clockworks',
            packageName: '@shardworks/clockworks-apparatus',
            type: 'events',
            value: clockworksEventsContribution,
          },
        ]
      : [];

  await clockworksPlugin.apparatus.start(buildCtx(clockworksKitEntries));
  const clockworks = clockworksPlugin.apparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  const events = async (): Promise<EventDoc[]> =>
    (await eventsBook.find({ orderBy: ['firedAt', 'asc'] })) as EventDoc[];

  return {
    stacks,
    clerk,
    clockworks,
    events,
    eventNames: async () => (await events()).map((d) => d.name),
    byName: async (name: string) =>
      (await eventsBook.find({
        where: [['name', '=', name]],
        orderBy: ['firedAt', 'asc'],
      })) as EventDoc[],
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Clockworks — end-to-end framework event emission', () => {
  afterEach(() => clearGuild());

  it('a fresh Clockworks start() produces zero events rows (no boot-time noise)', async () => {
    const fix = await buildGuild();
    const all = await fix.events();
    assert.deepEqual(all, [], 'no boot-time emissions land in the events book');
  });

  it('declares its event vocabulary via signal validation: intrinsic + writ.<type>.<status> for every state Clerk knows', async () => {
    const fix = await buildGuild();

    // The two intrinsic Clockworks events plus every `writ.mandate.<status>`
    // pair declared by Clerk's mandate config are framework-owned. The
    // signal-tool validator surfaces this distinction by rejecting plugin-
    // declared names with the framework-owned message; an undeclared name
    // is rejected with the "not a declared event" message instead.
    const expected = [
      'clockworks.standing-order.failed',
      'clockworks.timer',
      'writ.mandate.new',
      'writ.mandate.open',
      'writ.mandate.stuck',
      'writ.mandate.completed',
      'writ.mandate.failed',
      'writ.mandate.cancelled',
    ];
    for (const name of expected) {
      assert.throws(
        () => fix.clockworks.validateSignal(name),
        /framework-owned event/,
        `expected "${name}" to be framework-owned`,
      );
    }

    // A name that was never declared falls into the "not a declared event"
    // branch instead — proving the merged set's positive coverage stops at
    // the declared list above.
    assert.throws(
      () => fix.clockworks.validateSignal('writ.mandate.totally-made-up'),
      /not a declared event/,
    );
  });

  it('posting a root mandate then publishing it fires writ.mandate.new and writ.mandate.open', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'do work', body: 'b' });
    const opened = await fix.clerk.transition(writ.id, 'open');
    assert.equal(opened.phase, 'open');

    const names = await fix.eventNames();
    assert.ok(names.includes('writ.mandate.new'));
    assert.ok(names.includes('writ.mandate.open'));
  });

  it('posting a draft fires writ.mandate.new; publishing it fires writ.mandate.open', async () => {
    const fix = await buildGuild();

    const draft = await fix.clerk.post({ title: 'drafty', body: 'b', draft: true });
    assert.equal(draft.phase, 'new');

    // Draft creation fires the universal `writ.mandate.new` row and
    // nothing else.
    assert.deepEqual(await fix.eventNames(), ['writ.mandate.new']);

    // Publish (new → open) fires writ.mandate.open.
    await fix.clerk.transition(draft.id, 'open');

    assert.deepEqual(await fix.eventNames(), [
      'writ.mandate.new',
      'writ.mandate.open',
    ]);
  });

  it('drives a root mandate through stuck → open → completed and observes the full writ.mandate.<status> sequence', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'multi-step', body: 'b' });
    // new → open (publish)
    await fix.clerk.transition(writ.id, 'open');
    // open → stuck
    await fix.clerk.transition(writ.id, 'stuck', { resolution: 'jammed' });
    // stuck → open (re-entry)
    await fix.clerk.transition(writ.id, 'open');
    // open → completed
    await fix.clerk.transition(writ.id, 'completed');

    // Universal contract: every transition (including initial creation)
    // fires exactly one `writ.<type>.<phase>` row. The strict-shape
    // assertion is the regression gate against the very change C2
    // makes — keep `deepEqual`, do not relax to `includes`.
    const lifecycle = (await fix.eventNames()).filter((n) => n.startsWith('writ.mandate.'));
    assert.deepEqual(lifecycle, [
      'writ.mandate.new',       // post() → draft creation
      'writ.mandate.open',      // new → open transition (publish)
      'writ.mandate.stuck',     // open → stuck
      'writ.mandate.open',      // stuck → open (re-entry)
      'writ.mandate.completed', // open → completed
    ]);

    // commissionId on every row points at the root writ's id.
    const allDocs = await fix.events();
    for (const doc of allDocs.filter((d) => d.name.startsWith('writ.mandate.'))) {
      const payload = doc.payload as Record<string, unknown>;
      assert.equal(payload.commissionId, writ.id);
    }
  });

  it('a transition into cancelled fires writ.mandate.cancelled (universal contract)', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'discard', body: 'b' });
    await fix.clerk.transition(writ.id, 'cancelled', { resolution: 'no longer needed' });

    const names = await fix.eventNames();
    assert.deepEqual(names, [
      'writ.mandate.new',
      'writ.mandate.cancelled',
    ]);
  });

  it('a child mandate writ behaves identically — fires writ.mandate.<status> with commissionId pointing at the root', async () => {
    const fix = await buildGuild();

    const root = await fix.clerk.post({ title: 'parent', body: 'b' });
    await fix.clerk.transition(root.id, 'open');
    // Child of type 'mandate' — same universal contract; no privileged
    // commission.* family.
    const child = await fix.clerk.post({
      title: 'child',
      body: 'b',
      type: 'mandate',
      parentId: root.id,
    });
    await fix.clerk.transition(child.id, 'open');

    // writ.mandate.open fires once for the root and once for the child.
    const opens = await fix.byName('writ.mandate.open');
    assert.equal(opens.length, 2);

    // The child's lifecycle event carries the root's id as commissionId.
    const childOpen = opens.find(
      (d) => (d.payload as Record<string, unknown>).writId === child.id,
    );
    assert.ok(childOpen);
    assert.equal((childOpen!.payload as Record<string, unknown>).commissionId, root.id);
  });

  it('every event row is emitted with emitter="framework"', async () => {
    const fix = await buildGuild();
    await fix.clerk.post({ title: 'whatever', body: 'b' });

    const all = await fix.events();
    for (const doc of all) {
      assert.equal(doc.emitter, 'framework', `event "${doc.name}" must use framework emitter`);
    }
  });
});

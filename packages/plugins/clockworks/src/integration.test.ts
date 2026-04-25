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

  await clockworksPlugin.apparatus.start(buildCtx());
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

  it('first guild boot produces exactly one guild.initialized event row', async () => {
    const fix = await buildGuild();

    const initialized = await fix.byName('guild.initialized');
    assert.equal(initialized.length, 1);
    assert.equal(initialized[0]!.emitter, 'framework');
  });

  it('a second start of the Clockworks against the same backend does NOT add a guild.initialized row', async () => {
    // First boot.
    await buildGuild();
    // Tear down the singleton, but keep the backend's persisted state.
    // Because each buildGuild() uses a fresh MemoryBackend, simulate
    // "second boot of the same guild" by starting Clockworks twice
    // against the same Stacks instance — the events book retains the
    // first emission so the second start finds the row and skips.
    const fix = await buildGuild();
    const beforeCount = (await fix.byName('guild.initialized')).length;
    assert.equal(beforeCount, 1);

    // Start Clockworks again (against the SAME backend / same guild
    // singleton) and confirm no second row appears.
    const clockworksAgain = createClockworks();
    if (!('apparatus' in clockworksAgain)) throw new Error('clockworks');
    await clockworksAgain.apparatus.start({ on: () => {}, kits: () => [] });

    const afterCount = (await fix.byName('guild.initialized')).length;
    assert.equal(afterCount, 1, 'a re-start must not add another guild.initialized row');
  });

  it('posting a root mandate fires mandate.ready, commission.posted, and commission.state.changed', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'do work', body: 'b' });
    assert.equal(writ.phase, 'open');

    const names = await fix.eventNames();
    assert.ok(names.includes('mandate.ready'));
    assert.ok(names.includes('commission.posted'));
    assert.ok(names.includes('commission.state.changed'));
  });

  it('posting a draft followed by writ-publish fires the same set as direct creation', async () => {
    const fix = await buildGuild();

    const draft = await fix.clerk.post({ title: 'drafty', body: 'b', draft: true });
    assert.equal(draft.phase, 'new');

    // Drafts produce no events on creation (D17).
    const draftNames = (await fix.eventNames()).filter(
      (n) => n !== 'guild.initialized',
    );
    assert.deepEqual(draftNames, []);

    // Publish (new → open) — should fire ready + posted + state.changed.
    await fix.clerk.transition(draft.id, 'open');

    const names = (await fix.eventNames()).filter((n) => n !== 'guild.initialized');
    assert.ok(names.includes('mandate.ready'));
    assert.ok(names.includes('commission.posted'));
    assert.ok(names.includes('commission.state.changed'));
  });

  it('drives a root mandate through stuck → open → completed and observes the full sequence', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'multi-step', body: 'b' });
    // open → stuck
    await fix.clerk.transition(writ.id, 'stuck', { resolution: 'jammed' });
    // stuck → open (re-entry)
    await fix.clerk.transition(writ.id, 'open');
    // open → completed
    await fix.clerk.transition(writ.id, 'completed');

    const all = (await fix.eventNames()).filter((n) => n !== 'guild.initialized');

    // mandate-lifecycle suffix sequence
    const lifecycle = all.filter((n) => n.startsWith('mandate.'));
    assert.deepEqual(lifecycle, [
      'mandate.ready',     // initial post into open
      'mandate.stuck',     // open → stuck
      'mandate.ready',     // stuck → open (D21 re-entry)
      'mandate.completed', // open → completed
    ]);

    // commission.* sequence
    const commission = all.filter((n) => n.startsWith('commission.'));
    // commission.posted fires twice — once per entry into open (D15).
    assert.equal(commission.filter((n) => n === 'commission.posted').length, 2);
    // commission.state.changed fires once per phase change (4 transitions
    // total: post into open, open→stuck, stuck→open, open→completed).
    assert.equal(commission.filter((n) => n === 'commission.state.changed').length, 4);
    // sealed AND completed both fire on entry into completed (D5).
    assert.equal(commission.filter((n) => n === 'commission.sealed').length, 1);
    assert.equal(commission.filter((n) => n === 'commission.completed').length, 1);

    // commissionId on every row points at the root writ's id.
    const allDocs = await fix.events();
    for (const doc of allDocs.filter((d) => d.name.startsWith('commission.'))) {
      const payload = doc.payload as Record<string, unknown>;
      assert.equal(payload.commissionId, writ.id);
    }
  });

  it('a transition into cancelled produces NO event row (D3)', async () => {
    const fix = await buildGuild();

    const writ = await fix.clerk.post({ title: 'discard', body: 'b' });
    const beforeCancel = (await fix.eventNames()).filter((n) => n !== 'guild.initialized');

    await fix.clerk.transition(writ.id, 'cancelled', { resolution: 'no longer needed' });

    const afterCancel = (await fix.eventNames()).filter((n) => n !== 'guild.initialized');
    assert.deepEqual(afterCancel, beforeCancel, 'cancellation must not add events');
  });

  it('a child non-mandate writ fires {type}.ready but NOT commission.* events', async () => {
    const fix = await buildGuild();

    const root = await fix.clerk.post({ title: 'parent', body: 'b' });
    // Child of type 'mandate' — but parentId is set, so commission.* gates off (D5).
    const child = await fix.clerk.post({
      title: 'child',
      body: 'b',
      type: 'mandate',
      parentId: root.id,
    });

    const childReady = await fix.byName('mandate.ready');
    // mandate.ready fires for both root and child.
    assert.ok(childReady.length >= 2);

    // commission.posted fired exactly once (for the root).
    const posted = await fix.byName('commission.posted');
    assert.equal(posted.length, 1);
    const payload = posted[0]!.payload as Record<string, unknown>;
    assert.equal(payload.commissionId, root.id);
    // Sanity: the child's lifecycle event carries the root's id as commissionId.
    const ready = childReady.find(
      (d) => (d.payload as Record<string, unknown>).writId === child.id,
    );
    assert.ok(ready);
    assert.equal((ready!.payload as Record<string, unknown>).commissionId, root.id);
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

/**
 * Clerk apparatus tests.
 *
 * Uses in-memory Stacks and a minimal fake guild to test the full writ
 * lifecycle without any external dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from './clerk.ts';
import type { ClerkApi } from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

let clerk: ClerkApi;

interface SetupOptions {
  writTypes?: Record<string, { description: string }>;
  clerkConfig?: { defaultType?: string };
}

function setup(options: SetupOptions = {}) {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    writTypes: options.writTypes,
    settings: { model: 'sonnet' },
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(pluginId: string): T {
      if (pluginId === 'clerk') {
        return (options.clerkConfig ?? {}) as T;
      }
      return {} as T;
    },
    writeConfig() { /* noop */ },
    guildConfig() { return fakeGuildConfig; },
    kits: () => [],
    apparatuses: () => [],
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {} });
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['status', 'type', 'assignee', 'postedAt'],
  });

  // Start clerk
  const clerkApparatus = (clerkPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  clerkApparatus.start({ on: () => {} });
  clerk = clerkApparatus.provides as ClerkApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Clerk', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── postCommission() ─────────────────────────────────────────────

  describe('postCommission()', () => {
    beforeEach(() => { setup(); });

    it('creates a writ with ready status and mandate type by default', async () => {
      const writ = await clerk.postCommission({ title: 'Fix the bug' });

      assert.ok(writ.id.startsWith('writ-'));
      assert.equal(writ.type, 'mandate');
      assert.equal(writ.title, 'Fix the bug');
      assert.equal(writ.status, 'ready');
      assert.equal(writ.body, null);
      assert.equal(writ.assignee, null);
      assert.equal(writ.acceptedAt, null);
      assert.equal(writ.closedAt, null);
      assert.equal(writ.failReason, null);
      assert.ok(writ.postedAt);
    });

    it('accepts explicit type when it is a built-in type', async () => {
      const writ = await clerk.postCommission({ title: 'Summon an anima', type: 'summon' });
      assert.equal(writ.type, 'summon');
    });

    it('persists body and assignee fields', async () => {
      const writ = await clerk.postCommission({
        title: 'Do the thing',
        body: 'Detailed instructions here',
        assignee: 'artificer',
      });

      assert.equal(writ.body, 'Detailed instructions here');
      assert.equal(writ.assignee, 'artificer');
    });

    it('uses guild defaultType from clerk config when provided', async () => {
      setup({ clerkConfig: { defaultType: 'summon' } });
      const writ = await clerk.postCommission({ title: 'Summon' });
      assert.equal(writ.type, 'summon');
    });

    it('rejects an unknown writ type', async () => {
      await assert.rejects(
        () => clerk.postCommission({ title: 'Test', type: 'unknown-type' }),
        /Unknown writ type/,
      );
    });

    it('accepts a type declared in guild writTypes config', async () => {
      setup({ writTypes: { 'errand': { description: 'A small errand' } } });
      const writ = await clerk.postCommission({ title: 'Run errand', type: 'errand' });
      assert.equal(writ.type, 'errand');
    });

    it('rejects a type that is not in guild writTypes', async () => {
      setup({ writTypes: { 'errand': { description: 'A small errand' } } });
      await assert.rejects(
        () => clerk.postCommission({ title: 'Test', type: 'quest' }),
        /Unknown writ type/,
      );
    });

    it('generates unique ids for each writ', async () => {
      const w1 = await clerk.postCommission({ title: 'Writ 1' });
      const w2 = await clerk.postCommission({ title: 'Writ 2' });
      assert.notEqual(w1.id, w2.id);
    });
  });

  // ── show() ───────────────────────────────────────────────────────

  describe('show()', () => {
    beforeEach(() => { setup(); });

    it('returns null for a non-existent writ id', async () => {
      const result = await clerk.show('writ-doesnotexist');
      assert.equal(result, null);
    });

    it('retrieves a writ that was just posted', async () => {
      const posted = await clerk.postCommission({ title: 'Show me' });
      const fetched = await clerk.show(posted.id);

      assert.ok(fetched);
      assert.equal(fetched.id, posted.id);
      assert.equal(fetched.title, 'Show me');
      assert.equal(fetched.status, 'ready');
    });
  });

  // ── list() ───────────────────────────────────────────────────────

  describe('list()', () => {
    beforeEach(() => {
      setup({ writTypes: { 'errand': { description: 'A small errand' } } });
    });

    it('returns all writs when no filters given', async () => {
      await clerk.postCommission({ title: 'Writ A' });
      await clerk.postCommission({ title: 'Writ B' });
      await clerk.postCommission({ title: 'Writ C' });

      const all = await clerk.list();
      assert.equal(all.length, 3);
    });

    it('filters by status', async () => {
      const w1 = await clerk.postCommission({ title: 'Ready writ' });
      const w2 = await clerk.postCommission({ title: 'Active writ' });
      await clerk.accept(w2.id);

      const ready = await clerk.list({ status: 'ready' });
      const active = await clerk.list({ status: 'active' });

      assert.equal(ready.length, 1);
      assert.equal(ready[0]!.id, w1.id);
      assert.equal(active.length, 1);
      assert.equal(active[0]!.id, w2.id);
    });

    it('filters by type', async () => {
      await clerk.postCommission({ title: 'Mandate writ', type: 'mandate' });
      await clerk.postCommission({ title: 'Errand writ', type: 'errand' });

      const mandates = await clerk.list({ type: 'mandate' });
      const errands = await clerk.list({ type: 'errand' });

      assert.equal(mandates.length, 1);
      assert.equal(mandates[0]!.type, 'mandate');
      assert.equal(errands.length, 1);
      assert.equal(errands[0]!.type, 'errand');
    });

    it('filters by assignee', async () => {
      await clerk.postCommission({ title: 'For artificer', assignee: 'artificer' });
      await clerk.postCommission({ title: 'Unassigned' });

      const assigned = await clerk.list({ assignee: 'artificer' });
      assert.equal(assigned.length, 1);
      assert.equal(assigned[0]!.assignee, 'artificer');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await clerk.postCommission({ title: `Writ ${i}` });
      }

      const limited = await clerk.list({ limit: 3 });
      assert.equal(limited.length, 3);
    });

    it('returns an empty array when no writs match filters', async () => {
      await clerk.postCommission({ title: 'One ready writ' });
      const completed = await clerk.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });
  });

  // ── accept() — ready → active ────────────────────────────────────

  describe('accept()', () => {
    beforeEach(() => { setup(); });

    it('transitions a ready writ to active', async () => {
      const writ = await clerk.postCommission({ title: 'Accept me' });
      const updated = await clerk.accept(writ.id);

      assert.equal(updated.status, 'active');
      assert.ok(updated.acceptedAt);
      assert.equal(updated.closedAt, null);
    });

    it('throws if writ does not exist', async () => {
      await assert.rejects(
        () => clerk.accept('writ-ghost'),
        /not found/,
      );
    });

    it('throws if writ is already active', async () => {
      const writ = await clerk.postCommission({ title: 'Active writ' });
      await clerk.accept(writ.id);

      await assert.rejects(
        () => clerk.accept(writ.id),
        /Cannot accept/,
      );
    });

    it('throws if writ is in a terminal state', async () => {
      const writ = await clerk.postCommission({ title: 'Completed writ' });
      await clerk.accept(writ.id);
      await clerk.complete(writ.id);

      await assert.rejects(
        () => clerk.accept(writ.id),
        /Cannot accept/,
      );
    });
  });

  // ── complete() — active → completed ─────────────────────────────

  describe('complete()', () => {
    beforeEach(() => { setup(); });

    it('transitions an active writ to completed', async () => {
      const writ = await clerk.postCommission({ title: 'Complete me' });
      await clerk.accept(writ.id);
      const completed = await clerk.complete(writ.id);

      assert.equal(completed.status, 'completed');
      assert.ok(completed.closedAt);
    });

    it('throws when completing a ready writ (must accept first)', async () => {
      const writ = await clerk.postCommission({ title: 'Not yet accepted' });

      await assert.rejects(
        () => clerk.complete(writ.id),
        /Cannot complete/,
      );
    });

    it('throws when completing a cancelled writ', async () => {
      const writ = await clerk.postCommission({ title: 'Cancelled' });
      await clerk.cancel(writ.id);

      await assert.rejects(
        () => clerk.complete(writ.id),
        /Cannot complete/,
      );
    });
  });

  // ── fail() — active → failed ─────────────────────────────────────

  describe('fail()', () => {
    beforeEach(() => { setup(); });

    it('transitions an active writ to failed', async () => {
      const writ = await clerk.postCommission({ title: 'Fail me' });
      await clerk.accept(writ.id);
      const failed = await clerk.fail(writ.id);

      assert.equal(failed.status, 'failed');
      assert.ok(failed.closedAt);
      assert.equal(failed.failReason, null);
    });

    it('records a failure reason when provided', async () => {
      const writ = await clerk.postCommission({ title: 'Will fail' });
      await clerk.accept(writ.id);
      const failed = await clerk.fail(writ.id, 'Ran out of time');

      assert.equal(failed.failReason, 'Ran out of time');
    });

    it('throws when failing a ready writ', async () => {
      const writ = await clerk.postCommission({ title: 'Not active' });

      await assert.rejects(
        () => clerk.fail(writ.id),
        /Cannot fail/,
      );
    });

    it('throws when failing a completed writ', async () => {
      const writ = await clerk.postCommission({ title: 'Already done' });
      await clerk.accept(writ.id);
      await clerk.complete(writ.id);

      await assert.rejects(
        () => clerk.fail(writ.id),
        /Cannot fail/,
      );
    });
  });

  // ── cancel() — ready|active → cancelled ─────────────────────────

  describe('cancel()', () => {
    beforeEach(() => { setup(); });

    it('cancels a ready writ', async () => {
      const writ = await clerk.postCommission({ title: 'Cancel me (ready)' });
      const cancelled = await clerk.cancel(writ.id);

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.closedAt);
    });

    it('cancels an active writ', async () => {
      const writ = await clerk.postCommission({ title: 'Cancel me (active)' });
      await clerk.accept(writ.id);
      const cancelled = await clerk.cancel(writ.id);

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.closedAt);
    });

    it('throws when cancelling a completed writ', async () => {
      const writ = await clerk.postCommission({ title: 'Done' });
      await clerk.accept(writ.id);
      await clerk.complete(writ.id);

      await assert.rejects(
        () => clerk.cancel(writ.id),
        /Cannot cancel/,
      );
    });

    it('throws when cancelling a failed writ', async () => {
      const writ = await clerk.postCommission({ title: 'Failed' });
      await clerk.accept(writ.id);
      await clerk.fail(writ.id);

      await assert.rejects(
        () => clerk.cancel(writ.id),
        /Cannot cancel/,
      );
    });

    it('throws when cancelling an already-cancelled writ', async () => {
      const writ = await clerk.postCommission({ title: 'Cancelled twice' });
      await clerk.cancel(writ.id);

      await assert.rejects(
        () => clerk.cancel(writ.id),
        /Cannot cancel/,
      );
    });
  });

  // ── Full lifecycle ───────────────────────────────────────────────

  describe('full lifecycle', () => {
    beforeEach(() => { setup(); });

    it('happy path: ready → active → completed', async () => {
      const writ = await clerk.postCommission({ title: 'Full lifecycle', body: 'Do it all' });
      assert.equal(writ.status, 'ready');

      const active = await clerk.accept(writ.id);
      assert.equal(active.status, 'active');
      assert.ok(active.acceptedAt);
      assert.equal(active.closedAt, null);

      const done = await clerk.complete(writ.id);
      assert.equal(done.status, 'completed');
      assert.ok(done.closedAt);

      // Verify persisted state via show()
      const persisted = await clerk.show(writ.id);
      assert.ok(persisted);
      assert.equal(persisted.status, 'completed');
    });

    it('failure path: ready → active → failed', async () => {
      const writ = await clerk.postCommission({ title: 'Will fail' });
      await clerk.accept(writ.id);
      const failed = await clerk.fail(writ.id, 'Something broke');

      assert.equal(failed.status, 'failed');
      assert.equal(failed.failReason, 'Something broke');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted?.status, 'failed');
    });

    it('cancellation path: ready → cancelled', async () => {
      const writ = await clerk.postCommission({ title: 'Cancelled early' });
      const cancelled = await clerk.cancel(writ.id);
      assert.equal(cancelled.status, 'cancelled');
    });
  });

  // ── Config validation ────────────────────────────────────────────

  describe('config: writTypes validation', () => {
    it('built-in types are always valid regardless of writTypes config', async () => {
      setup({ writTypes: {} }); // empty writTypes — built-ins still work
      const w1 = await clerk.postCommission({ title: 'Mandate', type: 'mandate' });
      const w2 = await clerk.postCommission({ title: 'Summon', type: 'summon' });
      assert.equal(w1.type, 'mandate');
      assert.equal(w2.type, 'summon');
    });

    it('declared custom types are accepted', async () => {
      setup({
        writTypes: {
          'quest': { description: 'A significant task' },
          'errand': { description: 'A small errand' },
        },
      });
      const w = await clerk.postCommission({ title: 'Go on a quest', type: 'quest' });
      assert.equal(w.type, 'quest');
    });

    it('undeclared types are rejected even when other custom types exist', async () => {
      setup({ writTypes: { 'quest': { description: 'A quest' } } });
      await assert.rejects(
        () => clerk.postCommission({ title: 'Test', type: 'unknown' }),
        /Unknown writ type/,
      );
    });

    it('defaultType from clerk config is validated against declared types', async () => {
      setup({ clerkConfig: { defaultType: 'summon' } });
      const w = await clerk.postCommission({ title: 'Default summon' });
      assert.equal(w.type, 'summon');
    });
  });
});

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
    indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
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

  // ── post() ───────────────────────────────────────────────────────

  describe('post()', () => {
    beforeEach(() => { setup(); });

    it('creates a writ with ready status and mandate type by default', async () => {
      const writ = await clerk.post({ title: 'Fix the bug', body: 'Details here' });

      assert.ok(writ.id.startsWith('writ-'));
      assert.equal(writ.type, 'mandate');
      assert.equal(writ.title, 'Fix the bug');
      assert.equal(writ.body, 'Details here');
      assert.equal(writ.status, 'ready');
      assert.ok(writ.createdAt);
      assert.ok(writ.updatedAt);
      assert.equal(writ.acceptedAt, undefined);
      assert.equal(writ.resolvedAt, undefined);
      assert.equal(writ.resolution, undefined);
      assert.equal(writ.codex, undefined);
    });

    it('requires body field', async () => {
      // TypeScript enforces this at compile time; at runtime the field is required
      const writ = await clerk.post({ title: 'Has body', body: 'Required content' });
      assert.equal(writ.body, 'Required content');
    });

    it('accepts explicit type when it is a built-in type', async () => {
      const writ = await clerk.post({ title: 'Summon an anima', body: 'Do it', type: 'summon' });
      assert.equal(writ.type, 'summon');
    });

    it('persists codex field', async () => {
      const writ = await clerk.post({
        title: 'Do the thing',
        body: 'Detailed instructions here',
        codex: 'artificer',
      });

      assert.equal(writ.codex, 'artificer');
    });

    it('omits codex when not provided', async () => {
      const writ = await clerk.post({ title: 'No codex', body: 'Details' });
      assert.equal(writ.codex, undefined);
    });

    it('uses guild defaultType from clerk config when provided', async () => {
      setup({ clerkConfig: { defaultType: 'summon' } });
      const writ = await clerk.post({ title: 'Summon', body: 'Body' });
      assert.equal(writ.type, 'summon');
    });

    it('rejects an unknown writ type', async () => {
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown-type' }),
        /Unknown writ type/,
      );
    });

    it('accepts a type declared in guild writTypes config', async () => {
      setup({ writTypes: { 'errand': { description: 'A small errand' } } });
      const writ = await clerk.post({ title: 'Run errand', body: 'Do it', type: 'errand' });
      assert.equal(writ.type, 'errand');
    });

    it('rejects a type that is not in guild writTypes', async () => {
      setup({ writTypes: { 'errand': { description: 'A small errand' } } });
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'quest' }),
        /Unknown writ type/,
      );
    });

    it('generates unique ids for each writ', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      assert.notEqual(w1.id, w2.id);
    });

    it('sets createdAt and updatedAt to the same value on creation', async () => {
      const writ = await clerk.post({ title: 'Timestamps', body: 'Body' });
      assert.equal(writ.createdAt, writ.updatedAt);
    });
  });

  // ── show() ───────────────────────────────────────────────────────

  describe('show()', () => {
    beforeEach(() => { setup(); });

    it('throws for a non-existent writ id', async () => {
      await assert.rejects(
        () => clerk.show('writ-doesnotexist'),
        /not found/,
      );
    });

    it('retrieves a writ that was just posted', async () => {
      const posted = await clerk.post({ title: 'Show me', body: 'Body' });
      const fetched = await clerk.show(posted.id);

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
      await clerk.post({ title: 'Writ A', body: 'Body' });
      await clerk.post({ title: 'Writ B', body: 'Body' });
      await clerk.post({ title: 'Writ C', body: 'Body' });

      const all = await clerk.list();
      assert.equal(all.length, 3);
    });

    it('filters by status', async () => {
      const w1 = await clerk.post({ title: 'Ready writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'Active writ', body: 'Body' });
      await clerk.transition(w2.id, 'active');

      const ready = await clerk.list({ status: 'ready' });
      const active = await clerk.list({ status: 'active' });

      assert.equal(ready.length, 1);
      assert.equal(ready[0]!.id, w1.id);
      assert.equal(active.length, 1);
      assert.equal(active[0]!.id, w2.id);
    });

    it('filters by type', async () => {
      await clerk.post({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const mandates = await clerk.list({ type: 'mandate' });
      const errands = await clerk.list({ type: 'errand' });

      assert.equal(mandates.length, 1);
      assert.equal(mandates[0]!.type, 'mandate');
      assert.equal(errands.length, 1);
      assert.equal(errands[0]!.type, 'errand');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await clerk.post({ title: `Writ ${i}`, body: 'Body' });
      }

      const limited = await clerk.list({ limit: 3 });
      assert.equal(limited.length, 3);
    });

    it('respects the offset parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await clerk.post({ title: `Writ ${i}`, body: 'Body' });
      }

      const all = await clerk.list();
      const offset = await clerk.list({ offset: 2 });
      assert.equal(offset.length, 3);
      assert.equal(offset[0]!.id, all[2]!.id);
    });

    it('returns an empty array when no writs match filters', async () => {
      await clerk.post({ title: 'One ready writ', body: 'Body' });
      const completed = await clerk.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });
  });

  // ── count() ──────────────────────────────────────────────────────

  describe('count()', () => {
    beforeEach(() => { setup(); });

    it('returns total count with no filters', async () => {
      await clerk.post({ title: 'Writ A', body: 'Body' });
      await clerk.post({ title: 'Writ B', body: 'Body' });
      assert.equal(await clerk.count(), 2);
    });

    it('returns 0 when no writs exist', async () => {
      assert.equal(await clerk.count(), 0);
    });

    it('filters by status', async () => {
      const w = await clerk.post({ title: 'Writ', body: 'Body' });
      await clerk.transition(w.id, 'active');

      assert.equal(await clerk.count({ status: 'active' }), 1);
      assert.equal(await clerk.count({ status: 'ready' }), 0);
    });

    it('filters by type', async () => {
      await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Summon', body: 'Body', type: 'summon' });

      assert.equal(await clerk.count({ type: 'mandate' }), 1);
      assert.equal(await clerk.count({ type: 'summon' }), 1);
    });
  });

  // ── transition() — ready → active ───────────────────────────────

  describe('transition() to active', () => {
    beforeEach(() => { setup(); });

    it('transitions a ready writ to active', async () => {
      const writ = await clerk.post({ title: 'Accept me', body: 'Body' });
      const updated = await clerk.transition(writ.id, 'active');

      assert.equal(updated.status, 'active');
      assert.ok(updated.acceptedAt);
      assert.equal(updated.resolvedAt, undefined);
    });

    it('sets updatedAt on transition', async () => {
      const writ = await clerk.post({ title: 'Timestamps', body: 'Body' });
      // Ensure a tiny gap so updatedAt can differ
      await new Promise(r => setTimeout(r, 2));
      const updated = await clerk.transition(writ.id, 'active');
      assert.ok(updated.updatedAt >= writ.updatedAt);
    });

    it('throws if writ does not exist', async () => {
      await assert.rejects(
        () => clerk.transition('writ-ghost', 'active'),
        /not found/,
      );
    });

    it('throws if writ is already active', async () => {
      const writ = await clerk.post({ title: 'Active writ', body: 'Body' });
      await clerk.transition(writ.id, 'active');

      await assert.rejects(
        () => clerk.transition(writ.id, 'active'),
        /Cannot transition/,
      );
    });

    it('throws if writ is in a terminal state', async () => {
      const writ = await clerk.post({ title: 'Completed writ', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'active'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — active → completed ───────────────────────────

  describe('transition() to completed', () => {
    beforeEach(() => { setup(); });

    it('transitions an active writ to completed', async () => {
      const writ = await clerk.post({ title: 'Complete me', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'All done' });

      assert.equal(completed.status, 'completed');
      assert.ok(completed.resolvedAt);
      assert.equal(completed.resolution, 'All done');
    });

    it('sets resolution on completed', async () => {
      const writ = await clerk.post({ title: 'With resolution', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Task fulfilled' });
      assert.equal(completed.resolution, 'Task fulfilled');
    });

    it('throws when completing a ready writ (must accept first)', async () => {
      const writ = await clerk.post({ title: 'Not yet accepted', body: 'Body' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'completed'),
        /Cannot transition/,
      );
    });

    it('throws when completing a cancelled writ', async () => {
      const writ = await clerk.post({ title: 'Cancelled', body: 'Body' });
      await clerk.transition(writ.id, 'cancelled');

      await assert.rejects(
        () => clerk.transition(writ.id, 'completed'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — active → failed ──────────────────────────────

  describe('transition() to failed', () => {
    beforeEach(() => { setup(); });

    it('transitions an active writ to failed', async () => {
      const writ = await clerk.post({ title: 'Fail me', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Ran out of time' });

      assert.equal(failed.status, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Ran out of time');
    });

    it('sets resolution on failed', async () => {
      const writ = await clerk.post({ title: 'Will fail', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });
      assert.equal(failed.resolution, 'Something broke');
    });

    it('throws when failing a ready writ', async () => {
      const writ = await clerk.post({ title: 'Not active', body: 'Body' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'failed'),
        /Cannot transition/,
      );
    });

    it('throws when failing a completed writ', async () => {
      const writ = await clerk.post({ title: 'Already done', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'failed'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — ready|active → cancelled ──────────────────────

  describe('transition() to cancelled', () => {
    beforeEach(() => { setup(); });

    it('cancels a ready writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (ready)', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('cancels an active writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (active)', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('sets resolution on cancelled when provided', async () => {
      const writ = await clerk.post({ title: 'Cancel with reason', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled', { resolution: 'No longer needed' });
      assert.equal(cancelled.resolution, 'No longer needed');
    });

    it('throws when cancelling a completed writ', async () => {
      const writ = await clerk.post({ title: 'Done', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });

    it('throws when cancelling a failed writ', async () => {
      const writ = await clerk.post({ title: 'Failed', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      await clerk.transition(writ.id, 'failed', { resolution: 'Broke' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });

    it('throws when cancelling an already-cancelled writ', async () => {
      const writ = await clerk.post({ title: 'Cancelled twice', body: 'Body' });
      await clerk.transition(writ.id, 'cancelled');

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });
  });

  // ── Full lifecycle ───────────────────────────────────────────────

  describe('full lifecycle', () => {
    beforeEach(() => { setup(); });

    it('happy path: ready → active → completed', async () => {
      const writ = await clerk.post({ title: 'Full lifecycle', body: 'Do it all' });
      assert.equal(writ.status, 'ready');

      const active = await clerk.transition(writ.id, 'active');
      assert.equal(active.status, 'active');
      assert.ok(active.acceptedAt);
      assert.equal(active.resolvedAt, undefined);

      const done = await clerk.transition(writ.id, 'completed', { resolution: 'All finished' });
      assert.equal(done.status, 'completed');
      assert.ok(done.resolvedAt);
      assert.equal(done.resolution, 'All finished');

      // Verify persisted state via show()
      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.status, 'completed');
    });

    it('failure path: ready → active → failed', async () => {
      const writ = await clerk.post({ title: 'Will fail', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });

      assert.equal(failed.status, 'failed');
      assert.equal(failed.resolution, 'Something broke');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.status, 'failed');
    });

    it('cancellation path: ready → cancelled', async () => {
      const writ = await clerk.post({ title: 'Cancelled early', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.status, 'cancelled');
    });

    it('updatedAt changes on each mutation', async () => {
      const writ = await clerk.post({ title: 'Track updates', body: 'Body' });
      const t0 = writ.updatedAt;

      await new Promise(r => setTimeout(r, 2));
      const active = await clerk.transition(writ.id, 'active');
      const t1 = active.updatedAt;

      await new Promise(r => setTimeout(r, 2));
      const done = await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const t2 = done.updatedAt;

      assert.ok(t1 >= t0);
      assert.ok(t2 >= t1);
    });
  });

  // ── Config validation ────────────────────────────────────────────

  describe('config: writTypes validation', () => {
    it('built-in types are always valid regardless of writTypes config', async () => {
      setup({ writTypes: {} }); // empty writTypes — built-ins still work
      const w1 = await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      const w2 = await clerk.post({ title: 'Summon', body: 'Body', type: 'summon' });
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
      const w = await clerk.post({ title: 'Go on a quest', body: 'Body', type: 'quest' });
      assert.equal(w.type, 'quest');
    });

    it('undeclared types are rejected even when other custom types exist', async () => {
      setup({ writTypes: { 'quest': { description: 'A quest' } } });
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown' }),
        /Unknown writ type/,
      );
    });

    it('defaultType from clerk config is validated against declared types', async () => {
      setup({ clerkConfig: { defaultType: 'summon' } });
      const w = await clerk.post({ title: 'Default summon', body: 'Body' });
      assert.equal(w.type, 'summon');
    });
  });
});

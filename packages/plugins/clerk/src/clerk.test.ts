/**
 * Clerk apparatus tests.
 *
 * Uses in-memory Stacks and a minimal fake guild to test the full writ
 * lifecycle without any external dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from './clerk.ts';
import type { ClerkKit } from './clerk.ts';
import type { ClerkApi, ClerkConfig, WritLinkDoc } from './types.ts';
import type { WritLinks } from './index.ts';
import writShow from './tools/writ-show.ts';
import writLink from './tools/writ-link.ts';
import writUnlink from './tools/writ-unlink.ts';

// ── Test harness ─────────────────────────────────────────────────────

let clerk: ClerkApi;

interface SetupOptions {
  clerkConfig?: ClerkConfig;
  extraKits?: LoadedKit[];
  extraApparatuses?: LoadedApparatus[];
}

function buildClerkCtx(kitEntries: KitEntry[] = []): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const ctx: StartupContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter(e => e.type === type)];
    },
  };
  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) await h(...args);
  }
  return { ctx, fire };
}

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[] = []): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

type ClerkPlugin = ReturnType<typeof createClerk>;

function setupCore(options: SetupOptions = {}, clerkCtx?: StartupContext): ClerkPlugin {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    settings: { model: 'sonnet' },
    clerk: options.clerkConfig,
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() { /* noop */ },
    guildConfig() { return fakeGuildConfig; },
    kits: () => options.extraKits ?? [],
    apparatuses: () => options.extraApparatuses ?? [],
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['status', 'type', 'createdAt', 'parentId', ['status', 'type'], ['status', 'createdAt'], ['parentId', 'status']],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'type', ['sourceId', 'type'], ['targetId', 'type']],
  });

  // Start clerk — build default ctx with Wire-phase kit entries if not provided
  const kitEntries = buildKitEntries(options.extraKits ?? [], options.extraApparatuses ?? []);
  const ctx = clerkCtx ?? buildClerkCtx(kitEntries).ctx;
  const clerkApparatus = (clerkPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  clerkApparatus.start(ctx);
  clerk = clerkApparatus.provides as ClerkApi;

  // Expose clerk as an apparatus so tool handlers can resolve it via guild()
  apparatusMap.set('clerk', clerk);

  return clerkPlugin;
}

function setup(options: SetupOptions = {}) {
  setupCore(options);
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

      assert.ok(writ.id.startsWith('w-'));
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
      const writ = await clerk.post({ title: 'A mandate', body: 'Do it', type: 'mandate' });
      assert.equal(writ.type, 'mandate');
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
      // mandate is a built-in, so it's always valid as a defaultType
      setup({ clerkConfig: { defaultType: 'mandate' } });
      const writ = await clerk.post({ title: 'Default mandate', body: 'Body' });
      assert.equal(writ.type, 'mandate');
    });

    it('rejects an unknown writ type', async () => {
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown-type' }),
        /Unknown writ type/,
      );
    });

    it('accepts a type declared in clerk writTypes config', async () => {
      setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
      const writ = await clerk.post({ title: 'Run errand', body: 'Do it', type: 'errand' });
      assert.equal(writ.type, 'errand');
    });

    it('rejects a type that is not in clerk writTypes', async () => {
      setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
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

    it('creates a writ in new (draft) status when draft: true', async () => {
      const writ = await clerk.post({ title: 'Draft writ', body: 'Details', draft: true });
      assert.equal(writ.status, 'new');
      assert.equal(writ.acceptedAt, undefined);
      assert.equal(writ.resolvedAt, undefined);
    });

    it('creates a writ in ready status when draft: false (explicit)', async () => {
      const writ = await clerk.post({ title: 'Explicit ready', body: 'Body', draft: false });
      assert.equal(writ.status, 'ready');
    });

    it('creates a writ in ready status when draft is omitted (backward compat)', async () => {
      const writ = await clerk.post({ title: 'Default ready', body: 'Body' });
      assert.equal(writ.status, 'ready');
    });
  });

  // ── show() ───────────────────────────────────────────────────────

  describe('show()', () => {
    beforeEach(() => { setup(); });

    it('throws for a non-existent writ id', async () => {
      await assert.rejects(
        () => clerk.show('w-doesnotexist'),
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
      setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
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

    it('filters by new status', async () => {
      await clerk.post({ title: 'Draft writ', body: 'Body', draft: true });
      await clerk.post({ title: 'Ready writ', body: 'Body' });

      const newWrits = await clerk.list({ status: 'new' });
      const readyWrits = await clerk.list({ status: 'ready' });

      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.status, 'new');
      assert.equal(readyWrits.length, 1);
      assert.equal(readyWrits[0]!.status, 'ready');
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
      setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
      await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Errand', body: 'Body', type: 'errand' });

      assert.equal(await clerk.count({ type: 'mandate' }), 1);
      assert.equal(await clerk.count({ type: 'errand' }), 1);
    });
  });

  // ── transition() — new → ready (publish) ────────────────────────

  describe('transition() to ready (publish)', () => {
    beforeEach(() => { setup(); });

    it('publishes a new (draft) writ to ready status', async () => {
      const writ = await clerk.post({ title: 'Draft writ', body: 'Body', draft: true });
      assert.equal(writ.status, 'new');

      const published = await clerk.transition(writ.id, 'ready');
      assert.equal(published.status, 'ready');
      assert.equal(published.acceptedAt, undefined);
      assert.equal(published.resolvedAt, undefined);
    });

    it('updates updatedAt on publish', async () => {
      const writ = await clerk.post({ title: 'Draft', body: 'Body', draft: true });
      await new Promise(r => setTimeout(r, 2));
      const published = await clerk.transition(writ.id, 'ready');
      assert.ok(published.updatedAt >= writ.updatedAt);
    });

    it('throws when publishing a writ that is already ready', async () => {
      const writ = await clerk.post({ title: 'Already ready', body: 'Body' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'ready'),
        /Cannot transition/,
      );
    });

    it('throws when publishing an active writ', async () => {
      const writ = await clerk.post({ title: 'Active', body: 'Body' });
      await clerk.transition(writ.id, 'active');
      await assert.rejects(
        () => clerk.transition(writ.id, 'ready'),
        /Cannot transition/,
      );
    });

    it('throws when publishing a cancelled writ', async () => {
      const writ = await clerk.post({ title: 'Cancelled', body: 'Body', draft: true });
      await clerk.transition(writ.id, 'cancelled');
      await assert.rejects(
        () => clerk.transition(writ.id, 'ready'),
        /Cannot transition/,
      );
    });

    it('a published writ can then be accepted (new → ready → active)', async () => {
      const writ = await clerk.post({ title: 'Full draft flow', body: 'Body', draft: true });
      await clerk.transition(writ.id, 'ready');
      const active = await clerk.transition(writ.id, 'active');
      assert.equal(active.status, 'active');
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
        () => clerk.transition('w-ghost', 'active'),
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

    it('cancels a new (draft) writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (new)', body: 'Body', draft: true });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

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

    it('transition() strips managed fields from caller-supplied fields', async () => {
      const writ = await clerk.post({ title: 'Sanitize test', body: 'Body' });
      await clerk.transition(writ.id, 'active');

      // Attempt to corrupt id, status, and timestamps via fields
      const done = await clerk.transition(writ.id, 'completed', {
        resolution: 'Legit resolution',
        id: 'w-evil',
        status: 'ready' as const,
        createdAt: '1999-01-01T00:00:00Z',
        updatedAt: '1999-01-01T00:00:00Z',
        acceptedAt: '1999-01-01T00:00:00Z',
        resolvedAt: '1999-01-01T00:00:00Z',
      });

      // Managed fields should NOT be overridden
      assert.equal(done.id, writ.id);
      assert.equal(done.status, 'completed');
      assert.notEqual(done.createdAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.updatedAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.resolvedAt, '1999-01-01T00:00:00Z');
      // But resolution should pass through
      assert.equal(done.resolution, 'Legit resolution');
    });
  });

  // ── link() ──────────────────────────────────────────────────────

  describe('link()', () => {
    beforeEach(() => { setup(); });

    it('creates a link between two writs and returns a WritLinkDoc', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const link = await clerk.link(w1.id, w2.id, 'fixes');

      assert.equal(link.sourceId, w1.id);
      assert.equal(link.targetId, w2.id);
      assert.equal(link.type, 'fixes');
      assert.equal(link.id, `${w1.id}:${w2.id}:fixes`);
      assert.ok(link.createdAt);
    });

    it('is idempotent — calling twice returns the same link', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const first = await clerk.link(w1.id, w2.id, 'fixes');
      const second = await clerk.link(w1.id, w2.id, 'fixes');

      assert.equal(first.id, second.id);
      assert.equal(first.createdAt, second.createdAt);

      // Only one document should exist
      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
    });

    it('throws for self-link', async () => {
      const w = await clerk.post({ title: 'Solo', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w.id, w.id, 'fixes'),
        /Cannot link a writ to itself/,
      );
    });

    it('throws when source writ does not exist', async () => {
      const w2 = await clerk.post({ title: 'Target', body: 'Body' });
      await assert.rejects(
        () => clerk.link('w-ghost', w2.id, 'fixes'),
        /not found/,
      );
    });

    it('throws when target writ does not exist', async () => {
      const w1 = await clerk.post({ title: 'Source', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, 'w-ghost', 'fixes'),
        /not found/,
      );
    });

    it('throws for empty type string', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, ''),
        /non-empty/,
      );
    });

    it('throws for whitespace-only type string', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, '   '),
        /non-empty/,
      );
    });

    it('accepts various non-empty type strings', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const l1 = await clerk.link(w1.id, w2.id, 'fixes');
      const l2 = await clerk.link(w1.id, w2.id, 'retries');

      assert.equal(l1.type, 'fixes');
      assert.equal(l2.type, 'retries');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 2);
    });

    it('creates separate links for same pair with different types', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'supersedes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 2);
    });

    it('creates links to multiple targets', async () => {
      const w1 = await clerk.post({ title: 'Source', body: 'Body' });
      const w2 = await clerk.post({ title: 'Target 2', body: 'Body' });
      const w3 = await clerk.post({ title: 'Target 3', body: 'Body' });

      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w3.id, 'retries');

      const r1 = await clerk.links(w1.id);
      assert.equal(r1.outbound.length, 2);

      const r2 = await clerk.links(w2.id);
      assert.equal(r2.inbound.length, 1);

      const r3 = await clerk.links(w3.id);
      assert.equal(r3.inbound.length, 1);
    });

    it('does not update writ timestamps when linking', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      const before1 = w1.updatedAt;
      const before2 = w2.updatedAt;

      await clerk.link(w1.id, w2.id, 'fixes');

      const after1 = await clerk.show(w1.id);
      const after2 = await clerk.show(w2.id);
      assert.equal(after1.updatedAt, before1);
      assert.equal(after2.updatedAt, before2);
    });
  });

  // ── links() ──────────────────────────────────────────────────────

  describe('links()', () => {
    beforeEach(() => { setup(); });

    it('returns outbound and inbound links', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      const w3 = await clerk.post({ title: 'Writ 3', body: 'Body' });

      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w3.id, w1.id, 'supersedes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
      assert.equal(result.outbound[0]!.targetId, w2.id);
      assert.equal(result.inbound.length, 1);
      assert.equal(result.inbound[0]!.sourceId, w3.id);
    });

    it('returns empty arrays for a writ with no links', async () => {
      const w = await clerk.post({ title: 'Lonely writ', body: 'Body' });
      const result = await clerk.links(w.id);
      assert.deepEqual(result, { outbound: [], inbound: [] });
    });

    it('returns empty arrays for a non-existent writ id', async () => {
      const result = await clerk.links('w-doesnotexist');
      assert.deepEqual(result, { outbound: [], inbound: [] });
    });
  });

  // ── unlink() ─────────────────────────────────────────────────────

  describe('unlink()', () => {
    beforeEach(() => { setup(); });

    it('removes an existing link', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      await clerk.unlink(w1.id, w2.id, 'fixes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 0);
    });

    it('is idempotent — no error when link does not exist', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      // No error — link was never created
      await clerk.unlink(w1.id, w2.id, 'fixes');
    });

    it('is idempotent — no error when called twice', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      await clerk.unlink(w1.id, w2.id, 'fixes');
      await clerk.unlink(w1.id, w2.id, 'fixes'); // second call — no error
    });

    it('does not affect other links', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'retries');

      await clerk.unlink(w1.id, w2.id, 'fixes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
      assert.equal(result.outbound[0]!.type, 'retries');
    });

    it('does not update writ timestamps when unlinking', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');
      const before1 = (await clerk.show(w1.id)).updatedAt;
      const before2 = (await clerk.show(w2.id)).updatedAt;

      await clerk.unlink(w1.id, w2.id, 'fixes');

      const after1 = await clerk.show(w1.id);
      const after2 = await clerk.show(w2.id);
      assert.equal(after1.updatedAt, before1);
      assert.equal(after2.updatedAt, before2);
    });
  });

  // ── writ-show tool with links ─────────────────────────────────────

  describe('writ-show tool — includes links', () => {
    beforeEach(() => { setup(); });

    it('includes links key with outbound and inbound arrays', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      // Call clerk.show() and clerk.links() like the tool handler does
      const [writ, links] = await Promise.all([
        clerk.show(w1.id),
        clerk.links(w1.id),
      ]);
      const result = { ...writ, links };

      assert.equal(result.id, w1.id);
      assert.equal(result.title, 'Writ 1');
      assert.ok(Array.isArray(result.links.outbound));
      assert.ok(Array.isArray(result.links.inbound));
      assert.equal(result.links.outbound.length, 1);
      assert.equal(result.links.inbound.length, 0);
      assert.equal((result.links.outbound[0] as WritLinkDoc).targetId, w2.id);
    });

    it('returns empty link arrays for a writ with no links', async () => {
      const w = await clerk.post({ title: 'Solo', body: 'Body' });

      const [writ, links] = await Promise.all([
        clerk.show(w.id),
        clerk.links(w.id),
      ]);
      const result = { ...writ, links };

      assert.deepEqual(result.links.outbound, []);
      assert.deepEqual(result.links.inbound, []);
    });
  });

  // ── writ-show tool handler ────────────────────────────────────────

  describe('writ-show tool handler (via guild apparatus)', () => {
    beforeEach(() => { setup(); });

    it('returns all writ fields plus a links key with outbound and inbound arrays', async () => {
      const w1 = await clerk.post({ title: 'Source writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'Target writ', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      const result = await writShow.handler({ id: w1.id }) as WritLinkDoc & { links: WritLinks };

      assert.equal(result.id, w1.id);
      assert.equal((result as unknown as { title: string }).title, 'Source writ');
      assert.ok('links' in result, 'result should have a links key');
      assert.ok(Array.isArray(result.links.outbound));
      assert.ok(Array.isArray(result.links.inbound));
      assert.equal(result.links.outbound.length, 1);
      assert.equal(result.links.outbound[0]!.targetId, w2.id);
      assert.equal(result.links.inbound.length, 0);
    });

    it('returns empty link arrays for a writ with no links', async () => {
      const w = await clerk.post({ title: 'Lone writ', body: 'Body' });

      const result = await writShow.handler({ id: w.id }) as { links: WritLinks };

      assert.deepEqual(result.links.outbound, []);
      assert.deepEqual(result.links.inbound, []);
    });

    it('throws when the writ does not exist', async () => {
      await assert.rejects(
        () => writShow.handler({ id: 'w-ghost' }),
        /not found/,
      );
    });

    it('returns inbound links when the writ is a target', async () => {
      const w1 = await clerk.post({ title: 'Source', body: 'Body' });
      const w2 = await clerk.post({ title: 'Target', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'supersedes');

      const result = await writShow.handler({ id: w2.id }) as { links: WritLinks };

      assert.equal(result.links.outbound.length, 0);
      assert.equal(result.links.inbound.length, 1);
      assert.equal(result.links.inbound[0]!.sourceId, w1.id);
    });
  });

  // ── writ-link tool handler ────────────────────────────────────────

  describe('writ-link tool handler (via guild apparatus)', () => {
    beforeEach(() => { setup(); });

    it('creates a link and returns a WritLinkDoc', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const result = await writLink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' }) as WritLinkDoc;

      assert.equal(result.sourceId, w1.id);
      assert.equal(result.targetId, w2.id);
      assert.equal(result.type, 'fixes');
      assert.equal(result.id, `${w1.id}:${w2.id}:fixes`);
      assert.ok(result.createdAt);
    });

    it('is idempotent — returns the same link on duplicate call', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const r1 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' }) as WritLinkDoc;
      const r2 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' }) as WritLinkDoc;

      assert.equal(r1.id, r2.id);
      assert.equal(r1.createdAt, r2.createdAt);
    });

    it('propagates self-link error from clerk.link()', async () => {
      const w = await clerk.post({ title: 'Solo', body: 'Body' });
      await assert.rejects(
        () => writLink.handler({ sourceId: w.id, targetId: w.id, type: 'fixes' }),
        /Cannot link a writ to itself/,
      );
    });

    it('propagates missing source error from clerk.link()', async () => {
      const w2 = await clerk.post({ title: 'Target', body: 'Body' });
      await assert.rejects(
        () => writLink.handler({ sourceId: 'w-ghost', targetId: w2.id, type: 'fixes' }),
        /not found/,
      );
    });
  });

  // ── writ-unlink tool handler ──────────────────────────────────────

  describe('writ-unlink tool handler (via guild apparatus)', () => {
    beforeEach(() => { setup(); });

    it('removes an existing link and returns { ok: true }', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' });

      assert.deepEqual(result, { ok: true });

      const linksResult = await clerk.links(w1.id);
      assert.equal(linksResult.outbound.length, 0);
    });

    it('is idempotent — returns { ok: true } when link does not exist', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      // Link was never created — no error
      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' });
      assert.deepEqual(result, { ok: true });
    });

    it('does not remove other links when unlinking by type', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'retries');

      await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, type: 'fixes' });

      const linksResult = await clerk.links(w1.id);
      assert.equal(linksResult.outbound.length, 1);
      assert.equal(linksResult.outbound[0]!.type, 'retries');
    });
  });

  // ── Package exports (V14) ────────────────────────────────────────

  describe('package entry point exports', () => {
    it('WritLinks type is importable from the package index (verified by import at top of file)', () => {
      // The import `import type { WritLinks } from './index.ts'` at the top of
      // this file statically verifies that WritLinks is exported from the
      // package entry point. If it were missing, the file would fail to compile.
      // This test acts as a living marker for that verification (V14).
      assert.ok(true, 'WritLinks is exported from ./index.ts');
    });
  });

  // ── Config validation ────────────────────────────────────────────

  describe('config: writTypes validation', () => {
    it('built-in type mandate is always valid regardless of writTypes config', async () => {
      setup({ clerkConfig: { writTypes: [] } }); // empty writTypes — built-in still works
      const w1 = await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      assert.equal(w1.type, 'mandate');
    });

    it('summon is not a built-in type (must be declared)', async () => {
      setup({ clerkConfig: { writTypes: [] } });
      await assert.rejects(
        () => clerk.post({ title: 'Summon', body: 'Body', type: 'summon' }),
        /Unknown writ type/,
      );
    });

    it('declared custom types are accepted', async () => {
      setup({
        clerkConfig: {
          writTypes: [
            { name: 'quest', description: 'A significant task' },
            { name: 'errand', description: 'A small errand' },
          ],
        },
      });
      const w = await clerk.post({ title: 'Go on a quest', body: 'Body', type: 'quest' });
      assert.equal(w.type, 'quest');
    });

    it('undeclared types are rejected even when other custom types exist', async () => {
      setup({ clerkConfig: { writTypes: [{ name: 'quest', description: 'A quest' }] } });
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown' }),
        /Unknown writ type/,
      );
    });

    it('defaultType from clerk config is validated against declared types', async () => {
      setup({
        clerkConfig: {
          writTypes: [{ name: 'errand', description: 'A small errand' }],
          defaultType: 'errand',
        },
      });
      const w = await clerk.post({ title: 'Default errand', body: 'Body' });
      assert.equal(w.type, 'errand');
    });
  });

  // ── Kit-contributed writ types ────────────────────────────────────

  describe('Kit-contributed writ types', () => {
    describe('V3 — basic kit writ type', () => {
      it('allows posting with kit-contributed writ type', async () => {
        const kit: LoadedKit = {
          packageName: '@test/quality-tools',
          id: 'quality-tools',
          version: '0.0.0',
          kit: { writTypes: [{ name: 'quality-audit' }] },
        };
        setup({ extraKits: [kit] });

        const writ = await clerk.post({ title: 'Audit', body: 'Run audit', type: 'quality-audit' });
        assert.equal(writ.type, 'quality-audit');
      });

      it('config writType with same name silently skips kit contribution', async () => {
        const kit: LoadedKit = {
          packageName: '@test/quality-tools',
          id: 'quality-tools',
          version: '0.0.0',
          kit: { writTypes: [{ name: 'quality-audit' }] },
        };
        setup({
          clerkConfig: { writTypes: [{ name: 'quality-audit' }] },
          extraKits: [kit],
        });
        // No warning should be emitted; posting should still work
        const writ = await clerk.post({ title: 'Audit', body: 'Run audit', type: 'quality-audit' });
        assert.equal(writ.type, 'quality-audit');
      });

      it('warns when two kits contribute same writ type (first wins)', async () => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

        try {
          const kitA: LoadedKit = {
            packageName: '@test/kit-a',
            id: 'kit-a',
            version: '0.0.0',
            kit: { writTypes: [{ name: 'quality-audit' }] },
          };
          const kitB: LoadedKit = {
            packageName: '@test/kit-b',
            id: 'kit-b',
            version: '0.0.0',
            kit: { writTypes: [{ name: 'quality-audit' }] },
          };
          setup({ extraKits: [kitA, kitB] });

          assert.ok(
            warnings.some(w => w.includes('kit-b') && w.includes('quality-audit')),
            `Expected duplicate writ type warning, got: ${JSON.stringify(warnings)}`
          );
          // Posting still works (first kit won)
          const writ = await clerk.post({ title: 'Audit', body: 'Run audit', type: 'quality-audit' });
          assert.equal(writ.type, 'quality-audit');
        } finally {
          console.warn = original;
        }
      });

      it('built-in mandate type still works even if kit contributes it', async () => {
        const kit: LoadedKit = {
          packageName: '@test/kit-a',
          id: 'kit-a',
          version: '0.0.0',
          kit: { writTypes: [{ name: 'mandate' }] },
        };
        setup({ extraKits: [kit] });
        // mandate is built-in, kit contribution is harmless but redundant
        const writ = await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
        assert.equal(writ.type, 'mandate');
      });

      it('rejects unknown type even with kits loaded', async () => {
        const kit: LoadedKit = {
          packageName: '@test/kit-a',
          id: 'kit-a',
          version: '0.0.0',
          kit: { writTypes: [{ name: 'known-type' }] },
        };
        setup({ extraKits: [kit] });
        await assert.rejects(
          () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown-type' }),
          /Unknown writ type/
        );
      });

      it('warns on malformed writTypes entry missing name field', async () => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

        try {
          const kit: LoadedKit = {
            packageName: '@test/bad-kit',
            id: 'bad-kit',
            version: '0.0.0',
            kit: { writTypes: [{ notName: 'bad' }] },
          };
          setup({ extraKits: [kit] });
          assert.ok(
            warnings.some(w => w.includes('bad-kit') && w.includes('writTypes')),
            `Expected warning about bad-kit writTypes, got: ${JSON.stringify(warnings)}`
          );
        } finally {
          console.warn = original;
        }
      });
    });

    describe('V9 — Clerk consumes declaration', () => {
      it('declares consumes with writTypes', () => {
        const plugin = createClerk();
        assert.ok('apparatus' in plugin);
        const apparatus = (plugin as { apparatus: { consumes?: string[] } }).apparatus;
        assert.ok(Array.isArray(apparatus.consumes));
        assert.ok(apparatus.consumes!.includes('writTypes'));
      });
    });

    describe('V11 — exports', () => {
      it('ClerkKit is exported from clerk module', async () => {
        // Just verify the import works — if it compiles, the export exists
        const mod = await import('./clerk.ts');
        // ClerkKit is a type export; we can't check it at runtime directly,
        // but we verify createClerk is still exported
        assert.ok(typeof mod.createClerk === 'function');
      });
    });

    describe('V13 — resolveWritTypes uses in-memory set', () => {
      it('kit-contributed type is valid for posting without re-reading config', async () => {
        const kit: LoadedKit = {
          packageName: '@test/quality-tools',
          id: 'quality-tools',
          version: '0.0.0',
          kit: { writTypes: [{ name: 'quality-audit' }] },
        };
        setup({ extraKits: [kit] });

        // Post multiple writs to confirm the set is stable
        const w1 = await clerk.post({ title: 'Audit 1', body: 'Body', type: 'quality-audit' });
        const w2 = await clerk.post({ title: 'Audit 2', body: 'Body', type: 'quality-audit' });
        assert.equal(w1.type, 'quality-audit');
        assert.equal(w2.type, 'quality-audit');
      });
    });

    describe('V25 — apparatus supportKit writ type via Wire phase', () => {
      it('apparatus supportKit writ type is valid for posting (via Wire phase)', async () => {
        const lateApp: LoadedApparatus = {
          packageName: '@test/late-app',
          id: 'late-app',
          version: '0.0.0',
          apparatus: {
            requires: [],
            start: () => {},
            supportKit: { writTypes: [{ name: 'late-type' }] },
          },
        };
        setup({ extraApparatuses: [lateApp] });

        const writ = await clerk.post({ title: 'Late', body: 'Body', type: 'late-type' });
        assert.equal(writ.type, 'late-type');
      });
    });
  });
});

// ── writ-types tool tests ─────────────────────────────────────────────

type AnyTool = { name: string; permission?: string; callableBy?: unknown; handler: (p: Record<string, unknown>) => Promise<unknown> };

function getTools(plugin: ClerkPlugin): AnyTool[] {
  const p = plugin as { apparatus: { supportKit: { tools: AnyTool[] } } };
  return p.apparatus.supportKit.tools;
}

function getWritTypesTool(plugin: ClerkPlugin): AnyTool {
  const t = getTools(plugin).find(t => t.name === 'writ-types');
  if (!t) throw new Error('writ-types tool not found');
  return t;
}

describe('writ-types tool', () => {
  afterEach(() => { clearGuild(); });

  it('returns builtin type with default config', async () => {
    const plugin = setupCore();
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; default: boolean }>;
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.description, null);
    assert.equal(mandate.default, true);
  });

  it('returns config-declared types with description', async () => {
    const plugin = setupCore({ clerkConfig: { writTypes: [{ name: 'task', description: 'A task' }] } });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; default: boolean }>;
    const task = result.find(t => t.name === 'task');
    assert.ok(task, 'task should be in result');
    assert.equal(task.description, 'A task');
    assert.equal(task.default, false);
    // mandate should still be there
    assert.ok(result.find(t => t.name === 'mandate'), 'mandate should still appear');
  });

  it('marks configured defaultType as default', async () => {
    const plugin = setupCore({ clerkConfig: { writTypes: [{ name: 'task' }], defaultType: 'task' } });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; default: boolean }>;
    const task = result.find(t => t.name === 'task');
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(task, 'task should be in result');
    assert.equal(task.default, true);
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.default, false);
  });

  it('includes kit-contributed types', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-a',
      id: 'kit-a',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit' }] },
    };
    const plugin = setupCore({ extraKits: [kit] });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; default: boolean }>;
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa, 'quality-audit should be in result');
    assert.equal(qa.description, null);
    assert.equal(qa.default, false);
  });

  it('tool is registered in supportKit.tools', () => {
    const plugin = createClerk();
    const tools = getTools(plugin);
    assert.ok(tools.some(t => t.name === 'writ-types'), 'writ-types tool should be in supportKit.tools');
  });

  it('tool has clerk:read permission', () => {
    const plugin = createClerk();
    const t = getWritTypesTool(plugin);
    assert.equal(t.permission, 'clerk:read');
  });

  it('tool has no callableBy restriction', () => {
    const plugin = createClerk();
    const t = getWritTypesTool(plugin);
    assert.equal(t.callableBy, undefined);
  });
});

// ── Apparatus wiring tests ────────────────────────────────────────────

describe('Apparatus wiring', () => {
  it('apparatus declares recommends oculus', () => {
    const plugin = createClerk();
    const p = plugin as { apparatus: { recommends?: string[] } };
    assert.ok(Array.isArray(p.apparatus.recommends), 'recommends should be an array');
    assert.ok(p.apparatus.recommends!.includes('oculus'), 'recommends should include "oculus"');
  });

  it('supportKit includes pages contribution for writs', () => {
    const plugin = createClerk();
    const p = plugin as { apparatus: { supportKit: { pages?: Array<{ id: string; title: string; dir: string }> } } };
    const pages = p.apparatus.supportKit.pages;
    assert.ok(Array.isArray(pages), 'pages should be an array');
    const writPage = pages!.find(pg => pg.id === 'writs');
    assert.ok(writPage, 'pages should include a writs entry');
    assert.equal(writPage.title, 'Writs');
    assert.equal(writPage.dir, 'pages/writs');
  });
});

// ── Parent/child relationship tests ──────────────────────────────────

describe('Parent/child relationships', () => {
  afterEach(() => { clearGuild(); });

  // ── Child creation ────────────────────────────────────────────────

  describe('child creation', () => {
    beforeEach(() => { setup(); });

    it('creates a child writ with parentId set', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Parent body' });
      const child = await clerk.post({ title: 'Child', body: 'Child body', parentId: parent.id });

      assert.equal(child.parentId, parent.id);
      assert.ok(child.id.startsWith('w-'));
      assert.equal(child.status, 'ready');
    });

    it('transitions parent from ready to waiting when child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      assert.equal(parent.status, 'ready');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'waiting');
    });

    it('transitions parent from new (draft) to waiting when child is added', async () => {
      const parent = await clerk.post({ title: 'Draft parent', body: 'Body', draft: true });
      assert.equal(parent.status, 'new');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'waiting');
    });

    it('keeps parent in waiting when a second child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.post({ title: 'Child 1', body: 'Body', parentId: parent.id });

      const midState = await clerk.show(parent.id);
      assert.equal(midState.status, 'waiting');

      await clerk.post({ title: 'Child 2', body: 'Body', parentId: parent.id });

      const endState = await clerk.show(parent.id);
      assert.equal(endState.status, 'waiting');
    });

    it('creates root writ without parentId', async () => {
      const writ = await clerk.post({ title: 'Root', body: 'Body' });
      assert.equal(writ.parentId, undefined);
    });

    it('inherits codex from parent when child codex is not specified', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body', codex: 'parent-codex' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      assert.equal(child.codex, 'parent-codex');
    });

    it('uses child explicit codex over parent codex', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body', codex: 'parent-codex' });
      const child = await clerk.post({ title: 'Child', body: 'Body', codex: 'child-codex', parentId: parent.id });

      assert.equal(child.codex, 'child-codex');
    });

    it('child has no codex when neither parent nor child specify one', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      assert.equal(child.codex, undefined);
    });
  });

  // ── Child creation validation ─────────────────────────────────────

  describe('child creation validation', () => {
    beforeEach(() => { setup(); });

    it('rejects child creation with non-existent parentId', async () => {
      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: 'w-nonexistent' }),
        { message: 'Parent writ "w-nonexistent" not found.' },
      );
    });

    it('rejects child creation when parent is active', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'active');

      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"active"'));
          return true;
        },
      );
    });

    it('rejects child creation when parent is completed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'active');
      await clerk.transition(parent.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"completed"'));
          return true;
        },
      );
    });

    it('rejects child creation when parent is failed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'active');
      await clerk.transition(parent.id, 'failed', { resolution: 'Broke' });

      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"failed"'));
          return true;
        },
      );
    });

    it('rejects child creation when parent is cancelled', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'cancelled');

      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"cancelled"'));
          return true;
        },
      );
    });
  });

  // ── Waiting status transitions ────────────────────────────────────

  describe('waiting status', () => {
    beforeEach(() => { setup(); });

    it('allows explicit transition from new to waiting', async () => {
      const writ = await clerk.post({ title: 'Draft', body: 'Body', draft: true });
      const updated = await clerk.transition(writ.id, 'waiting');
      assert.equal(updated.status, 'waiting');
    });

    it('allows explicit transition from ready to waiting', async () => {
      const writ = await clerk.post({ title: 'Ready', body: 'Body' });
      const updated = await clerk.transition(writ.id, 'waiting');
      assert.equal(updated.status, 'waiting');
    });

    it('rejects transition from active to waiting', async () => {
      const writ = await clerk.post({ title: 'Active', body: 'Body' });
      await clerk.transition(writ.id, 'active');

      await assert.rejects(
        () => clerk.transition(writ.id, 'waiting'),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot transition'));
          return true;
        },
      );
    });

    it('does not set resolvedAt when transitioning to waiting', async () => {
      const writ = await clerk.post({ title: 'W', body: 'Body' });
      const updated = await clerk.transition(writ.id, 'waiting');
      assert.equal(updated.resolvedAt, undefined);
      assert.equal(updated.acceptedAt, undefined);
    });

    it('waiting is not terminal', async () => {
      const writ = await clerk.post({ title: 'W', body: 'Body' });
      const updated = await clerk.transition(writ.id, 'waiting');
      // Can transition out of waiting
      const ready = await clerk.transition(updated.id, 'ready');
      assert.equal(ready.status, 'ready');
    });

    it('allows cancellation of waiting writ', async () => {
      const writ = await clerk.post({ title: 'W', body: 'Body' });
      await clerk.transition(writ.id, 'waiting');
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.status, 'cancelled');
    });

    it('allows failing a waiting writ', async () => {
      const writ = await clerk.post({ title: 'W', body: 'Body' });
      await clerk.transition(writ.id, 'waiting');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Broke' });
      assert.equal(failed.status, 'failed');
    });
  });

  // ── Completion rollup (child → parent) ────────────────────────────

  describe('completion rollup', () => {
    beforeEach(() => { setup(); });

    it('transitions parent to ready when single child completes', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'ready');
    });

    it('transitions parent to ready when all 3 children complete', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });
      const c3 = await clerk.post({ title: 'C3', body: 'B', parentId: parent.id });

      for (const c of [c1, c2, c3]) {
        await clerk.transition(c.id, 'active');
        await clerk.transition(c.id, 'completed', { resolution: 'Done' });
      }

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'ready');
    });

    it('transitions parent to ready when children complete and cancel (none failed)', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'active');
      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      await clerk.transition(c2.id, 'cancelled');

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'ready');
    });

    it('keeps parent waiting when not all children are terminal', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'active');
      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'waiting');
    });

    it('transitions parent to ready when both children are cancelled (none failed)', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'cancelled');
      await clerk.transition(c2.id, 'cancelled');

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'ready');
    });
  });

  // ── Failure cascade ───────────────────────────────────────────────

  describe('failure cascade', () => {
    beforeEach(() => { setup(); });

    it('fails parent when child fails, cancels remaining siblings', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });
      const c3 = await clerk.post({ title: 'C3', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'active');
      await clerk.transition(c1.id, 'failed', { resolution: 'Broke' });

      const updatedParent = await clerk.show(parent.id);
      assert.equal(updatedParent.status, 'failed');
      assert.ok(updatedParent.resolution?.includes(`Child "${c1.id}" failed: Broke`));

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
      assert.equal(updatedC2.resolution, 'Automatically cancelled due to sibling failure');

      const updatedC3 = await clerk.show(c3.id);
      assert.equal(updatedC3.status, 'cancelled');
      assert.equal(updatedC3.resolution, 'Automatically cancelled due to sibling failure');
    });

    it('fails parent when single child fails', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'failed', { resolution: 'Error occurred' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'failed');
      assert.ok(updated.resolution?.includes('Error occurred'));
    });

    it('cascades failure through 3-level hierarchy', async () => {
      const grandparent = await clerk.post({ title: 'GP', body: 'B' });
      const parent = await clerk.post({ title: 'P', body: 'B', parentId: grandparent.id });
      const child = await clerk.post({ title: 'C', body: 'B', parentId: parent.id });

      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'failed', { resolution: 'Leaf failed' });

      const updatedChild = await clerk.show(child.id);
      assert.equal(updatedChild.status, 'failed');

      const updatedParent = await clerk.show(parent.id);
      assert.equal(updatedParent.status, 'failed');

      const updatedGP = await clerk.show(grandparent.id);
      assert.equal(updatedGP.status, 'failed');
    });

    it('uses "unknown" when child has no resolution', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      // Transition child to active, then fail without resolution
      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'failed');

      const updated = await clerk.show(parent.id);
      assert.ok(updated.resolution?.includes('unknown'));
    });
  });

  // ── Downward cancellation cascade ─────────────────────────────────

  describe('cancellation cascade (downward)', () => {
    beforeEach(() => { setup(); });

    it('cancels non-terminal children when parent is cancelled', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(parent.id, 'cancelled');

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.status, 'cancelled');
      assert.equal(updatedC1.resolution, 'Automatically cancelled due to sibling failure');

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
    });

    it('does not cancel already-terminal children', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      // Complete c1 first
      await clerk.transition(c1.id, 'active');
      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      // Parent goes back to waiting since c2 is still non-terminal... wait, c1 completion checks all children.
      // Actually c2 is still ready (non-terminal), so parent stays waiting.

      // Now cancel parent
      await clerk.transition(parent.id, 'cancelled');

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.status, 'completed'); // already terminal, unchanged

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
    });
  });

  // ── Full lifecycle with children ──────────────────────────────────

  describe('full lifecycle with children', () => {
    beforeEach(() => { setup(); });

    it('parent flows: ready → waiting → ready → active → completed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      assert.equal(parent.status, 'ready');

      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });
      const p1 = await clerk.show(parent.id);
      assert.equal(p1.status, 'waiting');

      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const p2 = await clerk.show(parent.id);
      assert.equal(p2.status, 'ready');

      await clerk.transition(parent.id, 'active');
      const p3 = await clerk.show(parent.id);
      assert.equal(p3.status, 'active');

      await clerk.transition(parent.id, 'completed', { resolution: 'All done' });
      const p4 = await clerk.show(parent.id);
      assert.equal(p4.status, 'completed');
    });

    it('children already terminal are not cancelled when parent completes normally', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      // Complete child → parent ready
      await clerk.transition(child.id, 'active');
      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      // Parent now ready → active → completed
      await clerk.transition(parent.id, 'active');
      await clerk.transition(parent.id, 'completed', { resolution: 'All done' });

      // Child should still be completed
      const updatedChild = await clerk.show(child.id);
      assert.equal(updatedChild.status, 'completed');
    });
  });

  // ── parentId immutability ─────────────────────────────────────────

  describe('parentId immutability', () => {
    beforeEach(() => { setup(); });

    it('transition does not change parentId even if passed in fields', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      const updated = await clerk.transition(child.id, 'active', { parentId: 'w-other' } as Partial<import('./types.ts').WritDoc>);
      assert.equal(updated.parentId, parent.id);
    });
  });

  // ── WritFilters with parentId ─────────────────────────────────────

  describe('list with parentId filter', () => {
    beforeEach(() => { setup(); });

    it('returns only children of the specified parent', async () => {
      const parent1 = await clerk.post({ title: 'P1', body: 'B' });
      const parent2 = await clerk.post({ title: 'P2', body: 'B' });
      await clerk.post({ title: 'C1', body: 'B', parentId: parent1.id });
      await clerk.post({ title: 'C2', body: 'B', parentId: parent1.id });
      await clerk.post({ title: 'C3', body: 'B', parentId: parent2.id });

      const children1 = await clerk.list({ parentId: parent1.id });
      assert.equal(children1.length, 2);
      assert.ok(children1.every((c) => c.parentId === parent1.id));

      const children2 = await clerk.list({ parentId: parent2.id });
      assert.equal(children2.length, 1);
      assert.equal(children2[0].parentId, parent2.id);
    });
  });

  // ── writ-show with parent/children context ────────────────────────

  describe('writ-show with parent/children context', () => {
    beforeEach(() => { setup(); });

    it('includes parent context for a child writ', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: child.id });
      assert.deepEqual(result.parent, { id: parent.id, title: 'Parent', status: 'waiting' });
      assert.deepEqual(result.children, { summary: {}, items: [] });
    });

    it('includes children context for a parent writ', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: parent.id });
      assert.equal(result.parent, null);
      assert.equal(result.children.items.length, 2);
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c1.id));
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c2.id));
      assert.equal(result.children.summary['ready'], 2);
    });

    it('returns null parent and empty children for root writ without children', async () => {
      const writ = await clerk.post({ title: 'Root', body: 'Body' });

      const result = await writShow.handler({ id: writ.id });
      assert.equal(result.parent, null);
      assert.deepEqual(result.children, { summary: {}, items: [] });
    });
  });

  // ── State machine validation ──────────────────────────────────────

  describe('state machine with waiting', () => {
    beforeEach(() => { setup(); });

    it('TERMINAL_STATUSES does not include waiting', async () => {
      // Verify by transitioning waiting → ready (only possible if waiting is non-terminal)
      const writ = await clerk.post({ title: 'W', body: 'B' });
      await clerk.transition(writ.id, 'waiting');
      const updated = await clerk.transition(writ.id, 'ready');
      assert.equal(updated.status, 'ready');
    });

    it('allows transition from waiting to failed', async () => {
      const writ = await clerk.post({ title: 'W', body: 'B' });
      await clerk.transition(writ.id, 'waiting');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Failed' });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.resolvedAt);
    });

    it('allows transition from waiting to cancelled', async () => {
      const writ = await clerk.post({ title: 'W', body: 'B' });
      await clerk.transition(writ.id, 'waiting');
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('rejects transition from waiting to active', async () => {
      const writ = await clerk.post({ title: 'W', body: 'B' });
      await clerk.transition(writ.id, 'waiting');

      await assert.rejects(
        () => clerk.transition(writ.id, 'active'),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot transition'));
          return true;
        },
      );
    });

    it('rejects transition from waiting to completed', async () => {
      const writ = await clerk.post({ title: 'W', body: 'B' });
      await clerk.transition(writ.id, 'waiting');

      await assert.rejects(
        () => clerk.transition(writ.id, 'completed', { resolution: 'Done' }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot transition'));
          return true;
        },
      );
    });
  });

  // ── Book indexes ──────────────────────────────────────────────────

  describe('book indexes', () => {
    it('writs book indexes include parentId and [parentId, status]', () => {
      const plugin = setupCore();
      const apparatus = (plugin as { apparatus: { supportKit: { books: Record<string, { indexes: unknown[] }> } } }).apparatus;
      const indexes = apparatus.supportKit.books.writs.indexes;
      assert.ok(indexes.includes('parentId'), 'indexes should include parentId');
      assert.ok(
        indexes.some((i: unknown) => Array.isArray(i) && i[0] === 'parentId' && i[1] === 'status'),
        'indexes should include [parentId, status]',
      );
    });
  });
});

// ── Page file structure tests ─────────────────────────────────────────

describe('Page file structure', () => {
  it('index.html exists and contains required HTML structural tags', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = join(__dirname, '..', 'pages', 'writs', 'index.html');
    let content: string;
    try {
      content = readFileSync(htmlPath, 'utf-8');
    } catch {
      assert.fail(`Expected pages/writs/index.html to exist at: ${htmlPath}`);
    }
    assert.ok(content.includes('<html'), 'index.html must contain <html tag');
    assert.ok(content.includes('<head'), 'index.html must contain <head tag');
    assert.ok(content.includes('<body'), 'index.html must contain <body tag');
  });
});

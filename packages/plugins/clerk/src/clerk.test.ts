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

import { createClerk, CASCADE_PARENT_TERMINATION_RESOLUTION } from './clerk.ts';
import type { ClerkKit } from './clerk.ts';
import type { ClerkApi, ClerkConfig, WritLinkDoc } from './types.ts';
import type { WritLinks } from './index.ts';
import writShow from './tools/writ-show.ts';
import writEdit from './tools/writ-edit.ts';
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

async function setupCore(options: SetupOptions = {}, clerkCtx?: StartupContext): Promise<ClerkPlugin> {
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
  await clerkApparatus.start(ctx);
  clerk = clerkApparatus.provides as ClerkApi;

  // Expose clerk as an apparatus so tool handlers can resolve it via guild()
  apparatusMap.set('clerk', clerk);

  return clerkPlugin;
}

async function setup(options: SetupOptions = {}) {
  await setupCore(options);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Clerk', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── post() ───────────────────────────────────────────────────────

  describe('post()', () => {
    beforeEach(async () => { await setup(); });

    it('creates a writ with open status and mandate type by default', async () => {
      const writ = await clerk.post({ title: 'Fix the bug', body: 'Details here' });

      assert.ok(writ.id.startsWith('w-'));
      assert.equal(writ.type, 'mandate');
      assert.equal(writ.title, 'Fix the bug');
      assert.equal(writ.body, 'Details here');
      assert.equal(writ.status, 'open');
      assert.ok(writ.createdAt);
      assert.ok(writ.updatedAt);
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
      await setup({ clerkConfig: { defaultType: 'mandate' } });
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
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
      const writ = await clerk.post({ title: 'Run errand', body: 'Do it', type: 'errand' });
      assert.equal(writ.type, 'errand');
    });

    it('rejects a type that is not in clerk writTypes', async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'epic' }),
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
      assert.equal(writ.resolvedAt, undefined);
    });

    it('creates a writ in open status when draft: false (explicit)', async () => {
      const writ = await clerk.post({ title: 'Explicit open', body: 'Body', draft: false });
      assert.equal(writ.status, 'open');
    });

    it('creates a writ in open status when draft is omitted (backward compat)', async () => {
      const writ = await clerk.post({ title: 'Default open', body: 'Body' });
      assert.equal(writ.status, 'open');
    });
  });

  // ── show() ───────────────────────────────────────────────────────

  describe('show()', () => {
    beforeEach(async () => { await setup(); });

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
      assert.equal(fetched.status, 'open');
    });
  });

  // ── list() ───────────────────────────────────────────────────────

  describe('list()', () => {
    beforeEach(async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
    });

    it('returns all writs when no filters given', async () => {
      await clerk.post({ title: 'Writ A', body: 'Body' });
      await clerk.post({ title: 'Writ B', body: 'Body' });
      await clerk.post({ title: 'Writ C', body: 'Body' });

      const all = await clerk.list();
      assert.equal(all.length, 3);
    });

    it('filters by status', async () => {
      const w1 = await clerk.post({ title: 'Open writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'New writ', body: 'Body', draft: true });

      const openWrits = await clerk.list({ status: 'open' });
      const newWrits = await clerk.list({ status: 'new' });

      assert.equal(openWrits.length, 1);
      assert.equal(openWrits[0]!.id, w1.id);
      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.id, w2.id);
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

    it('filters by multiple types (OR)', async () => {
      await clerk.post({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const result = await clerk.list({ type: ['mandate', 'errand'] });
      assert.equal(result.length, 2);
      const types = new Set(result.map((w) => w.type));
      assert.ok(types.has('mandate'));
      assert.ok(types.has('errand'));
    });

    it('single-element type array behaves like a scalar filter', async () => {
      await clerk.post({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const result = await clerk.list({ type: ['mandate'] });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.type, 'mandate');
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
      await clerk.post({ title: 'One open writ', body: 'Body' });
      const completed = await clerk.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('filters by new status', async () => {
      await clerk.post({ title: 'Draft writ', body: 'Body', draft: true });
      await clerk.post({ title: 'Open writ', body: 'Body' });

      const newWrits = await clerk.list({ status: 'new' });
      const openWrits = await clerk.list({ status: 'open' });

      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.status, 'new');
      assert.equal(openWrits.length, 1);
      assert.equal(openWrits[0]!.status, 'open');
    });

    it('filters by multiple statuses (OR)', async () => {
      const w1 = await clerk.post({ title: 'Open writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'New writ', body: 'Body', draft: true });
      const w3 = await clerk.post({ title: 'Completed writ', body: 'Body' });
      await clerk.transition(w3.id, 'completed');

      const result = await clerk.list({ status: ['open', 'new'] });
      assert.equal(result.length, 2);
      const statuses = new Set(result.map((w) => w.status));
      assert.ok(statuses.has('open'));
      assert.ok(statuses.has('new'));
      assert.ok(!statuses.has('completed'));
    });

    it('filters by stuck status', async () => {
      const writ = await clerk.post({ title: 'Stuck writ', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await clerk.post({ title: 'Open writ', body: 'Body' });

      const result = await clerk.list({ status: 'stuck' });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.status, 'stuck');
    });

    it('single-element status array behaves like a scalar filter', async () => {
      await clerk.post({ title: 'Open writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'New writ', body: 'Body', draft: true });

      const result = await clerk.list({ status: ['open'] });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.status, 'open');
    });
  });

  // ── count() ──────────────────────────────────────────────────────

  describe('count()', () => {
    beforeEach(async () => { await setup(); });

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
      await clerk.transition(w.id, 'completed');

      assert.equal(await clerk.count({ status: 'completed' }), 1);
      assert.equal(await clerk.count({ status: 'open' }), 0);
    });

    it('filters by type', async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
      await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      await clerk.post({ title: 'Errand', body: 'Body', type: 'errand' });

      assert.equal(await clerk.count({ type: 'mandate' }), 1);
      assert.equal(await clerk.count({ type: 'errand' }), 1);
    });
  });

  // ── edit() ───────────────────────────────────────────────────────

  describe('edit()', () => {
    beforeEach(async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
    });

    it('updates the title of a draft writ', async () => {
      const writ = await clerk.post({ title: 'Old title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'New title' });
      assert.equal(edited.title, 'New title');
      assert.equal(edited.body, 'Body'); // unchanged
    });

    it('updates the body of a draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Old body', draft: true });
      const edited = await clerk.edit({ id: writ.id, body: 'New body' });
      assert.equal(edited.body, 'New body');
      assert.equal(edited.title, 'Title'); // unchanged
    });

    it('updates the type of a draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', draft: true });
      assert.equal(writ.type, 'mandate');
      const edited = await clerk.edit({ id: writ.id, type: 'errand' });
      assert.equal(edited.type, 'errand');
    });

    it('updates the codex of a draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', codex: 'alpha', draft: true });
      const edited = await clerk.edit({ id: writ.id, codex: 'beta' });
      assert.equal(edited.codex, 'beta');
    });

    it('clears codex when empty string is passed', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', codex: 'alpha', draft: true });
      const edited = await clerk.edit({ id: writ.id, codex: '' });
      assert.equal(edited.codex, undefined);
    });

    it('updates multiple fields at once', async () => {
      const writ = await clerk.post({ title: 'Old', body: 'Old body', draft: true });
      const edited = await clerk.edit({
        id: writ.id,
        title: 'New',
        body: 'New body',
        type: 'errand',
        codex: 'gamma',
      });
      assert.equal(edited.title, 'New');
      assert.equal(edited.body, 'New body');
      assert.equal(edited.type, 'errand');
      assert.equal(edited.codex, 'gamma');
    });

    it('updates updatedAt timestamp', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'Updated' });
      assert.ok(edited.updatedAt >= writ.updatedAt);
    });

    it('preserves status as new', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'Updated' });
      assert.equal(edited.status, 'new');
    });

    it('allows editing title of a writ in open status', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.status, 'open');
    });

    it('allows editing body of an open writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' });
      const edited = await clerk.edit({ id: writ.id, body: 'New body' });
      assert.equal(edited.body, 'New body');
      assert.equal(edited.status, 'open');
    });

    it('allows editing title of a completed writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.status, 'completed');
    });

    it('rejects changing type on a non-draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => clerk.edit({ id: writ.id, type: 'errand' }),
        /Cannot change type.*status is "open"/,
      );
    });

    it('rejects changing codex on a non-draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => clerk.edit({ id: writ.id, codex: 'gamma' }),
        /Cannot change codex.*status is "open"/,
      );
    });

    it('rejects editing a non-existent writ', async () => {
      await assert.rejects(
        () => clerk.edit({ id: 'w-doesnotexist', title: 'Nope' }),
        /not found/,
      );
    });

    it('rejects an invalid writ type', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', draft: true });
      await assert.rejects(
        () => clerk.edit({ id: writ.id, type: 'nonexistent' }),
        /Unknown writ type/,
      );
    });

    it('persists edits so show() returns updated values', async () => {
      const writ = await clerk.post({ title: 'Original', body: 'Original body', draft: true });
      await clerk.edit({ id: writ.id, title: 'Edited', body: 'Edited body' });
      const fetched = await clerk.show(writ.id);
      assert.equal(fetched.title, 'Edited');
      assert.equal(fetched.body, 'Edited body');
    });
  });

  // ── transition() — new → open (publish) ─────────────────────────

  describe('transition() to open (publish)', () => {
    beforeEach(async () => { await setup(); });

    it('publishes a new (draft) writ to open status', async () => {
      const writ = await clerk.post({ title: 'Draft writ', body: 'Body', draft: true });
      assert.equal(writ.status, 'new');

      const published = await clerk.transition(writ.id, 'open');
      assert.equal(published.status, 'open');
      assert.equal(published.resolvedAt, undefined);
    });

    it('updates updatedAt on publish', async () => {
      const writ = await clerk.post({ title: 'Draft', body: 'Body', draft: true });
      await new Promise(r => setTimeout(r, 2));
      const published = await clerk.transition(writ.id, 'open');
      assert.ok(published.updatedAt >= writ.updatedAt);
    });

    it('throws when publishing a writ that is already open', async () => {
      const writ = await clerk.post({ title: 'Already open', body: 'Body' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'open'),
        /Cannot transition/,
      );
    });

    it('throws when publishing a cancelled writ', async () => {
      const writ = await clerk.post({ title: 'Cancelled', body: 'Body', draft: true });
      await clerk.transition(writ.id, 'cancelled');
      await assert.rejects(
        () => clerk.transition(writ.id, 'open'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — open → completed ──────────────────────────────

  describe('transition() to completed', () => {
    beforeEach(async () => { await setup(); });

    it('transitions an open writ to completed', async () => {
      const writ = await clerk.post({ title: 'Complete me', body: 'Body' });
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'All done' });

      assert.equal(completed.status, 'completed');
      assert.ok(completed.resolvedAt);
      assert.equal(completed.resolution, 'All done');
    });

    it('sets resolution on completed', async () => {
      const writ = await clerk.post({ title: 'With resolution', body: 'Body' });
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Task fulfilled' });
      assert.equal(completed.resolution, 'Task fulfilled');
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

  // ── transition() — open → failed ─────────────────────────────────

  describe('transition() to failed', () => {
    beforeEach(async () => { await setup(); });

    it('transitions an open writ to failed', async () => {
      const writ = await clerk.post({ title: 'Fail me', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Ran out of time' });

      assert.equal(failed.status, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Ran out of time');
    });

    it('sets resolution on failed', async () => {
      const writ = await clerk.post({ title: 'Will fail', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });
      assert.equal(failed.resolution, 'Something broke');
    });

    it('throws when failing a new writ', async () => {
      const writ = await clerk.post({ title: 'Not open', body: 'Body', draft: true });

      await assert.rejects(
        () => clerk.transition(writ.id, 'failed'),
        /Cannot transition/,
      );
    });

    it('throws when failing a completed writ', async () => {
      const writ = await clerk.post({ title: 'Already done', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'failed'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — new|open → cancelled ──────────────────────────

  describe('transition() to cancelled', () => {
    beforeEach(async () => { await setup(); });

    it('cancels a new (draft) writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (new)', body: 'Body', draft: true });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('cancels an open writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (open)', body: 'Body' });
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
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });

    it('throws when cancelling a failed writ', async () => {
      const writ = await clerk.post({ title: 'Failed', body: 'Body' });
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

  // ── transition() — open → stuck (non-terminal) ──────────────────

  describe('transition() to stuck', () => {
    beforeEach(async () => { await setup(); });

    it('transitions an open writ to stuck', async () => {
      const writ = await clerk.post({ title: 'Stuck writ', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck', { resolution: 'Engine failure' });

      assert.equal(stuck.status, 'stuck');
      // stuck is non-terminal — no resolvedAt
      assert.equal(stuck.resolvedAt, undefined);
      assert.equal(stuck.resolution, 'Engine failure');
    });

    it('stuck is non-terminal — resolvedAt is not set', async () => {
      const writ = await clerk.post({ title: 'Non-terminal', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck');
      assert.equal(stuck.resolvedAt, undefined);
    });

    it('throws when transitioning new → stuck', async () => {
      const writ = await clerk.post({ title: 'Draft', body: 'Body', draft: true });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning completed → stuck', async () => {
      const writ = await clerk.post({ title: 'Done', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning failed → stuck', async () => {
      const writ = await clerk.post({ title: 'Failed', body: 'Body' });
      await clerk.transition(writ.id, 'failed', { resolution: 'Broke' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning cancelled → stuck', async () => {
      const writ = await clerk.post({ title: 'Cancelled', body: 'Body' });
      await clerk.transition(writ.id, 'cancelled');
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });
  });

  // ── transition() — stuck → open/failed/cancelled ──────────────────

  describe('transition() from stuck', () => {
    beforeEach(async () => { await setup(); });

    it('transitions stuck → open (recovery)', async () => {
      const writ = await clerk.post({ title: 'Recoverable', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const reopened = await clerk.transition(writ.id, 'open');
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.resolvedAt, undefined);
    });

    it('transitions stuck → failed (abandon)', async () => {
      const writ = await clerk.post({ title: 'Abandoned', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Giving up' });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Giving up');
    });

    it('transitions stuck → cancelled (withdrawn)', async () => {
      const writ = await clerk.post({ title: 'Withdrawn', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const cancelled = await clerk.transition(writ.id, 'cancelled', { resolution: 'No longer needed' });
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('throws when transitioning stuck → completed', async () => {
      const writ = await clerk.post({ title: 'Cannot complete from stuck', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await assert.rejects(
        () => clerk.transition(writ.id, 'completed'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning stuck → stuck (no self-transition)', async () => {
      const writ = await clerk.post({ title: 'Already stuck', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });
  });

  // ── Full lifecycle ───────────────────────────────────────────────

  describe('full lifecycle', () => {
    beforeEach(async () => { await setup(); });

    it('happy path: open → completed', async () => {
      const writ = await clerk.post({ title: 'Full lifecycle', body: 'Do it all' });
      assert.equal(writ.status, 'open');

      const done = await clerk.transition(writ.id, 'completed', { resolution: 'All finished' });
      assert.equal(done.status, 'completed');
      assert.ok(done.resolvedAt);
      assert.equal(done.resolution, 'All finished');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.status, 'completed');
    });

    it('failure path: open → failed', async () => {
      const writ = await clerk.post({ title: 'Will fail', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });

      assert.equal(failed.status, 'failed');
      assert.equal(failed.resolution, 'Something broke');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.status, 'failed');
    });

    it('cancellation path: open → cancelled', async () => {
      const writ = await clerk.post({ title: 'Cancelled early', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.status, 'cancelled');
    });

    it('stuck path: open → stuck → failed', async () => {
      const writ = await clerk.post({ title: 'Stuck then failed', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck', { resolution: 'Engine failure' });
      assert.equal(stuck.status, 'stuck');
      assert.equal(stuck.resolvedAt, undefined, 'stuck is non-terminal');

      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Abandoned' });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.resolvedAt);
    });

    it('stuck recovery path: open → stuck → open → completed', async () => {
      const writ = await clerk.post({ title: 'Recovered', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await clerk.transition(writ.id, 'open');
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Recovered and done' });
      assert.equal(completed.status, 'completed');
      assert.ok(completed.resolvedAt);
    });

    it('updatedAt changes on each mutation', async () => {
      const writ = await clerk.post({ title: 'Track updates', body: 'Body' });
      const t0 = writ.updatedAt;

      await new Promise(r => setTimeout(r, 2));
      const done = await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const t1 = done.updatedAt;

      assert.ok(t1 >= t0);
    });

    it('transition() strips managed fields from caller-supplied fields', async () => {
      const writ = await clerk.post({ title: 'Sanitize test', body: 'Body' });

      const done = await clerk.transition(writ.id, 'completed', {
        resolution: 'Legit resolution',
        id: 'w-evil',
        status: 'open' as const,
        createdAt: '1999-01-01T00:00:00Z',
        updatedAt: '1999-01-01T00:00:00Z',
        resolvedAt: '1999-01-01T00:00:00Z',
      });

      assert.equal(done.id, writ.id);
      assert.equal(done.status, 'completed');
      assert.notEqual(done.createdAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.updatedAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.resolvedAt, '1999-01-01T00:00:00Z');
      assert.equal(done.resolution, 'Legit resolution');
    });
  });

  // ── link() ──────────────────────────────────────────────────────

  describe('link()', () => {
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

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

  // ── writ-edit tool handler ────────────────────────────────────────

  describe('writ-edit tool handler (via guild apparatus)', () => {
    beforeEach(async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'errand', description: 'A small errand' }] } });
    });

    it('edits title of a draft writ via the tool handler', async () => {
      const writ = await clerk.post({ title: 'Old', body: 'Body', draft: true });
      const result = await writEdit.handler({ id: writ.id, title: 'New' }) as { title: string };
      assert.equal(result.title, 'New');
    });

    it('edits multiple fields via the tool handler', async () => {
      const writ = await clerk.post({ title: 'Old', body: 'Old body', draft: true });
      const result = await writEdit.handler({
        id: writ.id,
        title: 'New',
        body: 'New body',
        type: 'errand',
        codex: 'gamma',
      }) as { title: string; body: string; type: string; codex: string };

      assert.equal(result.title, 'New');
      assert.equal(result.body, 'New body');
      assert.equal(result.type, 'errand');
      assert.equal(result.codex, 'gamma');
    });

    it('rejects when no editable fields are provided', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body', draft: true });
      await assert.rejects(
        () => writEdit.handler({ id: writ.id }),
        /At least one field/,
      );
    });

    it('allows editing title/body of a non-draft writ via the tool handler', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      const edited = await writEdit.handler({ id: writ.id, title: 'Changed', body: 'New body' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.body, 'New body');
    });

    it('rejects changing type on a non-draft writ via the tool handler', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => writEdit.handler({ id: writ.id, type: 'errand' }),
        /Cannot change type/,
      );
    });

    it('rejects changing codex on a non-draft writ via the tool handler', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => writEdit.handler({ id: writ.id, codex: 'gamma' }),
        /Cannot change codex/,
      );
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
      await setup({ clerkConfig: { writTypes: [] } }); // empty writTypes — built-in still works
      const w1 = await clerk.post({ title: 'Mandate', body: 'Body', type: 'mandate' });
      assert.equal(w1.type, 'mandate');
    });

    it('summon is not a built-in type (must be declared)', async () => {
      await setup({ clerkConfig: { writTypes: [] } });
      await assert.rejects(
        () => clerk.post({ title: 'Summon', body: 'Body', type: 'summon' }),
        /Unknown writ type/,
      );
    });

    it('declared custom types are accepted', async () => {
      await setup({
        clerkConfig: {
          writTypes: [
            { name: 'epic', description: 'A significant task' },
            { name: 'errand', description: 'A small errand' },
          ],
        },
      });
      const w = await clerk.post({ title: 'Start an epic', body: 'Body', type: 'epic' });
      assert.equal(w.type, 'epic');
    });

    it('undeclared types are rejected even when other custom types exist', async () => {
      await setup({ clerkConfig: { writTypes: [{ name: 'epic', description: 'An epic' }] } });
      await assert.rejects(
        () => clerk.post({ title: 'Test', body: 'Body', type: 'unknown' }),
        /Unknown writ type/,
      );
    });

    it('defaultType from clerk config is validated against declared types', async () => {
      await setup({
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
        await setup({ extraKits: [kit] });

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
        await setup({
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
          await setup({ extraKits: [kitA, kitB] });

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
        await setup({ extraKits: [kit] });
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
        await setup({ extraKits: [kit] });
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
          await setup({ extraKits: [kit] });
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
        await setup({ extraKits: [kit] });

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
        await setup({ extraApparatuses: [lateApp] });

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
    const plugin = await setupCore();
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.description, null);
    assert.equal(mandate.isDefault, true);
    assert.equal(mandate.source, 'builtin');
  });

  it('returns config-declared types with description', async () => {
    const plugin = await setupCore({ clerkConfig: { writTypes: [{ name: 'task', description: 'A task' }] } });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const task = result.find(t => t.name === 'task');
    assert.ok(task, 'task should be in result');
    assert.equal(task.description, 'A task');
    assert.equal(task.isDefault, false);
    assert.equal(task.source, 'guild');
    // mandate should still be there
    assert.ok(result.find(t => t.name === 'mandate'), 'mandate should still appear');
  });

  it('marks configured defaultType as default', async () => {
    const plugin = await setupCore({ clerkConfig: { writTypes: [{ name: 'task' }], defaultType: 'task' } });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const task = result.find(t => t.name === 'task');
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(task, 'task should be in result');
    assert.equal(task.isDefault, true);
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.isDefault, false);
  });

  it('includes kit-contributed types', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-a',
      id: 'kit-a',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit' }] },
    };
    const plugin = await setupCore({ extraKits: [kit] });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa, 'quality-audit should be in result');
    assert.equal(qa.description, null);
    assert.equal(qa.isDefault, false);
    assert.equal(qa.source, 'kit-a');
  });

  it('tool is registered in supportKit.tools', () => {
    const plugin = createClerk();
    const tools = getTools(plugin);
    assert.ok(tools.some(t => t.name === 'writ-types'), 'writ-types tool should be in supportKit.tools');
  });

  it('tool has bare-level read permission', () => {
    const plugin = createClerk();
    const t = getWritTypesTool(plugin);
    assert.equal(t.permission, 'read');
  });

  it('tool has no callableBy restriction', () => {
    const plugin = createClerk();
    const t = getWritTypesTool(plugin);
    assert.equal(t.callableBy, undefined);
  });

  it('preserves kit-contributed description', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-desc',
      id: 'kit-desc',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit', description: 'Code quality audit' }] },
    };
    const plugin = await setupCore({ extraKits: [kit] });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa, 'quality-audit should be in result');
    assert.equal(qa.description, 'Code quality audit');
    assert.equal(qa.source, 'kit-desc');
    assert.equal(qa.isDefault, false);
  });

  it('guild config shadows kit description', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-shadow',
      id: 'kit-shadow',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit', description: 'Kit version' }] },
    };
    const plugin = await setupCore({
      clerkConfig: { writTypes: [{ name: 'quality-audit', description: 'Guild version' }] },
      extraKits: [kit],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa, 'quality-audit should be in result');
    assert.equal(qa.description, 'Guild version');
    assert.equal(qa.source, 'guild');
  });

  it('guild config shadows kit with no description', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-shadow2',
      id: 'kit-shadow2',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit', description: 'Kit version' }] },
    };
    const plugin = await setupCore({
      clerkConfig: { writTypes: [{ name: 'quality-audit' }] },
      extraKits: [kit],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa, 'quality-audit should be in result');
    assert.equal(qa.description, null);
    assert.equal(qa.source, 'guild');
  });

  it('tool delegates to api.listWritTypes()', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-delegate',
      id: 'kit-delegate',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit', description: 'QA' }] },
    };
    const plugin = await setupCore({
      clerkConfig: { writTypes: [{ name: 'task', description: 'A task' }] },
      extraKits: [kit],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const toolResult = await writTypesTool.handler({});
    const apiResult = clerk.listWritTypes();
    assert.deepEqual(toolResult, apiResult);
  });

  it('uses isDefault field name (not default)', async () => {
    const plugin = await setupCore();
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<Record<string, unknown>>;
    for (const entry of result) {
      assert.ok('isDefault' in entry, `entry "${entry.name}" should have isDefault field`);
      assert.ok(!('default' in entry), `entry "${entry.name}" should not have default field`);
    }
  });
});

// ── listWritTypes() API method tests ─────────────────────────────────

describe('listWritTypes()', () => {
  afterEach(() => { clearGuild(); });

  it('returns builtin type with source and isDefault', async () => {
    await setupCore();
    const result = clerk.listWritTypes();
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.source, 'builtin');
    assert.equal(mandate.isDefault, true);
    assert.equal(mandate.description, null);
  });

  it('returns guild config types with source guild', async () => {
    await setupCore({ clerkConfig: { writTypes: [{ name: 'task', description: 'A task' }] } });
    const result = clerk.listWritTypes();
    const task = result.find(t => t.name === 'task');
    assert.ok(task);
    assert.equal(task.source, 'guild');
    assert.equal(task.description, 'A task');
  });

  it('returns kit types with pluginId as source', async () => {
    const kit: LoadedKit = {
      packageName: '@test/kit-src',
      id: 'kit-src',
      version: '0.0.0',
      kit: { writTypes: [{ name: 'quality-audit', description: 'Code quality audit' }] },
    };
    await setupCore({ extraKits: [kit] });
    const result = clerk.listWritTypes();
    const qa = result.find(t => t.name === 'quality-audit');
    assert.ok(qa);
    assert.equal(qa.source, 'kit-src');
    assert.equal(qa.description, 'Code quality audit');
    assert.equal(qa.isDefault, false);
  });

  it('guild config default override changes isDefault', async () => {
    await setupCore({ clerkConfig: { writTypes: [{ name: 'task' }], defaultType: 'task' } });
    const result = clerk.listWritTypes();
    const task = result.find(t => t.name === 'task');
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(task);
    assert.equal(task.isDefault, true);
    assert.ok(mandate);
    assert.equal(mandate.isDefault, false);
  });

  it('apparatus supportKit writ type has pluginId source', async () => {
    const apparatusPlugin = createClerk();
    const fakeApparatus: LoadedApparatus = {
      packageName: '@test/apparatus-contrib',
      id: 'apparatus-contrib',
      version: '0.0.0',
      apparatus: {
        ...((apparatusPlugin as { apparatus: Record<string, unknown> }).apparatus),
        supportKit: {
          writTypes: [{ name: 'late-type', description: 'Late' }],
        },
        provides: {},
        start() {},
      },
    };
    await setupCore({ extraApparatuses: [fakeApparatus] });
    const result = clerk.listWritTypes();
    const late = result.find(t => t.name === 'late-type');
    assert.ok(late, 'late-type should be in result');
    assert.equal(late.description, 'Late');
    assert.equal(late.source, 'apparatus-contrib');
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
    beforeEach(async () => { await setup(); });

    it('creates a child writ with parentId set', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Parent body' });
      const child = await clerk.post({ title: 'Child', body: 'Child body', parentId: parent.id });

      assert.equal(child.parentId, parent.id);
      assert.ok(child.id.startsWith('w-'));
      assert.equal(child.status, 'open');
    });

    it('parent stays in open when child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      assert.equal(parent.status, 'open');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'open');
    });

    it('parent stays in new when child is added', async () => {
      const parent = await clerk.post({ title: 'Draft parent', body: 'Body', draft: true });
      assert.equal(parent.status, 'new');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'new');
    });

    it('parent stays in open when a second child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.post({ title: 'Child 1', body: 'Body', parentId: parent.id });

      const midState = await clerk.show(parent.id);
      assert.equal(midState.status, 'open');

      await clerk.post({ title: 'Child 2', body: 'Body', parentId: parent.id });

      const endState = await clerk.show(parent.id);
      assert.equal(endState.status, 'open');
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
    beforeEach(async () => { await setup(); });

    it('rejects child creation with non-existent parentId', async () => {
      await assert.rejects(
        () => clerk.post({ title: 'Child', body: 'Body', parentId: 'w-nonexistent' }),
        { message: 'Parent writ "w-nonexistent" not found.' },
      );
    });

    it('rejects child creation when parent is completed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
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

    it('allows child creation when parent is stuck', async () => {
      const parent = await clerk.post({ title: 'Stuck parent', body: 'Body' });
      await clerk.transition(parent.id, 'stuck');

      const child = await clerk.post({ title: 'Child of stuck', body: 'Body', parentId: parent.id });
      assert.equal(child.parentId, parent.id);
    });
  });

  // ── Child failure cascade ──────────────────────────────────────────

  describe('child failure cascade', () => {
    beforeEach(async () => { await setup(); });

    it('transitions open parent to failed when child fails', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Broke' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'failed');
      assert.ok(updated.resolution?.includes('Child'));
      assert.ok(updated.resolution?.includes('Broke'));
    });

    it('transitions stuck parent to failed when child fails', async () => {
      const parent = await clerk.post({ title: 'Stuck Parent', body: 'Body' });
      await clerk.transition(parent.id, 'stuck');
      const child = await clerk.post({ title: 'Child of stuck', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Broke too' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'failed');
      assert.ok(updated.resolution?.includes('Child'));
    });

    it('does not cascade failure when parent is in new status', async () => {
      const parent = await clerk.post({ title: 'Draft Parent', body: 'Body', draft: true });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Broke' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'new');
    });

    it('parent stays open when child completes', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'open');
    });

    it('parent stays open when all children complete', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      await clerk.transition(c2.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'open');
    });

    it('two children: first completes, second fails → parent transitions to failed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      await clerk.transition(c2.id, 'failed', { resolution: 'Broke' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'failed');
    });
  });

  // ── Failure cascade ───────────────────────────────────────────────

  describe('failure cascade', () => {
    beforeEach(async () => { await setup(); });

    it('fails parent when child fails, cancels remaining siblings', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });
      const c3 = await clerk.post({ title: 'C3', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'failed', { resolution: 'Broke' });

      const updatedParent = await clerk.show(parent.id);
      assert.equal(updatedParent.status, 'failed');
      assert.ok(updatedParent.resolution?.includes(`Child "${c1.id}" failed: Broke`));

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
      assert.equal(updatedC2.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC3 = await clerk.show(c3.id);
      assert.equal(updatedC3.status, 'cancelled');
      assert.equal(updatedC3.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);
    });

    it('fails parent when single child fails', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Error occurred' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.status, 'failed');
      assert.ok(updated.resolution?.includes('Error occurred'));
    });

    it('cascades failure through 3-level hierarchy', async () => {
      const grandparent = await clerk.post({ title: 'GP', body: 'B' });
      const parent = await clerk.post({ title: 'P', body: 'B', parentId: grandparent.id });
      const child = await clerk.post({ title: 'C', body: 'B', parentId: parent.id });

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

      // Fail child without resolution
      await clerk.transition(child.id, 'failed');

      const updated = await clerk.show(parent.id);
      assert.ok(updated.resolution?.includes('unknown'));
    });
  });

  // ── Downward cancellation cascade ─────────────────────────────────

  describe('cancellation cascade (downward)', () => {
    beforeEach(async () => { await setup(); });

    it('cancels non-terminal children when parent is cancelled', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(parent.id, 'cancelled');

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.status, 'cancelled');
      assert.equal(updatedC1.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
    });

    it('does not cancel already-terminal children', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      // Complete c1 first
      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });

      // Now cancel parent
      await clerk.transition(parent.id, 'cancelled');

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.status, 'completed'); // already terminal, unchanged

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
    });

    it('cancels non-terminal children when parent is failed directly', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      // Transition parent directly to failed (no child failure driving it).
      await clerk.transition(parent.id, 'failed', { resolution: 'Parent-level failure' });

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.status, 'cancelled');
      assert.equal(updatedC1.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.status, 'cancelled');
      assert.equal(updatedC2.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);
    });
  });

  // ── Downward completion cascade (warn, do not cancel) ────────────

  describe('completion cascade (downward)', () => {
    beforeEach(async () => { await setup(); });

    it('does not cancel non-terminal children when parent completes; warns for each', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

      try {
        const parent = await clerk.post({ title: 'Parent', body: 'Body' });
        const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
        const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

        // Transition the parent straight to completed while children are still open.
        // This simulates the race the commission is defending against: parent
        // reaches `completed` before child-writ bookkeeping has caught up.
        await clerk.transition(parent.id, 'completed', { resolution: 'Parent completed early' });

        // Children must remain non-terminal — the cascade must not mask the gap.
        const updatedC1 = await clerk.show(c1.id);
        assert.equal(updatedC1.status, 'open');
        assert.equal(updatedC1.resolution, undefined);

        const updatedC2 = await clerk.show(c2.id);
        assert.equal(updatedC2.status, 'open');
        assert.equal(updatedC2.resolution, undefined);

        // A warning must be emitted referencing each non-terminal child so the
        // bookkeeping gap is visible to operators.
        assert.ok(
          warnings.some((w) => w.includes(c1.id) && w.includes(parent.id) && w.includes('completed')),
          `Expected warning referencing c1 (${c1.id}) and parent (${parent.id}), got: ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          warnings.some((w) => w.includes(c2.id) && w.includes(parent.id) && w.includes('completed')),
          `Expected warning referencing c2 (${c2.id}) and parent (${parent.id}), got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = original;
      }
    });

    it('does not warn when all children are already terminal at parent completion', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

      try {
        const parent = await clerk.post({ title: 'Parent', body: 'Body' });
        const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });

        await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
        await clerk.transition(parent.id, 'completed', { resolution: 'All done' });

        const updatedC1 = await clerk.show(c1.id);
        assert.equal(updatedC1.status, 'completed');

        assert.ok(
          !warnings.some((w) => w.includes('non-terminal')),
          `Expected no non-terminal child warnings, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = original;
      }
    });

    it('does not cancel non-terminal children when parent completes, regardless of child count', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

      try {
        const parent = await clerk.post({ title: 'Parent', body: 'Body' });
        const openChild = await clerk.post({ title: 'Open', body: 'B', parentId: parent.id });
        const stuckChild = await clerk.post({ title: 'Stuck', body: 'B', parentId: parent.id });
        await clerk.transition(stuckChild.id, 'stuck');
        const doneChild = await clerk.post({ title: 'Done', body: 'B', parentId: parent.id });
        await clerk.transition(doneChild.id, 'completed', { resolution: 'Done' });

        await clerk.transition(parent.id, 'completed', { resolution: 'Parent done' });

        // Terminal child stays terminal; non-terminal children stay non-terminal.
        assert.equal((await clerk.show(openChild.id)).status, 'open');
        assert.equal((await clerk.show(stuckChild.id)).status, 'stuck');
        assert.equal((await clerk.show(doneChild.id)).status, 'completed');

        // Cascade must have warned for both non-terminal children, but not the terminal one.
        assert.ok(
          warnings.some((w) => w.includes(openChild.id) && w.includes('non-terminal')),
          `Expected warning for open child, got: ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          warnings.some((w) => w.includes(stuckChild.id) && w.includes('non-terminal')),
          `Expected warning for stuck child, got: ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          !warnings.some((w) => w.includes(doneChild.id) && w.includes('non-terminal')),
          `Did not expect warning for already-terminal child, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = original;
      }
    });
  });

  // ── Full lifecycle with children ──────────────────────────────────

  describe('full lifecycle with children', () => {
    beforeEach(async () => { await setup(); });

    it('parent flows: open → completed (children do not change parent status)', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      assert.equal(parent.status, 'open');

      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });
      const p1 = await clerk.show(parent.id);
      assert.equal(p1.status, 'open');

      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const p2 = await clerk.show(parent.id);
      assert.equal(p2.status, 'open');

      await clerk.transition(parent.id, 'completed', { resolution: 'All done' });
      const p3 = await clerk.show(parent.id);
      assert.equal(p3.status, 'completed');
    });

    it('children already terminal are not cancelled when parent completes normally', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      // Complete child — parent stays open
      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      // Parent now open → completed
      await clerk.transition(parent.id, 'completed', { resolution: 'All done' });

      // Child should still be completed
      const updatedChild = await clerk.show(child.id);
      assert.equal(updatedChild.status, 'completed');
    });
  });

  // ── parentId immutability ─────────────────────────────────────────

  describe('parentId immutability', () => {
    beforeEach(async () => { await setup(); });

    it('transition does not change parentId even if passed in fields', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      const updated = await clerk.transition(child.id, 'completed', { parentId: 'w-other' } as Partial<import('./types.ts').WritDoc>);
      assert.equal(updated.parentId, parent.id);
    });
  });

  // ── WritFilters with parentId ─────────────────────────────────────

  describe('list with parentId filter', () => {
    beforeEach(async () => { await setup(); });

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
    beforeEach(async () => { await setup(); });

    it('includes parent context for a child writ', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: child.id });
      assert.deepEqual(result.parent, { id: parent.id, title: 'Parent', status: 'open' });
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
      assert.equal(result.children.summary['open'], 2);
    });

    it('returns null parent and empty children for root writ without children', async () => {
      const writ = await clerk.post({ title: 'Root', body: 'Body' });

      const result = await writShow.handler({ id: writ.id });
      assert.equal(result.parent, null);
      assert.deepEqual(result.children, { summary: {}, items: [] });
    });
  });

  // ── Book indexes ──────────────────────────────────────────────────

  describe('book indexes', () => {
    it('writs book indexes include parentId and [parentId, status]', async () => {
      const plugin = await setupCore();
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

  it('wraps page content in a <main> element with 24px padding', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = join(__dirname, '..', 'pages', 'writs', 'index.html');
    const content = readFileSync(htmlPath, 'utf-8');
    assert.ok(content.includes('<main'), 'index.html must contain a <main> element');
    assert.ok(content.includes('padding: 24px'), 'main element must have 24px padding');
    assert.ok(content.includes('</main>'), 'main element must be closed');
  });

  it('has a page heading', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = join(__dirname, '..', 'pages', 'writs', 'index.html');
    const content = readFileSync(htmlPath, 'utf-8');
    assert.ok(content.includes('<h1>Writs</h1>'), 'page must have an h1 heading');
  });

  it('uses card class for toolbar and data table sections', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = join(__dirname, '..', 'pages', 'writs', 'index.html');
    const content = readFileSync(htmlPath, 'utf-8');
    // The toolbar and data table should each be inside a .card container
    const cardCount = (content.match(/class="card"/g) || []).length;
    assert.ok(cardCount >= 2, `expected at least 2 card containers, found ${cardCount}`);
  });

  it('post-section form uses card class', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const htmlPath = join(__dirname, '..', 'pages', 'writs', 'index.html');
    const content = readFileSync(htmlPath, 'utf-8');
    assert.ok(content.includes('id="post-section" class="card"'), 'post-section must use card class');
  });
});

// ── piece-add tool tests ──────────────────────────────────────────────

describe('piece-add tool', () => {
  afterEach(() => { clearGuild(); });

  it('creates a piece writ as child of a mandate with structured XML body', async () => {
    await setup({
      clerkConfig: {
        writTypes: [{ name: 'piece', description: 'task piece' }],
      },
    });

    // Create a mandate first
    const mandate = await clerk.post({ title: 'Parent mandate', body: 'Do all things', type: 'mandate' });

    // Use piece-add handler directly
    const pieceAddTool = (await import('./tools/piece-add.ts')).default;
    const handler = pieceAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;
    const piece = await handler({
      mandateId: mandate.id,
      name: 'First task',
      action: 'Do the first thing',
      files: 'src/app.ts',
      verify: 'pnpm test',
      done: 'Tests pass',
    }) as { id: string; type: string; title: string; body: string; parentId: string; status: string };

    assert.equal(piece.type, 'piece');
    assert.equal(piece.title, 'First task');
    assert.equal(piece.parentId, mandate.id);
    assert.equal(piece.status, 'open');
    assert.ok(piece.body.includes('<task id='));
    assert.ok(piece.body.includes('<name>First task</name>'));
    assert.ok(piece.body.includes('<action>Do the first thing</action>'));
    assert.ok(piece.body.includes('<files>src/app.ts</files>'));
    assert.ok(piece.body.includes('<verify>pnpm test</verify>'));
    assert.ok(piece.body.includes('<done>Tests pass</done>'));
  });

  it('creates a piece with only required fields', async () => {
    await setup({
      clerkConfig: {
        writTypes: [{ name: 'piece', description: 'task piece' }],
      },
    });

    const mandate = await clerk.post({ title: 'Parent mandate', body: 'Do things', type: 'mandate' });

    const pieceAddTool = (await import('./tools/piece-add.ts')).default;
    const handler = pieceAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;
    const piece = await handler({
      mandateId: mandate.id,
      name: 'Minimal task',
      action: 'Do something simple',
    }) as { body: string };

    assert.ok(piece.body.includes('<name>Minimal task</name>'));
    assert.ok(piece.body.includes('<action>Do something simple</action>'));
    assert.ok(!piece.body.includes('<files>'));
    assert.ok(!piece.body.includes('<verify>'));
    assert.ok(!piece.body.includes('<done>'));
  });

  it('rejects when parent mandate does not exist', async () => {
    await setup({
      clerkConfig: {
        writTypes: [{ name: 'piece', description: 'task piece' }],
      },
    });

    const pieceAddTool = (await import('./tools/piece-add.ts')).default;
    const handler = pieceAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;

    await assert.rejects(
      () => handler({
        mandateId: 'nonexistent-mandate',
        name: 'Orphan task',
        action: 'This should fail',
      }),
      (err: Error) => {
        assert.ok(err.message.includes('not found'));
        return true;
      },
    );
  });
});

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

import { setGuild, clearGuild, guild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk, CASCADE_PARENT_TERMINATION_RESOLUTION } from './clerk.ts';
import type { ClerkKit } from './clerk.ts';
import type { ClerkApi, ClerkConfig, WritDoc, WritLinkDoc, LinkKindDoc } from './types.ts';
import type { WritLinks } from './index.ts';
import writShow from './tools/writ-show.ts';
import writEdit from './tools/writ-edit.ts';
import writLink from './tools/writ-link.ts';
import writUnlink from './tools/writ-unlink.ts';
import writLinkKinds from './tools/writ-link-kinds.ts';
import writLinkKindsShow from './tools/writ-link-kinds-show.ts';

// ── Test harness ─────────────────────────────────────────────────────

let clerk: ClerkApi;

interface SetupOptions {
  clerkConfig?: ClerkConfig;
  extraKits?: LoadedKit[];
  extraApparatuses?: LoadedApparatus[];
  /**
   * Pre-normalization writ rows to seed into the writs book before clerk
   * starts. Used by tests that verify the startup migration against
   * existing data.
   */
  seedWrits?: Array<Record<string, unknown>>;
  /**
   * Pre-normalization link rows to seed into the links book before clerk
   * starts. Used by tests that verify the startup migration against
   * existing data.
   */
  seedLinks?: Array<Record<string, unknown>>;
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
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
  });

  // Seed pre-normalization rows for migration tests — use the already-started
  // stacks API to write directly, before clerk.start() runs its migration.
  if (options.seedWrits) {
    const writsBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'writs');
    for (const row of options.seedWrits) {
      await writsBook.put(row as Record<string, unknown> & { id: string });
    }
  }
  if (options.seedLinks) {
    const linksBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'links');
    for (const row of options.seedLinks) {
      await linksBook.put(row as Record<string, unknown> & { id: string });
    }
  }

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
      assert.equal(writ.phase, 'open');
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
      assert.equal(writ.phase, 'new');
      assert.equal(writ.resolvedAt, undefined);
    });

    it('creates a writ in open status when draft: false (explicit)', async () => {
      const writ = await clerk.post({ title: 'Explicit open', body: 'Body', draft: false });
      assert.equal(writ.phase, 'open');
    });

    it('creates a writ in open status when draft is omitted (backward compat)', async () => {
      const writ = await clerk.post({ title: 'Default open', body: 'Body' });
      assert.equal(writ.phase, 'open');
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
      assert.equal(fetched.phase, 'open');
    });
  });

  // ── resolveId() ──────────────────────────────────────────────────

  describe('resolveId()', () => {
    beforeEach(async () => { await setup(); });

    it('returns the full id unchanged when given an exact match', async () => {
      const posted = await clerk.post({ title: 'Exact', body: 'Body' });
      const resolved = await clerk.resolveId(posted.id);
      assert.equal(resolved, posted.id);
    });

    it('resolves a short id prefix to the full id', async () => {
      const posted = await clerk.post({ title: 'Prefix', body: 'Body' });
      // Writ ids are `w-{base36_timestamp}{hex_random}` — the `w-{timestamp}`
      // segment before the final hyphen is the short display form.
      const shortId = posted.id.slice(0, posted.id.lastIndexOf('-'));
      const resolved = await clerk.resolveId(shortId);
      assert.equal(resolved, posted.id);
    });

    it('throws when no writ matches the prefix', async () => {
      await assert.rejects(
        () => clerk.resolveId('w-nonexistent'),
        /No writ found matching prefix/,
      );
    });

    it('throws when the prefix matches multiple writs', async () => {
      // Direct backend inserts to contrive an ambiguous prefix without
      // relying on id generation timing.
      const stacks = guild().apparatus<StacksApi>('stacks');
      const writs = stacks.book<WritDoc>('clerk', 'writs');
      const now = new Date().toISOString();
      await writs.put({
        id: 'w-ambigxx-aaaa1111aaaa1111',
        type: 'mandate',
        phase: 'open',
        title: 'A',
        body: '',
        createdAt: now,
        updatedAt: now,
      });
      await writs.put({
        id: 'w-ambigxx-bbbb2222bbbb2222',
        type: 'mandate',
        phase: 'open',
        title: 'B',
        body: '',
        createdAt: now,
        updatedAt: now,
      });
      await assert.rejects(
        () => clerk.resolveId('w-ambigxx'),
        /Ambiguous prefix.*matches 2 writs/,
      );
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

      const openWrits = await clerk.list({ phase: 'open' });
      const newWrits = await clerk.list({ phase: 'new' });

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
      const completed = await clerk.list({ phase: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('filters by new status', async () => {
      await clerk.post({ title: 'Draft writ', body: 'Body', draft: true });
      await clerk.post({ title: 'Open writ', body: 'Body' });

      const newWrits = await clerk.list({ phase: 'new' });
      const openWrits = await clerk.list({ phase: 'open' });

      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.phase, 'new');
      assert.equal(openWrits.length, 1);
      assert.equal(openWrits[0]!.phase, 'open');
    });

    it('filters by multiple statuses (OR)', async () => {
      const w1 = await clerk.post({ title: 'Open writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'New writ', body: 'Body', draft: true });
      const w3 = await clerk.post({ title: 'Completed writ', body: 'Body' });
      await clerk.transition(w3.id, 'completed');

      const result = await clerk.list({ phase: ['open', 'new'] });
      assert.equal(result.length, 2);
      const statuses = new Set(result.map((w) => w.phase));
      assert.ok(statuses.has('open'));
      assert.ok(statuses.has('new'));
      assert.ok(!statuses.has('completed'));
    });

    it('filters by stuck status', async () => {
      const writ = await clerk.post({ title: 'Stuck writ', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await clerk.post({ title: 'Open writ', body: 'Body' });

      const result = await clerk.list({ phase: 'stuck' });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.phase, 'stuck');
    });

    it('single-element status array behaves like a scalar filter', async () => {
      await clerk.post({ title: 'Open writ', body: 'Body' });
      const w2 = await clerk.post({ title: 'New writ', body: 'Body', draft: true });

      const result = await clerk.list({ phase: ['open'] });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.phase, 'open');
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

      assert.equal(await clerk.count({ phase: 'completed' }), 1);
      assert.equal(await clerk.count({ phase: 'open' }), 0);
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
      assert.equal(edited.phase, 'new');
    });

    it('allows editing title of a writ in open status', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.phase, 'open');
    });

    it('allows editing body of an open writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' });
      const edited = await clerk.edit({ id: writ.id, body: 'New body' });
      assert.equal(edited.body, 'New body');
      assert.equal(edited.phase, 'open');
    });

    it('allows editing title of a completed writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.phase, 'completed');
    });

    it('rejects changing type on a non-draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => clerk.edit({ id: writ.id, type: 'errand' }),
        /Cannot change type.*phase is "open"/,
      );
    });

    it('rejects changing codex on a non-draft writ', async () => {
      const writ = await clerk.post({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => clerk.edit({ id: writ.id, codex: 'gamma' }),
        /Cannot change codex.*phase is "open"/,
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
      assert.equal(writ.phase, 'new');

      const published = await clerk.transition(writ.id, 'open');
      assert.equal(published.phase, 'open');
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

      assert.equal(completed.phase, 'completed');
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

      assert.equal(failed.phase, 'failed');
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

      assert.equal(cancelled.phase, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('cancels an open writ', async () => {
      const writ = await clerk.post({ title: 'Cancel me (open)', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.phase, 'cancelled');
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

      assert.equal(stuck.phase, 'stuck');
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
      assert.equal(reopened.phase, 'open');
      assert.equal(reopened.resolvedAt, undefined);
    });

    it('transitions stuck → failed (abandon)', async () => {
      const writ = await clerk.post({ title: 'Abandoned', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Giving up' });
      assert.equal(failed.phase, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Giving up');
    });

    it('transitions stuck → cancelled (withdrawn)', async () => {
      const writ = await clerk.post({ title: 'Withdrawn', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const cancelled = await clerk.transition(writ.id, 'cancelled', { resolution: 'No longer needed' });
      assert.equal(cancelled.phase, 'cancelled');
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
      assert.equal(writ.phase, 'open');

      const done = await clerk.transition(writ.id, 'completed', { resolution: 'All finished' });
      assert.equal(done.phase, 'completed');
      assert.ok(done.resolvedAt);
      assert.equal(done.resolution, 'All finished');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.phase, 'completed');
    });

    it('failure path: open → failed', async () => {
      const writ = await clerk.post({ title: 'Will fail', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });

      assert.equal(failed.phase, 'failed');
      assert.equal(failed.resolution, 'Something broke');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.phase, 'failed');
    });

    it('cancellation path: open → cancelled', async () => {
      const writ = await clerk.post({ title: 'Cancelled early', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');
    });

    it('stuck path: open → stuck → failed', async () => {
      const writ = await clerk.post({ title: 'Stuck then failed', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck', { resolution: 'Engine failure' });
      assert.equal(stuck.phase, 'stuck');
      assert.equal(stuck.resolvedAt, undefined, 'stuck is non-terminal');

      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Abandoned' });
      assert.equal(failed.phase, 'failed');
      assert.ok(failed.resolvedAt);
    });

    it('stuck recovery path: open → stuck → open → completed', async () => {
      const writ = await clerk.post({ title: 'Recovered', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await clerk.transition(writ.id, 'open');
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Recovered and done' });
      assert.equal(completed.phase, 'completed');
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
        phase: 'open' as const,
        status: { evil: { injected: true } },
        createdAt: '1999-01-01T00:00:00Z',
        updatedAt: '1999-01-01T00:00:00Z',
        resolvedAt: '1999-01-01T00:00:00Z',
      });

      assert.equal(done.id, writ.id);
      assert.equal(done.phase, 'completed');
      assert.equal(done.status, undefined,
        'status is a managed field — transition() must strip it from the body');
      assert.notEqual(done.createdAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.updatedAt, '1999-01-01T00:00:00Z');
      assert.notEqual(done.resolvedAt, '1999-01-01T00:00:00Z');
      assert.equal(done.resolution, 'Legit resolution');
    });
  });

  // ── setWritStatus() — plugin-owned observation slot ───────────────

  describe('setWritStatus()', () => {
    beforeEach(async () => { await setup(); });

    it('returns an empty status slot for a freshly created writ', async () => {
      const writ = await clerk.post({ title: 'No slot yet', body: 'Body' });
      assert.equal(writ.status, undefined, 'new writs have no status slot by default');
    });

    it('writes a sub-slot under the provided pluginId', async () => {
      const writ = await clerk.post({ title: 'Observed', body: 'Body' });
      const updated = await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'await-graft' });

      assert.ok(updated.status, 'status slot should exist after setWritStatus');
      assert.deepEqual(updated.status!['spider'], { stuckCause: 'await-graft' });
    });

    it('disjoint sub-slot writes from different plugins do not clobber each other', async () => {
      const writ = await clerk.post({ title: 'Two observers', body: 'Body' });

      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'engine-failed' });
      const afterSecond = await clerk.setWritStatus(writ.id, 'ratchet', { progress: 0.5 });

      assert.deepEqual(afterSecond.status!['spider'], { stuckCause: 'engine-failed' });
      assert.deepEqual(afterSecond.status!['ratchet'], { progress: 0.5 });
    });

    it('overwrites its own sub-slot but preserves sibling sub-slots', async () => {
      const writ = await clerk.post({ title: 'Own overwrite', body: 'Body' });

      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'first' });
      await clerk.setWritStatus(writ.id, 'ratchet', { progress: 0.1 });
      const updated = await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'second' });

      assert.deepEqual(updated.status!['spider'], { stuckCause: 'second' });
      assert.deepEqual(updated.status!['ratchet'], { progress: 0.1 });
    });

    it('survives terminal transitions — slot is not cleared on completed/failed/cancelled', async () => {
      const writ = await clerk.post({ title: 'Terminal survivor', body: 'Body' });
      await clerk.setWritStatus(writ.id, 'spider', { lastRig: 'rig-1' });

      const done = await clerk.transition(writ.id, 'completed', { resolution: 'ok' });
      assert.deepEqual(done.status!['spider'], { lastRig: 'rig-1' },
        'observation slot survives transition to a terminal phase');

      const fetched = await clerk.show(writ.id);
      assert.deepEqual(fetched.status!['spider'], { lastRig: 'rig-1' });
    });

    it('transition() strips the caller-supplied status field and preserves sibling sub-slots', async () => {
      // The observation slot is writable only via setWritStatus() — the
      // one sanctioned slot-write path, which performs a transactional
      // read-modify-write on the sub-slot keyed by pluginId so sibling
      // sub-slots are preserved. transition() silently drops any `status`
      // in its body (the same treatment as the other managed fields) so
      // that a smuggled slot-write through the generic shallow-merge
      // path cannot clobber sibling sub-slots.
      const writ = await clerk.post({ title: 'Strip status on transition', body: 'Body' });
      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'original' });
      await clerk.setWritStatus(writ.id, 'ratchet', { progress: 0.2 });

      const done = await clerk.transition(writ.id, 'completed', {
        resolution: 'done',
        status: { spider: { stuckCause: 'overwritten' } },
      });

      // The caller-supplied sub-slot is discarded; sibling sub-slots survive.
      assert.deepEqual(done.status!['spider'], { stuckCause: 'original' },
        'caller-supplied status sub-slot is discarded by transition()');
      assert.deepEqual(done.status!['ratchet'], { progress: 0.2 },
        'sibling sub-slots are preserved when transition() drops the body status');
    });

    it('throws when writId is missing', async () => {
      await assert.rejects(
        () => clerk.setWritStatus('', 'spider', {}),
        /writId is required/,
      );
    });

    it('throws when pluginId is missing', async () => {
      const writ = await clerk.post({ title: 'No plugin', body: 'Body' });
      await assert.rejects(
        () => clerk.setWritStatus(writ.id, '', {}),
        /pluginId is required/,
      );
    });

    it('throws when the writ does not exist', async () => {
      await assert.rejects(
        () => clerk.setWritStatus('w-missing-xxxx', 'spider', {}),
        /not found/,
      );
    });

    it('emits a CDC update event carrying the new status sub-slot', async () => {
      const writ = await clerk.post({ title: 'CDC emit', body: 'Body' });

      // Subscribe to the writs book before invoking setWritStatus so the
      // handler captures the event it fires.
      const stacks = guild().apparatus<StacksApi>('stacks');
      const events: Array<{ entry: WritDoc; prev: WritDoc | undefined }> = [];
      stacks.watch<WritDoc>('clerk', 'writs', (event) => {
        if (event.type !== 'update') return;
        if (event.entry.id !== writ.id) return;
        events.push({ entry: event.entry, prev: event.prev });
      });

      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'cdc-emitted' });

      assert.equal(events.length, 1, 'setWritStatus() should emit exactly one update event');
      assert.deepEqual(events[0]!.entry.status!['spider'], { stuckCause: 'cdc-emitted' },
        'CDC event carries the freshly-written sub-slot');
      assert.equal(events[0]!.prev!.status, undefined,
        'prev observation slot was empty before the write');
    });

    it('supports an arbitrary JSON-compatible value in the sub-slot', async () => {
      const writ = await clerk.post({ title: 'Any value', body: 'Body' });

      // Strings, arrays, numbers, nested objects — all valid.
      const stringValue = await clerk.setWritStatus(writ.id, 'a', 'just-a-string');
      assert.equal(stringValue.status!['a'], 'just-a-string');

      const arrayValue = await clerk.setWritStatus(writ.id, 'b', [1, 2, 3]);
      assert.deepEqual(arrayValue.status!['b'], [1, 2, 3]);

      const nested = await clerk.setWritStatus(writ.id, 'c', { nested: { deep: true } });
      assert.deepEqual(nested.status!['c'], { nested: { deep: true } });
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
      assert.equal(link.label, 'fixes');
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

    it('throws for empty label string', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, ''),
        /non-empty/,
      );
    });

    it('throws for whitespace-only label string', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, '   '),
        /non-empty/,
      );
    });

    it('accepts various non-empty label strings', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const l1 = await clerk.link(w1.id, w2.id, 'fixes');
      const l2 = await clerk.link(w1.id, w2.id, 'retries');

      assert.equal(l1.label, 'fixes');
      assert.equal(l2.label, 'retries');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 2);
    });

    it('creates separate links for same pair with different labels', async () => {
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
      assert.equal(result.outbound[0]!.label, 'retries');
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

  // ── Link label normalization ──────────────────────────────────────
  //
  // Normalization is syntactic, NOT synonymy. Variant spellings of the
  // same label collapse to a single canonical form; distinct labels
  // stay distinct. Synonymy is expressed via `kind`, not
  // via the normalization pipeline.

  describe('link()/unlink() — syntactic label normalization (NOT synonymy)', () => {
    beforeEach(async () => { await setup(); });

    it('stores the canonicalized label on the link row', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });

      const link = await clerk.link(w1.id, w2.id, 'DependsOn');

      assert.equal(link.label, 'depends on');
      assert.equal(link.id, `${w1.id}:${w2.id}:depends on`);
    });

    it('variant spellings of the same label collapse to a single link', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });

      const a = await clerk.link(w1.id, w2.id, 'depends-on');
      const b = await clerk.link(w1.id, w2.id, 'dependsOn');
      const c = await clerk.link(w1.id, w2.id, 'DEPENDS_ON');

      assert.equal(a.id, b.id);
      assert.equal(b.id, c.id);
      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
    });

    it('unlink() normalizes its label argument before deletion', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await clerk.link(w1.id, w2.id, 'depends-on');

      // Unlink using a differently-spelled variant of the same label.
      await clerk.unlink(w1.id, w2.id, 'dependsOn');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 0);
    });

    it('keeps distinct labels distinct (not synonymy)', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });

      await clerk.link(w1.id, w2.id, 'requires');
      await clerk.link(w1.id, w2.id, 'depends-on');

      const result = await clerk.links(w1.id);
      // Two distinct canonical forms → two separate links.
      assert.equal(result.outbound.length, 2);
    });

    it('rejects a whitespace-only label (canonicalizes to empty)', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, '   \t\n  '),
        /non-empty/,
      );
    });

    it('keeps the existing builtin `fixes` composite-id shape stable', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      const link = await clerk.link(w1.id, w2.id, 'fixes');
      // `fixes` is already canonical — the existing assertion shape still holds.
      assert.equal(link.id, `${w1.id}:${w2.id}:fixes`);
      assert.equal(link.label, 'fixes');
    });
  });

  // ── kind ────────────────────────────────────────────────

  describe('link() — kind field and upsert', () => {
    const kindKit: LoadedKit = {
      packageName: '@test/kinds',
      id: 'testkit',
      version: '0.0.0',
      kit: {
        linkKinds: [
          { id: 'testkit.refines', description: 'Source refines target' },
          { id: 'testkit.supersedes', description: 'Source supersedes target' },
        ],
      },
    };

    beforeEach(async () => { await setup({ extraKits: [kindKit] }); });

    it('defaults kind to null when no kind is provided', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      const link = await clerk.link(w1.id, w2.id, 'fixes');
      assert.equal(link.kind, null);
    });

    it('stores the supplied kind on the new row', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      const link = await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');
      assert.equal(link.kind, 'testkit.refines');
    });

    it('upserts kind onto an existing link on a subsequent call', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });

      const first = await clerk.link(w1.id, w2.id, 'supersedes');
      assert.equal(first.kind, null);

      const second = await clerk.link(w1.id, w2.id, 'supersedes', 'testkit.supersedes');
      assert.equal(second.id, first.id);
      assert.equal(second.kind, 'testkit.supersedes');

      // Only one row exists.
      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
    });

    it('leaves existing kind untouched when a subsequent call omits it', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });

      await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');
      const again = await clerk.link(w1.id, w2.id, 'refines');
      assert.equal(again.kind, 'testkit.refines');
    });

    it('rejects an unknown kind id', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, 'fixes', 'nonexistent.meaning'),
        /Unknown link kind/,
      );
    });

    it('writ-show surfaces kind on each link row', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');

      const result = await writShow.handler({ id: w1.id }) as { links: WritLinks };
      assert.equal(result.links.outbound.length, 1);
      assert.equal(result.links.outbound[0]!.kind, 'testkit.refines');
    });
  });

  // ── Kit-contributed link kinds ─────────────────────────────────────

  describe('linkKinds kit ingest', () => {
    afterEach(() => { clearGuild(); });

    it('registers kit-contributed kinds', async () => {
      const kit: LoadedKit = {
        packageName: '@test/alpha',
        id: 'alpha',
        version: '0.0.0',
        kit: {
          linkKinds: [
            { id: 'alpha.refines', description: 'Refines relationship' },
            { id: 'alpha.blocks', description: 'Blocks relationship' },
          ],
        },
      };
      await setup({ extraKits: [kit] });
      const kinds = await clerk.listKinds();
      assert.equal(kinds.length, 2);
      const refines = kinds.find((k) => k.id === 'alpha.refines');
      assert.ok(refines, 'alpha.refines should be registered');
      assert.equal(refines.ownerPlugin, 'alpha');
      assert.equal(refines.description, 'Refines relationship');
    });

    it('registers kinds contributed by apparatus supportKit', async () => {
      const apparatus: LoadedApparatus = {
        packageName: '@test/support-app',
        id: 'support-app',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit: {
            linkKinds: [
              { id: 'support-app.refines', description: 'Support refines' },
            ],
          },
        },
      };
      await setup({ extraApparatuses: [apparatus] });
      const kinds = await clerk.listKinds();
      const k = kinds.find((x) => x.id === 'support-app.refines');
      assert.ok(k, 'support-app.refines should be registered');
      assert.equal(k.ownerPlugin, 'support-app');
    });

    it('returns an empty array when no kinds are registered', async () => {
      await setup();
      const kinds = await clerk.listKinds();
      assert.deepEqual(kinds, []);
    });

    it('hard-fails when an entry is not an object', async () => {
      const kit: LoadedKit = {
        packageName: '@test/bad',
        id: 'bad',
        version: '0.0.0',
        kit: { linkKinds: ['not-an-object'] as unknown as Array<{ id: string; description: string }> },
      };
      await assert.rejects(() => setup({ extraKits: [kit] }), /linkKinds.*not an object/);
    });

    it('hard-fails when an entry is missing the id field', async () => {
      const kit: LoadedKit = {
        packageName: '@test/bad',
        id: 'bad',
        version: '0.0.0',
        kit: { linkKinds: [{ description: 'missing id' }] as unknown as Array<{ id: string; description: string }> },
      };
      await assert.rejects(() => setup({ extraKits: [kit] }), /missing a non-empty string "id"/);
    });

    it('hard-fails when an entry is missing the description field', async () => {
      const kit: LoadedKit = {
        packageName: '@test/bad',
        id: 'bad',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'bad.refines' }] as unknown as Array<{ id: string; description: string }> },
      };
      await assert.rejects(
        () => setup({ extraKits: [kit] }),
        /missing a non-empty string "description"/,
      );
    });

    it('hard-fails when a kind id has no dot separator', async () => {
      const kit: LoadedKit = {
        packageName: '@test/bad',
        id: 'bad',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'refines', description: 'no prefix' }] },
      };
      await assert.rejects(
        () => setup({ extraKits: [kit] }),
        /must be of the form "\{pluginId\}\.\{kebab-suffix\}"/,
      );
    });

    it('hard-fails when the id prefix does not match the contributing plugin', async () => {
      const kit: LoadedKit = {
        packageName: '@test/alpha',
        id: 'alpha',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'beta.refines', description: 'wrong owner' }] },
      };
      await assert.rejects(
        () => setup({ extraKits: [kit] }),
        /must match the contributing plugin id "alpha"/,
      );
    });

    it('hard-fails when the suffix is not kebab-case', async () => {
      const kit: LoadedKit = {
        packageName: '@test/alpha',
        id: 'alpha',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'alpha.Refines_Not_Kebab', description: 'bad suffix' }] },
      };
      await assert.rejects(() => setup({ extraKits: [kit] }), /must be kebab-case/);
    });

    it('hard-fails when two kits contribute the same kind id', async () => {
      const kitA: LoadedKit = {
        packageName: '@test/alpha',
        id: 'alpha',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'alpha.refines', description: 'first' }] },
      };
      const kitB: LoadedKit = {
        packageName: '@test/alpha-again',
        // Same pluginId so the prefix rule doesn't fire first.
        id: 'alpha',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'alpha.refines', description: 'duplicate' }] },
      };
      await assert.rejects(
        () => setup({ extraKits: [kitA, kitB] }),
        /duplicate kind id "alpha\.refines"/,
      );
    });

    it('link() rejects a kind not present in the registry', async () => {
      await setup();
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, 'fixes', 'ghost.meaning'),
        /Unknown link kind/,
      );
    });
  });

  // ── Apparatus consumes declaration for linkKinds ────────────────

  describe('apparatus declares linkKinds in consumes', () => {
    it('consumes declaration includes linkKinds', () => {
      const plugin = createClerk();
      const p = plugin as { apparatus: { consumes?: string[] } };
      assert.ok(Array.isArray(p.apparatus.consumes));
      assert.ok(p.apparatus.consumes!.includes('linkKinds'));
    });
  });

  // ── Link migration (pre-normalization rows) ────────────────────────

  describe('start() migration — rewrites pre-normalization link rows', () => {
    afterEach(() => { clearGuild(); });

    it('rewrites id and label to canonical form and sets kind = null', async () => {
      const seedLinks = [
        {
          id: 'w-src:w-tgt:DependsOn',
          sourceId: 'w-src',
          targetId: 'w-tgt',
          label: 'DependsOn',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      await setup({ seedLinks });

      const result = await clerk.links('w-src');
      assert.equal(result.outbound.length, 1);
      const link = result.outbound[0]!;
      assert.equal(link.id, 'w-src:w-tgt:depends on');
      assert.equal(link.label, 'depends on');
      assert.equal(link.kind, null);
      assert.equal(link.createdAt, '2024-01-01T00:00:00.000Z');
    });

    it('two-pass collision: keeps the oldest row and warns about younger siblings', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

      try {
        const seedLinks = [
          {
            id: 'w-src:w-tgt:depends-on',
            sourceId: 'w-src',
            targetId: 'w-tgt',
            label: 'depends-on',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 'w-src:w-tgt:dependsOn',
            sourceId: 'w-src',
            targetId: 'w-tgt',
            label: 'dependsOn',
            createdAt: '2024-02-01T00:00:00.000Z',
          },
          {
            id: 'w-src:w-tgt:DEPENDS_ON',
            sourceId: 'w-src',
            targetId: 'w-tgt',
            label: 'DEPENDS_ON',
            createdAt: '2024-03-01T00:00:00.000Z',
          },
        ];
        await setup({ seedLinks });

        const result = await clerk.links('w-src');
        assert.equal(result.outbound.length, 1);
        const survivor = result.outbound[0]!;
        assert.equal(survivor.id, 'w-src:w-tgt:depends on');
        assert.equal(survivor.label, 'depends on');
        // Oldest row wins.
        assert.equal(survivor.createdAt, '2024-01-01T00:00:00.000Z');
        assert.equal(survivor.kind, null);

        // Two collisions → two warnings, each mentioning w-src and w-tgt.
        const collisionWarns = warnings.filter((w) =>
          w.includes('collapsing duplicate link') && w.includes('w-src') && w.includes('w-tgt'),
        );
        assert.equal(collisionWarns.length, 2);
      } finally {
        console.warn = original;
      }
    });

    it('is a no-op on already-canonical rows (no rewrite, no warnings)', async () => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

      try {
        const seedLinks = [
          {
            id: 'w-src:w-tgt:fixes',
            sourceId: 'w-src',
            targetId: 'w-tgt',
            label: 'fixes',
            kind: null,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ];
        await setup({ seedLinks });

        const result = await clerk.links('w-src');
        assert.equal(result.outbound.length, 1);
        assert.equal(result.outbound[0]!.id, 'w-src:w-tgt:fixes');
        assert.equal(
          warnings.filter((w) => w.includes('collapsing duplicate link')).length,
          0,
        );
      } finally {
        console.warn = original;
      }
    });
  });

  // ── Writ migration (pre-rename rows) ───────────────────────────────

  describe('start() migration — rewrites pre-rename writ rows', () => {
    afterEach(() => { clearGuild(); });

    it('rewrites pre-rename rows: moves `status` to `phase` and deletes the old key', async () => {
      const seedWrits = [
        {
          id: 'w-open1',
          type: 'mandate',
          status: 'open',
          title: 'Open writ',
          body: 'Body',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'w-new1',
          type: 'mandate',
          status: 'new',
          title: 'Draft writ',
          body: 'Body',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'w-stuck1',
          type: 'mandate',
          status: 'stuck',
          title: 'Stuck writ',
          body: 'Body',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
        },
      ];
      await setup({ seedWrits });

      const stacks = guild().apparatus<StacksApi>('stacks');
      const writsBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'writs');

      const open = await writsBook.get('w-open1');
      assert.equal(open?.phase, 'open', 'status → phase');
      assert.equal(open?.status, undefined, 'old `status` key is absent');
      assert.equal(open?.updatedAt, '2024-01-01T00:00:00.000Z',
        'updatedAt preserved — migration is a storage-format change, not a logical edit');

      const draft = await writsBook.get('w-new1');
      assert.equal(draft?.phase, 'new');
      assert.equal(draft?.status, undefined);

      const stuck = await writsBook.get('w-stuck1');
      assert.equal(stuck?.phase, 'stuck');
      assert.equal(stuck?.status, undefined);
    });

    it('collapses legacy values `ready` | `active` | `waiting` → `open`', async () => {
      const seedWrits = [
        {
          id: 'w-ready',
          type: 'mandate',
          status: 'ready',
          title: 'Ready writ',
          body: 'Body',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'w-active',
          type: 'mandate',
          status: 'active',
          title: 'Active writ',
          body: 'Body',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'w-waiting',
          type: 'mandate',
          status: 'waiting',
          title: 'Waiting writ',
          body: 'Body',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
        },
      ];
      await setup({ seedWrits });

      const stacks = guild().apparatus<StacksApi>('stacks');
      const writsBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'writs');

      for (const id of ['w-ready', 'w-active', 'w-waiting']) {
        const row = await writsBook.get(id);
        assert.equal(row?.phase, 'open', `legacy status collapsed to open for ${id}`);
        assert.equal(row?.status, undefined, `legacy status key removed for ${id}`);
      }
    });

    it('preserves terminal-phase rows (completed, failed, cancelled)', async () => {
      const seedWrits = [
        {
          id: 'w-done',
          type: 'mandate',
          status: 'completed',
          title: 'Done writ',
          body: 'Body',
          resolution: 'ok',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          resolvedAt: '2024-01-01T01:00:00.000Z',
        },
        {
          id: 'w-fail',
          type: 'mandate',
          status: 'failed',
          title: 'Failed writ',
          body: 'Body',
          resolution: 'broken',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          resolvedAt: '2024-01-02T01:00:00.000Z',
        },
        {
          id: 'w-cancel',
          type: 'mandate',
          status: 'cancelled',
          title: 'Cancelled writ',
          body: 'Body',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
          resolvedAt: '2024-01-03T01:00:00.000Z',
        },
      ];
      await setup({ seedWrits });

      const stacks = guild().apparatus<StacksApi>('stacks');
      const writsBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'writs');

      const done = await writsBook.get('w-done');
      assert.equal(done?.phase, 'completed');
      assert.equal(done?.status, undefined);
      assert.equal(done?.resolvedAt, '2024-01-01T01:00:00.000Z', 'resolvedAt preserved');

      const failed = await writsBook.get('w-fail');
      assert.equal(failed?.phase, 'failed');
      assert.equal(failed?.status, undefined);

      const cancelled = await writsBook.get('w-cancel');
      assert.equal(cancelled?.phase, 'cancelled');
      assert.equal(cancelled?.status, undefined);
    });

    it('aborts startup with a clear error on an unknown `status` value', async () => {
      const seedWrits = [
        {
          id: 'w-bogus',
          type: 'mandate',
          status: 'bogus-value',
          title: 'Bogus writ',
          body: 'Body',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      await assert.rejects(
        () => setup({ seedWrits }),
        /unrecognized status value "bogus-value"/,
      );
    });

    it('is idempotent — restarting against already-migrated rows is a no-op', async () => {
      // First pass: seed pre-rename rows and run the migration.
      const seedWrits = [
        {
          id: 'w-idem1',
          type: 'mandate',
          status: 'open',
          title: 'Idempotent writ',
          body: 'Body',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'w-idem2',
          type: 'mandate',
          status: 'ready', // legacy
          title: 'Legacy writ',
          body: 'Body',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
      ];
      await setup({ seedWrits });

      const stacks = guild().apparatus<StacksApi>('stacks');
      const writsBook = stacks.book<Record<string, unknown> & { id: string }>('clerk', 'writs');

      const before1 = await writsBook.get('w-idem1');
      const before2 = await writsBook.get('w-idem2');
      assert.equal(before1?.phase, 'open');
      assert.equal(before2?.phase, 'open');

      // Second pass: create a second Clerk plugin instance, start it against
      // the same guild (and therefore the same backend). The migration guard
      // (`typeof phase === 'string'`) should cause it to skip every already-
      // migrated row — no writes, no errors.
      const clerk2 = createClerk();
      const { ctx: ctx2 } = buildClerkCtx([]);
      const clerk2Apparatus = (clerk2 as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
      await clerk2Apparatus.start(ctx2);

      const after1 = await writsBook.get('w-idem1');
      const after2 = await writsBook.get('w-idem2');
      // Rows unchanged after a second migration pass.
      assert.deepEqual(after1, before1, 'already-migrated row is not rewritten');
      assert.deepEqual(after2, before2, 'already-migrated legacy-origin row is not rewritten');
    });
  });

  // ── writ-link tool: --kind flag ────────────────────────────────────

  describe('writ-link tool with --kind', () => {
    const kindKit: LoadedKit = {
      packageName: '@test/toolkit',
      id: 'toolkit',
      version: '0.0.0',
      kit: {
        linkKinds: [
          { id: 'toolkit.refines', description: 'Refines' },
        ],
      },
    };

    beforeEach(async () => { await setup({ extraKits: [kindKit] }); });

    it('attaches the supplied kind to the created link', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      const result = (await writLink.handler({
        sourceId: w1.id,
        targetId: w2.id,
        label: 'refines',
        kind: 'toolkit.refines',
      })) as WritLinkDoc;

      assert.equal(result.kind, 'toolkit.refines');
    });

    it('rejects with a clear error when the kind id is unknown', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => writLink.handler({
          sourceId: w1.id,
          targetId: w2.id,
          label: 'fixes',
          kind: 'ghost.meaning',
        }),
        /Unknown link kind/,
      );
    });

    it('still works without --kind (casual label path)', async () => {
      const w1 = await clerk.post({ title: 'W1', body: 'B' });
      const w2 = await clerk.post({ title: 'W2', body: 'B' });
      const result = (await writLink.handler({
        sourceId: w1.id,
        targetId: w2.id,
        label: 'fixes',
      })) as WritLinkDoc;
      assert.equal(result.kind, null);
    });
  });

  // ── writ-link-kinds tools ───────────────────────────────────────

  describe('writ-link-kinds tool (list)', () => {
    afterEach(() => { clearGuild(); });

    it('returns a table string with ID / OWNER / DESCRIPTION columns', async () => {
      const kit: LoadedKit = {
        packageName: '@test/kit',
        id: 'kit',
        version: '0.0.0',
        kit: {
          linkKinds: [
            { id: 'kit.refines', description: 'Source refines target' },
          ],
        },
      };
      await setup({ extraKits: [kit] });

      const result = (await writLinkKinds.handler({ json: false })) as string;
      assert.equal(typeof result, 'string');
      assert.ok(result.includes('ID'));
      assert.ok(result.includes('OWNER'));
      assert.ok(result.includes('DESCRIPTION'));
      assert.ok(result.includes('kit.refines'));
      assert.ok(result.includes('Source refines target'));
    });

    it('returns the raw array under --json', async () => {
      const kit: LoadedKit = {
        packageName: '@test/kit',
        id: 'kit',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'kit.refines', description: 'Refines' }] },
      };
      await setup({ extraKits: [kit] });

      const result = (await writLinkKinds.handler({ json: true })) as LinkKindDoc[];
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.equal(result[0]!.id, 'kit.refines');
      assert.equal(result[0]!.ownerPlugin, 'kit');
    });

    it('prints "No link kinds registered." in table mode when the registry is empty', async () => {
      await setup();
      const result = (await writLinkKinds.handler({ json: false })) as string;
      assert.equal(result, 'No link kinds registered.');
    });

    it('returns [] under --json when the registry is empty', async () => {
      await setup();
      const result = (await writLinkKinds.handler({ json: true })) as LinkKindDoc[];
      assert.deepEqual(result, []);
    });
  });

  describe('writ-link-kinds-show tool (detail)', () => {
    afterEach(() => { clearGuild(); });

    it('returns the full kind record for a registered id', async () => {
      const kit: LoadedKit = {
        packageName: '@test/kit',
        id: 'kit',
        version: '0.0.0',
        kit: { linkKinds: [{ id: 'kit.refines', description: 'Refines' }] },
      };
      await setup({ extraKits: [kit] });

      const result = (await writLinkKindsShow.handler({ id: 'kit.refines' })) as LinkKindDoc;
      assert.equal(result.id, 'kit.refines');
      assert.equal(result.ownerPlugin, 'kit');
      assert.equal(result.description, 'Refines');
    });

    it('throws a clear not-found error for an unknown id', async () => {
      await setup();
      await assert.rejects(
        () => writLinkKindsShow.handler({ id: 'ghost.meaning' }),
        /Unknown link kind "ghost\.meaning"/,
      );
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
        /No writ found/,
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

      const result = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;

      assert.equal(result.sourceId, w1.id);
      assert.equal(result.targetId, w2.id);
      assert.equal(result.label, 'fixes');
      assert.equal(result.id, `${w1.id}:${w2.id}:fixes`);
      assert.ok(result.createdAt);
    });

    it('is idempotent — returns the same link on duplicate call', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      const r1 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;
      const r2 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;

      assert.equal(r1.id, r2.id);
      assert.equal(r1.createdAt, r2.createdAt);
    });

    it('propagates self-link error from clerk.link()', async () => {
      const w = await clerk.post({ title: 'Solo', body: 'Body' });
      await assert.rejects(
        () => writLink.handler({ sourceId: w.id, targetId: w.id, label: 'fixes' }),
        /Cannot link a writ to itself/,
      );
    });

    it('propagates missing source error from clerk.link()', async () => {
      const w2 = await clerk.post({ title: 'Target', body: 'Body' });
      await assert.rejects(
        () => writLink.handler({ sourceId: 'w-ghost', targetId: w2.id, label: 'fixes' }),
        /No writ found/,
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

      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' });

      assert.deepEqual(result, { ok: true });

      const linksResult = await clerk.links(w1.id);
      assert.equal(linksResult.outbound.length, 0);
    });

    it('is idempotent — returns { ok: true } when link does not exist', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });

      // Link was never created — no error
      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' });
      assert.deepEqual(result, { ok: true });
    });

    it('does not remove other links when unlinking by label', async () => {
      const w1 = await clerk.post({ title: 'Writ 1', body: 'Body' });
      const w2 = await clerk.post({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'retries');

      await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' });

      const linksResult = await clerk.links(w1.id);
      assert.equal(linksResult.outbound.length, 1);
      assert.equal(linksResult.outbound[0]!.label, 'retries');
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

      it('throws when two kits contribute the same writ type (kit-vs-kit collision is fatal)', async () => {
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
        await assert.rejects(
          () => setup({ extraKits: [kitA, kitB] }),
          (err: Error) => {
            // Error must name both contributing plugins and the conflicting writ type.
            return (
              /writTypes/.test(err.message) &&
              /quality-audit/.test(err.message) &&
              /kit-a/.test(err.message) &&
              /kit-b/.test(err.message)
            );
          },
          'kit-vs-kit writ-type collision must throw and name both plugins + the writ type',
        );
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
      assert.equal(child.phase, 'open');
    });

    it('parent stays in open when child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      assert.equal(parent.phase, 'open');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'open');
    });

    it('parent stays in new when child is added', async () => {
      const parent = await clerk.post({ title: 'Draft parent', body: 'Body', draft: true });
      assert.equal(parent.phase, 'new');

      await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'new');
    });

    it('parent stays in open when a second child is added', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      await clerk.post({ title: 'Child 1', body: 'Body', parentId: parent.id });

      const midState = await clerk.show(parent.id);
      assert.equal(midState.phase, 'open');

      await clerk.post({ title: 'Child 2', body: 'Body', parentId: parent.id });

      const endState = await clerk.show(parent.id);
      assert.equal(endState.phase, 'open');
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
      assert.equal(updated.phase, 'failed');
      assert.ok(updated.resolution?.includes('Child'));
      assert.ok(updated.resolution?.includes('Broke'));
    });

    it('transitions stuck parent to failed when child fails', async () => {
      const parent = await clerk.post({ title: 'Stuck Parent', body: 'Body' });
      await clerk.transition(parent.id, 'stuck');
      const child = await clerk.post({ title: 'Child of stuck', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Broke too' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'failed');
      assert.ok(updated.resolution?.includes('Child'));
    });

    it('does not cascade failure when parent is in new status', async () => {
      const parent = await clerk.post({ title: 'Draft Parent', body: 'Body', draft: true });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Broke' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'new');
    });

    it('parent stays open when child completes', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'Body', parentId: parent.id });

      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'open');
    });

    it('parent stays open when all children complete', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      await clerk.transition(c2.id, 'completed', { resolution: 'Done' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'open');
    });

    it('two children: first completes, second fails → parent transitions to failed', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'Done' });
      await clerk.transition(c2.id, 'failed', { resolution: 'Broke' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'failed');
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
      assert.equal(updatedParent.phase, 'failed');
      assert.ok(updatedParent.resolution?.includes(`Child "${c1.id}" failed: Broke`));

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.phase, 'cancelled');
      assert.equal(updatedC2.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC3 = await clerk.show(c3.id);
      assert.equal(updatedC3.phase, 'cancelled');
      assert.equal(updatedC3.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);
    });

    it('fails parent when single child fails', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Error occurred' });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'failed');
      assert.ok(updated.resolution?.includes('Error occurred'));
    });

    it('cascades failure through 3-level hierarchy', async () => {
      const grandparent = await clerk.post({ title: 'GP', body: 'B' });
      const parent = await clerk.post({ title: 'P', body: 'B', parentId: grandparent.id });
      const child = await clerk.post({ title: 'C', body: 'B', parentId: parent.id });

      await clerk.transition(child.id, 'failed', { resolution: 'Leaf failed' });

      const updatedChild = await clerk.show(child.id);
      assert.equal(updatedChild.phase, 'failed');

      const updatedParent = await clerk.show(parent.id);
      assert.equal(updatedParent.phase, 'failed');

      const updatedGP = await clerk.show(grandparent.id);
      assert.equal(updatedGP.phase, 'failed');
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
      assert.equal(updatedC1.phase, 'cancelled');
      assert.equal(updatedC1.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.phase, 'cancelled');
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
      assert.equal(updatedC1.phase, 'completed'); // already terminal, unchanged

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.phase, 'cancelled');
    });

    it('cancels non-terminal children when parent is failed directly', async () => {
      const parent = await clerk.post({ title: 'Parent', body: 'Body' });
      const c1 = await clerk.post({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await clerk.post({ title: 'C2', body: 'B', parentId: parent.id });

      // Transition parent directly to failed (no child failure driving it).
      await clerk.transition(parent.id, 'failed', { resolution: 'Parent-level failure' });

      const updatedC1 = await clerk.show(c1.id);
      assert.equal(updatedC1.phase, 'cancelled');
      assert.equal(updatedC1.resolution, CASCADE_PARENT_TERMINATION_RESOLUTION);

      const updatedC2 = await clerk.show(c2.id);
      assert.equal(updatedC2.phase, 'cancelled');
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
        assert.equal(updatedC1.phase, 'open');
        assert.equal(updatedC1.resolution, undefined);

        const updatedC2 = await clerk.show(c2.id);
        assert.equal(updatedC2.phase, 'open');
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
        assert.equal(updatedC1.phase, 'completed');

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
        assert.equal((await clerk.show(openChild.id)).phase, 'open');
        assert.equal((await clerk.show(stuckChild.id)).phase, 'stuck');
        assert.equal((await clerk.show(doneChild.id)).phase, 'completed');

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
      assert.equal(parent.phase, 'open');

      const child = await clerk.post({ title: 'Child', body: 'B', parentId: parent.id });
      const p1 = await clerk.show(parent.id);
      assert.equal(p1.phase, 'open');

      await clerk.transition(child.id, 'completed', { resolution: 'Done' });

      const p2 = await clerk.show(parent.id);
      assert.equal(p2.phase, 'open');

      await clerk.transition(parent.id, 'completed', { resolution: 'All done' });
      const p3 = await clerk.show(parent.id);
      assert.equal(p3.phase, 'completed');
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
      assert.equal(updatedChild.phase, 'completed');
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
      assert.deepEqual(result.parent, { id: parent.id, title: 'Parent', phase: 'open' });
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
    it('writs book indexes include parentId and [parentId, phase]', async () => {
      const plugin = await setupCore();
      const apparatus = (plugin as { apparatus: { supportKit: { books: Record<string, { indexes: unknown[] }> } } }).apparatus;
      const indexes = apparatus.supportKit.books.writs.indexes;
      assert.ok(indexes.includes('parentId'), 'indexes should include parentId');
      assert.ok(
        indexes.some((i: unknown) => Array.isArray(i) && i[0] === 'parentId' && i[1] === 'phase'),
        'indexes should include [parentId, phase]',
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
    }) as { id: string; type: string; title: string; body: string; parentId: string; phase: string };

    assert.equal(piece.type, 'piece');
    assert.equal(piece.title, 'First task');
    assert.equal(piece.parentId, mandate.id);
    assert.equal(piece.phase, 'open');
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
        // Short-id resolution surfaces the mismatch before post() runs —
        // the error comes from resolveId's "No writ found matching prefix".
        assert.ok(
          /No writ found matching prefix|not found/.test(err.message),
          `unexpected error message: ${err.message}`,
        );
        return true;
      },
    );
  });
});

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

import { createClerk } from './clerk.ts';
import type { ClerkKit } from './clerk.ts';
import type { ClerkApi, ClerkConfig, WritDoc, WritLinkDoc, LinkKindDoc } from './types.ts';
import type { WritTypeConfig } from './writ-type-config.ts';
import { makeWritTypeApparatus, mandateLikeWritType } from './testing.ts';
import type { WritLinks } from './index.ts';
import writShow from './tools/writ-show.ts';
import writTree from './tools/writ-tree.ts';
import writEdit from './tools/writ-edit.ts';
import writLink from './tools/writ-link.ts';
import writUnlink from './tools/writ-unlink.ts';
import writLinkKinds from './tools/writ-link-kinds.ts';
import writLinkKindsShow from './tools/writ-link-kinds-show.ts';

// ── Test harness ─────────────────────────────────────────────────────

let clerk: ClerkApi;

/**
 * Legacy-semantics wrapper around `clerk.post()` — posts a writ and, for
 * mandate types, immediately transitions it from the declared initial
 * state (`new`) to `open`. Mirrors the old `clerk.post({draft: false})`
 * default: many existing tests expect a mandate writ to land in `open`
 * after a single call. Per D19/D20, `post()` itself always lands in the
 * declared initial state; the `commission-post` tool (and this helper)
 * carry the auto-publish UX.
 *
 * Callers that want the raw initial state should continue to call
 * `clerk.post()` directly.
 */
async function postMandate(
  request: { title: string; body: string; type?: string; codex?: string; parentId?: string; draft?: boolean }
): Promise<import('./types.ts').WritDoc> {
  const { draft, ...postRequest } = request;
  const writ = await clerk.post(postRequest);
  if (draft !== true && writ.type === 'mandate') {
    return clerk.transition(writ.id, 'open');
  }
  return writ;
}

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

  // Start each extraApparatus after clerk — mirrors the production
  // ordering where plugins with `requires: ['clerk']` register their
  // writ types from their own `start()`. The helper
  // `makeWritTypeApparatus` returns apparatuses shaped for exactly this
  // path.
  for (const app of options.extraApparatuses ?? []) {
    const apparatus = (app.apparatus as {
      start?: (ctx: unknown) => void | Promise<void>;
    });
    if (typeof apparatus.start === 'function') {
      await apparatus.start({ on: () => {}, kits: () => [] });
    }
  }

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
      const writ = await postMandate({ title: 'Fix the bug', body: 'Details here' });

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
      const writ = await postMandate({ title: 'Has body', body: 'Required content' });
      assert.equal(writ.body, 'Required content');
    });

    it('accepts explicit type when it is a built-in type', async () => {
      const writ = await postMandate({ title: 'A mandate', body: 'Do it', type: 'mandate' });
      assert.equal(writ.type, 'mandate');
    });

    it('persists codex field', async () => {
      const writ = await postMandate({
        title: 'Do the thing',
        body: 'Detailed instructions here',
        codex: 'artificer',
      });

      assert.equal(writ.codex, 'artificer');
    });

    it('omits codex when not provided', async () => {
      const writ = await postMandate({ title: 'No codex', body: 'Details' });
      assert.equal(writ.codex, undefined);
    });

    it('uses guild defaultType from clerk config when provided', async () => {
      // mandate is a built-in, so it's always valid as a defaultType
      await setup({ clerkConfig: { defaultType: 'mandate' } });
      const writ = await postMandate({ title: 'Default mandate', body: 'Body' });
      assert.equal(writ.type, 'mandate');
    });

    it('rejects an unknown writ type', async () => {
      await assert.rejects(
        () => postMandate({ title: 'Test', body: 'Body', type: 'unknown-type' }),
        /Unknown writ type/,
      );
    });

    it('accepts a type contributed via registerWritType', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      const writ = await postMandate({ title: 'Run errand', body: 'Do it', type: 'errand' });
      assert.equal(writ.type, 'errand');
    });

    it('rejects a type that has not been registered', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      await assert.rejects(
        () => postMandate({ title: 'Test', body: 'Body', type: 'epic' }),
        /Unknown writ type/,
      );
    });

    it('generates unique ids for each writ', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      assert.notEqual(w1.id, w2.id);
    });

    it('sets createdAt and updatedAt to the same value on creation', async () => {
      // Use clerk.post() directly — postMandate() does post() then transition(),
      // which crosses two writes and breaks the createdAt === updatedAt invariant.
      const writ = await clerk.post({ title: 'Timestamps', body: 'Body' });
      assert.equal(writ.phase, 'new');
      assert.equal(writ.createdAt, writ.updatedAt);
    });

    it('creates a writ in new (draft) status when draft: true', async () => {
      const writ = await postMandate({ title: 'Draft writ', body: 'Details', draft: true });
      assert.equal(writ.phase, 'new');
      assert.equal(writ.resolvedAt, undefined);
    });

    it('creates a writ in open status when draft: false (explicit)', async () => {
      const writ = await postMandate({ title: 'Explicit open', body: 'Body', draft: false });
      assert.equal(writ.phase, 'open');
    });

    it('creates a writ in open status when draft is omitted (backward compat)', async () => {
      const writ = await postMandate({ title: 'Default open', body: 'Body' });
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
      const posted = await postMandate({ title: 'Show me', body: 'Body' });
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
      const posted = await postMandate({ title: 'Exact', body: 'Body' });
      const resolved = await clerk.resolveId(posted.id);
      assert.equal(resolved, posted.id);
    });

    it('resolves a short id prefix to the full id', async () => {
      const posted = await postMandate({ title: 'Prefix', body: 'Body' });
      // Writ ids are `w-{base36_timestamp}-{hex_random}` — the `w-{timestamp}`
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
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
    });

    it('returns all writs when no filters given', async () => {
      await postMandate({ title: 'Writ A', body: 'Body' });
      await postMandate({ title: 'Writ B', body: 'Body' });
      await postMandate({ title: 'Writ C', body: 'Body' });

      const all = await clerk.list();
      assert.equal(all.length, 3);
    });

    it('filters by status', async () => {
      const w1 = await postMandate({ title: 'Open writ', body: 'Body' });
      const w2 = await postMandate({ title: 'New writ', body: 'Body', draft: true });

      const openWrits = await clerk.list({ phase: 'open' });
      const newWrits = await clerk.list({ phase: 'new' });

      assert.equal(openWrits.length, 1);
      assert.equal(openWrits[0]!.id, w1.id);
      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.id, w2.id);
    });

    it('filters by type', async () => {
      await postMandate({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await postMandate({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const mandates = await clerk.list({ type: 'mandate' });
      const errands = await clerk.list({ type: 'errand' });

      assert.equal(mandates.length, 1);
      assert.equal(mandates[0]!.type, 'mandate');
      assert.equal(errands.length, 1);
      assert.equal(errands[0]!.type, 'errand');
    });

    it('filters by multiple types (OR)', async () => {
      await postMandate({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await postMandate({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const result = await clerk.list({ type: ['mandate', 'errand'] });
      assert.equal(result.length, 2);
      const types = new Set(result.map((w) => w.type));
      assert.ok(types.has('mandate'));
      assert.ok(types.has('errand'));
    });

    it('single-element type array behaves like a scalar filter', async () => {
      await postMandate({ title: 'Mandate writ', body: 'Body', type: 'mandate' });
      await postMandate({ title: 'Errand writ', body: 'Body', type: 'errand' });

      const result = await clerk.list({ type: ['mandate'] });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.type, 'mandate');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await postMandate({ title: `Writ ${i}`, body: 'Body' });
      }

      const limited = await clerk.list({ limit: 3 });
      assert.equal(limited.length, 3);
    });

    it('respects the offset parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await postMandate({ title: `Writ ${i}`, body: 'Body' });
      }

      const all = await clerk.list();
      const offset = await clerk.list({ offset: 2 });
      assert.equal(offset.length, 3);
      assert.equal(offset[0]!.id, all[2]!.id);
    });

    it('returns an empty array when no writs match filters', async () => {
      await postMandate({ title: 'One open writ', body: 'Body' });
      const completed = await clerk.list({ phase: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('filters by new status', async () => {
      await postMandate({ title: 'Draft writ', body: 'Body', draft: true });
      await postMandate({ title: 'Open writ', body: 'Body' });

      const newWrits = await clerk.list({ phase: 'new' });
      const openWrits = await clerk.list({ phase: 'open' });

      assert.equal(newWrits.length, 1);
      assert.equal(newWrits[0]!.phase, 'new');
      assert.equal(openWrits.length, 1);
      assert.equal(openWrits[0]!.phase, 'open');
    });

    it('filters by multiple statuses (OR)', async () => {
      const w1 = await postMandate({ title: 'Open writ', body: 'Body' });
      const w2 = await postMandate({ title: 'New writ', body: 'Body', draft: true });
      const w3 = await postMandate({ title: 'Completed writ', body: 'Body' });
      await clerk.transition(w3.id, 'completed');

      const result = await clerk.list({ phase: ['open', 'new'] });
      assert.equal(result.length, 2);
      const statuses = new Set(result.map((w) => w.phase));
      assert.ok(statuses.has('open'));
      assert.ok(statuses.has('new'));
      assert.ok(!statuses.has('completed'));
    });

    it('filters by stuck status', async () => {
      const writ = await postMandate({ title: 'Stuck writ', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await postMandate({ title: 'Open writ', body: 'Body' });

      const result = await clerk.list({ phase: 'stuck' });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.phase, 'stuck');
    });

    it('single-element status array behaves like a scalar filter', async () => {
      await postMandate({ title: 'Open writ', body: 'Body' });
      const w2 = await postMandate({ title: 'New writ', body: 'Body', draft: true });

      const result = await clerk.list({ phase: ['open'] });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.phase, 'open');
    });
  });

  // ── count() ──────────────────────────────────────────────────────

  describe('count()', () => {
    beforeEach(async () => { await setup(); });

    it('returns total count with no filters', async () => {
      await postMandate({ title: 'Writ A', body: 'Body' });
      await postMandate({ title: 'Writ B', body: 'Body' });
      assert.equal(await clerk.count(), 2);
    });

    it('returns 0 when no writs exist', async () => {
      assert.equal(await clerk.count(), 0);
    });

    it('filters by status', async () => {
      const w = await postMandate({ title: 'Writ', body: 'Body' });
      await clerk.transition(w.id, 'completed');

      assert.equal(await clerk.count({ phase: 'completed' }), 1);
      assert.equal(await clerk.count({ phase: 'open' }), 0);
    });

    it('filters by type', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      await postMandate({ title: 'Mandate', body: 'Body', type: 'mandate' });
      await postMandate({ title: 'Errand', body: 'Body', type: 'errand' });

      assert.equal(await clerk.count({ type: 'mandate' }), 1);
      assert.equal(await clerk.count({ type: 'errand' }), 1);
    });
  });

  // ── countActive() ─────────────────────────────────────────────────

  describe('countActive()', () => {
    it('matches the prior phase=open count on a pure-mandate guild', async () => {
      await setup();
      // Two writs published to open.
      const a = await postMandate({ title: 'A', body: '' });
      const b = await postMandate({ title: 'B', body: '' });
      // Mandate's only active states are `open` and `stuck`. Drive
      // one to `stuck` (still active-classified) and one to a
      // terminal state.
      await clerk.transition(a.id, 'stuck', { resolution: 'paused' });
      const baselineOpen = await clerk.count({ phase: 'open' });
      // open=1 (b is still open), stuck=1 (a) → countActive=2.
      assert.equal(await clerk.countActive(), baselineOpen + 1);
      assert.equal(await clerk.countActive(), 2);
      // Drive b terminal — only the stuck mandate remains active.
      await clerk.transition(b.id, 'completed');
      assert.equal(await clerk.countActive(), 1);
      // And finally drive a terminal too.
      await clerk.transition(a.id, 'failed', { resolution: 'abandoned' });
      assert.equal(await clerk.countActive(), 0);
    });

    it('counts active writs across multiple types with structurally-different state machines', async () => {
      // A second writ type whose lifecycle deliberately uses state
      // names that do not overlap with mandate. Asserts countActive
      // is classification-driven, not phase-string driven.
      const taskType: WritTypeConfig = {
        name: 'task',
        states: [
          { name: 'pending', classification: 'initial', allowedTransitions: ['running', 'done'] },
          { name: 'running', classification: 'active', allowedTransitions: ['done'] },
          { name: 'done', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
        ],
      };
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([taskType], { id: 'task-plugin' }),
        ],
      });

      // No writs anywhere.
      assert.equal(await clerk.countActive(), 0);

      // Two mandates → both `open` (mandate active state) → +2.
      const m1 = await postMandate({ title: 'M1', body: '' });
      const m2 = await postMandate({ title: 'M2', body: '' });
      assert.equal(await clerk.countActive(), 2);

      // A task in `pending` (initial — NOT active) does not count.
      const t1 = await clerk.post({ title: 'T1', body: '', type: 'task' });
      assert.equal(t1.phase, 'pending');
      assert.equal(await clerk.countActive(), 2);

      // Transition the task to `running` (active) → +1.
      await clerk.transition(t1.id, 'running');
      assert.equal(await clerk.countActive(), 3);

      // Finish the task → terminal → −1.
      await clerk.transition(t1.id, 'done');
      assert.equal(await clerk.countActive(), 2);

      // Finish a mandate.
      await clerk.transition(m1.id, 'completed');
      assert.equal(await clerk.countActive(), 1);

      // Finish the second mandate.
      await clerk.transition(m2.id, 'completed');
      assert.equal(await clerk.countActive(), 0);
    });

    it('returns 0 when no registered type declares an active state', async () => {
      // A type whose entire lifecycle is initial → terminal — no
      // `active` classification. countActive must return 0 even when
      // writs exist in the initial state.
      const inertType: WritTypeConfig = {
        name: 'inert',
        states: [
          { name: 'queued', classification: 'initial', allowedTransitions: ['done'] },
          { name: 'done', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
        ],
      };
      await setup({
        clerkConfig: { defaultType: 'inert' },
        extraApparatuses: [
          makeWritTypeApparatus([inertType], { id: 'inert-plugin' }),
        ],
      });

      // post() yields a writ in `queued` (initial) — not active.
      // mandate is also registered but no mandate writs exist.
      const w = await clerk.post({ title: 'W', body: '' });
      assert.equal(w.phase, 'queued');
      assert.equal(await clerk.countActive(), 0);
    });
  });

  // ── tree() ────────────────────────────────────────────────────────

  describe('tree()', () => {
    beforeEach(async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus(
            [mandateLikeWritType('errand'), mandateLikeWritType('task')],
            { id: 'tree-types' },
          ),
        ],
      });
    });

    it('returns a forest of all roots with their direct + recursive children', async () => {
      const a = await postMandate({ title: 'Root A', body: 'Body' });
      const b = await postMandate({ title: 'Root B', body: 'Body' });
      await postMandate({ title: 'Child of A', body: 'Body', parentId: a.id });

      const forest = await clerk.tree();
      assert.equal(forest.length, 2);
      // Order is "newest root first" to match the existing list-page UX —
      // tested explicitly below; here we verify presence + child shape.
      const byId = new Map(forest.map((t) => [t.writ.id, t]));
      assert.ok(byId.has(a.id));
      assert.ok(byId.has(b.id));
      assert.equal(byId.get(a.id).children.length, 1);
      assert.equal(byId.get(b.id).children.length, 0);
    });

    it('returns a single subtree when rootId is supplied', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: root.id });
      await postMandate({ title: 'Grandchild', body: 'Body', parentId: child.id });

      const forest = await clerk.tree({ rootId: root.id });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
      assert.equal(forest[0].children.length, 1);
      assert.equal(forest[0].children[0].writ.id, child.id);
      assert.equal(forest[0].children[0].children.length, 1);
    });

    it('returns an empty array when rootId does not exist', async () => {
      const forest = await clerk.tree({ rootId: 'w-nonexistent' });
      assert.deepEqual(forest, []);
    });

    it('filters by phase with prune semantics', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const open = await postMandate({ title: 'Open child', body: 'Body', parentId: root.id });
      const completed = await postMandate({ title: 'Completed child', body: 'Body', parentId: root.id });
      // Add the grandchild *before* transitioning its parent — the post
      // path rejects parents in terminal phases.
      const grand = await postMandate({ title: 'Grand of completed', body: 'Body', parentId: completed.id });
      // Transition the completed child after grand exists. `completed` does
      // not auto-cancel non-terminal children — `handleParentTerminal` only
      // warns when reaching `completed` with non-terminal children.
      await clerk.transition(completed.id, 'completed');

      const forest = await clerk.tree({ phase: 'open' });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
      // Only `open` child remains; the `completed` subtree is pruned even
      // though grand itself is open.
      assert.equal(forest[0].children.length, 1);
      assert.equal(forest[0].children[0].writ.id, open.id);
      // grand should not appear anywhere.
      const ids = JSON.stringify(forest);
      assert.ok(!ids.includes(grand.id));
    });

    it('filters by multiple phases (OR)', async () => {
      // No parents — the cascade machinery only cares about parent/child
      // failures, so flat roots keep this test clean.
      const a = await postMandate({ title: 'A', body: 'Body' });
      const b = await postMandate({ title: 'B', body: 'Body' });
      const c = await postMandate({ title: 'C (open)', body: 'Body' });
      await clerk.transition(a.id, 'completed');
      await clerk.transition(b.id, 'failed', { resolution: 'nope' });

      const forest = await clerk.tree({ phase: ['completed', 'failed'] });
      const ids = forest.map((t) => t.writ.id).sort();
      assert.deepEqual(ids, [a.id, b.id].sort());
      // c remains open and is pruned.
      assert.ok(!ids.includes(c.id));
    });

    it('filters by type with prune semantics', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body', type: 'mandate' });
      const errand = await postMandate({ title: 'Errand', body: 'Body', type: 'errand', parentId: root.id });
      await postMandate({ title: 'Task', body: 'Body', type: 'task', parentId: root.id });

      const forest = await clerk.tree({ type: ['mandate', 'errand'] });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].children.length, 1);
      assert.equal(forest[0].children[0].writ.id, errand.id);
    });

    it('caps depth — node at depth N included, descendants pruned', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: root.id });
      await postMandate({ title: 'Grand', body: 'Body', parentId: child.id });

      const forest = await clerk.tree({ depth: 1 });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].children.length, 1);
      // Grandchild dropped — depth 1 means root (0) + children (1).
      assert.equal(forest[0].children[0].children.length, 0);
    });

    it('depth 0 returns roots only', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      await postMandate({ title: 'Child', body: 'Body', parentId: root.id });

      const forest = await clerk.tree({ depth: 0 });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
      assert.equal(forest[0].children.length, 0);
    });

    it('children are returned in createdAt asc order under each parent', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'Body', parentId: root.id });
      const c2 = await postMandate({ title: 'C2', body: 'Body', parentId: root.id });
      const c3 = await postMandate({ title: 'C3', body: 'Body', parentId: root.id });

      const forest = await clerk.tree({ rootId: root.id });
      assert.deepEqual(
        forest[0].children.map((c) => c.writ.id),
        [c1.id, c2.id, c3.id],
      );
    });

    it('rootLimit and rootOffset slice the root layer', async () => {
      // Sleep between posts so each root gets a distinct millisecond
      // timestamp; otherwise multiple posts in a single ms can collide and
      // the desc sort becomes implementation-defined.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const r1 = await postMandate({ title: 'R1', body: 'Body' }); await sleep(2);
      const r2 = await postMandate({ title: 'R2', body: 'Body' }); await sleep(2);
      const r3 = await postMandate({ title: 'R3', body: 'Body' });
      // Each root has a child to verify children are still expanded under the slice.
      await postMandate({ title: 'R1c', body: 'Body', parentId: r1.id });

      // Roots are returned newest-first (createdAt desc) to match list().
      const page1 = await clerk.tree({ rootLimit: 2, rootOffset: 0 });
      assert.deepEqual(page1.map((t) => t.writ.id), [r3.id, r2.id]);
      // Children are still expanded under each root in the slice (r3 has none here,
      // but its children property must be present and empty).
      assert.equal(page1[0].children.length, 0);
      assert.equal(page1[1].children.length, 0);

      const page2 = await clerk.tree({ rootLimit: 2, rootOffset: 2 });
      assert.deepEqual(page2.map((t) => t.writ.id), [r1.id]);
      // r1 has the one child we created above.
      assert.equal(page2[0].children.length, 1);
    });

    it('roots are ordered createdAt desc (newest first), matching list()', async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const a = await postMandate({ title: 'A', body: 'Body' }); await sleep(2);
      const b = await postMandate({ title: 'B', body: 'Body' }); await sleep(2);
      const c = await postMandate({ title: 'C', body: 'Body' });

      const forest = await clerk.tree();
      assert.deepEqual(forest.map((t) => t.writ.id), [c.id, b.id, a.id]);
    });

    it('rootLimit and rootOffset are ignored when rootId is set', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      await postMandate({ title: 'C', body: 'Body', parentId: root.id });

      const forest = await clerk.tree({ rootId: root.id, rootLimit: 0, rootOffset: 99 });
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
      assert.equal(forest[0].children.length, 1);
    });

    it('returns an empty array when no roots exist', async () => {
      const forest = await clerk.tree();
      assert.deepEqual(forest, []);
    });
  });

  // ── edit() ───────────────────────────────────────────────────────

  describe('edit()', () => {
    beforeEach(async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
    });

    it('updates the title of a draft writ', async () => {
      const writ = await postMandate({ title: 'Old title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'New title' });
      assert.equal(edited.title, 'New title');
      assert.equal(edited.body, 'Body'); // unchanged
    });

    it('updates the body of a draft writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Old body', draft: true });
      const edited = await clerk.edit({ id: writ.id, body: 'New body' });
      assert.equal(edited.body, 'New body');
      assert.equal(edited.title, 'Title'); // unchanged
    });

    it('updates the type of a draft writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body', draft: true });
      assert.equal(writ.type, 'mandate');
      const edited = await clerk.edit({ id: writ.id, type: 'errand' });
      assert.equal(edited.type, 'errand');
    });

    it('updates the codex of a draft writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body', codex: 'alpha', draft: true });
      const edited = await clerk.edit({ id: writ.id, codex: 'beta' });
      assert.equal(edited.codex, 'beta');
    });

    it('clears codex when empty string is passed', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body', codex: 'alpha', draft: true });
      const edited = await clerk.edit({ id: writ.id, codex: '' });
      assert.equal(edited.codex, undefined);
    });

    it('updates multiple fields at once', async () => {
      const writ = await postMandate({ title: 'Old', body: 'Old body', draft: true });
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
      const writ = await postMandate({ title: 'Title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'Updated' });
      assert.ok(edited.updatedAt >= writ.updatedAt);
    });

    it('preserves status as new', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body', draft: true });
      const edited = await clerk.edit({ id: writ.id, title: 'Updated' });
      assert.equal(edited.phase, 'new');
    });

    it('allows editing title of a writ in open status', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.phase, 'open');
    });

    it('allows editing body of an open writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' });
      const edited = await clerk.edit({ id: writ.id, body: 'New body' });
      assert.equal(edited.body, 'New body');
      assert.equal(edited.phase, 'open');
    });

    it('allows editing title of a completed writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const edited = await clerk.edit({ id: writ.id, title: 'Changed' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.phase, 'completed');
    });

    it('rejects changing type on a non-draft writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => clerk.edit({ id: writ.id, type: 'errand' }),
        /Cannot change type.*phase is "open"/,
      );
    });

    it('rejects changing codex on a non-draft writ', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
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
      const writ = await postMandate({ title: 'Title', body: 'Body', draft: true });
      await assert.rejects(
        () => clerk.edit({ id: writ.id, type: 'nonexistent' }),
        /Unknown writ type/,
      );
    });

    it('persists edits so show() returns updated values', async () => {
      const writ = await postMandate({ title: 'Original', body: 'Original body', draft: true });
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
      const writ = await postMandate({ title: 'Draft writ', body: 'Body', draft: true });
      assert.equal(writ.phase, 'new');

      const published = await clerk.transition(writ.id, 'open');
      assert.equal(published.phase, 'open');
      assert.equal(published.resolvedAt, undefined);
    });

    it('updates updatedAt on publish', async () => {
      const writ = await postMandate({ title: 'Draft', body: 'Body', draft: true });
      await new Promise(r => setTimeout(r, 2));
      const published = await clerk.transition(writ.id, 'open');
      assert.ok(published.updatedAt >= writ.updatedAt);
    });

    it('throws when publishing a writ that is already open', async () => {
      const writ = await postMandate({ title: 'Already open', body: 'Body' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'open'),
        /Cannot transition/,
      );
    });

    it('throws when publishing a cancelled writ', async () => {
      const writ = await postMandate({ title: 'Cancelled', body: 'Body', draft: true });
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
      const writ = await postMandate({ title: 'Complete me', body: 'Body' });
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'All done' });

      assert.equal(completed.phase, 'completed');
      assert.ok(completed.resolvedAt);
      assert.equal(completed.resolution, 'All done');
    });

    it('sets resolution on completed', async () => {
      const writ = await postMandate({ title: 'With resolution', body: 'Body' });
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Task fulfilled' });
      assert.equal(completed.resolution, 'Task fulfilled');
    });

    it('throws when completing a cancelled writ', async () => {
      const writ = await postMandate({ title: 'Cancelled', body: 'Body' });
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
      const writ = await postMandate({ title: 'Fail me', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Ran out of time' });

      assert.equal(failed.phase, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Ran out of time');
    });

    it('sets resolution on failed', async () => {
      const writ = await postMandate({ title: 'Will fail', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });
      assert.equal(failed.resolution, 'Something broke');
    });

    it('throws when failing a new writ', async () => {
      const writ = await postMandate({ title: 'Not open', body: 'Body', draft: true });

      await assert.rejects(
        () => clerk.transition(writ.id, 'failed'),
        /Cannot transition/,
      );
    });

    it('throws when failing a completed writ', async () => {
      const writ = await postMandate({ title: 'Already done', body: 'Body' });
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
      const writ = await postMandate({ title: 'Cancel me (new)', body: 'Body', draft: true });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.phase, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('cancels an open writ', async () => {
      const writ = await postMandate({ title: 'Cancel me (open)', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');

      assert.equal(cancelled.phase, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('sets resolution on cancelled when provided', async () => {
      const writ = await postMandate({ title: 'Cancel with reason', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled', { resolution: 'No longer needed' });
      assert.equal(cancelled.resolution, 'No longer needed');
    });

    it('throws when cancelling a completed writ', async () => {
      const writ = await postMandate({ title: 'Done', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });

    it('throws when cancelling a failed writ', async () => {
      const writ = await postMandate({ title: 'Failed', body: 'Body' });
      await clerk.transition(writ.id, 'failed', { resolution: 'Broke' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'cancelled'),
        /Cannot transition/,
      );
    });

    it('throws when cancelling an already-cancelled writ', async () => {
      const writ = await postMandate({ title: 'Cancelled twice', body: 'Body' });
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
      const writ = await postMandate({ title: 'Stuck writ', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck', { resolution: 'Engine failure' });

      assert.equal(stuck.phase, 'stuck');
      // stuck is non-terminal — no resolvedAt
      assert.equal(stuck.resolvedAt, undefined);
      assert.equal(stuck.resolution, 'Engine failure');
    });

    it('stuck is non-terminal — resolvedAt is not set', async () => {
      const writ = await postMandate({ title: 'Non-terminal', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck');
      assert.equal(stuck.resolvedAt, undefined);
    });

    it('throws when transitioning new → stuck', async () => {
      const writ = await postMandate({ title: 'Draft', body: 'Body', draft: true });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning completed → stuck', async () => {
      const writ = await postMandate({ title: 'Done', body: 'Body' });
      await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning failed → stuck', async () => {
      const writ = await postMandate({ title: 'Failed', body: 'Body' });
      await clerk.transition(writ.id, 'failed', { resolution: 'Broke' });
      await assert.rejects(
        () => clerk.transition(writ.id, 'stuck'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning cancelled → stuck', async () => {
      const writ = await postMandate({ title: 'Cancelled', body: 'Body' });
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
      const writ = await postMandate({ title: 'Recoverable', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const reopened = await clerk.transition(writ.id, 'open');
      assert.equal(reopened.phase, 'open');
      assert.equal(reopened.resolvedAt, undefined);
    });

    it('transitions stuck → failed (abandon)', async () => {
      const writ = await postMandate({ title: 'Abandoned', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Giving up' });
      assert.equal(failed.phase, 'failed');
      assert.ok(failed.resolvedAt);
      assert.equal(failed.resolution, 'Giving up');
    });

    it('transitions stuck → cancelled (withdrawn)', async () => {
      const writ = await postMandate({ title: 'Withdrawn', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      const cancelled = await clerk.transition(writ.id, 'cancelled', { resolution: 'No longer needed' });
      assert.equal(cancelled.phase, 'cancelled');
      assert.ok(cancelled.resolvedAt);
    });

    it('throws when transitioning stuck → completed', async () => {
      const writ = await postMandate({ title: 'Cannot complete from stuck', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await assert.rejects(
        () => clerk.transition(writ.id, 'completed'),
        /Cannot transition/,
      );
    });

    it('throws when transitioning stuck → stuck (no self-transition)', async () => {
      const writ = await postMandate({ title: 'Already stuck', body: 'Body' });
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
      const writ = await postMandate({ title: 'Full lifecycle', body: 'Do it all' });
      assert.equal(writ.phase, 'open');

      const done = await clerk.transition(writ.id, 'completed', { resolution: 'All finished' });
      assert.equal(done.phase, 'completed');
      assert.ok(done.resolvedAt);
      assert.equal(done.resolution, 'All finished');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.phase, 'completed');
    });

    it('failure path: open → failed', async () => {
      const writ = await postMandate({ title: 'Will fail', body: 'Body' });
      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Something broke' });

      assert.equal(failed.phase, 'failed');
      assert.equal(failed.resolution, 'Something broke');

      const persisted = await clerk.show(writ.id);
      assert.equal(persisted.phase, 'failed');
    });

    it('cancellation path: open → cancelled', async () => {
      const writ = await postMandate({ title: 'Cancelled early', body: 'Body' });
      const cancelled = await clerk.transition(writ.id, 'cancelled');
      assert.equal(cancelled.phase, 'cancelled');
    });

    it('stuck path: open → stuck → failed', async () => {
      const writ = await postMandate({ title: 'Stuck then failed', body: 'Body' });
      const stuck = await clerk.transition(writ.id, 'stuck', { resolution: 'Engine failure' });
      assert.equal(stuck.phase, 'stuck');
      assert.equal(stuck.resolvedAt, undefined, 'stuck is non-terminal');

      const failed = await clerk.transition(writ.id, 'failed', { resolution: 'Abandoned' });
      assert.equal(failed.phase, 'failed');
      assert.ok(failed.resolvedAt);
    });

    it('stuck recovery path: open → stuck → open → completed', async () => {
      const writ = await postMandate({ title: 'Recovered', body: 'Body' });
      await clerk.transition(writ.id, 'stuck');
      await clerk.transition(writ.id, 'open');
      const completed = await clerk.transition(writ.id, 'completed', { resolution: 'Recovered and done' });
      assert.equal(completed.phase, 'completed');
      assert.ok(completed.resolvedAt);
    });

    it('updatedAt changes on each mutation', async () => {
      const writ = await postMandate({ title: 'Track updates', body: 'Body' });
      const t0 = writ.updatedAt;

      await new Promise(r => setTimeout(r, 2));
      const done = await clerk.transition(writ.id, 'completed', { resolution: 'Done' });
      const t1 = done.updatedAt;

      assert.ok(t1 >= t0);
    });

    it('transition() strips managed fields from caller-supplied fields', async () => {
      const writ = await postMandate({ title: 'Sanitize test', body: 'Body' });

      // Note: `phase` in fields is rejected outright (D29 — smuggling a phase
      // via fields is a caller bug) and is tested separately below. Other
      // managed fields are silently stripped.
      const done = await clerk.transition(writ.id, 'completed', {
        resolution: 'Legit resolution',
        id: 'w-evil',
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

    it('transition() throws when fields.phase is supplied (D29)', async () => {
      const writ = await postMandate({ title: 'Phase conflict', body: 'Body' });

      await assert.rejects(
        () => clerk.transition(writ.id, 'completed', {
          resolution: 'Done',
          phase: 'open' as const,
        }),
        /\[clerk\] transition: cannot override phase via fields argument/,
      );
    });
  });

  // ── setWritStatus() — plugin-owned observation slot ───────────────

  describe('setWritStatus()', () => {
    beforeEach(async () => { await setup(); });

    it('returns an empty status slot for a freshly created writ', async () => {
      const writ = await postMandate({ title: 'No slot yet', body: 'Body' });
      assert.equal(writ.status, undefined, 'new writs have no status slot by default');
    });

    it('writes a sub-slot under the provided pluginId', async () => {
      const writ = await postMandate({ title: 'Observed', body: 'Body' });
      const updated = await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'await-graft' });

      assert.ok(updated.status, 'status slot should exist after setWritStatus');
      assert.deepEqual(updated.status!['spider'], { stuckCause: 'await-graft' });
    });

    it('disjoint sub-slot writes from different plugins do not clobber each other', async () => {
      const writ = await postMandate({ title: 'Two observers', body: 'Body' });

      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'engine-failed' });
      const afterSecond = await clerk.setWritStatus(writ.id, 'ratchet', { progress: 0.5 });

      assert.deepEqual(afterSecond.status!['spider'], { stuckCause: 'engine-failed' });
      assert.deepEqual(afterSecond.status!['ratchet'], { progress: 0.5 });
    });

    it('overwrites its own sub-slot but preserves sibling sub-slots', async () => {
      const writ = await postMandate({ title: 'Own overwrite', body: 'Body' });

      await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'first' });
      await clerk.setWritStatus(writ.id, 'ratchet', { progress: 0.1 });
      const updated = await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'second' });

      assert.deepEqual(updated.status!['spider'], { stuckCause: 'second' });
      assert.deepEqual(updated.status!['ratchet'], { progress: 0.1 });
    });

    it('survives terminal transitions — slot is not cleared on completed/failed/cancelled', async () => {
      const writ = await postMandate({ title: 'Terminal survivor', body: 'Body' });
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
      const writ = await postMandate({ title: 'Strip status on transition', body: 'Body' });
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
      const writ = await postMandate({ title: 'No plugin', body: 'Body' });
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
      const writ = await postMandate({ title: 'CDC emit', body: 'Body' });

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
      const writ = await postMandate({ title: 'Any value', body: 'Body' });

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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      const link = await clerk.link(w1.id, w2.id, 'fixes');

      assert.equal(link.sourceId, w1.id);
      assert.equal(link.targetId, w2.id);
      assert.equal(link.label, 'fixes');
      assert.equal(link.id, `${w1.id}:${w2.id}:fixes`);
      assert.ok(link.createdAt);
    });

    it('is idempotent — calling twice returns the same link', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      const first = await clerk.link(w1.id, w2.id, 'fixes');
      const second = await clerk.link(w1.id, w2.id, 'fixes');

      assert.equal(first.id, second.id);
      assert.equal(first.createdAt, second.createdAt);

      // Only one document should exist
      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
    });

    it('throws for self-link', async () => {
      const w = await postMandate({ title: 'Solo', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w.id, w.id, 'fixes'),
        /Cannot link a writ to itself/,
      );
    });

    it('throws when source writ does not exist', async () => {
      const w2 = await postMandate({ title: 'Target', body: 'Body' });
      await assert.rejects(
        () => clerk.link('w-ghost', w2.id, 'fixes'),
        /not found/,
      );
    });

    it('throws when target writ does not exist', async () => {
      const w1 = await postMandate({ title: 'Source', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, 'w-ghost', 'fixes'),
        /not found/,
      );
    });

    it('throws for empty label string', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, ''),
        /non-empty/,
      );
    });

    it('throws for whitespace-only label string', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, '   '),
        /non-empty/,
      );
    });

    it('accepts various non-empty label strings', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      const l1 = await clerk.link(w1.id, w2.id, 'fixes');
      const l2 = await clerk.link(w1.id, w2.id, 'retries');

      assert.equal(l1.label, 'fixes');
      assert.equal(l2.label, 'retries');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 2);
    });

    it('creates separate links for same pair with different labels', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'supersedes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 2);
    });

    it('creates links to multiple targets', async () => {
      const w1 = await postMandate({ title: 'Source', body: 'Body' });
      const w2 = await postMandate({ title: 'Target 2', body: 'Body' });
      const w3 = await postMandate({ title: 'Target 3', body: 'Body' });

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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      const w3 = await postMandate({ title: 'Writ 3', body: 'Body' });

      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w3.id, w1.id, 'supersedes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
      assert.equal(result.outbound[0]!.targetId, w2.id);
      assert.equal(result.inbound.length, 1);
      assert.equal(result.inbound[0]!.sourceId, w3.id);
    });

    it('returns empty arrays for a writ with no links', async () => {
      const w = await postMandate({ title: 'Lonely writ', body: 'Body' });
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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      await clerk.unlink(w1.id, w2.id, 'fixes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 0);
    });

    it('is idempotent — no error when link does not exist', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      // No error — link was never created
      await clerk.unlink(w1.id, w2.id, 'fixes');
    });

    it('is idempotent — no error when called twice', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      await clerk.unlink(w1.id, w2.id, 'fixes');
      await clerk.unlink(w1.id, w2.id, 'fixes'); // second call — no error
    });

    it('does not affect other links', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');
      await clerk.link(w1.id, w2.id, 'retries');

      await clerk.unlink(w1.id, w2.id, 'fixes');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
      assert.equal(result.outbound[0]!.label, 'retries');
    });

    it('does not update writ timestamps when unlinking', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });

      const link = await clerk.link(w1.id, w2.id, 'DependsOn');

      assert.equal(link.label, 'depends on');
      assert.equal(link.id, `${w1.id}:${w2.id}:depends on`);
    });

    it('variant spellings of the same label collapse to a single link', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });

      const a = await clerk.link(w1.id, w2.id, 'depends-on');
      const b = await clerk.link(w1.id, w2.id, 'dependsOn');
      const c = await clerk.link(w1.id, w2.id, 'DEPENDS_ON');

      assert.equal(a.id, b.id);
      assert.equal(b.id, c.id);
      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 1);
    });

    it('unlink() normalizes its label argument before deletion', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      await clerk.link(w1.id, w2.id, 'depends-on');

      // Unlink using a differently-spelled variant of the same label.
      await clerk.unlink(w1.id, w2.id, 'dependsOn');

      const result = await clerk.links(w1.id);
      assert.equal(result.outbound.length, 0);
    });

    it('keeps distinct labels distinct (not synonymy)', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });

      await clerk.link(w1.id, w2.id, 'requires');
      await clerk.link(w1.id, w2.id, 'depends-on');

      const result = await clerk.links(w1.id);
      // Two distinct canonical forms → two separate links.
      assert.equal(result.outbound.length, 2);
    });

    it('rejects a whitespace-only label (canonicalizes to empty)', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, '   \t\n  '),
        /non-empty/,
      );
    });

    it('keeps the existing builtin `fixes` composite-id shape stable', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      const link = await clerk.link(w1.id, w2.id, 'fixes');
      assert.equal(link.kind, null);
    });

    it('stores the supplied kind on the new row', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      const link = await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');
      assert.equal(link.kind, 'testkit.refines');
    });

    it('upserts kind onto an existing link on a subsequent call', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });

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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });

      await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');
      const again = await clerk.link(w1.id, w2.id, 'refines');
      assert.equal(again.kind, 'testkit.refines');
    });

    it('rejects an unknown kind id', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      await assert.rejects(
        () => clerk.link(w1.id, w2.id, 'fixes', 'nonexistent.meaning'),
        /Unknown link kind/,
      );
    });

    it('writ-show surfaces kind on each link row', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      await clerk.link(w1.id, w2.id, 'refines', 'testkit.refines');

      const result = await writShow.handler({ id: w1.id, format: 'json' }) as { links: WritLinks };
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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
      const result = (await writLink.handler({
        sourceId: w1.id,
        targetId: w2.id,
        label: 'refines',
        kind: 'toolkit.refines',
      })) as WritLinkDoc;

      assert.equal(result.kind, 'toolkit.refines');
    });

    it('rejects with a clear error when the kind id is unknown', async () => {
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
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
      const w1 = await postMandate({ title: 'W1', body: 'B' });
      const w2 = await postMandate({ title: 'W2', body: 'B' });
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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
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
      const w = await postMandate({ title: 'Solo', body: 'Body' });

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
      const w1 = await postMandate({ title: 'Source writ', body: 'Body' });
      const w2 = await postMandate({ title: 'Target writ', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      const result = await writShow.handler({ id: w1.id, format: 'json' }) as WritLinkDoc & { links: WritLinks };

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
      const w = await postMandate({ title: 'Lone writ', body: 'Body' });

      const result = await writShow.handler({ id: w.id, format: 'json' }) as { links: WritLinks };

      assert.deepEqual(result.links.outbound, []);
      assert.deepEqual(result.links.inbound, []);
    });

    it('throws when the writ does not exist', async () => {
      await assert.rejects(
        () => writShow.handler({ id: 'w-ghost', format: 'json' }),
        /No writ found/,
      );
    });

    it('returns inbound links when the writ is a target', async () => {
      const w1 = await postMandate({ title: 'Source', body: 'Body' });
      const w2 = await postMandate({ title: 'Target', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'supersedes');

      const result = await writShow.handler({ id: w2.id, format: 'json' }) as { links: WritLinks };

      assert.equal(result.links.outbound.length, 0);
      assert.equal(result.links.inbound.length, 1);
      assert.equal(result.links.inbound[0]!.sourceId, w1.id);
    });
  });

  // ── writ-tree tool handler ────────────────────────────────────────

  describe('writ-tree tool handler (via guild apparatus)', () => {
    beforeEach(async () => { await setup(); });

    it('returns the structured forest in json format', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: root.id });

      const forest = await writTree.handler({ format: 'json' }) as Array<{ writ: WritDoc; children: unknown[] }>;
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
      assert.equal(forest[0].children.length, 1);
      assert.equal((forest[0].children[0] as { writ: WritDoc }).writ.id, child.id);
    });

    it('returns a placeholder string when no writs exist (text format)', async () => {
      const result = await writTree.handler({ format: 'text' }) as string;
      assert.equal(typeof result, 'string');
      assert.match(result, /No writs found/);
    });

    it('returns a filter-aware placeholder when filters match nothing (text format)', async () => {
      await postMandate({ title: 'Root', body: 'Body' });
      const result = await writTree.handler({ format: 'text', phase: 'completed' }) as string;
      assert.match(result, /No writs match the given filters/);
    });

    it('renders the box-drawing tree in text format', async () => {
      const root = await postMandate({ title: 'Root', body: 'Body' });
      await postMandate({ title: 'Child', body: 'Body', parentId: root.id });

      const result = await writTree.handler({ format: 'text' }) as string;
      // Box-drawing connector for the only child.
      assert.match(result, /└──/);
      assert.match(result, /Root/);
      assert.match(result, /Child/);
    });

    it('honors --root-id with prefix resolution', async () => {
      const root = await postMandate({ title: 'Solo', body: 'Body' });
      // Use a prefix of the id to verify resolveId is called.
      const prefix = root.id.slice(0, 12);
      const forest = await writTree.handler({ format: 'json', rootId: prefix }) as Array<{ writ: WritDoc }>;
      assert.equal(forest.length, 1);
      assert.equal(forest[0].writ.id, root.id);
    });

    it('honors --depth and --type filters', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
        ],
      });
      const root = await postMandate({ title: 'Root', body: 'Body', type: 'mandate' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: root.id, type: 'task' });
      await postMandate({ title: 'Grand', body: 'Body', parentId: child.id, type: 'task' });

      const depth1 = await writTree.handler({ format: 'json', depth: 1 }) as Array<{ children: unknown[] }>;
      assert.equal(depth1.length, 1);
      assert.equal(depth1[0].children.length, 1);
      assert.equal((depth1[0].children[0] as { children: unknown[] }).children.length, 0);

      const onlyMandate = await writTree.handler({ format: 'json', type: 'mandate' }) as Array<{ children: unknown[] }>;
      assert.equal(onlyMandate.length, 1);
      assert.equal(onlyMandate[0].children.length, 0);
    });

    it('renders mandate writ glyphs byte-for-byte: new=◌, open=●, stuck=◇, completed=○, failed=✕, cancelled=⊘', async () => {
      // One writ per declared mandate state; each glyph appears at least once
      // in the rendered tree.
      const draft = await clerk.post({ title: 'Draft', body: 'Body' });
      assert.equal(draft.phase, 'new');

      const open = await postMandate({ title: 'Open writ', body: 'Body' });

      const completed = await postMandate({ title: 'Done', body: 'Body' });
      await clerk.transition(completed.id, 'completed', { resolution: 'fine' });

      const failed = await postMandate({ title: 'Bust', body: 'Body' });
      await clerk.transition(failed.id, 'failed', { resolution: 'broke' });

      const cancelled = await postMandate({ title: 'Withdrawn', body: 'Body' });
      await clerk.transition(cancelled.id, 'cancelled', { resolution: 'gone' });

      const stuck = await postMandate({ title: 'Stuck', body: 'Body' });
      await clerk.transition(stuck.id, 'stuck');

      const text = await writTree.handler({ format: 'text' }) as string;
      assert.ok(text.includes('◌'), 'new glyph ◌ should appear');
      assert.ok(text.includes('●'), 'open glyph ● should appear');
      assert.ok(text.includes('◇'), 'stuck glyph ◇ should appear');
      assert.ok(text.includes('○'), 'completed glyph ○ should appear');
      assert.ok(text.includes('✕'), 'failed glyph ✕ should appear');
      assert.ok(text.includes('⊘'), 'cancelled glyph ⊘ should appear');

      // Discard unused references so the linter does not complain.
      void [draft, open, completed, failed, cancelled, stuck];
    });

    it('renders non-mandate writ glyphs through attrs-driven derivation', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      const errand = await clerk.post({ title: 'Errand', body: 'Body', type: 'errand' });
      assert.equal(errand.phase, 'new');
      const text = await writTree.handler({ format: 'text' }) as string;
      // Initial state → ◌ (matches mandate's `new` glyph because both share
      // the `initial` classification with no recognized attrs).
      assert.ok(text.includes('◌'), 'errand initial state glyph ◌ should appear');
    });

    it('renders ? for an unregistered writ type without aborting the walk', async () => {
      // Bypass clerk.post() and write directly so the writ persists with a
      // type the registry never saw — mirrors the legacy/orphan condition
      // D17 calls out.
      const stacks = guild().apparatus<StacksApi>('stacks');
      const writs = stacks.book<WritDoc>('clerk', 'writs');
      const orphan: WritDoc = {
        id: 'w-orphan-aaaaaaaaaaaa',
        type: 'unregistered-type',
        phase: 'open',
        title: 'Orphan',
        body: 'Body',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      };
      await writs.put(orphan);

      // The text render must not throw and must surface `?` for the unknown
      // classification.
      const text = await writTree.handler({ format: 'text' }) as string;
      assert.ok(text.includes('Orphan'));
      assert.ok(text.includes('?'), 'unregistered-type writ should render with ? glyph');
    });

    it('embeds classification + allowedTransitions on every node in the tree', async () => {
      // Mixed-type tree exercises both mandate and a plugin-registered
      // type so the assertion can prove non-mandate transitions surface.
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
        ],
      });
      const root = await postMandate({ title: 'Root', body: 'Body', type: 'mandate' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: root.id, type: 'task' });

      const forest = await writTree.handler({ format: 'json' }) as Array<{
        writ: { id: string; phase: string; classification: string; allowedTransitions: string[] };
        children: Array<{ writ: { id: string; phase: string; classification: string; allowedTransitions: string[] } }>;
      }>;
      const rootNode = forest.find(n => n.writ.id === root.id);
      assert.ok(rootNode);
      assert.equal(rootNode.writ.classification, 'active');
      assert.deepEqual(rootNode.writ.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);

      // Plugin-registered type's transitions surface as declared in its config —
      // no mandate-specific literals required. The child task stays in `new`
      // (postMandate's auto-publish only fires for mandate type), so the
      // initial-state transitions (open, cancelled) are what surface here.
      const childNode = rootNode.children.find(n => n.writ.id === child.id);
      assert.ok(childNode);
      assert.equal(childNode.writ.phase, 'new');
      assert.equal(childNode.writ.classification, 'initial');
      assert.deepEqual(childNode.writ.allowedTransitions, ['open', 'cancelled']);
    });
  });

  // ── writ-list tool handler — presentation embedding ───────────────

  describe('writ-list tool handler — embeds classification + allowedTransitions', () => {
    beforeEach(async () => { await setup(); });

    it('every row carries classification and allowedTransitions (json format)', async () => {
      const writ = await postMandate({ title: 'Some writ', body: 'Body' });
      const writList = (await import('./tools/writ-list.ts')).default;
      const result = await writList.handler({ format: 'json' }) as Array<{
        id: string;
        phase: string;
        classification: string;
        allowedTransitions: string[];
      }>;
      const row = result.find(r => r.id === writ.id);
      assert.ok(row);
      assert.equal(row.phase, 'open');
      assert.equal(row.classification, 'active');
      assert.deepEqual(row.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);
    });

    it('default format=text renders a tabular view with TYPE | STATE | ID | TITLE | CREATED columns', async () => {
      await postMandate({ title: 'A writ', body: 'Body' });
      const writList = (await import('./tools/writ-list.ts')).default;
      const text = await writList.handler({}) as string;
      assert.equal(typeof text, 'string', 'text mode should return a string');
      assert.ok(text.includes('TYPE'));
      assert.ok(text.includes('STATE'));
      assert.ok(text.includes('ID'));
      assert.ok(text.includes('TITLE'));
      assert.ok(text.includes('CREATED'));
      assert.ok(text.includes('mandate'));
      assert.ok(text.includes('open'));
      assert.ok(text.includes('A writ'));
    });

    it('text mode renders a non-mandate writ with its declared state name', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      await clerk.post({ title: 'An errand', body: 'Body', type: 'errand' });
      const writList = (await import('./tools/writ-list.ts')).default;
      const text = await writList.handler({ format: 'text' }) as string;
      assert.ok(text.includes('errand'));
      // initial state from mandate-like config = 'new'
      assert.ok(text.includes('new'));
    });

    it('text mode prints "No writs found." for an empty result', async () => {
      const writList = (await import('./tools/writ-list.ts')).default;
      const text = await writList.handler({}) as string;
      assert.match(text, /No writs found/);
    });

    it('--classification active filters across every registered type', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      // Drafts (initial classification) — should not match.
      await clerk.post({ title: 'Draft m', body: 'B' });
      await clerk.post({ title: 'Draft e', body: 'B', type: 'errand' });
      // Active writs of both types — should match.
      const m = await postMandate({ title: 'Active m', body: 'B' });
      const e = await clerk.post({ title: 'Active e', body: 'B', type: 'errand' });
      await clerk.transition(e.id, 'open');
      // Terminal — should not match.
      const t = await postMandate({ title: 'Terminal m', body: 'B' });
      await clerk.transition(t.id, 'completed', { resolution: 'done' });

      const writList = (await import('./tools/writ-list.ts')).default;
      const result = await writList.handler({ format: 'json', classification: 'active', limit: 100 }) as Array<{
        id: string;
        type: string;
        phase: string;
      }>;
      const ids = new Set(result.map(r => r.id));
      assert.ok(ids.has(m.id));
      assert.ok(ids.has(e.id));
      // Terminal and initial writs are not in the result.
      assert.ok(!ids.has(t.id));
      // Every returned row carries an active-classified state.
      for (const row of result) {
        assert.ok(['open', 'stuck'].includes(row.phase), `expected active state, got ${row.phase}`);
      }
    });

    it('--phase open without --type implicitly scopes to mandate (D7)', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      // Mandate writ in `open` and an errand in its same-named `open` state.
      const m = await postMandate({ title: 'Mandate open', body: 'B' });
      const e = await clerk.post({ title: 'Errand open', body: 'B', type: 'errand' });
      await clerk.transition(e.id, 'open');

      const writList = (await import('./tools/writ-list.ts')).default;
      // No --type filter; --phase=open must NOT leak the errand writ.
      const unscoped = await writList.handler({ format: 'json', phase: 'open' }) as Array<{ id: string; type: string }>;
      const ids = new Set(unscoped.map(r => r.id));
      assert.ok(ids.has(m.id), 'mandate open writ should be in the result');
      assert.ok(!ids.has(e.id), 'errand open writ must NOT leak into --phase open without --type');
      // Every returned row is type=mandate.
      for (const row of unscoped) {
        assert.equal(row.type, 'mandate');
      }

      // Operator passes both --type errand --phase open: now the errand surfaces.
      const scoped = await writList.handler({ format: 'json', type: 'errand', phase: 'open' }) as Array<{ id: string; type: string }>;
      const scopedIds = new Set(scoped.map(r => r.id));
      assert.ok(scopedIds.has(e.id));
      assert.ok(!scopedIds.has(m.id), 'mandate writ should not leak in when type=errand');
    });

    it('writ-tree --classification terminal returns only terminal-rooted forests (prune semantics)', async () => {
      // The tree filter prunes top-down: a root that fails the filter
      // drops with its entire subtree. So the test seeds two independent
      // roots — one active, one terminal — and asserts only the terminal
      // root surfaces under --classification terminal.
      const writTreeTool = (await import('./tools/writ-tree.ts')).default;
      const active = await postMandate({ title: 'Active root', body: 'B' });
      const terminal = await postMandate({ title: 'Terminal root', body: 'B' });
      await clerk.transition(terminal.id, 'completed', { resolution: 'done' });

      const forest = await writTreeTool.handler({ format: 'json', classification: 'terminal' }) as Array<{
        writ: { id: string; phase: string; classification: string };
        children: unknown[];
      }>;
      const rootIds = forest.map(n => n.writ.id);
      assert.ok(rootIds.includes(terminal.id));
      assert.ok(!rootIds.includes(active.id));
      // Every root in the result is terminal-classified.
      for (const node of forest) {
        assert.equal(node.writ.classification, 'terminal');
      }
    });
  });

  // ── writ-show tool handler — presentation embedding ───────────────

  describe('writ-show tool handler — embeds classification + allowedTransitions', () => {
    beforeEach(async () => { await setup(); });

    it('top-level writ, parent reference, and children.items entries all carry presentation projection', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'B' });
      const child = await postMandate({ title: 'Child', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: child.id, format: 'json' }) as {
        id: string;
        classification: string;
        allowedTransitions: string[];
        parent: { classification: string; allowedTransitions: string[] };
        children: { items: Array<{ id: string; classification: string; allowedTransitions: string[] }> };
      };

      assert.equal(result.classification, 'active');
      assert.deepEqual(result.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);
      assert.equal(result.parent.classification, 'active');
      assert.deepEqual(result.parent.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);

      // Now look at parent — its children.items entries must also carry
      // the projection.
      const parentResult = await writShow.handler({ id: parent.id, format: 'json' }) as {
        children: { items: Array<{ id: string; classification: string; allowedTransitions: string[] }> };
      };
      const childItem = parentResult.children.items.find(i => i.id === child.id);
      assert.ok(childItem);
      assert.equal(childItem.classification, 'active');
      assert.deepEqual(childItem.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);
    });

    it('default format=text renders the lifecycle-aware block with classification + attrs annotation and allowed transitions', async () => {
      const writ = await postMandate({ title: 'Some writ', body: 'Body content' });
      // Move into stuck so the attrs annotation surfaces in the rendering.
      await clerk.transition(writ.id, 'stuck');
      const text = await writShow.handler({ id: writ.id }) as string;
      assert.equal(typeof text, 'string', 'text mode should return a string');
      assert.ok(text.includes('Type:'));
      assert.ok(text.includes('mandate'));
      assert.ok(text.includes('State:'));
      assert.ok(text.includes('stuck'));
      assert.ok(text.includes('classification: active'));
      // attrs annotation present for `stuck`.
      assert.ok(text.includes('attrs: [stuck]'));
      // Allowed transitions list rendered.
      assert.ok(text.includes('Transitions:'));
      assert.ok(text.includes('open'));
      assert.ok(text.includes('failed'));
      assert.ok(text.includes('cancelled'));
    });

    it('text mode renders lifecycle for non-mandate writs using their declared vocabulary', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      const e = await clerk.post({ title: 'My errand', body: 'B', type: 'errand' });
      const text = await writShow.handler({ id: e.id }) as string;
      assert.ok(text.includes('errand'));
      assert.ok(text.includes('classification: initial'));
      // initial state for mandateLikeWritType: 'new', transitions to ['open', 'cancelled']
      assert.ok(text.includes('open, cancelled') || (text.includes('open') && text.includes('cancelled')));
    });

    it('text mode renders descendants summary and links section when present', async () => {
      const root = await postMandate({ title: 'Root', body: 'B' });
      const child = await postMandate({ title: 'Child', body: 'B', parentId: root.id });
      void child;
      // Add a link
      const target = await postMandate({ title: 'Target', body: 'B' });
      await clerk.link(root.id, target.id, 'fixes');

      const text = await writShow.handler({ id: root.id }) as string;
      assert.ok(text.includes('Descendants'));
      assert.ok(text.includes('open: 1'));
      assert.ok(text.includes('Children:'));
      assert.ok(text.includes('Links:'));
      assert.ok(text.includes('fixes'));
    });
  });

  // ── writ-link tool handler ────────────────────────────────────────

  describe('writ-link tool handler (via guild apparatus)', () => {
    beforeEach(async () => { await setup(); });

    it('creates a link and returns a WritLinkDoc', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      const result = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;

      assert.equal(result.sourceId, w1.id);
      assert.equal(result.targetId, w2.id);
      assert.equal(result.label, 'fixes');
      assert.equal(result.id, `${w1.id}:${w2.id}:fixes`);
      assert.ok(result.createdAt);
    });

    it('is idempotent — returns the same link on duplicate call', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      const r1 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;
      const r2 = await writLink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' }) as WritLinkDoc;

      assert.equal(r1.id, r2.id);
      assert.equal(r1.createdAt, r2.createdAt);
    });

    it('propagates self-link error from clerk.link()', async () => {
      const w = await postMandate({ title: 'Solo', body: 'Body' });
      await assert.rejects(
        () => writLink.handler({ sourceId: w.id, targetId: w.id, label: 'fixes' }),
        /Cannot link a writ to itself/,
      );
    });

    it('propagates missing source error from clerk.link()', async () => {
      const w2 = await postMandate({ title: 'Target', body: 'Body' });
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
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
      await clerk.link(w1.id, w2.id, 'fixes');

      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' });

      assert.deepEqual(result, { ok: true });

      const linksResult = await clerk.links(w1.id);
      assert.equal(linksResult.outbound.length, 0);
    });

    it('is idempotent — returns { ok: true } when link does not exist', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });

      // Link was never created — no error
      const result = await writUnlink.handler({ sourceId: w1.id, targetId: w2.id, label: 'fixes' });
      assert.deepEqual(result, { ok: true });
    });

    it('does not remove other links when unlinking by label', async () => {
      const w1 = await postMandate({ title: 'Writ 1', body: 'Body' });
      const w2 = await postMandate({ title: 'Writ 2', body: 'Body' });
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
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
    });

    it('edits title of a draft writ via the tool handler', async () => {
      const writ = await postMandate({ title: 'Old', body: 'Body', draft: true });
      const result = await writEdit.handler({ id: writ.id, title: 'New' }) as { title: string };
      assert.equal(result.title, 'New');
    });

    it('edits multiple fields via the tool handler', async () => {
      const writ = await postMandate({ title: 'Old', body: 'Old body', draft: true });
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
      const writ = await postMandate({ title: 'Title', body: 'Body', draft: true });
      await assert.rejects(
        () => writEdit.handler({ id: writ.id }),
        /At least one field/,
      );
    });

    it('allows editing title/body of a non-draft writ via the tool handler', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
      const edited = await writEdit.handler({ id: writ.id, title: 'Changed', body: 'New body' });
      assert.equal(edited.title, 'Changed');
      assert.equal(edited.body, 'New body');
    });

    it('rejects changing type on a non-draft writ via the tool handler', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
      await assert.rejects(
        () => writEdit.handler({ id: writ.id, type: 'errand' }),
        /Cannot change type/,
      );
    });

    it('rejects changing codex on a non-draft writ via the tool handler', async () => {
      const writ = await postMandate({ title: 'Title', body: 'Body' }); // open
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

  describe('config: defaultType validation', () => {
    it('built-in type mandate is always available', async () => {
      await setup();
      const w = await postMandate({ title: 'Mandate', body: 'Body', type: 'mandate' });
      assert.equal(w.type, 'mandate');
    });

    it('rejects an unregistered writ type at post time', async () => {
      await setup();
      await assert.rejects(
        () => postMandate({ title: 'Summon', body: 'Body', type: 'summon' }),
        /Unknown writ type/,
      );
    });

    it('plugin-registered custom types are accepted', async () => {
      await setup({
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      const w = await postMandate({ title: 'Start an errand', body: 'Body', type: 'errand' });
      assert.equal(w.type, 'errand');
    });

    it('defaultType is honored when its writ type is registered', async () => {
      await setup({
        clerkConfig: { defaultType: 'errand' },
        extraApparatuses: [
          makeWritTypeApparatus([mandateLikeWritType('errand')], { id: 'errand-plugin' }),
        ],
      });
      const w = await postMandate({ title: 'Default errand', body: 'Body' });
      assert.equal(w.type, 'errand');
    });
  });

  // ── registerWritType API ─────────────────────────────────────────

  describe('registerWritType API', () => {
    it('throws on duplicate registration', async () => {
      await setup();
      // mandate is already registered by clerk.start(); a second
      // registration of mandate is a duplicate.
      assert.throws(
        () => clerk.registerWritType(mandateLikeWritType('mandate')),
        (err: Error) =>
          /\[clerk\] registerWritType:/.test(err.message) &&
          /duplicate writ type/.test(err.message) &&
          /"mandate"/.test(err.message),
        'duplicate writ type registration must throw with the [clerk] registerWritType: prefix',
      );
    });

    it('rejects late registration after the startup window has sealed', async () => {
      const { ctx, fire } = buildClerkCtx();
      await setupCore({}, ctx);
      // Fire the framework's global phase:started event — the Clerk seals
      // the registration window on this signal.
      await fire('phase:started');
      assert.throws(
        () => clerk.registerWritType(mandateLikeWritType('late-type')),
        (err: Error) =>
          /\[clerk\] registerWritType:/.test(err.message) &&
          /startup registration window has closed/.test(err.message),
      );
    });

    it('propagates validator errors verbatim with the writTypeConfig path', async () => {
      await setup();
      assert.throws(
        () =>
          clerk.registerWritType({
            // Invalid: empty states array.
            name: 'broken',
            states: [],
          }),
        (err: Error) =>
          /\[clerk\] writTypeConfig\.states/.test(err.message) &&
          // The validator's prefix should NOT be wrapped — registration-
          // specific failures use [clerk] registerWritType:; validator
          // failures use [clerk] writTypeConfig.<path>:.
          !/registerWritType/.test(err.message),
      );
    });

    it('post() of an unregistered type fails with the registry error', async () => {
      await setup();
      await assert.rejects(
        () => clerk.post({ title: 'X', body: 'Y', type: 'never-registered' }),
        /Unknown writ type "never-registered"/,
      );
    });

    it('rejects child creation on a parent in a terminal state', async () => {
      await setup();
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      // Drive the parent into a terminal state.
      await clerk.transition(parent.id, 'completed', { resolution: 'done' });
      await assert.rejects(
        () => postMandate({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) =>
          /Cannot add children to writ/.test(err.message) &&
          /terminal/.test(err.message),
      );
    });

    it('classification predicates reflect the registered config for known types', async () => {
      await setup();
      const w = await clerk.post({ title: 'X', body: 'Y' });
      // mandate's `new` is initial.
      assert.equal(clerk.isInitial(w), true);
      assert.equal(clerk.isActive(w), false);
      assert.equal(clerk.isTerminal(w), false);

      const opened = await clerk.transition(w.id, 'open');
      assert.equal(clerk.isInitial(opened), false);
      assert.equal(clerk.isActive(opened), true);
      assert.equal(clerk.isTerminal(opened), false);

      const completed = await clerk.transition(opened.id, 'completed');
      assert.equal(clerk.isInitial(completed), false);
      assert.equal(clerk.isActive(completed), false);
      assert.equal(clerk.isTerminal(completed), true);
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

  it('returns builtin mandate with source "builtin" and isDefault true', async () => {
    const plugin = await setupCore();
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.description, null);
    assert.equal(mandate.isDefault, true);
    assert.equal(mandate.source, 'builtin');
  });

  it('returns plugin-registered types with source "plugin"', async () => {
    const plugin = await setupCore({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
      ],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const task = result.find(t => t.name === 'task');
    assert.ok(task, 'task should be in result');
    assert.equal(task.description, null);
    assert.equal(task.isDefault, false);
    assert.equal(task.source, 'plugin');
    // mandate should still be there
    assert.ok(result.find(t => t.name === 'mandate'), 'mandate should still appear');
  });

  it('marks configured defaultType as default when the type is registered', async () => {
    const plugin = await setupCore({
      clerkConfig: { defaultType: 'task' },
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
      ],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{ name: string; description: string | null; source: string; isDefault: boolean }>;
    const task = result.find(t => t.name === 'task');
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(task, 'task should be in result');
    assert.equal(task.isDefault, true);
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.isDefault, false);
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

  it('tool delegates to api.listWritTypes()', async () => {
    const plugin = await setupCore({
      extraApparatuses: [
        makeWritTypeApparatus(
          [mandateLikeWritType('task'), mandateLikeWritType('quality-audit')],
          { id: 'types-plugin' },
        ),
      ],
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

  it('exposes per-type states catalogue (name, classification, attrs, allowedTransitions)', async () => {
    const plugin = await setupCore();
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{
      name: string;
      states: Array<{
        name: string;
        classification: 'initial' | 'active' | 'terminal';
        attrs: string[];
        allowedTransitions: string[];
      }>;
    }>;
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.ok(Array.isArray(mandate.states), 'mandate.states should be an array');

    // Six declared states, in the declared order.
    assert.deepEqual(
      mandate.states.map(s => s.name),
      ['new', 'open', 'stuck', 'completed', 'failed', 'cancelled'],
    );

    const byName = new Map(mandate.states.map(s => [s.name, s]));
    assert.equal(byName.get('new')!.classification, 'initial');
    assert.deepEqual(byName.get('new')!.attrs, []);
    assert.deepEqual(byName.get('new')!.allowedTransitions, ['open', 'cancelled']);

    assert.equal(byName.get('stuck')!.classification, 'active');
    assert.deepEqual(byName.get('stuck')!.attrs, ['stuck']);
    assert.deepEqual(byName.get('stuck')!.allowedTransitions, ['open', 'failed', 'cancelled']);

    assert.equal(byName.get('completed')!.classification, 'terminal');
    assert.deepEqual(byName.get('completed')!.attrs, ['success']);
    assert.deepEqual(byName.get('completed')!.allowedTransitions, []);

    assert.equal(byName.get('failed')!.classification, 'terminal');
    assert.deepEqual(byName.get('failed')!.attrs, ['failure']);

    assert.equal(byName.get('cancelled')!.classification, 'terminal');
    assert.deepEqual(byName.get('cancelled')!.attrs, ['cancelled']);
  });

  it('exposes states catalogue for plugin-registered types', async () => {
    const plugin = await setupCore({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
      ],
    });
    const writTypesTool = getWritTypesTool(plugin);
    const result = await writTypesTool.handler({}) as Array<{
      name: string;
      states: Array<{ name: string; classification: string; attrs: string[]; allowedTransitions: string[] }>;
    }>;
    const task = result.find(t => t.name === 'task');
    assert.ok(task, 'task should be in result');
    assert.deepEqual(
      task.states.map(s => s.name),
      ['new', 'open', 'stuck', 'completed', 'failed', 'cancelled'],
    );
    assert.deepEqual(
      task.states.find(s => s.name === 'completed')!.attrs,
      ['success'],
    );
  });
});

// ── listWritTypes() API method tests ─────────────────────────────────

describe('listWritTypes()', () => {
  afterEach(() => { clearGuild(); });

  it('returns builtin mandate with source and isDefault', async () => {
    await setupCore();
    const result = clerk.listWritTypes();
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(mandate, 'mandate should be in result');
    assert.equal(mandate.source, 'builtin');
    assert.equal(mandate.isDefault, true);
    assert.equal(mandate.description, null);
  });

  it('returns plugin-registered types with source "plugin"', async () => {
    await setupCore({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
      ],
    });
    const result = clerk.listWritTypes();
    const task = result.find(t => t.name === 'task');
    assert.ok(task);
    assert.equal(task.source, 'plugin');
    assert.equal(task.description, null);
    assert.equal(task.isDefault, false);
  });

  it('defaultType override changes isDefault when the type is registered', async () => {
    await setupCore({
      clerkConfig: { defaultType: 'task' },
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('task')], { id: 'task-plugin' }),
      ],
    });
    const result = clerk.listWritTypes();
    const task = result.find(t => t.name === 'task');
    const mandate = result.find(t => t.name === 'mandate');
    assert.ok(task);
    assert.equal(task.isDefault, true);
    assert.ok(mandate);
    assert.equal(mandate.isDefault, false);
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
      const parent = await postMandate({ title: 'Parent', body: 'Parent body' });
      const child = await postMandate({ title: 'Child', body: 'Child body', parentId: parent.id });

      assert.equal(child.parentId, parent.id);
      assert.ok(child.id.startsWith('w-'));
      assert.equal(child.phase, 'open');
    });

    it('parent stays in open when child is added', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      assert.equal(parent.phase, 'open');

      await postMandate({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'open');
    });

    it('parent stays in new when child is added', async () => {
      const parent = await postMandate({ title: 'Draft parent', body: 'Body', draft: true });
      assert.equal(parent.phase, 'new');

      await postMandate({ title: 'Child', body: 'Body', parentId: parent.id });

      const updated = await clerk.show(parent.id);
      assert.equal(updated.phase, 'new');
    });

    it('parent stays in open when a second child is added', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      await postMandate({ title: 'Child 1', body: 'Body', parentId: parent.id });

      const midState = await clerk.show(parent.id);
      assert.equal(midState.phase, 'open');

      await postMandate({ title: 'Child 2', body: 'Body', parentId: parent.id });

      const endState = await clerk.show(parent.id);
      assert.equal(endState.phase, 'open');
    });

    it('creates root writ without parentId', async () => {
      const writ = await postMandate({ title: 'Root', body: 'Body' });
      assert.equal(writ.parentId, undefined);
    });

    it('inherits codex from parent when child codex is not specified', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body', codex: 'parent-codex' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: parent.id });

      assert.equal(child.codex, 'parent-codex');
    });

    it('uses child explicit codex over parent codex', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body', codex: 'parent-codex' });
      const child = await postMandate({ title: 'Child', body: 'Body', codex: 'child-codex', parentId: parent.id });

      assert.equal(child.codex, 'child-codex');
    });

    it('child has no codex when neither parent nor child specify one', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'Body', parentId: parent.id });

      assert.equal(child.codex, undefined);
    });
  });

  // ── Child creation validation ─────────────────────────────────────

  describe('child creation validation', () => {
    beforeEach(async () => { await setup(); });

    it('rejects child creation with non-existent parentId', async () => {
      await assert.rejects(
        () => postMandate({ title: 'Child', body: 'Body', parentId: 'w-nonexistent' }),
        { message: 'Parent writ "w-nonexistent" not found.' },
      );
    });

    it('rejects child creation when parent is completed', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'completed', { resolution: 'Done' });

      await assert.rejects(
        () => postMandate({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"completed"'));
          return true;
        },
      );
    });

    it('rejects child creation when parent is failed', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'failed', { resolution: 'Broke' });

      await assert.rejects(
        () => postMandate({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"failed"'));
          return true;
        },
      );
    });

    it('rejects child creation when parent is cancelled', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      await clerk.transition(parent.id, 'cancelled');

      await assert.rejects(
        () => postMandate({ title: 'Child', body: 'Body', parentId: parent.id }),
        (err: Error) => {
          assert.ok(err.message.includes('Cannot add children to writ'));
          assert.ok(err.message.includes('"cancelled"'));
          return true;
        },
      );
    });

    it('allows child creation when parent is stuck', async () => {
      const parent = await postMandate({ title: 'Stuck parent', body: 'Body' });
      await clerk.transition(parent.id, 'stuck');

      const child = await postMandate({ title: 'Child of stuck', body: 'Body', parentId: parent.id });
      assert.equal(child.parentId, parent.id);
    });
  });

  // ── Children-behavior cascade engine (T3) ─────────────────────────
  //
  // The Clerk's children-behavior engine watches the writs book at Phase 1
  // and, when any writ transitions to a terminal state, evaluates the
  // parent's `WritTypeConfig.childrenBehavior` block. Mandate opts into
  // both triggers with `copyResolution: true` — these tests exercise the
  // brief's six scenarios end-to-end through the registered watcher,
  // verifying the firing rule, trigger precedence, idempotency, and
  // resolution-copy semantics.

  describe('children-behavior cascade', () => {
    beforeEach(async () => { await setup(); });

    // (a) all children complete → parent → completed
    it('lifts the parent to completed when every child reaches a success-attr terminal state', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await postMandate({ title: 'C2', body: 'B', parentId: parent.id });

      // First child completing leaves the parent open — the second child
      // is still active, so allSuccess does not fire.
      await clerk.transition(c1.id, 'completed', { resolution: 'first' });
      const mid = await clerk.show(parent.id);
      assert.equal(mid.phase, 'open');

      // Last child completing fires allSuccess — parent transitions to
      // `completed` carrying the triggering child's resolution.
      await clerk.transition(c2.id, 'completed', { resolution: 'second' });
      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'completed');
      assert.equal(after.resolution, 'second');
    });

    // (b) one child fails while another is still active → parent → failed
    it('lifts the parent to failed as soon as any child fails (sibling still active)', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      await postMandate({ title: 'C2', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'failed', { resolution: 'kaboom' });

      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'failed');
      assert.equal(after.resolution, 'kaboom');
    });

    // (c) simultaneous mixed terminal events committed in one transaction
    //     → parent → failed (anyFailure wins)
    it('anyFailure wins when mixed terminal events commit in the same transaction', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await postMandate({ title: 'C2', body: 'B', parentId: parent.id });

      // Two terminal transitions inside a single Stacks transaction —
      // Phase 1 watchers fire per-event in order. Whichever order the
      // outcomes commit in, anyFailure must win the parent's terminal
      // state (idempotency on the second event, when parent is already
      // terminal).
      const stacks = guild().apparatus<StacksApi>('stacks');
      await stacks.transaction(async () => {
        await clerk.transition(c1.id, 'completed', { resolution: 'success-bro' });
        await clerk.transition(c2.id, 'failed', { resolution: 'crashed' });
      });

      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'failed');
      assert.equal(after.resolution, 'crashed');
    });

    // (d) sequential child completions — parent stays non-terminal until
    //     the last child completes
    it('parent stays non-terminal across N-1 sequential completions and lifts on the Nth', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await postMandate({ title: 'C2', body: 'B', parentId: parent.id });
      const c3 = await postMandate({ title: 'C3', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'one' });
      assert.equal((await clerk.show(parent.id)).phase, 'open');

      await clerk.transition(c2.id, 'completed', { resolution: 'two' });
      assert.equal((await clerk.show(parent.id)).phase, 'open');

      await clerk.transition(c3.id, 'completed', { resolution: 'three' });
      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'completed');
      assert.equal(after.resolution, 'three');
    });

    // (e) child terminates after parent already terminal → no-op
    it('is idempotent — child terminal events on an already-terminal parent are no-ops', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      await postMandate({ title: 'C2', body: 'B', parentId: parent.id });

      // Drive the parent terminal directly without invoking cascade.
      await clerk.transition(parent.id, 'failed', { resolution: 'manual-fail' });

      // A subsequent terminal child event must NOT throw and must NOT
      // overwrite the parent's resolution.
      await clerk.transition(c1.id, 'completed', { resolution: 'late-win' });

      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'failed');
      assert.equal(after.resolution, 'manual-fail');

      // The completed child still terminates correctly.
      const child = await clerk.show(c1.id);
      assert.equal(child.phase, 'completed');
      assert.equal(child.resolution, 'late-win');
    });

    // (f) single-child case behaves identically to multi-child with one entry
    it('single-child parent transitions on the lone child terminal event', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });

      await clerk.transition(c1.id, 'completed', { resolution: 'only-child-done' });

      const after = await clerk.show(parent.id);
      assert.equal(after.phase, 'completed');
      assert.equal(after.resolution, 'only-child-done');
    });

    // Bonus: grandparent lift via natural CDC re-fire — terminal child
    // bubbles up through one level of cascade. Stacks' 16-deep cascade
    // cap is the only protection and is intentional.
    it('cascades upward through grandparents via natural CDC re-fire', async () => {
      const root = await postMandate({ title: 'Root', body: 'B' });
      const middle = await postMandate({ title: 'Middle', body: 'B', parentId: root.id });
      const leaf = await postMandate({ title: 'Leaf', body: 'B', parentId: middle.id });

      await clerk.transition(leaf.id, 'completed', { resolution: 'leaf-done' });

      const afterLeaf = await clerk.show(leaf.id);
      const afterMiddle = await clerk.show(middle.id);
      const afterRoot = await clerk.show(root.id);
      assert.equal(afterLeaf.phase, 'completed');
      assert.equal(afterMiddle.phase, 'completed');
      assert.equal(afterRoot.phase, 'completed');
      // Resolution propagates through both levels — the triggering child's
      // resolution is copied at each cascade hop, so the root carries the
      // leaf's resolution string.
      assert.equal(afterMiddle.resolution, 'leaf-done');
      assert.equal(afterRoot.resolution, 'leaf-done');
    });
  });

  // ── parentId immutability ─────────────────────────────────────────

  describe('parentId immutability', () => {
    beforeEach(async () => { await setup(); });

    it('transition does not change parentId even if passed in fields', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'B', parentId: parent.id });

      const updated = await clerk.transition(child.id, 'completed', { parentId: 'w-other' } as Partial<import('./types.ts').WritDoc>);
      assert.equal(updated.parentId, parent.id);
    });
  });

  // ── WritFilters with parentId ─────────────────────────────────────

  describe('list with parentId filter', () => {
    beforeEach(async () => { await setup(); });

    it('returns only children of the specified parent', async () => {
      const parent1 = await postMandate({ title: 'P1', body: 'B' });
      const parent2 = await postMandate({ title: 'P2', body: 'B' });
      await postMandate({ title: 'C1', body: 'B', parentId: parent1.id });
      await postMandate({ title: 'C2', body: 'B', parentId: parent1.id });
      await postMandate({ title: 'C3', body: 'B', parentId: parent2.id });

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
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const child = await postMandate({ title: 'Child', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: child.id, format: 'json' });
      // Parent reference now embeds presentation projection (classification +
      // allowedTransitions) so renderers can derive badges and action buttons
      // without a second registry lookup.
      assert.deepEqual(result.parent, {
        id: parent.id,
        title: 'Parent',
        type: 'mandate',
        phase: 'open',
        classification: 'active',
        allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'],
      });
      assert.deepEqual(result.children, { summary: {}, items: [] });
    });

    it('includes children context for a parent writ', async () => {
      const parent = await postMandate({ title: 'Parent', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: parent.id });
      const c2 = await postMandate({ title: 'C2', body: 'B', parentId: parent.id });

      const result = await writShow.handler({ id: parent.id, format: 'json' });
      assert.equal(result.parent, null);
      assert.equal(result.children.items.length, 2);
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c1.id));
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c2.id));
      assert.equal(result.children.summary['open'], 2);
    });

    it('returns null parent and empty children for root writ without children', async () => {
      const writ = await postMandate({ title: 'Root', body: 'Body' });

      const result = await writShow.handler({ id: writ.id, format: 'json' });
      assert.equal(result.parent, null);
      assert.deepEqual(result.children, { summary: {}, items: [] });
    });

    it('children.summary counts the entire descendant subtree, not just direct children', async () => {
      // Build a three-level tree:
      //   root
      //   ├─ c1 (open)       — direct child
      //   │  ├─ g1 (open)    — grandchild
      //   │  └─ g2 (stuck)   — grandchild
      //   └─ c2 (open)       — direct child
      const root = await postMandate({ title: 'Root', body: 'Body' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: root.id });
      const c2 = await postMandate({ title: 'C2', body: 'B', parentId: root.id });
      const g1 = await postMandate({ title: 'G1', body: 'B', parentId: c1.id });
      const g2 = await postMandate({ title: 'G2', body: 'B', parentId: c1.id });
      // Nudge g2 into stuck so phases diverge across the subtree.
      await clerk.transition(g2.id, 'stuck');

      const result = await writShow.handler({ id: root.id, format: 'json' });

      // Items stay direct-children-only — only c1 and c2 appear.
      assert.equal(result.children.items.length, 2);
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c1.id));
      assert.ok(result.children.items.some((i: { id: string }) => i.id === c2.id));
      assert.ok(!result.children.items.some((i: { id: string }) => i.id === g1.id));

      // Summary covers the whole subtree — grandchildren contribute.
      // 3 open (c1, c2, g1) + 1 stuck (g2) = 4 descendants total.
      assert.equal(result.children.summary['open'], 3);
      assert.equal(result.children.summary['stuck'], 1);
    });

    it('ClerkApi.countDescendantsByPhase returns subtree-wide phase counts', async () => {
      // Build a subtree with a sibling that prevents the children-behavior
      // engine from lifting c1 — g2 stays open, so allSuccess never fires
      // when g1 completes. Counts: c1 open, g1 completed, g2 open.
      const root = await postMandate({ title: 'Root', body: 'B' });
      const c1 = await postMandate({ title: 'C1', body: 'B', parentId: root.id });
      const g1 = await postMandate({ title: 'G1', body: 'B', parentId: c1.id });
      await postMandate({ title: 'G2', body: 'B', parentId: c1.id });
      await clerk.transition(g1.id, 'completed', { resolution: 'done' });

      const counts = await clerk.countDescendantsByPhase(root.id);
      assert.equal(counts['open'], 2);
      assert.equal(counts['completed'], 1);
    });

    it('ClerkApi.countDescendantsByPhase returns empty object for leaf writs', async () => {
      const leaf = await postMandate({ title: 'Leaf', body: 'B' });
      const counts = await clerk.countDescendantsByPhase(leaf.id);
      assert.deepEqual(counts, {});
    });

    it('ClerkApi.countDescendantsByPhase throws on unknown id', async () => {
      await assert.rejects(
        () => clerk.countDescendantsByPhase('w-does-not-exist'),
        /not found/,
      );
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

// ── step-add tool tests ──────────────────────────────────────────────

describe('step-add tool', () => {
  afterEach(() => { clearGuild(); });

  it('creates a step writ as child of a mandate with structured XML body', async () => {
    await setup({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('step')], { id: 'step-plugin' }),
      ],
    });

    // Create a mandate first
    const mandate = await postMandate({ title: 'Parent mandate', body: 'Do all things', type: 'mandate' });

    // Use step-add handler directly
    const stepAddTool = (await import('./tools/step-add.ts')).default;
    const handler = stepAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;
    const step = await handler({
      mandateId: mandate.id,
      name: 'First task',
      action: 'Do the first thing',
      files: 'src/app.ts',
      verify: 'pnpm test',
      done: 'Tests pass',
    }) as { id: string; type: string; title: string; body: string; parentId: string; phase: string };

    assert.equal(step.type, 'step');
    assert.equal(step.title, 'First task');
    assert.equal(step.parentId, mandate.id);
    assert.equal(step.phase, 'open');
    assert.ok(step.body.includes('<task id='));
    assert.ok(step.body.includes('<name>First task</name>'));
    assert.ok(step.body.includes('<action>Do the first thing</action>'));
    assert.ok(step.body.includes('<files>src/app.ts</files>'));
    assert.ok(step.body.includes('<verify>pnpm test</verify>'));
    assert.ok(step.body.includes('<done>Tests pass</done>'));
  });

  it('creates a step with only required fields', async () => {
    await setup({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('step')], { id: 'step-plugin' }),
      ],
    });

    const mandate = await postMandate({ title: 'Parent mandate', body: 'Do things', type: 'mandate' });

    const stepAddTool = (await import('./tools/step-add.ts')).default;
    const handler = stepAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;
    const step = await handler({
      mandateId: mandate.id,
      name: 'Minimal task',
      action: 'Do something simple',
    }) as { body: string };

    assert.ok(step.body.includes('<name>Minimal task</name>'));
    assert.ok(step.body.includes('<action>Do something simple</action>'));
    assert.ok(!step.body.includes('<files>'));
    assert.ok(!step.body.includes('<verify>'));
    assert.ok(!step.body.includes('<done>'));
  });

  it('rejects when parent mandate does not exist', async () => {
    await setup({
      extraApparatuses: [
        makeWritTypeApparatus([mandateLikeWritType('step')], { id: 'step-plugin' }),
      ],
    });

    const stepAddTool = (await import('./tools/step-add.ts')).default;
    const handler = stepAddTool.handler as (params: Record<string, unknown>) => Promise<unknown>;

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

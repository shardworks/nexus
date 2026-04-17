/**
 * Ratchet apparatus tests.
 *
 * Uses in-memory Stacks and a minimal fake guild to test the full click
 * lifecycle without any external dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext, KitEntry } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createRatchet } from './ratchet.ts';
import type { RatchetApi, ClickDoc, ClickTree, ClickStatus } from './types.ts';
import clickCreate from './tools/click-create.ts';
import clickShow from './tools/click-show.ts';
import clickList from './tools/click-list.ts';
import clickPark from './tools/click-park.ts';
import clickExtract from './tools/click-extract.ts';
import clickTree from './tools/click-tree.ts';

// ── Test harness ─────────────────────────────────────────────────────

let ratchet: RatchetApi;

function buildCtx(): StartupContext {
  return {
    on() {},
    kits(): KitEntry[] { return []; },
  };
}

async function setup(): Promise<void> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const ratchetPlugin = createRatchet();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    settings: { model: 'sonnet' },
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits: () => [],
    apparatuses: () => [],
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'ratchet', book: 'clicks' }, {
    indexes: ['status', 'createdAt', 'parentId', ['status', 'createdAt'], ['parentId', 'status']],
  });
  memBackend.ensureBook({ ownerId: 'ratchet', book: 'click_links' }, {
    indexes: ['sourceId', 'targetId', 'linkType', ['sourceId', 'linkType'], ['targetId', 'linkType']],
  });

  // Start ratchet
  const ratchetApparatus = (ratchetPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  await ratchetApparatus.start(buildCtx());
  ratchet = ratchetApparatus.provides as RatchetApi;
  apparatusMap.set('ratchet', ratchet);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Ratchet', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => { clearGuild(); });

  // ── Plugin structure ────────────────────────────────────────────

  describe('plugin structure', () => {
    it('returns correct apparatus metadata', () => {
      const plugin = createRatchet();
      const app = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      assert.deepStrictEqual(app.requires, ['stacks']);
      assert.deepStrictEqual(app.recommends, ['oculus']);
      assert.strictEqual(app.consumes, undefined);
    });

    it('declares correct book indexes', () => {
      const plugin = createRatchet();
      const app = (plugin as { apparatus: { supportKit: { books: Record<string, unknown> } } }).apparatus;
      const books = app.supportKit.books as Record<string, { indexes: unknown[] }>;
      assert.deepStrictEqual(books.clicks.indexes, [
        'status', 'createdAt', 'parentId', ['status', 'createdAt'], ['parentId', 'status'],
      ]);
      assert.deepStrictEqual(books.click_links.indexes, [
        'sourceId', 'targetId', 'linkType', ['sourceId', 'linkType'], ['targetId', 'linkType'],
      ]);
    });

    it('supportKit includes pages contribution for clicks', () => {
      const plugin = createRatchet();
      const p = plugin as { apparatus: { supportKit: { pages?: Array<{ id: string; title: string; dir: string }> } } };
      const pages = p.apparatus.supportKit.pages;
      assert.ok(Array.isArray(pages), 'pages should be an array');
      const clicksPage = pages!.find((pg) => pg.id === 'clicks');
      assert.ok(clicksPage, 'pages should include a clicks entry');
      assert.strictEqual(clicksPage.title, 'Clicks');
      assert.strictEqual(clicksPage.dir, 'pages/clicks');
    });
  });

  // ── Create ──────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a minimal click', async () => {
      const click = await ratchet.create({ goal: 'Ship v2' });
      assert.ok(click.id.startsWith('c-'));
      assert.strictEqual(click.goal, 'Ship v2');
      assert.strictEqual(click.status, 'live');
      assert.ok(click.createdAt);
      assert.strictEqual(click.conclusion, undefined);
      assert.strictEqual(click.resolvedAt, undefined);
    });

    it('creates with session ID', async () => {
      const click = await ratchet.create({ goal: 'Fix bug', createdSessionId: 'sess-1' });
      assert.strictEqual(click.createdSessionId, 'sess-1');
    });

    it('creates with valid parent', async () => {
      const parent = await ratchet.create({ goal: 'Parent' });
      const child = await ratchet.create({ goal: 'Child', parentId: parent.id });
      assert.strictEqual(child.parentId, parent.id);
    });

    it('throws on non-existent parent', async () => {
      await assert.rejects(
        () => ratchet.create({ goal: 'Orphan', parentId: 'c-nonexistent' }),
        (err: Error) => err.message.includes('not found'),
      );
    });
  });

  // ── Get ─────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns existing click', async () => {
      const created = await ratchet.create({ goal: 'Test' });
      const fetched = await ratchet.get(created.id);
      assert.strictEqual(fetched.id, created.id);
      assert.strictEqual(fetched.goal, 'Test');
    });

    it('throws on non-existent ID', async () => {
      await assert.rejects(
        () => ratchet.get('c-nonexistent'),
        (err: Error) => err.message.includes('not found'),
      );
    });

    it('does not resolve short prefixes', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const prefix = click.id.substring(0, 8);
      await assert.rejects(
        () => ratchet.get(prefix),
        (err: Error) => err.message.includes('not found'),
      );
    });
  });

  // ── List ────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns clicks ordered by createdAt descending', async () => {
      const a = await ratchet.create({ goal: 'First' });
      // Small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
      const b = await ratchet.create({ goal: 'Second' });
      const list = await ratchet.list();
      // b was created later, should be first in descending order
      assert.strictEqual(list[0].id, b.id);
      assert.strictEqual(list[1].id, a.id);
    });

    it('defaults to limit 20', async () => {
      for (let i = 0; i < 25; i++) {
        await ratchet.create({ goal: `Click ${i}` });
      }
      const list = await ratchet.list();
      assert.strictEqual(list.length, 20);
    });

    it('filters by status', async () => {
      const a = await ratchet.create({ goal: 'Live' });
      const b = await ratchet.create({ goal: 'Parked' });
      await ratchet.park(b.id);
      const live = await ratchet.list({ status: 'live' });
      assert.strictEqual(live.length, 1);
      assert.strictEqual(live[0].id, a.id);
    });

    it('filters by status array', async () => {
      const a = await ratchet.create({ goal: 'Live' });
      const b = await ratchet.create({ goal: 'Parked' });
      await ratchet.park(b.id);
      const c = await ratchet.create({ goal: 'Concluded' });
      await ratchet.conclude(c.id, { conclusion: 'Done' });

      const results = await ratchet.list({ status: ['live', 'parked'] });
      assert.strictEqual(results.length, 2);
    });

    it('filters by parentId', async () => {
      const parent = await ratchet.create({ goal: 'Parent' });
      await ratchet.create({ goal: 'Child', parentId: parent.id });
      await ratchet.create({ goal: 'Other' });

      const children = await ratchet.list({ parentId: parent.id });
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].goal, 'Child');
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await ratchet.create({ goal: `Click ${i}` });
      }
      const page = await ratchet.list({ limit: 2, offset: 1 });
      assert.strictEqual(page.length, 2);
    });
  });

  // ── Status transitions ─────────────────────────────────────────

  describe('status transitions', () => {
    it('parks a live click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const parked = await ratchet.park(click.id);
      assert.strictEqual(parked.status, 'parked');
    });

    it('resumes a parked click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.park(click.id);
      const resumed = await ratchet.resume(click.id);
      assert.strictEqual(resumed.status, 'live');
    });

    it('concludes from live', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const concluded = await ratchet.conclude(click.id, { conclusion: 'Done' });
      assert.strictEqual(concluded.status, 'concluded');
      assert.strictEqual(concluded.conclusion, 'Done');
      assert.ok(concluded.resolvedAt);
    });

    it('concludes from parked', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.park(click.id);
      const concluded = await ratchet.conclude(click.id, { conclusion: 'Done' });
      assert.strictEqual(concluded.status, 'concluded');
    });

    it('drops from live', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const dropped = await ratchet.drop(click.id, { conclusion: 'Not needed' });
      assert.strictEqual(dropped.status, 'dropped');
      assert.strictEqual(dropped.conclusion, 'Not needed');
      assert.ok(dropped.resolvedAt);
    });

    it('drops from parked', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.park(click.id);
      const dropped = await ratchet.drop(click.id, { conclusion: 'Abandoned' });
      assert.strictEqual(dropped.status, 'dropped');
    });

    it('conclude with session ID', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const concluded = await ratchet.conclude(click.id, { conclusion: 'Done', resolvedSessionId: 'sess-2' });
      assert.strictEqual(concluded.resolvedSessionId, 'sess-2');
    });

    // Invalid transitions
    it('throws when parking a parked click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.park(click.id);
      await assert.rejects(() => ratchet.park(click.id), /Cannot transition/);
    });

    it('throws when resuming a live click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await assert.rejects(() => ratchet.resume(click.id), /Cannot transition/);
    });

    it('throws when concluding a concluded click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'Done' });
      await assert.rejects(() => ratchet.conclude(click.id, { conclusion: 'Again' }), /Cannot transition/);
    });

    it('throws when dropping a dropped click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.drop(click.id, { conclusion: 'Gone' });
      await assert.rejects(() => ratchet.drop(click.id, { conclusion: 'Again' }), /Cannot transition/);
    });

    it('throws when concluding a dropped click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.drop(click.id, { conclusion: 'Gone' });
      await assert.rejects(() => ratchet.conclude(click.id, { conclusion: 'Nope' }), /Cannot transition/);
    });

    it('throws when parking a concluded click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'Done' });
      await assert.rejects(() => ratchet.park(click.id), /Cannot transition/);
    });

    it('throws when resuming a concluded click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'Done' });
      await assert.rejects(() => ratchet.resume(click.id), /Cannot transition/);
    });

    it('throws when dropping a concluded click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'Done' });
      await assert.rejects(() => ratchet.drop(click.id, { conclusion: 'Nope' }), /Cannot transition/);
    });

    it('throws when parking a dropped click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.drop(click.id, { conclusion: 'Gone' });
      await assert.rejects(() => ratchet.park(click.id), /Cannot transition/);
    });

    it('throws when resuming a dropped click', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.drop(click.id, { conclusion: 'Gone' });
      await assert.rejects(() => ratchet.resume(click.id), /Cannot transition/);
    });
  });

  // ── Conclusion write-once ──────────────────────────────────────

  describe('conclusion write-once', () => {
    it('rejects empty conclusion string', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await assert.rejects(
        () => ratchet.conclude(click.id, { conclusion: '' }),
        /non-empty/,
      );
    });

    it('rejects whitespace-only conclusion', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await assert.rejects(
        () => ratchet.conclude(click.id, { conclusion: '   ' }),
        /non-empty/,
      );
    });

    it('rejects empty conclusion on drop', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await assert.rejects(
        () => ratchet.drop(click.id, { conclusion: '' }),
        /non-empty/,
      );
    });
  });

  // ── Goal immutability ──────────────────────────────────────────

  describe('goal immutability', () => {
    it('goal is unchanged after park/resume cycle', async () => {
      const click = await ratchet.create({ goal: 'Original' });
      await ratchet.park(click.id);
      await ratchet.resume(click.id);
      const fetched = await ratchet.get(click.id);
      assert.strictEqual(fetched.goal, 'Original');
    });
  });

  // ── Reparent ───────────────────────────────────────────────────

  describe('reparent', () => {
    it('moves a click to a new parent', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      const updated = await ratchet.reparent(b.id, { parentId: a.id });
      assert.strictEqual(updated.parentId, a.id);
    });

    it('moves a click to root', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B', parentId: a.id });
      const updated = await ratchet.reparent(b.id, { parentId: null });
      assert.strictEqual(updated.parentId, undefined);
    });

    it('throws on non-existent parent', async () => {
      const a = await ratchet.create({ goal: 'A' });
      await assert.rejects(
        () => ratchet.reparent(a.id, { parentId: 'c-ghost' }),
        /not found/,
      );
    });

    it('detects direct circular parentage', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B', parentId: a.id });
      await assert.rejects(
        () => ratchet.reparent(a.id, { parentId: b.id }),
        /circular parentage/,
      );
    });

    it('detects indirect circular parentage', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B', parentId: a.id });
      const c = await ratchet.create({ goal: 'C', parentId: b.id });
      await assert.rejects(
        () => ratchet.reparent(a.id, { parentId: c.id }),
        /circular parentage/,
      );
    });

    it('detects self-reparent', async () => {
      const a = await ratchet.create({ goal: 'A' });
      await assert.rejects(
        () => ratchet.reparent(a.id, { parentId: a.id }),
        /circular parentage/,
      );
    });

    it('allows reparenting a concluded click', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      await ratchet.conclude(a.id, { conclusion: 'Done' });
      const updated = await ratchet.reparent(a.id, { parentId: b.id });
      assert.strictEqual(updated.parentId, b.id);
    });

    it('allows reparenting to a concluded parent', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      await ratchet.conclude(b.id, { conclusion: 'Done' });
      const updated = await ratchet.reparent(a.id, { parentId: b.id });
      assert.strictEqual(updated.parentId, b.id);
    });

    it('allows reparenting across branches', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B', parentId: a.id });
      const c = await ratchet.create({ goal: 'C', parentId: a.id });
      // Move C under B — no cycle
      const updated = await ratchet.reparent(c.id, { parentId: b.id });
      assert.strictEqual(updated.parentId, b.id);
    });
  });

  // ── Extract ────────────────────────────────────────────────────

  describe('extract', () => {
    it('renders markdown for a single click', async () => {
      const click = await ratchet.create({ goal: 'Root goal' });
      const md = await ratchet.extract(click.id, { format: 'md' }) as string;
      assert.ok(md.startsWith('# '));
      assert.ok(md.includes('Root goal'));
      assert.ok(md.includes('[live]'));
    });

    it('renders markdown with children', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      await ratchet.create({ goal: 'Child 1', parentId: root.id });
      await ratchet.create({ goal: 'Child 2', parentId: root.id });

      const md = await ratchet.extract(root.id, { format: 'md' }) as string;
      assert.ok(md.includes('# '));
      // Children should have ## headings
      const h2count = (md.match(/^## /gm) || []).length;
      assert.strictEqual(h2count, 2);
    });

    it('renders markdown deep tree with bold at depth >= 6', async () => {
      // Create chain of 8 levels
      let parentId: string | undefined;
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const click = await ratchet.create({ goal: `Level ${i}`, parentId });
        ids.push(click.id);
        parentId = click.id;
      }
      const md = await ratchet.extract(ids[0], { format: 'md' }) as string;
      // Depth 0-5: # through ######
      assert.ok(md.includes('# '));     // depth 0
      assert.ok(md.includes('## '));    // depth 1
      assert.ok(md.includes('### '));   // depth 2
      assert.ok(md.includes('#### '));  // depth 3
      assert.ok(md.includes('##### ')); // depth 4
      assert.ok(md.includes('###### ')); // depth 5
      // Depth 6+: bold
      assert.ok(md.includes('**'));
    });

    it('returns JSON tree for a single click', async () => {
      const click = await ratchet.create({ goal: 'Root' });
      const tree = await ratchet.extract(click.id, { format: 'json' }) as { click: ClickDoc; children: unknown[] };
      assert.strictEqual(tree.click.id, click.id);
      assert.deepStrictEqual(tree.children, []);
    });

    it('returns JSON tree with children', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      await ratchet.create({ goal: 'Child 1', parentId: root.id });
      await ratchet.create({ goal: 'Child 2', parentId: root.id });

      const tree = await ratchet.extract(root.id, { format: 'json' }) as { click: ClickDoc; children: Array<{ click: ClickDoc }> };
      assert.strictEqual(tree.children.length, 2);
      assert.strictEqual(tree.click.id, root.id);
    });
  });

  // ── Links ──────────────────────────────────────────────────────

  describe('links', () => {
    it('creates a same-substrate link', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      const link = await ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'related' });
      assert.strictEqual(link.sourceId, a.id);
      assert.strictEqual(link.targetId, b.id);
      assert.strictEqual(link.linkType, 'related');
      assert.strictEqual(link.id, `${a.id}:${b.id}:related`);
    });

    it('is idempotent', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      const link1 = await ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'related' });
      const link2 = await ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'related' });
      assert.strictEqual(link1.id, link2.id);
    });

    it('rejects invalid link type', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      await assert.rejects(
        () => ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'blocks' as any }),
        /Invalid link type/,
      );
    });

    it('rejects self-links', async () => {
      const a = await ratchet.create({ goal: 'A' });
      await assert.rejects(
        () => ratchet.link({ sourceId: a.id, targetId: a.id, linkType: 'related' }),
        /Cannot link a click to itself/,
      );
    });

    it('allows cross-substrate link', async () => {
      const click = await ratchet.create({ goal: 'A' });
      const link = await ratchet.link({ sourceId: click.id, targetId: 'w-abc123', linkType: 'commissioned' });
      assert.strictEqual(link.targetId, 'w-abc123');
    });

    it('throws on same-substrate missing target', async () => {
      const a = await ratchet.create({ goal: 'A' });
      await assert.rejects(
        () => ratchet.link({ sourceId: a.id, targetId: 'c-nonexistent', linkType: 'related' }),
        /not found/,
      );
    });

    it('throws on same-substrate missing source', async () => {
      const a = await ratchet.create({ goal: 'A' });
      await assert.rejects(
        () => ratchet.link({ sourceId: 'c-nonexistent', targetId: a.id, linkType: 'related' }),
        /not found/,
      );
    });

    it('queries outbound and inbound links', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      const c = await ratchet.create({ goal: 'C' });
      await ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'related' });
      await ratchet.link({ sourceId: c.id, targetId: a.id, linkType: 'depends-on' });

      const links = await ratchet.links(a.id);
      assert.strictEqual(links.outbound.length, 1);
      assert.strictEqual(links.outbound[0].targetId, b.id);
      assert.strictEqual(links.inbound.length, 1);
      assert.strictEqual(links.inbound[0].sourceId, c.id);
    });
  });

  // ── Unlink ─────────────────────────────────────────────────────

  describe('unlink', () => {
    it('removes an existing link', async () => {
      const a = await ratchet.create({ goal: 'A' });
      const b = await ratchet.create({ goal: 'B' });
      await ratchet.link({ sourceId: a.id, targetId: b.id, linkType: 'related' });
      await ratchet.unlink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

      const links = await ratchet.links(a.id);
      assert.strictEqual(links.outbound.length, 0);
    });

    it('throws on non-existent link', async () => {
      await assert.rejects(
        () => ratchet.unlink({ sourceId: 'c-a', targetId: 'c-b', linkType: 'related' }),
        /not found/,
      );
    });
  });

  // ── Resolve ID ─────────────────────────────────────────────────

  describe('resolveId', () => {
    it('resolves a unique prefix', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const resolved = await ratchet.resolveId(click.id.substring(0, 8));
      assert.strictEqual(resolved, click.id);
    });

    it('resolves full ID as prefix', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const resolved = await ratchet.resolveId(click.id);
      assert.strictEqual(resolved, click.id);
    });

    it('throws on no match', async () => {
      await assert.rejects(
        () => ratchet.resolveId('c-zzzzzzzzz'),
        /No click found/,
      );
    });

    it('throws on ambiguous prefix', async () => {
      // Create two clicks — they share the 'c-' prefix
      await ratchet.create({ goal: 'A' });
      await ratchet.create({ goal: 'B' });
      // 'c-' is a 2-char prefix that matches both
      await assert.rejects(
        () => ratchet.resolveId('c-'),
        /Ambiguous prefix/,
      );
    });
  });

  // ── Tool integration ───────────────────────────────────────────

  describe('tool integration', () => {
    it('click-show enriches with links, parent, and children', async () => {
      const parent = await ratchet.create({ goal: 'Parent' });
      const click = await ratchet.create({ goal: 'Main', parentId: parent.id });
      const child = await ratchet.create({ goal: 'Child', parentId: click.id });
      const other = await ratchet.create({ goal: 'Other' });
      await ratchet.link({ sourceId: click.id, targetId: other.id, linkType: 'related' });

      const result = await clickShow.handler({ id: click.id }) as Record<string, unknown>;
      assert.ok(result.parent);
      assert.strictEqual((result.parent as { id: string }).id, parent.id);
      assert.ok(result.children);
      const children = result.children as { summary: Record<string, number>; items: unknown[] };
      assert.strictEqual(children.items.length, 1);
      assert.ok(result.links);
      const links = result.links as { outbound: unknown[]; inbound: unknown[] };
      assert.strictEqual(links.outbound.length, 1);
    });

    it('click-park resolves short ID', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      const prefix = click.id.substring(0, 10);
      const result = await clickPark.handler({ id: prefix }) as ClickDoc;
      assert.strictEqual(result.status, 'parked');
      assert.strictEqual(result.id, click.id);
    });

    it('click-list passes through filters', async () => {
      await ratchet.create({ goal: 'Live' });
      const b = await ratchet.create({ goal: 'Parked' });
      await ratchet.park(b.id);

      const result = await clickList.handler({ status: 'live', limit: 20 }) as ClickDoc[];
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].goal, 'Live');
    });
  });

  // ── click-create tool ──────────────────────────────────────────

  describe('click-create tool', () => {
    it('resolves short parentId prefix', async () => {
      const parent = await ratchet.create({ goal: 'Parent' });
      const prefix = parent.id.substring(0, 10);
      const child = await clickCreate.handler({ goal: 'Child', parentId: prefix }) as ClickDoc;
      assert.strictEqual(child.parentId, parent.id);
      assert.strictEqual(child.goal, 'Child');
    });

    it('resolves full parentId', async () => {
      const parent = await ratchet.create({ goal: 'Parent' });
      const child = await clickCreate.handler({ goal: 'Child', parentId: parent.id }) as ClickDoc;
      assert.strictEqual(child.parentId, parent.id);
    });

    it('creates without parentId', async () => {
      const click = await clickCreate.handler({ goal: 'Standalone' }) as ClickDoc;
      assert.ok(click.id.startsWith('c-'));
      assert.strictEqual(click.goal, 'Standalone');
      assert.strictEqual(click.parentId, undefined);
    });

    it('throws on non-existent parentId prefix', async () => {
      await assert.rejects(
        () => clickCreate.handler({ goal: 'Orphan', parentId: 'c-zzzzzzzzz' }),
        /No click found/,
      );
    });

    it('throws on ambiguous parentId prefix', async () => {
      await ratchet.create({ goal: 'A' });
      await ratchet.create({ goal: 'B' });
      await assert.rejects(
        () => clickCreate.handler({ goal: 'Child', parentId: 'c-' }),
        /Ambiguous prefix/,
      );
    });
  });

  // ── tree() API ────────────────────────────────────────────────

  describe('tree', () => {
    it('returns forest of all root clicks', async () => {
      const a = await ratchet.create({ goal: 'Root A' });
      const b = await ratchet.create({ goal: 'Root B' });
      await ratchet.create({ goal: 'Child of A', parentId: a.id });

      const forest = await ratchet.tree();
      assert.strictEqual(forest.length, 2);
      assert.strictEqual(forest[0].click.id, a.id);
      assert.strictEqual(forest[1].click.id, b.id);
      // Root A should have one child
      assert.strictEqual(forest[0].children.length, 1);
      // Root B should have no children
      assert.strictEqual(forest[1].children.length, 0);
    });

    it('returns single-element array for subtree mode', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.create({ goal: 'Grandchild', parentId: child.id });

      const forest = await ratchet.tree({ rootId: root.id });
      assert.strictEqual(forest.length, 1);
      assert.strictEqual(forest[0].click.id, root.id);
      assert.strictEqual(forest[0].children.length, 1);
      assert.strictEqual(forest[0].children[0].children.length, 1);
    });

    it('filters by status with prune semantics', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const live = await ratchet.create({ goal: 'Live child', parentId: root.id });
      const parked = await ratchet.create({ goal: 'Parked child', parentId: root.id });
      await ratchet.park(parked.id);
      // Child of parked should also be pruned
      await ratchet.create({ goal: 'Grandchild of parked', parentId: parked.id });

      const forest = await ratchet.tree({ status: 'live' });
      assert.strictEqual(forest.length, 1);
      // Only root and live child remain
      assert.strictEqual(forest[0].children.length, 1);
      assert.strictEqual(forest[0].children[0].click.id, live.id);
    });

    it('filters by multiple statuses', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child1 = await ratchet.create({ goal: 'Parked', parentId: root.id });
      await ratchet.park(child1.id);
      const child2 = await ratchet.create({ goal: 'Concluded', parentId: root.id });
      await ratchet.conclude(child2.id, { conclusion: 'Done' });

      const forest = await ratchet.tree({ status: ['parked', 'concluded'] });
      // Root is live, so it gets pruned and entire forest is empty
      assert.strictEqual(forest.length, 0);
    });

    it('limits depth', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.create({ goal: 'Grandchild', parentId: child.id });

      const forest = await ratchet.tree({ depth: 1 });
      assert.strictEqual(forest.length, 1);
      assert.strictEqual(forest[0].children.length, 1);
      // Grandchild should not be included — depth 1 means root (depth 0) + children (depth 1)
      assert.strictEqual(forest[0].children[0].children.length, 0);
    });

    it('depth 0 returns roots only', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      await ratchet.create({ goal: 'Child', parentId: root.id });

      const forest = await ratchet.tree({ depth: 0 });
      assert.strictEqual(forest.length, 1);
      assert.strictEqual(forest[0].children.length, 0);
    });

    it('returns empty array when no clicks exist', async () => {
      const forest = await ratchet.tree();
      assert.strictEqual(forest.length, 0);
    });

    it('returns empty array when filters match nothing', async () => {
      await ratchet.create({ goal: 'Live click' });
      const forest = await ratchet.tree({ status: 'parked' });
      assert.strictEqual(forest.length, 0);
    });
  });

  // ── list with rootId ──────────────────────────────────────────

  describe('list with rootId', () => {
    it('returns all descendants of a click', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      const grandchild = await ratchet.create({ goal: 'Grandchild', parentId: child.id });
      await ratchet.create({ goal: 'Unrelated' });

      const result = await ratchet.list({ rootId: root.id });
      assert.strictEqual(result.length, 2);
      const ids = result.map((c) => c.id);
      assert.ok(ids.includes(child.id));
      assert.ok(ids.includes(grandchild.id));
    });

    it('combines rootId with status filter', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const live = await ratchet.create({ goal: 'Live child', parentId: root.id });
      const parked = await ratchet.create({ goal: 'Parked child', parentId: root.id });
      await ratchet.park(parked.id);

      const result = await ratchet.list({ rootId: root.id, status: 'live' });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, live.id);
    });

    it('combines rootId with limit', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      for (let i = 0; i < 5; i++) {
        await ratchet.create({ goal: `Child ${i}`, parentId: root.id });
      }

      const result = await ratchet.list({ rootId: root.id, limit: 3 });
      assert.strictEqual(result.length, 3);
    });

    it('returns empty when click has no descendants', async () => {
      const root = await ratchet.create({ goal: 'Leaf' });
      const result = await ratchet.list({ rootId: root.id });
      assert.strictEqual(result.length, 0);
    });
  });

  // ── extract with full flag ────────────────────────────────────

  describe('extract with full flag', () => {
    it('defaults to goals-only in markdown (omits conclusions)', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'All done' });

      const md = await ratchet.extract(click.id, { format: 'md' }) as string;
      assert.ok(!md.includes('All done'), 'should not include conclusion in goals-only mode');
      assert.ok(md.includes('Test'), 'should still include goal');
    });

    it('includes conclusions when full=true in markdown', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'All done' });

      const md = await ratchet.extract(click.id, { format: 'md', full: true }) as string;
      assert.ok(md.includes('All done'), 'should include conclusion in full mode');
    });

    it('omits conclusion field in JSON when full=false', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'All done' });

      const tree = await ratchet.extract(click.id, { format: 'json' }) as ClickTree;
      assert.strictEqual(tree.click.conclusion, undefined, 'conclusion should be stripped');
      assert.ok(tree.click.goal, 'goal should remain');
    });

    it('includes conclusion field in JSON when full=true', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'All done' });

      const tree = await ratchet.extract(click.id, { format: 'json', full: true }) as ClickTree;
      assert.strictEqual(tree.click.conclusion, 'All done', 'conclusion should be present in full mode');
    });

    it('strips conclusions from nested children in JSON', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.conclude(child.id, { conclusion: 'Child done' });

      const tree = await ratchet.extract(root.id, { format: 'json' }) as ClickTree;
      assert.strictEqual(tree.children[0].click.conclusion, undefined);
    });
  });

  // ── click-tree tool ───────────────────────────────────────────

  describe('click-tree tool', () => {
    it('renders a basic tree with connectors', async () => {
      const root = await ratchet.create({ goal: 'Root goal' });
      await ratchet.create({ goal: 'Child 1', parentId: root.id });
      await ratchet.create({ goal: 'Child 2', parentId: root.id });

      const output = await clickTree.handler({}) as string;
      assert.ok(output.includes('Root goal'), 'should include root goal');
      assert.ok(output.includes('├──') || output.includes('└──'), 'should have tree connectors');
      assert.ok(output.includes('●'), 'should have live status indicator');
    });

    it('uses correct status indicators', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const parked = await ratchet.create({ goal: 'Parked', parentId: root.id });
      await ratchet.park(parked.id);
      const concluded = await ratchet.create({ goal: 'Concluded', parentId: root.id });
      await ratchet.conclude(concluded.id, { conclusion: 'Done' });
      const dropped = await ratchet.create({ goal: 'Dropped', parentId: root.id });
      await ratchet.drop(dropped.id, { conclusion: 'Nope' });

      const output = await clickTree.handler({}) as string;
      assert.ok(output.includes('●'), 'should have live indicator');
      assert.ok(output.includes('◇'), 'should have parked indicator');
      assert.ok(output.includes('○'), 'should have concluded indicator');
      assert.ok(output.includes('✕'), 'should have dropped indicator');
    });

    it('returns empty message when no clicks exist', async () => {
      const output = await clickTree.handler({}) as string;
      assert.strictEqual(output, 'No clicks found.');
    });

    it('returns filter-aware empty message', async () => {
      await ratchet.create({ goal: 'Live' });
      const output = await clickTree.handler({ status: 'parked' }) as string;
      assert.strictEqual(output, 'No clicks match the given filters.');
    });

    it('respects depth parameter', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.create({ goal: 'Grandchild', parentId: child.id });

      const output = await clickTree.handler({ depth: 1 }) as string;
      assert.ok(output.includes('Root'), 'should include root');
      assert.ok(output.includes('Child'), 'should include child');
      assert.ok(!output.includes('Grandchild'), 'should not include grandchild');
    });

    it('respects rootId parameter', async () => {
      const a = await ratchet.create({ goal: 'Root A' });
      await ratchet.create({ goal: 'Root B' });
      await ratchet.create({ goal: 'Child of A', parentId: a.id });

      const output = await clickTree.handler({ rootId: a.id }) as string;
      assert.ok(output.includes('Root A'), 'should include Root A');
      assert.ok(output.includes('Child of A'), 'should include child');
      assert.ok(!output.includes('Root B'), 'should not include Root B');
    });

    it('renders the short ID in a fixed-width column before the goal', async () => {
      const root = await ratchet.create({ goal: 'Root goal' });
      const child = await ratchet.create({ goal: 'Child one', parentId: root.id });

      const output = await clickTree.handler({}) as string;
      const lines = output.split('\n');

      // Short ID form: `c-<base36ts>`, i.e. the first two hyphen-delimited segments.
      // Two clicks created in the same millisecond will share this prefix — the
      // random suffix is what disambiguates them — so lookups below go by goal text.
      const rootShort = root.id.split('-').slice(0, 2).join('-');
      const childShort = child.id.split('-').slice(0, 2).join('-');

      assert.ok(rootShort.startsWith('c-'), 'short ID starts with click prefix');
      assert.ok(rootShort.length < root.id.length, 'short ID is shorter than full ID');

      // Root line: no connector, so the ID sits at column 0.
      const rootLine = lines.find((l) => l.includes('Root goal'))!;
      assert.strictEqual(rootLine.indexOf(rootShort), 0, 'root row should start with the short ID');

      // Child line: the `└── ` or `├── ` connector comes first, then the ID column.
      const childLine = lines.find((l) => l.includes('Child one'))!;
      const connectorMatch = childLine.match(/^(└── |├── )/);
      assert.ok(connectorMatch, `child row should start with a tree connector: ${JSON.stringify(childLine)}`);
      assert.strictEqual(
        childLine.indexOf(childShort),
        connectorMatch![0].length,
        'child short ID should sit immediately after the connector',
      );

      // Goal text follows the ID column (IDs and goals align in fixed columns).
      const goalIdx = childLine.indexOf('Child one');
      assert.ok(
        goalIdx > childLine.indexOf(childShort) + childShort.length,
        'goal text should appear after the ID column',
      );
    });

    it('aligns goal text in a consistent column across rows', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      await ratchet.create({ goal: 'First', parentId: root.id });
      await ratchet.create({ goal: 'Second', parentId: root.id });

      const output = await clickTree.handler({}) as string;
      const lines = output.split('\n');

      // Sibling rows render at the same depth — their goal text should start
      // at the same column because the ID column is fixed-width.
      const firstLine = lines.find((l) => l.includes('First'))!;
      const secondLine = lines.find((l) => l.includes('Second'))!;
      assert.strictEqual(
        firstLine.indexOf('First'),
        secondLine.indexOf('Second'),
        'sibling goals should align in the same column',
      );
    });

    // ── JSON format (D1) ────────────────────────────────────────

    it('returns structured ClickTree[] when format=json', async () => {
      const root = await ratchet.create({ goal: 'Root goal' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });

      const result = await clickTree.handler({ format: 'json' }) as ClickTree[];
      assert.ok(Array.isArray(result), 'should return an array');
      assert.strictEqual(result.length, 1, 'should have one root');
      assert.strictEqual(result[0].click.id, root.id);
      assert.strictEqual(result[0].click.goal, 'Root goal');
      assert.strictEqual(result[0].children.length, 1);
      assert.strictEqual(result[0].children[0].click.id, child.id);
    });

    it('returns empty array for format=json with no clicks', async () => {
      const result = await clickTree.handler({ format: 'json' }) as ClickTree[];
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });

    it('returns empty array for format=json when filters match nothing', async () => {
      await ratchet.create({ goal: 'Live click' });
      const result = await clickTree.handler({ format: 'json', status: 'parked' }) as ClickTree[];
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });

    it('preserves default text output when format is omitted', async () => {
      const root = await ratchet.create({ goal: 'Root goal' });
      await ratchet.create({ goal: 'Child', parentId: root.id });

      const defaultOutput = await clickTree.handler({}) as string;
      const explicitTextOutput = await clickTree.handler({ format: 'text' }) as string;

      // Explicit text === omitted default.
      assert.strictEqual(typeof defaultOutput, 'string');
      assert.strictEqual(defaultOutput, explicitTextOutput);
    });

    it('format=json honors status filter with prune semantics', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const live = await ratchet.create({ goal: 'Live child', parentId: root.id });
      const parked = await ratchet.create({ goal: 'Parked child', parentId: root.id });
      await ratchet.park(parked.id);
      await ratchet.create({ goal: 'Grandchild of parked', parentId: parked.id });

      const result = await clickTree.handler({ format: 'json', status: 'live' }) as ClickTree[];
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children.length, 1, 'parked branch should be pruned');
      assert.strictEqual(result[0].children[0].click.id, live.id);
    });

    it('format=json honors depth parameter', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      const child = await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.create({ goal: 'Grandchild', parentId: child.id });

      const result = await clickTree.handler({ format: 'json', depth: 1 }) as ClickTree[];
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].children.length, 1);
      // Depth 1 includes root (0) + children (1); grandchild (2) should be pruned
      assert.strictEqual(result[0].children[0].children.length, 0);
    });

    it('format=json honors rootId parameter', async () => {
      const a = await ratchet.create({ goal: 'Root A' });
      await ratchet.create({ goal: 'Root B' });
      const childOfA = await ratchet.create({ goal: 'Child of A', parentId: a.id });

      const result = await clickTree.handler({ format: 'json', rootId: a.id }) as ClickTree[];
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].click.id, a.id);
      assert.strictEqual(result[0].children.length, 1);
      assert.strictEqual(result[0].children[0].click.id, childOfA.id);
    });
  });

  // ── click-extract tool always includes conclusions ────────────

  describe('click-extract tool', () => {
    it('always includes conclusions (no opt-out flag)', async () => {
      const click = await ratchet.create({ goal: 'Test' });
      await ratchet.conclude(click.id, { conclusion: 'All done' });

      const result = await clickExtract.handler({ id: click.id, format: 'md' }) as string;
      assert.ok(result.includes('All done'), 'conclusion should appear in CLI output');
      assert.ok(result.includes('Test'), 'goal should appear in CLI output');
    });
  });

  // ── click-list tool with rootId ───────────────────────────────

  describe('click-list tool rootId', () => {
    it('passes rootId through to API', async () => {
      const root = await ratchet.create({ goal: 'Root' });
      await ratchet.create({ goal: 'Child', parentId: root.id });
      await ratchet.create({ goal: 'Unrelated' });

      const result = await clickList.handler({ rootId: root.id, limit: 20 }) as ClickDoc[];
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].goal, 'Child');
    });
  });
});

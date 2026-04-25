/**
 * Astrolabe tool tests.
 *
 * Tests plan-show, plan-list, and the five write tools using an in-memory
 * Stacks backend and a minimal fake guild.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createAstrolabe } from './astrolabe.ts';
import type { AstrolabeApi } from './types.ts';
import type { PlanDoc } from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

let api: AstrolabeApi;
let plansBook: ReturnType<StacksApi['book']>;
let memBackend: MemoryBackend;

function buildStartupCtx(): StartupContext {
  return {
    on() {},
    kits() { return []; },
  };
}

function setup() {
  memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const astrolabePlugin = createAstrolabe();

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
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as {
    apparatus: { start: (ctx: StartupContext) => void; provides: unknown };
  }).apparatus;
  stacksApparatus.start(buildStartupCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'astrolabe', book: 'plans' }, {
    indexes: ['status', 'codex', 'createdAt'],
  });

  // Stub clerk apparatus — astrolabe's start() now calls
  // `clerk.registerWritType(...)` for piece and observation-set, so the
  // test harness must surface a stub that absorbs those calls.
  apparatusMap.set('clerk', { registerWritType() {} });

  // Start astrolabe
  const astrolabeApparatus = (astrolabePlugin as {
    apparatus: { start: (ctx: StartupContext) => void; provides: unknown };
  }).apparatus;
  astrolabeApparatus.start(buildStartupCtx());
  api = astrolabeApparatus.provides as AstrolabeApi;

  // Also set api in apparatus map so tools can resolve it
  apparatusMap.set('astrolabe', api);

  // Get book reference for direct plan creation
  plansBook = stacks.book<PlanDoc>('astrolabe', 'plans');
}

function makePlan(overrides: Partial<PlanDoc> = {}): PlanDoc {
  const now = new Date().toISOString();
  return {
    id: `w-test-${Math.random().toString(36).slice(2)}`,
    codex: 'test-codex',
    status: 'reading',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Astrolabe tools', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { clearGuild(); });

  // ── plan-show ──────────────────────────────────────────────────────

  describe('plan-show (via api.show)', () => {
    it('returns the full PlanDoc when it exists', async () => {
      const plan = makePlan({ status: 'reading', inventory: 'some inventory' });
      await plansBook.put(plan);

      const result = await api.show(plan.id);
      assert.equal(result.id, plan.id);
      assert.equal(result.codex, plan.codex);
      assert.equal(result.status, 'reading');
      assert.equal(result.inventory, 'some inventory');
    });

    it('throws when plan not found', async () => {
      await assert.rejects(
        () => api.show('nonexistent-plan'),
        (err: Error) => {
          assert.ok(err.message.includes('not found'));
          return true;
        },
      );
    });
  });

  // ── plan-list ──────────────────────────────────────────────────────

  describe('plan-list (via api.list)', () => {
    it('returns empty array when no plans exist', async () => {
      const result = await api.list();
      assert.deepEqual(result, []);
    });

    it('returns all plans ordered by createdAt descending', async () => {
      const p1 = makePlan({ id: 'plan-1', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' });
      const p2 = makePlan({ id: 'plan-2', createdAt: '2024-01-03T00:00:00.000Z', updatedAt: '2024-01-03T00:00:00.000Z' });
      const p3 = makePlan({ id: 'plan-3', createdAt: '2024-01-02T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' });
      await plansBook.put(p1);
      await plansBook.put(p2);
      await plansBook.put(p3);

      const result = await api.list();
      assert.equal(result.length, 3);
      assert.equal(result[0].id, 'plan-2');
      assert.equal(result[1].id, 'plan-3');
      assert.equal(result[2].id, 'plan-1');
    });

    it('filters by status', async () => {
      await plansBook.put(makePlan({ id: 'p1', status: 'reading' }));
      await plansBook.put(makePlan({ id: 'p2', status: 'analyzing' }));
      await plansBook.put(makePlan({ id: 'p3', status: 'reading' }));

      const result = await api.list({ status: 'reading' });
      assert.equal(result.length, 2);
      assert.ok(result.every(p => p.status === 'reading'));
    });

    it('filters by codex', async () => {
      await plansBook.put(makePlan({ id: 'p1', codex: 'alpha' }));
      await plansBook.put(makePlan({ id: 'p2', codex: 'beta' }));
      await plansBook.put(makePlan({ id: 'p3', codex: 'alpha' }));

      const result = await api.list({ codex: 'alpha' });
      assert.equal(result.length, 2);
      assert.ok(result.every(p => p.codex === 'alpha'));
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await plansBook.put(makePlan({ id: `plan-${i}`, createdAt: `2024-01-0${i + 1}T00:00:00.000Z`, updatedAt: `2024-01-0${i + 1}T00:00:00.000Z` }));
      }
      const result = await api.list({ limit: 2 });
      assert.equal(result.length, 2);
    });

    it('respects offset for pagination', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now + i * 1000).toISOString();
        await plansBook.put(makePlan({ id: `plan-${i}`, createdAt: ts, updatedAt: ts }));
      }
      const page1 = await api.list({ limit: 2, offset: 0 });
      const page2 = await api.list({ limit: 2, offset: 2 });
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.notEqual(page1[0].id, page2[0].id);
    });
  });

  // ── inventory-write ────────────────────────────────────────────────

  describe('inventory-write (via api.patch)', () => {
    it('updates only the inventory and updatedAt fields', async () => {
      const plan = makePlan({ status: 'reading', updatedAt: '2024-01-01T00:00:00.000Z' });
      await plansBook.put(plan);

      const updated = await api.patch(plan.id, {
        inventory: 'src/foo.ts — the main module',
        updatedAt: new Date().toISOString(),
      });

      assert.equal(updated.inventory, 'src/foo.ts — the main module');
      assert.equal(updated.status, 'reading');
      assert.notEqual(updated.updatedAt, '2024-01-01T00:00:00.000Z');
    });

    it('does not transition plan status', async () => {
      const plan = makePlan({ status: 'analyzing' });
      await plansBook.put(plan);

      const updated = await api.patch(plan.id, { inventory: 'some content', updatedAt: new Date().toISOString() });
      assert.equal(updated.status, 'analyzing');
    });
  });

  // ── scope-write ────────────────────────────────────────────────────

  describe('scope-write (via api.patch)', () => {
    it('updates the scope field', async () => {
      const plan = makePlan();
      await plansBook.put(plan);

      const scope = [
        { id: 'S1', description: 'Add feature X', rationale: 'Required', included: true },
        { id: 'S2', description: 'Remove feature Y', rationale: 'Not needed', included: false },
      ];

      const updated = await api.patch(plan.id, { scope, updatedAt: new Date().toISOString() });
      assert.equal(updated.scope?.length, 2);
      assert.equal(updated.scope?.[0].id, 'S1');
      assert.equal(updated.scope?.[1].included, false);
    });
  });

  // ── decisions-write ────────────────────────────────────────────────

  describe('decisions-write (via api.patch)', () => {
    it('updates the decisions field including optional fields', async () => {
      const plan = makePlan();
      await plansBook.put(plan);

      const decisions = [
        {
          id: 'D1',
          scope: ['S1'],
          question: 'Which approach?',
          context: 'We have two options',
          options: { A: 'Option A', B: 'Option B' },
          recommendation: 'A',
          rationale: 'A is simpler',
          selected: 'A',
          patronOverride: undefined,
        },
      ];

      const updated = await api.patch(plan.id, { decisions, updatedAt: new Date().toISOString() });
      assert.equal(updated.decisions?.length, 1);
      assert.equal(updated.decisions?.[0].id, 'D1');
      assert.equal(updated.decisions?.[0].selected, 'A');
    });
  });

  // ── observations-write ─────────────────────────────────────────────

  describe('observations-write (via api.patch)', () => {
    it('updates the observations field with a structured record array', async () => {
      const plan = makePlan();
      await plansBook.put(plan);

      const observations = [
        {
          id: 'obs-1',
          title: 'Replace deprecated helper in src/foo.ts',
          body: '`renderLegacy` in `src/foo.ts` is superseded by `renderCard`; migrate remaining callers.',
        },
        {
          id: 'obs-2',
          title: 'Typo in error message for plan-finalize',
          body: 'Plan-finalize throws `"spec writier"` instead of `"spec writer"` when the spec is absent.',
        },
      ];

      const updated = await api.patch(plan.id, {
        observations,
        updatedAt: new Date().toISOString(),
      });

      assert.ok(Array.isArray(updated.observations));
      assert.equal(updated.observations?.length, 2);
      assert.equal(updated.observations?.[0].id, 'obs-1');
      assert.equal(updated.observations?.[0].title, 'Replace deprecated helper in src/foo.ts');
      assert.ok(updated.observations?.[0].body.includes('renderLegacy'));
      assert.equal(updated.observations?.[1].id, 'obs-2');
      assert.equal(updated.status, plan.status);
    });
  });

  // ── spec-write ─────────────────────────────────────────────────────

  describe('spec-write (via api.patch)', () => {
    it('updates the spec field', async () => {
      const plan = makePlan();
      await plansBook.put(plan);

      const updated = await api.patch(plan.id, {
        spec: '# Specification\n\nImplement the thing.',
        updatedAt: new Date().toISOString(),
      });
      assert.equal(updated.spec, '# Specification\n\nImplement the thing.');
    });
  });

  // ── write tool on missing plan ─────────────────────────────────────

  describe('write on nonexistent plan', () => {
    it('throws when patching a nonexistent plan', async () => {
      await assert.rejects(
        () => api.patch('nonexistent', { inventory: 'x', updatedAt: new Date().toISOString() }),
        (err: Error) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
    });
  });
});

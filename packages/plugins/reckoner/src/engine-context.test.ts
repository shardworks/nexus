/**
 * Unit tests for the engine-failure context resolver.
 *
 * Drives the resolver against a freshly-built `ReadOnlyBook<RigRow>` so
 * each branch (rig found / no rig / rig found but no failed engine /
 * multiple failed engines picks first / attempts summary shape) lands
 * in isolation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type {
  Book,
  ReadOnlyBook,
  StacksApi,
  StartupContext,
  KitEntry,
} from '@shardworks/stacks-apparatus';
import {
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
} from '@shardworks/nexus-core';

import { resolveEngineFailureContext } from './engine-context.ts';

interface EngineAttempt {
  startedAt?: string;
  endedAt?: string;
  status?: 'completed' | 'failed';
  error?: string;
  sessionId?: string;
  yields?: unknown;
}

interface EngineInstance {
  id: string;
  designId: string;
  status: string;
  attemptCount?: number;
  attempts?: EngineAttempt[];
}

interface RigRow extends Record<string, unknown> {
  id: string;
  writId: string;
  status: string;
  createdAt?: string;
  engines?: EngineInstance[];
}

function buildCtx(): StartupContext {
  return {
    on(): void {},
    kits(_type: string): KitEntry[] {
      return [];
    },
  };
}

function fakeGuild(map: Map<string, unknown>): Guild {
  return {
    home: '/tmp/test',
    apparatus<T>(name: string): T {
      const api = map.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(_id: string): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return { name: 't', nexus: '0', plugins: [] };
    },
    kits(): LoadedKit[] {
      return [];
    },
    apparatuses(): LoadedApparatus[] {
      return [];
    },
    failedPlugins() {
      return [];
    },
    startupWarnings() {
      return [];
    },
  };
}

interface Fixture {
  rigs: Book<RigRow>;
  rigsBook: ReadOnlyBook<RigRow>;
}

function buildFixture(): Fixture {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  const apparatusMap = new Map<string, unknown>();
  setGuild(fakeGuild(apparatusMap));
  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);
  backend.ensureBook(
    { ownerId: 'spider', book: 'rigs' },
    { indexes: ['status', 'writId', 'createdAt'] },
  );
  const rigs = stacks.book<RigRow>('spider', 'rigs');
  const rigsBook = stacks.readBook<RigRow>('spider', 'rigs');
  return { rigs, rigsBook };
}

describe('resolveEngineFailureContext', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = buildFixture();
  });

  // Manual teardown after each — the fixture replaces the global guild
  // each beforeEach, so a leftover global from a prior test is fine for
  // the next one's setGuild() call. clearGuild() at the very end keeps
  // the suite leak-free.
  it('returns undefined when no rig exists for the writ', async () => {
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-no-rig');
    assert.equal(ctx, undefined);
    clearGuild();
  });

  it('returns undefined when the rig is not in failed status', async () => {
    await fix.rigs.put({
      id: 'rig-running',
      writId: 'w-running',
      status: 'running',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'e1', designId: 'draft', status: 'running' },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-running');
    assert.equal(ctx, undefined);
    clearGuild();
  });

  it('returns undefined when the rig is failed but no engine is failed', async () => {
    await fix.rigs.put({
      id: 'rig-no-failed-engine',
      writId: 'w-no-failed',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'e1', designId: 'draft', status: 'completed' },
        { id: 'e2', designId: 'review', status: 'cancelled' },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-no-failed');
    assert.equal(ctx, undefined);
    clearGuild();
  });

  it('returns undefined when the rig has no engines array at all', async () => {
    await fix.rigs.put({
      id: 'rig-empty',
      writId: 'w-empty',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-empty');
    assert.equal(ctx, undefined);
    clearGuild();
  });

  it('builds the engine-failure context for a failed rig + failed engine', async () => {
    await fix.rigs.put({
      id: 'rig-fail',
      writId: 'w-fail',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'pre', designId: 'draft', status: 'completed' },
        {
          id: 'impl',
          designId: 'implement',
          status: 'failed',
          attemptCount: 3,
          attempts: [
            {
              startedAt: '2026-04-25T00:01:00.000Z',
              endedAt: '2026-04-25T00:02:00.000Z',
              status: 'failed',
              error: 'transient error 1',
              sessionId: 's-1',
            },
            {
              startedAt: '2026-04-25T00:03:00.000Z',
              endedAt: '2026-04-25T00:04:00.000Z',
              status: 'failed',
              error: 'transient error 2',
              sessionId: 's-2',
            },
            {
              startedAt: '2026-04-25T00:05:00.000Z',
              endedAt: '2026-04-25T00:06:00.000Z',
              status: 'failed',
              error: 'final error',
              sessionId: 's-3',
              yields: { dropped: 'this should not appear' },
            },
          ],
        },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-fail');
    assert.ok(ctx, 'should return a context');
    assert.equal(ctx.rigId, 'rig-fail');
    assert.equal(ctx.engineId, 'impl');
    assert.equal(ctx.engineDesignId, 'implement');
    assert.equal(ctx.attemptCount, 3);
    assert.equal(ctx.lastError, 'final error');
    assert.equal(ctx.attemptsSummary.length, 3);
    // Yields must be dropped from each summary.
    for (const entry of ctx.attemptsSummary) {
      assert.ok(!('yields' in entry));
    }
    // Tail entry shape sanity check.
    const tail = ctx.attemptsSummary[2]!;
    assert.equal(tail.startedAt, '2026-04-25T00:05:00.000Z');
    assert.equal(tail.endedAt, '2026-04-25T00:06:00.000Z');
    assert.equal(tail.status, 'failed');
    assert.equal(tail.error, 'final error');
    assert.equal(tail.sessionId, 's-3');
    clearGuild();
  });

  it('picks the first failed engine when multiple engines are failed', async () => {
    await fix.rigs.put({
      id: 'rig-multi',
      writId: 'w-multi',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'first', designId: 'draft', status: 'failed', attemptCount: 1 },
        { id: 'second', designId: 'review', status: 'failed', attemptCount: 2 },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-multi');
    assert.ok(ctx);
    assert.equal(ctx.engineId, 'first');
    assert.equal(ctx.engineDesignId, 'draft');
    assert.equal(ctx.attemptCount, 1);
    clearGuild();
  });

  it('picks the most-recent failed rig when multiple failed rigs exist for the writ', async () => {
    await fix.rigs.put({
      id: 'rig-old',
      writId: 'w-multi-rig',
      status: 'failed',
      createdAt: '2026-04-23T00:00:00.000Z',
      engines: [
        { id: 'old-engine', designId: 'old-design', status: 'failed' },
      ],
    });
    await fix.rigs.put({
      id: 'rig-new',
      writId: 'w-multi-rig',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'new-engine', designId: 'new-design', status: 'failed' },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-multi-rig');
    assert.ok(ctx);
    assert.equal(ctx.rigId, 'rig-new');
    assert.equal(ctx.engineId, 'new-engine');
    clearGuild();
  });

  it('omits attemptCount when the engine has no counter recorded', async () => {
    await fix.rigs.put({
      id: 'rig-no-count',
      writId: 'w-no-count',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        {
          id: 'fail-fast',
          designId: 'fast',
          status: 'failed',
          attempts: [{ status: 'failed', error: 'boom' }],
        },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-no-count');
    assert.ok(ctx);
    assert.equal(ctx.attemptCount, undefined);
    assert.equal(ctx.lastError, 'boom');
    clearGuild();
  });

  it('omits lastError when the engine has no attempts recorded', async () => {
    await fix.rigs.put({
      id: 'rig-no-attempts',
      writId: 'w-no-attempts',
      status: 'failed',
      createdAt: '2026-04-25T00:00:00.000Z',
      engines: [
        { id: 'never-ran', designId: 'never', status: 'failed' },
      ],
    });
    const ctx = await resolveEngineFailureContext(fix.rigsBook, 'w-no-attempts');
    assert.ok(ctx);
    assert.equal(ctx.lastError, undefined);
    assert.deepEqual(ctx.attemptsSummary, []);
    clearGuild();
  });

  it('returns undefined silently when the book read throws', async () => {
    const explosiveBook: ReadOnlyBook<RigRow> = {
      get: async () => null,
      find: async () => {
        throw new Error('book offline');
      },
      list: async () => [],
      count: async () => 0,
    };
    const ctx = await resolveEngineFailureContext(explosiveBook, 'w-anything');
    assert.equal(ctx, undefined);
    clearGuild();
  });
});

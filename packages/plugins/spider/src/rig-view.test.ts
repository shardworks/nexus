/**
 * Rig view aggregator — unit tests.
 *
 * Validates that enrichRigView/enrichRigViews:
 *  - omit costSummary and engineCosts when no engine has a sessionId
 *  - include a per-engine entry for every engine with a sessionId
 *  - sum costUsd and tokenUsage across all engine sessions
 *  - omit the parenthetical token totals when no session reported tokenUsage
 *  - include engines in non-terminal statuses whose sessions are mid-flight (D17)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '@shardworks/animator-apparatus';
import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, KitEntry } from '@shardworks/nexus-core';

import type { RigDoc } from './types.ts';
import { enrichRigView, enrichRigViews } from './rig-view.ts';

function makeStacks(memBackend: MemoryBackend): StacksApi {
  const stacksPlugin = createStacksApparatus(memBackend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
  stacksPlugin.apparatus.start(noopCtx as never);
  return stacksPlugin.apparatus.provides as StacksApi;
}

function writeSession(
  stacks: StacksApi,
  id: string,
  costUsd: number | undefined,
  tokenUsage: { inputTokens: number; outputTokens: number } | undefined,
): Promise<void> {
  const book = stacks.book<SessionDoc>('animator', 'sessions');
  const doc: SessionDoc = {
    id,
    status: 'completed',
    provider: 'mock',
    startedAt: new Date().toISOString(),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  } as SessionDoc;
  return book.put(doc).then(() => undefined);
}

describe('rig-view aggregator', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    const fakeGuild: Guild = {
      home: '/tmp/test',
      apparatus<T>(): T { return null as T; },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 't', nexus: '0.0.0', plugins: [] } as GuildConfig; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    const memBackend = new MemoryBackend();
    // enrichRigView reads the animator/sessions book via readBook, which
    // requires the book to exist in the backend before the read.
    memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
      indexes: ['startedAt', 'status'],
    });
    stacks = makeStacks(memBackend);
  });

  afterEach(() => {
    clearGuild();
  });

  it('omits costSummary and engineCosts when no engine has a sessionId', async () => {
    const rig: RigDoc = {
      id: 'rig-1',
      writId: 'writ-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      engines: [
        { id: 'draft', designId: 'draft', status: 'completed', upstream: [], givensSpec: {} },
        { id: 'seal', designId: 'seal', status: 'pending', upstream: ['draft'], givensSpec: {} },
      ],
    };

    const view = await enrichRigView(rig, stacks);
    assert.equal(view.costSummary, undefined, 'costSummary should be absent');
    assert.equal(view.engineCosts, undefined, 'engineCosts should be absent');
    assert.equal(view.id, 'rig-1');
    assert.equal(view.engines.length, 2);
  });

  it('populates costSummary and engineCosts across all engines with sessionId', async () => {
    await writeSession(stacks, 'sess-a', 0.15, { inputTokens: 1000, outputTokens: 200 });
    await writeSession(stacks, 'sess-b', 0.25, { inputTokens: 2000, outputTokens: 500 });

    const rig: RigDoc = {
      id: 'rig-2',
      writId: 'writ-2',
      status: 'running',
      createdAt: new Date().toISOString(),
      engines: [
        { id: 'implement', designId: 'implement', status: 'completed', upstream: [], givensSpec: {}, sessionId: 'sess-a' },
        { id: 'review', designId: 'review', status: 'running', upstream: ['implement'], givensSpec: {}, sessionId: 'sess-b' },
        { id: 'seal', designId: 'seal', status: 'pending', upstream: ['review'], givensSpec: {} },
      ],
    };

    const view = await enrichRigView(rig, stacks);
    assert.ok(view.costSummary, 'costSummary should be present');
    assert.equal(view.costSummary?.costUsd, 0.4);
    assert.equal(view.costSummary?.inputTokens, 3000);
    assert.equal(view.costSummary?.outputTokens, 700);

    assert.ok(view.engineCosts, 'engineCosts should be present');
    assert.equal(view.engineCosts?.implement.costUsd, 0.15);
    assert.equal(view.engineCosts?.implement.inputTokens, 1000);
    assert.equal(view.engineCosts?.review.costUsd, 0.25);
    assert.equal(view.engineCosts?.review.outputTokens, 500);
    assert.equal(view.engineCosts?.seal, undefined, 'engines without sessionId are omitted');
  });

  it('omits tokenUsage totals when no session reported tokenUsage', async () => {
    await writeSession(stacks, 'sess-c', 0.10, undefined);

    const rig: RigDoc = {
      id: 'rig-3',
      writId: 'writ-3',
      status: 'running',
      createdAt: new Date().toISOString(),
      engines: [
        { id: 'anim', designId: 'implement', status: 'completed', upstream: [], givensSpec: {}, sessionId: 'sess-c' },
      ],
    };

    const view = await enrichRigView(rig, stacks);
    assert.equal(view.costSummary?.costUsd, 0.10);
    assert.equal(view.costSummary?.inputTokens, undefined);
    assert.equal(view.costSummary?.outputTokens, undefined);
  });

  it('treats sessions missing from the book as zero contribution', async () => {
    // No session written — the engine references an id that cannot be resolved.
    const rig: RigDoc = {
      id: 'rig-4',
      writId: 'writ-4',
      status: 'running',
      createdAt: new Date().toISOString(),
      engines: [
        { id: 'anim', designId: 'implement', status: 'running', upstream: [], givensSpec: {}, sessionId: 'sess-missing' },
      ],
    };

    const view = await enrichRigView(rig, stacks);
    assert.equal(view.costSummary?.costUsd, 0);
    assert.equal(view.engineCosts?.anim.costUsd, 0);
  });

  it('includes engines in non-terminal statuses whose sessions are in-progress (D17)', async () => {
    await writeSession(stacks, 'sess-running', 0.05, { inputTokens: 500, outputTokens: 100 });

    const rig: RigDoc = {
      id: 'rig-5',
      writId: 'writ-5',
      status: 'running',
      createdAt: new Date().toISOString(),
      engines: [
        { id: 'anim', designId: 'implement', status: 'running', upstream: [], givensSpec: {}, sessionId: 'sess-running' },
      ],
    };

    const view = await enrichRigView(rig, stacks);
    assert.equal(view.costSummary?.costUsd, 0.05);
    assert.equal(view.engineCosts?.anim.costUsd, 0.05);
  });

  it('enrichRigViews processes multiple rigs', async () => {
    await writeSession(stacks, 'sess-x', 0.5, { inputTokens: 100, outputTokens: 50 });

    const rigs: RigDoc[] = [
      {
        id: 'rig-a',
        writId: 'writ-a',
        status: 'running',
        createdAt: new Date().toISOString(),
        engines: [
          { id: 'anim', designId: 'implement', status: 'completed', upstream: [], givensSpec: {}, sessionId: 'sess-x' },
        ],
      },
      {
        id: 'rig-b',
        writId: 'writ-b',
        status: 'running',
        createdAt: new Date().toISOString(),
        engines: [{ id: 'draft', designId: 'draft', status: 'pending', upstream: [], givensSpec: {} }],
      },
    ];

    const views = await enrichRigViews(rigs, stacks);
    assert.equal(views.length, 2);
    assert.equal(views[0].costSummary?.costUsd, 0.5);
    assert.equal(views[1].costSummary, undefined);
  });
});

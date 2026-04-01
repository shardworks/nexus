/**
 * Tests for session-list and session-show tools.
 *
 * Uses the same fake guild + in-memory Stacks harness as the main animator
 * tests. Seeds session documents directly into Stacks, then exercises the
 * tool handlers to verify query construction, filtering, and error handling.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';

import type { SessionDoc } from '../types.ts';
import sessionList from './session-list.ts';
import sessionShow from './session-show.ts';

// ── Test harness ────────────────────────────────────────────────────

let stacks: StacksApi;
let sessions: Book<SessionDoc>;

function setup() {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);

  const apparatusMap = new Map<string, unknown>();

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(): T {
      return {} as T;
    },
    writeConfig() { /* noop in test */ },
    guildConfig: () => ({
      name: 'test-guild',
      nexus: '0.0.0',
      workshops: {},
      roles: {},
      baseTools: [],
      plugins: [],
      settings: { model: 'sonnet' },
    }),
    kits: () => [],
    apparatuses: () => [],
  };

  setGuild(fakeGuild);

  const sa = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  sa.start({ on: () => {} });
  stacks = sa.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });

  sessions = stacks.book<SessionDoc>('animator', 'sessions');
}

// ── Seed data ───────────────────────────────────────────────────────

const seedSessions: SessionDoc[] = [
  {
    id: 'ses-00000001',
    status: 'completed',
    startedAt: '2026-04-01T10:00:00Z',
    endedAt: '2026-04-01T10:05:00Z',
    durationMs: 300000,
    provider: 'claude-code',
    exitCode: 0,
    costUsd: 0.42,
    conversationId: 'conv-aaa',
    metadata: { trigger: 'summon', animaName: 'scribe' },
  },
  {
    id: 'ses-00000002',
    status: 'failed',
    startedAt: '2026-04-01T11:00:00Z',
    endedAt: '2026-04-01T11:01:00Z',
    durationMs: 60000,
    provider: 'claude-code',
    exitCode: 1,
    error: 'Process crashed',
    conversationId: 'conv-bbb',
  },
  {
    id: 'ses-00000003',
    status: 'completed',
    startedAt: '2026-04-01T12:00:00Z',
    endedAt: '2026-04-01T12:10:00Z',
    durationMs: 600000,
    provider: 'other-provider',
    exitCode: 0,
    costUsd: 1.20,
    conversationId: 'conv-aaa',
  },
  {
    id: 'ses-00000004',
    status: 'timeout',
    startedAt: '2026-04-01T13:00:00Z',
    endedAt: '2026-04-01T13:05:00Z',
    durationMs: 300000,
    provider: 'claude-code',
    exitCode: 124,
    error: 'Session timed out',
  },
  {
    id: 'ses-00000005',
    status: 'running',
    startedAt: '2026-04-01T14:00:00Z',
    provider: 'claude-code',
  },
];

async function seedAll() {
  for (const doc of seedSessions) {
    await sessions.put(doc);
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('session-list tool', () => {
  beforeEach(async () => {
    setup();
    await seedAll();
  });

  afterEach(() => {
    clearGuild();
  });

  it('returns all sessions with no filters', async () => {
    const results = await sessionList.handler({ limit: 20 });
    assert.equal(results.length, 5);
  });

  it('filters by status', async () => {
    const results = await sessionList.handler({ status: 'completed', limit: 20 });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.status, 'completed');
    }
  });

  it('filters by provider', async () => {
    const results = await sessionList.handler({ provider: 'other-provider', limit: 20 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, 'ses-00000003');
  });

  it('filters by conversationId', async () => {
    const results = await sessionList.handler({ conversationId: 'conv-aaa', limit: 20 });
    assert.equal(results.length, 2);
    const ids = results.map((r) => r.id).sort();
    assert.deepEqual(ids, ['ses-00000001', 'ses-00000003']);
  });

  it('filters by running status', async () => {
    const results = await sessionList.handler({ status: 'running', limit: 20 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, 'ses-00000005');
  });

  it('combines multiple filters', async () => {
    const results = await sessionList.handler({
      status: 'completed',
      provider: 'claude-code',
      limit: 20,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, 'ses-00000001');
  });

  it('respects limit', async () => {
    const results = await sessionList.handler({ limit: 2 });
    assert.equal(results.length, 2);
  });

  it('returns summary projection (expected fields only)', async () => {
    const results = await sessionList.handler({ limit: 1 });
    assert.equal(results.length, 1);
    const keys = Object.keys(results[0]!).sort();
    assert.deepEqual(keys, [
      'costUsd', 'durationMs', 'endedAt', 'exitCode',
      'id', 'provider', 'startedAt', 'status',
    ]);
  });

  it('returns empty array when no sessions match', async () => {
    const results = await sessionList.handler({ provider: 'nonexistent', limit: 20 });
    assert.equal(results.length, 0);
  });
});

describe('session-show tool', () => {
  beforeEach(async () => {
    setup();
    await seedAll();
  });

  afterEach(() => {
    clearGuild();
  });

  it('returns full session record by id', async () => {
    const result = await sessionShow.handler({ id: 'ses-00000001' });
    assert.equal(result.id, 'ses-00000001');
    assert.equal(result.status, 'completed');
    assert.equal(result.provider, 'claude-code');
    assert.equal(result.costUsd, 0.42);
    assert.deepEqual(result.metadata, { trigger: 'summon', animaName: 'scribe' });
  });

  it('returns session with error fields', async () => {
    const result = await sessionShow.handler({ id: 'ses-00000002' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Process crashed');
    assert.equal(result.exitCode, 1);
  });

  it('throws for missing session id', async () => {
    await assert.rejects(
      () => sessionShow.handler({ id: 'ses-nonexistent' }),
      { message: 'Session "ses-nonexistent" not found.' },
    );
  });
});

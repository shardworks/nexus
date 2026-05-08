/**
 * engine.test.ts — scaffold-surveyor.summon engine unit tests.
 *
 * Exercises the `summonEngine.run()` call path end-to-end with a mock guild
 * and mock animator. This covers the engine's full behaviour contract:
 *
 *   - Calls `animator.summon()` with the role/prompt from givens
 *   - Falls back to `guild().home` when `givens.cwd` is absent
 *   - Uses `givens.cwd` when provided
 *   - Passes writ id in `metadata.writId` and sets `GIT_AUTHOR_EMAIL` when
 *     `givens.writ` is present
 *   - Returns `{ status: 'launched', sessionId }` on success
 *   - Throws on empty role or prompt
 *   - Throws when both `givens.cwd` and `guild().home` are empty
 *
 * All external apparatus packages are imported as `import type` only — their
 * runtime values are never referenced. All mock implementations are inline
 * objects cast through `unknown`. This avoids the workspace ESM symlink
 * resolution issue where following symlinks into sibling packages can break
 * transitive dependency resolution.
 *
 * Only `@shardworks/nexus-core` is value-imported because it is a direct
 * dependency of this package and resolves correctly.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';

import type { AnimatorApi, SummonRequest, AnimateHandle } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

import { summonEngine } from './engine.ts';

// ── Inline mock helpers ────────────────────────────────────────────────

/** Minimal AnimateHandle: only sessionId is used by the engine. */
function makeHandle(sessionId: string): AnimateHandle {
  async function* noChunks() {}
  return {
    sessionId,
    chunks: noChunks(),
    result: Promise.resolve({
      id: sessionId, status: 'completed' as const,
      startedAt: '', endedAt: '', durationMs: 0,
      provider: 'mock', exitCode: 0,
    }),
  } as unknown as AnimateHandle;
}

interface CapturedSummon {
  request: SummonRequest;
  sessionId: string;
}

/**
 * Build a mock guild where:
 *   - `guild().home` is `home`
 *   - `guild().apparatus('animator')` returns a mock that records `summon()` calls
 *
 * Returns the guild and a `calls` array that accumulates every summon call.
 */
function buildMockGuild(
  home: string,
  calls: CapturedSummon[],
): Guild {
  let sessionCounter = 0;
  const mockAnimator: AnimatorApi = {
    summon(req: SummonRequest): AnimateHandle {
      const sessionId = `ses-mock-${++sessionCounter}`;
      calls.push({ request: req, sessionId });
      return makeHandle(sessionId);
    },
    animate(): AnimateHandle {
      throw new Error('[mock] animate() not used in engine tests');
    },
    subscribeToSession(): null { return null; },
    async cancel(id: string) {
      return { id, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as unknown as Awaited<ReturnType<AnimatorApi['cancel']>>;
    },
    async getSessionCosts() { return new Map(); },
    async getStatus() {
      return { ok: false, pid: 0, uptime: 0 } as unknown as Awaited<ReturnType<AnimatorApi['getStatus']>>;
    },
  } as unknown as AnimatorApi;

  return {
    home,
    apparatus<T>(name: string): T {
      if (name === 'animator') return mockAnimator as unknown as T;
      throw new Error(`[mock guild] apparatus "${name}" not installed`);
    },
    tryApparatus<T>(name: string): T | null {
      if (name === 'animator') return mockAnimator as unknown as T;
      return null;
    },
    config<T>() { return {} as T; },
    writeConfig() {},
    guildConfig() { return { name: 'mock', nexus: '0.0.0', plugins: [] }; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  } as unknown as Guild;
}

/** Minimal engine context (only `engineId` is referenced in metadata). */
const ENGINE_CTX = { engineId: 'scaffold-surveyor.summon' };

// ── Tests ──────────────────────────────────────────────────────────────

describe('summonEngine — happy path', () => {
  afterEach(() => clearGuild());

  it('calls animator.summon with role and prompt from givens', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    const result = await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'Survey writ id: w-001', cwd: '/some/dir' },
      ENGINE_CTX,
    );

    assert.equal(calls.length, 1, 'animator.summon() called exactly once');
    assert.equal(calls[0].request.role, 'scaffold-surveyor.survey-vision');
    assert.equal(calls[0].request.prompt, 'Survey writ id: w-001');
    assert.equal(result.status, 'launched');
    assert.equal(result.sessionId, calls[0].sessionId);
  });

  it('passes provided cwd to animator.summon', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-charge', prompt: 'Survey charge', cwd: '/workspace/project' },
      ENGINE_CTX,
    );

    assert.equal(calls[0].request.cwd, '/workspace/project');
  });

  it('falls back to guild().home when cwd is absent', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/guild/home', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'Survey writ id: w-002' },
      ENGINE_CTX,
    );

    assert.equal(calls[0].request.cwd, '/guild/home');
  });

  it('falls back to guild().home when cwd is empty string', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/guild/home', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-piece', prompt: 'Survey piece', cwd: '' },
      ENGINE_CTX,
    );

    assert.equal(calls[0].request.cwd, '/guild/home');
  });

  it('sets streaming: true on every summon call', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'p', cwd: '/d' },
      ENGINE_CTX,
    );

    assert.equal(calls[0].request.streaming, true);
  });

  it('passes engineId in metadata', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'p', cwd: '/d' },
      ENGINE_CTX,
    );

    const meta = calls[0].request.metadata as Record<string, unknown>;
    assert.equal(meta.engineId, 'scaffold-surveyor.summon');
  });

  it('returns { status: "launched", sessionId }', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    const result = await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'p', cwd: '/d' },
      ENGINE_CTX,
    );

    assert.equal(result.status, 'launched');
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
  });
});

describe('summonEngine — writ givens', () => {
  afterEach(() => clearGuild());

  it('passes writ.id as metadata.writId when writ is provided', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    const fakeWrit: WritDoc = {
      id: 'w-survey-abc',
      type: 'survey-vision',
      phase: 'open',
      title: 'Survey vision: My Vision',
      body: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'Survey writ id: w-survey-abc', cwd: '/d', writ: fakeWrit },
      ENGINE_CTX,
    );

    const meta = calls[0].request.metadata as Record<string, unknown>;
    assert.equal(meta.writId, 'w-survey-abc');
  });

  it('sets GIT_AUTHOR_EMAIL to <writId>@nexus.local when writ is provided', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    const fakeWrit: WritDoc = {
      id: 'w-survey-xyz',
      type: 'survey-charge',
      phase: 'open',
      title: 'Survey charge: My Charge',
      body: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-charge', prompt: 'Survey writ id: w-survey-xyz', cwd: '/d', writ: fakeWrit },
      ENGINE_CTX,
    );

    const env = calls[0].request.environment as Record<string, string>;
    assert.equal(env.GIT_AUTHOR_EMAIL, 'w-survey-xyz@nexus.local');
  });

  it('passes empty environment when no writ is provided', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'p', cwd: '/d' },
      ENGINE_CTX,
    );

    const env = calls[0].request.environment as Record<string, string>;
    assert.deepEqual(env, {});
  });

  it('omits writId from metadata when no writ is provided', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await summonEngine.run(
      { role: 'scaffold-surveyor.survey-vision', prompt: 'p', cwd: '/d' },
      ENGINE_CTX,
    );

    const meta = calls[0].request.metadata as Record<string, unknown>;
    assert.equal('writId' in meta, false, 'writId must not be in metadata when writ absent');
  });
});

describe('summonEngine — error cases', () => {
  afterEach(() => clearGuild());

  it('throws when role is an empty string', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await assert.rejects(
      () => summonEngine.run({ role: '', prompt: 'p', cwd: '/d' }, ENGINE_CTX),
      /non-empty string "role"/,
    );
    assert.equal(calls.length, 0, 'summon must not be called');
  });

  it('throws when role is absent (undefined)', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await assert.rejects(
      () => summonEngine.run({ prompt: 'p', cwd: '/d' }, ENGINE_CTX),
      /non-empty string "role"/,
    );
    assert.equal(calls.length, 0);
  });

  it('throws when prompt is an empty string', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await assert.rejects(
      () => summonEngine.run({ role: 'scaffold-surveyor.survey-vision', prompt: '', cwd: '/d' }, ENGINE_CTX),
      /non-empty string "prompt"/,
    );
    assert.equal(calls.length, 0);
  });

  it('throws when prompt is absent (undefined)', async () => {
    const calls: CapturedSummon[] = [];
    setGuild(buildMockGuild('/home/guild', calls));

    await assert.rejects(
      () => summonEngine.run({ role: 'scaffold-surveyor.survey-vision', cwd: '/d' }, ENGINE_CTX),
      /non-empty string "prompt"/,
    );
    assert.equal(calls.length, 0);
  });

  it('throws when cwd is absent and guild().home is empty', async () => {
    const calls: CapturedSummon[] = [];
    // Guild home is empty string — must trigger the fallback error.
    setGuild(buildMockGuild('', calls));

    await assert.rejects(
      () => summonEngine.run({ role: 'scaffold-surveyor.survey-vision', prompt: 'p' }, ENGINE_CTX),
      /no "cwd" given and guild\(\)\.home is empty/,
    );
    assert.equal(calls.length, 0);
  });
});

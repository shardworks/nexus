/**
 * astrolabe.reader-analyst engine tests.
 *
 * Covers the primer-variant selection contract (D4):
 *   - astrolabe.patronRole non-empty string → sage-primer-attended
 *   - astrolabe.patronRole unset (no astrolabe config)   → sage-primer-solo
 *   - astrolabe.patronRole empty string                  → sage-primer-solo
 *   - astrolabe.patronRole whitespace-only               → sage-primer-solo
 * And the engine surface:
 *   - returns { status: 'launched', sessionId }
 *   - prompt/cwd givens are required (throws otherwise)
 *   - writ and metadata givens are plumbed through to animator.summon()
 *   - no `role` given is accepted — the engine chooses it
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';
import type {
  AnimatorApi,
  AnimateHandle,
  SessionChunk,
  SessionDoc,
  SummonRequest,
} from '@shardworks/animator-apparatus';

import {
  createReaderAnalystEngine,
  selectPrimerRole,
  PRIMER_ATTENDED_ROLE,
  PRIMER_SOLO_ROLE,
} from './reader-analyst.ts';

// ── Test harness ─────────────────────────────────────────────────────

interface FakeAnimator extends AnimatorApi {
  summonCalls: SummonRequest[];
}

function emptyChunks(): AsyncIterable<SessionChunk> {
  return {
    [Symbol.asyncIterator]: async function* () {
      // no chunks
    },
  };
}

function makeFakeAnimator(): FakeAnimator {
  const inst: FakeAnimator = {
    summonCalls: [],
    summon(request: SummonRequest): AnimateHandle {
      inst.summonCalls.push(request);
      const sessionId = `ses-${inst.summonCalls.length.toString().padStart(4, '0')}`;
      const now = new Date().toISOString();
      return {
        sessionId,
        chunks: emptyChunks(),
        result: Promise.resolve({
          id: sessionId,
          status: 'completed',
          startedAt: now,
          endedAt: now,
          durationMs: 1,
          provider: 'fake',
          exitCode: 0,
        } satisfies SessionDoc),
      };
    },
    animate(): AnimateHandle {
      throw new Error('FakeAnimator.animate not implemented');
    },
    subscribeToSession() {
      return null;
    },
    async cancel() {
      throw new Error('FakeAnimator.cancel not implemented');
    },
  };
  return inst;
}

let fakeAnimator: FakeAnimator;

function setup(config: { patronRole?: string } | undefined): void {
  const apparatusMap = new Map<string, unknown>();
  const fakeGuildConfig: GuildConfig & { astrolabe?: { patronRole?: string } } = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(config !== undefined && config.patronRole !== undefined
      ? { astrolabe: { patronRole: config.patronRole } }
      : {}),
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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

  fakeAnimator = makeFakeAnimator();
  apparatusMap.set('animator', fakeAnimator);
}

function buildCtx(): EngineRunContext {
  return { rigId: 'rig-ra-001', engineId: 'reader-analyst', upstream: {} };
}

function defaultGivens(): Record<string, unknown> {
  return {
    prompt: 'Plan ID: w-test-001',
    cwd: '/tmp/draft-worktree',
  };
}

// ── Primer-variant selection (D4) ────────────────────────────────────

describe('astrolabe.reader-analyst — primer-variant selection (D4)', () => {
  afterEach(() => { clearGuild(); });

  it('selectPrimerRole returns sage-primer-attended when patronRole is a non-empty string', () => {
    setup({ patronRole: 'guild.patron' });
    assert.equal(selectPrimerRole(), PRIMER_ATTENDED_ROLE);
    assert.equal(PRIMER_ATTENDED_ROLE, 'astrolabe.sage-primer-attended');
  });

  it('selectPrimerRole returns sage-primer-solo when patronRole is an empty string', () => {
    setup({ patronRole: '' });
    assert.equal(selectPrimerRole(), PRIMER_SOLO_ROLE);
  });

  it('selectPrimerRole returns sage-primer-solo when patronRole is whitespace-only', () => {
    setup({ patronRole: '   \t  ' });
    assert.equal(selectPrimerRole(), PRIMER_SOLO_ROLE);
  });

  it('selectPrimerRole returns sage-primer-solo when astrolabe config is absent entirely', () => {
    setup(undefined);
    assert.equal(selectPrimerRole(), PRIMER_SOLO_ROLE);
    assert.equal(PRIMER_SOLO_ROLE, 'astrolabe.sage-primer-solo');
  });

  it('engine.run passes sage-primer-attended to animator.summon when patronRole is non-empty', async () => {
    setup({ patronRole: 'guild.patron' });
    const engine = createReaderAnalystEngine();

    const result = await engine.run(defaultGivens(), buildCtx());
    assert.equal(result.status, 'launched');
    assert.equal(fakeAnimator.summonCalls.length, 1);
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-attended');
  });

  it('engine.run passes sage-primer-solo to animator.summon when patronRole is unset', async () => {
    setup(undefined);
    const engine = createReaderAnalystEngine();

    const result = await engine.run(defaultGivens(), buildCtx());
    assert.equal(result.status, 'launched');
    assert.equal(fakeAnimator.summonCalls.length, 1);
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-solo');
  });

  it('engine.run passes sage-primer-solo to animator.summon when patronRole is whitespace-only', async () => {
    setup({ patronRole: '   ' });
    const engine = createReaderAnalystEngine();

    await engine.run(defaultGivens(), buildCtx());
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-solo');
  });

  it('engine.run resolves patronRole from live config on each call — run-time selection (not a captured value)', async () => {
    // First call with patron unset → solo.
    setup(undefined);
    const engine = createReaderAnalystEngine();
    await engine.run(defaultGivens(), buildCtx());
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-solo');

    // Reconfigure the guild mid-experiment — attended should now be chosen.
    clearGuild();
    setup({ patronRole: 'guild.patron' });
    const engine2 = createReaderAnalystEngine();
    await engine2.run(defaultGivens(), buildCtx());
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-attended');
  });
});

// ── Engine surface ───────────────────────────────────────────────────

describe('astrolabe.reader-analyst — engine surface', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('has the expected designId', () => {
    const engine = createReaderAnalystEngine();
    assert.equal(engine.id, 'astrolabe.reader-analyst');
  });

  it('returns { status: "launched", sessionId }', async () => {
    const engine = createReaderAnalystEngine();
    const result = await engine.run(defaultGivens(), buildCtx());
    assert.equal(result.status, 'launched');
    const launched = result as { status: 'launched'; sessionId: string };
    assert.ok(launched.sessionId);
  });

  it('throws when the prompt given is missing', async () => {
    const engine = createReaderAnalystEngine();
    await assert.rejects(
      () => engine.run({ cwd: '/tmp/draft' }, buildCtx()),
      /prompt/,
    );
  });

  it('throws when the cwd given is missing', async () => {
    const engine = createReaderAnalystEngine();
    await assert.rejects(
      () => engine.run({ prompt: 'something' }, buildCtx()),
      /cwd/,
    );
  });

  it('propagates writ metadata to the animator', async () => {
    const engine = createReaderAnalystEngine();
    const givens = {
      ...defaultGivens(),
      writ: { id: 'w-test-123', type: 'mandate', status: 'open' },
    };
    await engine.run(givens, buildCtx());
    assert.equal(fakeAnimator.summonCalls.length, 1);
    const call = fakeAnimator.summonCalls[0];
    assert.equal(call.environment?.GIT_AUTHOR_EMAIL, 'w-test-123@nexus.local');
    assert.equal(call.metadata?.writId, 'w-test-123');
    assert.equal(call.metadata?.engineId, 'reader-analyst');
  });

  it('does not accept a `role` given — the engine chooses the role', async () => {
    // Even if an `astrolabe.reader-analyst` engine slot accidentally gets a
    // `role` given, the engine must not forward it blindly — it must still
    // resolve the primer variant from config.
    const engine = createReaderAnalystEngine();
    await engine.run(
      { ...defaultGivens(), role: 'some.other.role' },
      buildCtx(),
    );
    assert.equal(fakeAnimator.summonCalls.length, 1);
    assert.equal(fakeAnimator.summonCalls[0].role, 'astrolabe.sage-primer-attended',
      'engine must select primer role from config, ignoring any `role` given');
  });
});

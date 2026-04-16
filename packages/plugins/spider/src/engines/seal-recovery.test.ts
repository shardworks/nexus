/**
 * Seal recovery — unit tests for the manual-merge recovery tail.
 *
 * Covers the four acceptance signals from the commission:
 *
 *   1. Full recovery path success — Scriptorium throws `Sealing seized:`;
 *      the seal engine returns `completed` with a graft describing
 *      `manual-merge → seal (retry)`. A subsequent manual-merge session
 *      emits `### Merge: SUCCESS` and the retry seal (with recover: false)
 *      calls scriptorium.seal() which this time succeeds.
 *
 *   2. Manual-merge emits FAILURE (or no marker) → manualMergeEngine.collect()
 *      throws. Inside the Spider this is translated by tryCollect() into a
 *      failEngine → rig stuck transition; here we assert the engine's
 *      collect() throw contract directly.
 *
 *   3. abandon:true + scriptorium.abandonDraft() throws → seal engine
 *      re-throws, no graft returned.
 *
 *   4. recover:false + Scriptorium throws `Sealing seized:` → seal engine
 *      re-throws, no graft returned (one recovery attempt only).
 *
 * The tests exercise the engines directly rather than going through the
 * Spider's crawl loop, which keeps the dependency surface minimal (no
 * fabricator/clerk/stacks wiring beyond what the engines themselves touch).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';
import type { SummonRequest, AnimateHandle, SessionDoc, SessionChunk, SessionResult } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

import sealEngine from './seal.ts';
import manualMergeEngine from './manual-merge.ts';
import type {
  DraftYields,
  SealRecoveryYields,
  SpiderEngineRunResult,
  RigTemplateEngine,
} from '../types.ts';

// ── Fixtures ──────────────────────────────────────────────────────────

type MockScriptorium = {
  seal: (req: unknown) => Promise<{
    success: boolean;
    strategy: 'fast-forward' | 'rebase';
    retries: number;
    sealedCommit: string;
    inscriptionsSealed: number;
  }>;
  abandonDraft: (req: unknown) => Promise<void>;
};

type MockAnimator = {
  summon: (req: SummonRequest) => AnimateHandle;
};

type MockStacks = {
  readBook: <T>(ownerId: string, book: string) => { get: (id: string) => Promise<T | undefined> };
  book: <T>(ownerId: string, book: string) => { get: (id: string) => Promise<T | undefined> };
};

/**
 * Install a minimal fake Guild with the given apparatus stubs. Tests use
 * this to swap in purpose-built scriptorium/animator/stacks mocks for each
 * scenario without standing up the full fixture.
 */
function installGuild(apparatus: Record<string, unknown>): void {
  const fakeConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };
  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatus[name];
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

/** Build a minimal WritDoc for engine input. */
function makeWrit(body = 'Implement the thing.'): WritDoc {
  const now = new Date().toISOString();
  return {
    id: 'writ-1',
    type: 'mandate',
    title: 'Recovery test writ',
    body,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    codex: 'c1',
  } as WritDoc;
}

/** Build minimal DraftYields for seal/manual-merge input. */
function makeDraft(): DraftYields {
  return {
    draftId: 'd1',
    codexName: 'c1',
    branch: 'draft/abc',
    path: '/tmp/worktree-abc',
    baseSha: 'sha1',
  };
}

function makeContext(engineId = 'seal', upstream: Record<string, unknown> = {}): EngineRunContext {
  return { rigId: 'rig-1', engineId, upstream };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('seal engine — recovery tail', () => {
  afterEach(() => {
    clearGuild();
  });

  it('happy path: scriptorium.seal() succeeds → SealYields, no graft', async () => {
    const scriptorium: MockScriptorium = {
      async seal() {
        return {
          success: true,
          strategy: 'fast-forward',
          retries: 0,
          sealedCommit: 'abcdef0',
          inscriptionsSealed: 3,
        };
      },
      async abandonDraft() { throw new Error('not expected'); },
    };
    installGuild({ codexes: scriptorium });

    const draft = makeDraft();
    const ctx = makeContext('seal', { draft });
    const result = await sealEngine.run({}, ctx);

    assert.equal(result.status, 'completed');
    const completed = result as { status: 'completed'; yields: Record<string, unknown>; graft?: unknown };
    assert.equal(completed.yields.sealedCommit, 'abcdef0');
    assert.equal(completed.yields.inscriptionsSealed, 3);
    assert.equal(completed.graft, undefined, 'no graft on success');
  });

  it('full recovery path: rebase-conflict → graft completes → retry seal succeeds', async () => {
    // First seal call throws Sealing seized; second seal call (the retry)
    // succeeds. A single scriptorium instance is shared between both engine
    // invocations to simulate in-memory state transitions.
    let sealCalls = 0;
    const scriptorium: MockScriptorium = {
      async seal() {
        sealCalls++;
        if (sealCalls === 1) {
          throw new Error(
            'Sealing seized: rebase of "draft/abc" onto "main" produced conflicts.',
          );
        }
        return {
          success: true,
          strategy: 'rebase',
          retries: 1,
          sealedCommit: 'deadbee',
          inscriptionsSealed: 2,
        };
      },
      async abandonDraft() { throw new Error('not expected'); },
    };
    installGuild({ codexes: scriptorium });

    const draft = makeDraft();

    // ── Step 1: original seal engine catches Sealing seized: and grafts ──
    const ctx1 = makeContext('seal', { draft });
    const r1 = (await sealEngine.run({}, ctx1)) as SpiderEngineRunResult & {
      status: 'completed';
      yields: SealRecoveryYields;
      graft: RigTemplateEngine[];
      graftTail: string;
    };

    assert.equal(r1.status, 'completed', 'engine completes (does not fail) on recoverable error');
    assert.equal(r1.yields.ok, false, 'yields.ok is false');
    assert.equal(r1.yields.grafted, true, 'yields.grafted is true');
    assert.match(r1.yields.reason, /^Sealing seized:/, 'reason preserves scriptorium message');
    assert.ok(Array.isArray(r1.graft) && r1.graft.length === 2, 'graft contains two engines');

    const [manualMerge, retrySeal] = r1.graft;
    assert.equal(manualMerge.designId, 'manual-merge', 'first graft engine is manual-merge');
    assert.equal(manualMerge.id, 'seal-manual-merge', 'manual-merge id namespaced by originator');
    assert.deepEqual(manualMerge.upstream, ['seal'], 'manual-merge depends on original seal');
    assert.equal(manualMerge.givens?.role, 'spider.mender', 'mender role supplied');
    assert.equal(manualMerge.givens?.writ, '${writ}', 'writ placeholder passed through');
    assert.equal(manualMerge.givens?.cwd, '${yields.draft.path}', 'cwd references draft yields');

    assert.equal(retrySeal.designId, 'seal', 'second graft engine is seal (retry)');
    assert.equal(retrySeal.id, 'seal-retry', 'retry id namespaced by originator');
    assert.deepEqual(retrySeal.upstream, ['seal-manual-merge'], 'retry depends on manual-merge');
    assert.equal(retrySeal.givens?.recover, false, 'retry has recover: false');

    assert.equal(r1.graftTail, 'seal-retry', 'graftTail points at retry seal');

    // ── Step 2: manual-merge engine runs and produces a SUCCESS session ──
    const summonCalls: SummonRequest[] = [];
    let capturedSessionId = '';
    // In-memory session store the manual-merge engine's collect() reads.
    const sessions: Record<string, SessionDoc> = {};

    const animator: MockAnimator = {
      summon(req: SummonRequest): AnimateHandle {
        summonCalls.push(req);
        const sessionId = `ses-${summonCalls.length}`;
        capturedSessionId = sessionId;
        const startedAt = new Date().toISOString();
        const endedAt = startedAt;
        const doc: SessionDoc = {
          id: sessionId,
          status: 'completed',
          startedAt,
          endedAt,
          durationMs: 0,
          provider: 'mock',
          exitCode: 0,
          output: 'Rebased cleanly.\n\n### Merge: SUCCESS',
          metadata: req.metadata,
        };
        sessions[sessionId] = doc;
        async function* empty(): AsyncIterable<SessionChunk> {}
        return {
          sessionId,
          chunks: empty(),
          result: Promise.resolve(doc as SessionResult),
        };
      },
    };
    const stacks: MockStacks = {
      readBook<T>(_owner: string, _book: string) {
        return {
          async get(id: string) { return sessions[id] as unknown as T | undefined; },
        };
      },
      book<T>(_owner: string, _book: string) {
        return {
          async get(id: string) { return sessions[id] as unknown as T | undefined; },
        };
      },
    };
    installGuild({ codexes: scriptorium, animator, stacks });

    // The Spider's template resolver would substitute ${yields.draft.path};
    // here we pass the resolved value directly as the engine would see it at
    // run() time after resolveYieldRefs/resolveGivens.
    const writ = makeWrit();
    const manualMergeCtx = makeContext('seal-manual-merge', { draft, seal: r1.yields });
    const manualMergeGivens = {
      writ,
      role: 'spider.mender',
      cwd: draft.path,
    };
    const mmRun = await manualMergeEngine.run(manualMergeGivens, manualMergeCtx);
    assert.equal(mmRun.status, 'launched', 'manual-merge launches a session');
    const launched = mmRun as { status: 'launched'; sessionId: string };
    assert.equal(launched.sessionId, capturedSessionId, 'sessionId returned matches animator');
    assert.equal(summonCalls.length, 1, 'animator.summon called exactly once');
    assert.equal(summonCalls[0].role, 'spider.mender', 'role passed through');
    assert.equal(summonCalls[0].cwd, draft.path, 'cwd is the draft worktree');
    assert.ok(summonCalls[0].prompt.includes(writ.body), 'prompt embeds the writ body (spec)');
    assert.ok(
      summonCalls[0].prompt.includes('Sealing seized:'),
      'prompt embeds the upstream seal reason',
    );

    // ── Step 3: manual-merge collect() reads SUCCESS marker → merged: true ──
    const mmYields = (await manualMergeEngine.collect!(
      launched.sessionId,
      manualMergeGivens,
      manualMergeCtx,
    )) as { sessionId: string; merged: true };
    assert.equal(mmYields.sessionId, launched.sessionId);
    assert.equal(mmYields.merged, true);

    // ── Step 4: retry seal runs with recover: false → scriptorium.seal()
    //    succeeds this time → normal SealYields, no further graft.
    const retryCtx = makeContext('seal-retry', { draft, 'seal-manual-merge': mmYields });
    const retryResult = await sealEngine.run({ recover: false }, retryCtx);
    assert.equal(retryResult.status, 'completed');
    const retry = retryResult as { status: 'completed'; yields: Record<string, unknown>; graft?: unknown };
    assert.equal(retry.yields.sealedCommit, 'deadbee');
    assert.equal(retry.yields.strategy, 'rebase');
    assert.equal(retry.graft, undefined, 'retry seal does not re-graft on success');
    assert.equal(sealCalls, 2, 'scriptorium.seal called twice total (initial + retry)');
  });

  it('manual-merge FAILURE: collect() throws; rig stays stuck (Spider translates)', async () => {
    const sessions: Record<string, SessionDoc> = {
      's1': {
        id: 's1',
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        provider: 'mock',
        exitCode: 0,
        output:
          'Attempted rebase but hit an irreducible conflict.\n\n### Merge: FAILURE',
      } as SessionDoc,
      's2': {
        id: 's2',
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        provider: 'mock',
        exitCode: 0,
        output: 'This output has no marker at all.',
      } as SessionDoc,
    };
    const stacks: MockStacks = {
      readBook<T>(_owner: string, _book: string) {
        return {
          async get(id: string) { return sessions[id] as unknown as T | undefined; },
        };
      },
      book<T>(_owner: string, _book: string) {
        return {
          async get(id: string) { return sessions[id] as unknown as T | undefined; },
        };
      },
    };
    installGuild({ stacks });

    const ctx = makeContext('seal-manual-merge', {});
    const givens = { writ: makeWrit(), role: 'spider.mender', cwd: '/tmp/worktree-abc' };

    await assert.rejects(
      () => manualMergeEngine.collect!('s1', givens, ctx),
      /FAILURE/,
      'collect() throws when mender emits FAILURE marker',
    );
    await assert.rejects(
      () => manualMergeEngine.collect!('s2', givens, ctx),
      /SUCCESS.*FAILURE|did not emit/,
      'collect() throws when no marker is present',
    );
  });

  it('abandon: scriptorium.abandonDraft() throws → seal re-throws, no graft', async () => {
    const scriptorium: MockScriptorium = {
      async seal() { throw new Error('should not be called on abandon path'); },
      async abandonDraft() {
        throw new Error('Abandon seized: remote unreachable');
      },
    };
    installGuild({ codexes: scriptorium });

    const draft = makeDraft();
    const ctx = makeContext('seal', { draft });

    await assert.rejects(
      () => sealEngine.run({ abandon: true }, ctx),
      /Abandon seized: remote unreachable/,
      'abandon failures always re-throw (no recovery applies)',
    );
  });

  it('recover:false: Sealing seized: still throws, no graft', async () => {
    const scriptorium: MockScriptorium = {
      async seal() {
        throw new Error(
          'Sealing seized: rebase of "draft/abc" onto "main" produced conflicts.',
        );
      },
      async abandonDraft() { throw new Error('not expected'); },
    };
    installGuild({ codexes: scriptorium });

    const draft = makeDraft();
    const ctx = makeContext('seal-retry', { draft });

    await assert.rejects(
      () => sealEngine.run({ recover: false }, ctx),
      /Sealing seized:/,
      'recover:false causes the rebase-conflict path to re-throw (no second recovery layer)',
    );
  });

  it('non-rebase-conflict error (e.g. auth) re-throws unchanged even with recover:true', async () => {
    const scriptorium: MockScriptorium = {
      async seal() {
        throw new Error('fatal: Authentication failed for https://example.com/repo.git');
      },
      async abandonDraft() { throw new Error('not expected'); },
    };
    installGuild({ codexes: scriptorium });

    const draft = makeDraft();
    const ctx = makeContext('seal', { draft });

    await assert.rejects(
      () => sealEngine.run({}, ctx),
      /Authentication failed/,
      'recovery is narrowly scoped to rebase-conflict errors; other errors re-throw',
    );
  });
});

/**
 * Animator session emission — end-to-end integration test.
 *
 * The `session-emission.test.ts` companion tests the helpers in
 * isolation by calling `emitSessionStarted`/`emitSessionEnded`/
 * `emitSessionRecordFailed` directly. This file goes the other
 * direction: it boots a live Animator + Stacks + (mock) Clockworks
 * apparatus and drives the actual dispatch paths so the call sites
 * (in-process attached, in-process cancel, detached
 * `handleSessionRecord`, orphan recovery, rate-limit pre-check) emit
 * what we say they emit.
 *
 * The mock Clockworks captures every `emit()` call into an in-memory
 * `events` book. The tests assert on the resulting rows: name (catalog
 * past tense), payload shape, and presence/absence relative to the
 * dispatch path.
 *
 * Each test boots a fresh apparatus stack so emissions from prior tests
 * cannot leak across test boundaries.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import type { ClockworksApi, EventDoc } from '@shardworks/clockworks-apparatus';

import { createAnimator } from './animator.ts';
import { handleSessionRecord } from './session-record-handler.ts';
import { recoverOrphans } from './startup.ts';
import type {
  AnimatorApi,
  AnimatorSessionProvider,
  SessionChunk,
  SessionDoc,
  SessionProviderConfig,
  SessionProviderResult,
} from './types.ts';

// ── Constants & helpers ──────────────────────────────────────────────

const STALENESS_THRESHOLD_MS = 90_000;

const emptyChunks: AsyncIterable<SessionChunk> = {
  [Symbol.asyncIterator]() {
    return {
      async next() {
        return { value: undefined as unknown as SessionChunk, done: true as const };
      },
    };
  },
};

function createCompletingProvider(
  overrides: Partial<SessionProviderResult> = {},
): AnimatorSessionProvider {
  return {
    name: 'fake',
    launch(_config: SessionProviderConfig) {
      return {
        chunks: emptyChunks,
        result: Promise.resolve({
          status: 'completed' as const,
          exitCode: 0,
          providerSessionId: 'fake-sess-int',
          ...overrides,
        }),
      };
    },
  };
}

function createThrowingProvider(error: Error): AnimatorSessionProvider {
  return {
    name: 'fake-throwing',
    launch() {
      return {
        chunks: emptyChunks,
        result: Promise.reject(error),
      };
    },
  };
}

// ── Fixture ──────────────────────────────────────────────────────────

interface IntegrationFixture {
  stacks: StacksApi;
  animator: AnimatorApi;
  events: Book<EventDoc>;
  /** Capture clockworks rows newer than the boot baseline. */
  eventsAfter(): Promise<EventDoc[]>;
  byName(name: string): Promise<EventDoc[]>;
  /** Underlying sessions book — useful for orphan-recovery setup. */
  sessions: Book<SessionDoc>;
}

interface SetupOptions {
  provider?: AnimatorSessionProvider;
  /** Pause the back-off machine before calling animate(). */
  pauseRateLimit?: { until: string; reason?: string };
  /**
   * Skip wiring the mock Clockworks into the apparatus map. Used to
   * exercise the "Clockworks not installed" silent-no-op contract end
   * to end (no rows in the events book; no thrown emissions).
   */
  withoutClockworks?: boolean;
}

async function setupFixture(opts: SetupOptions = {}): Promise<IntegrationFixture> {
  const provider = opts.provider ?? createCompletingProvider();

  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const animatorPlugin = createAnimator();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in animatorPlugin)) throw new Error('animator must be apparatus');

  const apparatusMap = new Map<string, unknown>();
  apparatusMap.set('fake-provider', provider);

  const fakeGuild: Guild = {
    home: '/tmp/animator-emission-int',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig(): void {},
    guildConfig() {
      return {
        name: 'test-guild',
        nexus: '0.0.0',
        plugins: [],
        settings: { model: 'sonnet' },
        animator: { sessionProvider: 'fake-provider' },
      };
    },
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
    startupWarnings: () => [],
  };
  setGuild(fakeGuild);

  // Pre-create the books each apparatus expects.
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'transcripts' }, {
    indexes: ['sessionId'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'state' }, {});
  memBackend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });

  // Start stacks first.
  await Promise.resolve(stacksPlugin.apparatus.start({ on: () => {}, kits: () => [] }));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Wire a thin in-memory ClockworksApi that mirrors emit() semantics
  // by writing directly to the events book. The animator helpers
  // resolve `clockworks` via `guild().apparatus()` lazily, so this is
  // sufficient — no need to start the real apparatus.
  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');
  if (!opts.withoutClockworks) {
    const clockworks: ClockworksApi = {
      async emit(name, payload, emitter) {
        const id = generateId('e');
        await eventsBook.put({
          id,
          name,
          payload: payload === undefined ? null : payload,
          emitter,
          firedAt: new Date().toISOString(),
          processed: false,
        });
        return id;
      },
    };
    apparatusMap.set('clockworks', clockworks);
  }

  // Optionally pause the rate-limit machine before start(): we write a
  // pause doc directly to `animator/state` so the back-off machine's
  // initial read picks it up.
  if (opts.pauseRateLimit) {
    const stateBook = stacks.book<SessionDoc>('animator', 'state');
    // Use the shape the back-off machine reads; specific field names
    // match `freshStatusDoc()` and the rate-limit-backoff implementation.
    await stateBook.put({
      id: 'dispatch-status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({
        state: 'paused',
        pausedUntil: opts.pauseRateLimit.until,
        pauseReason: opts.pauseRateLimit.reason ?? 'rate-limit',
      } as Record<string, unknown>),
    } as unknown as SessionDoc);
  }

  await Promise.resolve(animatorPlugin.apparatus.start({ on: () => {}, kits: () => [] }));
  const animator = animatorPlugin.apparatus.provides as AnimatorApi;

  // Capture the row-id baseline so subsequent assertions can scope to
  // emissions produced by the test body. Boot doesn't emit anything in
  // this fixture (no first-boot guild.initialized — the events book is
  // pre-created and empty), but we capture anyway to stay robust.
  const baselineRows = await eventsBook.list();
  const baselineIds = new Set(baselineRows.map((r) => r.id));

  return {
    stacks,
    animator,
    events: eventsBook,
    sessions: stacks.book<SessionDoc>('animator', 'sessions'),
    async eventsAfter(): Promise<EventDoc[]> {
      const all = await eventsBook.list({ orderBy: ['firedAt', 'asc'] });
      return all.filter((r) => !baselineIds.has(r.id));
    },
    async byName(name: string): Promise<EventDoc[]> {
      const all = await eventsBook.list({ orderBy: ['firedAt', 'asc'] });
      return all
        .filter((r) => !baselineIds.has(r.id))
        .filter((r) => r.name === name);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Animator emission — end-to-end terminal sites', () => {
  let fix: IntegrationFixture;

  afterEach(() => clearGuild());

  describe('in-process attached path', () => {
    beforeEach(async () => {
      fix = await setupFixture();
    });

    it('emits animator.session.started + animator.session.ended through animate()', async () => {
      const result = await fix.animator.animate({
        context: { systemPrompt: 'test' },
        cwd: '/tmp/wd',
        metadata: { role: 'artificer', trigger: 'summon' },
      }).result;

      assert.equal(result.status, 'completed');

      const started = await fix.byName('animator.session.started');
      const ended = await fix.byName('animator.session.ended');
      assert.equal(started.length, 1, 'animator.session.started fires exactly once');
      assert.equal(ended.length, 1, 'animator.session.ended fires exactly once');

      const startPayload = started[0].payload as Record<string, unknown>;
      assert.equal(startPayload.sessionId, result.id);
      assert.equal(startPayload.anima, 'artificer');
      assert.equal(startPayload.trigger, 'summon');

      const endPayload = ended[0].payload as Record<string, unknown>;
      assert.equal(endPayload.sessionId, result.id);
      assert.equal(endPayload.exitCode, 0);
      assert.equal(typeof endPayload.durationMs, 'number');
    });

    it('emits animator.session.ended with error and non-zero exitCode when provider throws', async () => {
      // New fixture wired to a throwing provider — beforeEach already
      // wired a completing one, so we re-build.
      clearGuild();
      fix = await setupFixture({
        provider: createThrowingProvider(new Error('boom')),
      });

      await assert.rejects(
        () => fix.animator.animate({
          context: { systemPrompt: 'test' },
          cwd: '/tmp/wd',
        }).result,
      );

      const ended = await fix.byName('animator.session.ended');
      assert.equal(ended.length, 1);
      const payload = ended[0].payload as Record<string, unknown>;
      assert.equal(payload.error, 'boom');
      assert.equal(payload.exitCode, 1);
    });
  });

  describe('rate-limit pre-check rejection path', () => {
    it('does NOT emit animator.session.started or animator.session.ended (no SessionDoc was authoritatively written)', async () => {
      // Pause far enough into the future that `isDispatchable` returns
      // false. The pre-check rejection path returns a synthesized
      // rejection result without ever writing a session doc — and
      // therefore must not emit any framework events.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      fix = await setupFixture({
        pauseRateLimit: { until: future, reason: 'rate-limit' },
      });

      const result = await fix.animator.animate({
        context: { systemPrompt: 'test' },
        cwd: '/tmp/wd',
        metadata: { role: 'artificer' },
      }).result;

      // The result indicates rate-limited:
      assert.equal(result.status, 'rate-limited');

      // No animator.session.* emissions.
      assert.equal((await fix.byName('animator.session.started')).length, 0);
      assert.equal((await fix.byName('animator.session.ended')).length, 0);
    });
  });

  describe('in-process cancel() path', () => {
    beforeEach(async () => {
      fix = await setupFixture();
    });

    it('emits animator.session.ended exactly once when cancel() is called on a running session', async () => {
      // Pre-write a running SessionDoc — animator.cancel() reads from
      // the sessions book and overwrites with a cancelled state.
      const id = generateId('ses', 4);
      await fix.sessions.put({
        id,
        status: 'running',
        startedAt: new Date(Date.now() - 1000).toISOString(),
        provider: 'fake',
        metadata: { role: 'artificer' },
      });

      const cancelled = await fix.animator.cancel(id, { reason: 'aborted' });
      assert.equal(cancelled.status, 'cancelled');

      const ended = await fix.byName('animator.session.ended');
      assert.equal(ended.length, 1, 'cancel() fires animator.session.ended exactly once');
      const payload = ended[0].payload as Record<string, unknown>;
      assert.equal(payload.sessionId, id);
      assert.equal(payload.error, 'aborted');
    });

    it('is idempotent — cancel() on an already-terminal session does NOT re-emit', async () => {
      // Pre-write a terminal session.
      const id = generateId('ses', 4);
      await fix.sessions.put({
        id,
        status: 'completed',
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1000,
        provider: 'fake',
      });

      await fix.animator.cancel(id);
      assert.equal((await fix.byName('animator.session.ended')).length, 0);
    });
  });

  describe('detached handleSessionRecord path', () => {
    beforeEach(async () => {
      fix = await setupFixture();
    });

    it('emits animator.session.ended for a detached terminal record', async () => {
      // Pre-write a running record (the babysitter would have done
      // this), then dispatch a terminal session-record payload.
      const id = generateId('ses', 4);
      await fix.sessions.put({
        id,
        status: 'running',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        provider: 'fake',
        metadata: { role: 'artificer' },
      });

      await handleSessionRecord({
        sessionId: id,
        status: 'completed',
        exitCode: 0,
      });

      const ended = await fix.byName('animator.session.ended');
      assert.equal(ended.length, 1);
      const payload = ended[0].payload as Record<string, unknown>;
      assert.equal(payload.sessionId, id);
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.anima, 'artificer');
    });

    it('does NOT emit animator.session.ended when the session is already terminal (idempotency)', async () => {
      const id = generateId('ses', 4);
      // Pre-write a terminal session. The handler sees the
      // already-terminal state and short-circuits without overwriting
      // the doc — and therefore must not emit again.
      await fix.sessions.put({
        id,
        status: 'completed',
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1000,
        provider: 'fake',
      });

      await handleSessionRecord({
        sessionId: id,
        status: 'completed',
        exitCode: 0,
      });

      assert.equal((await fix.byName('animator.session.ended')).length, 0);
    });
  });

  describe('orphan recovery path', () => {
    beforeEach(async () => {
      fix = await setupFixture();
    });

    it('emits animator.session.ended for a stale session reconciled to failed', async () => {
      // Plant a stale session — heartbeat older than the staleness
      // threshold so recoverOrphans() flips it to `failed`.
      const id = generateId('ses', 4);
      const stale = new Date(Date.now() - (STALENESS_THRESHOLD_MS + 60_000)).toISOString();
      await fix.sessions.put({
        id,
        status: 'running',
        startedAt: stale,
        lastActivityAt: stale,
        provider: 'fake',
        metadata: { role: 'artificer' },
      });

      const recovered = await recoverOrphans(fix.sessions, 0);
      assert.equal(recovered, 1);

      const ended = await fix.byName('animator.session.ended');
      assert.equal(ended.length, 1);
      const payload = ended[0].payload as Record<string, unknown>;
      assert.equal(payload.sessionId, id);
    });
  });

  describe('soft-dependency contract — Clockworks not installed', () => {
    it('animate() succeeds and no events land anywhere', async () => {
      fix = await setupFixture({ withoutClockworks: true });

      const result = await fix.animator.animate({
        context: { systemPrompt: 'test' },
        cwd: '/tmp/wd',
        metadata: { role: 'artificer' },
      }).result;

      assert.equal(result.status, 'completed');

      // Events book exists but no rows landed (silent no-op contract).
      assert.equal(await fix.events.count(), 0);
    });
  });
});

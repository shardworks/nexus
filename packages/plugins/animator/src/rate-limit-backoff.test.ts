/**
 * Tests for the Animator rate-limit back-off state machine.
 *
 * Covers:
 *  - Back-off config validation (D10 — patron-override fail-loud shape).
 *  - The state machine's pause / resume / coalesce / increment rules
 *    (D7, D8).
 *  - Reading the status doc via `read()` and the cached `peek()`.
 *  - isDispatchable() predicate (D24 — combined state + window check).
 *  - buildPrecheckRejectionResult() shape parity with in-flight
 *    rate-limited terminals.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';
import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, KitEntry } from '@shardworks/nexus-core';

import {
  DISPATCH_STATUS_DOC_ID,
  DEFAULT_RATE_LIMIT_BACKOFF,
  buildPrecheckRejectionResult,
  createBackoffMachine,
  createResumeProbeTracker,
  freshStatusDoc,
  isDispatchable,
  validateBackoffConfig,
} from './rate-limit-backoff.ts';
import type { AnimatorStatusDoc } from './types.ts';

// ── validateBackoffConfig ───────────────────────────────────────────

describe('validateBackoffConfig()', () => {
  it('returns defaults when config is absent', () => {
    const resolved = validateBackoffConfig(undefined);
    assert.deepEqual(resolved, { ...DEFAULT_RATE_LIMIT_BACKOFF });
  });

  it('accepts partial overrides', () => {
    const resolved = validateBackoffConfig({ initialMs: 1000 });
    assert.equal(resolved.initialMs, 1000);
    assert.equal(resolved.maxMs, DEFAULT_RATE_LIMIT_BACKOFF.maxMs);
    assert.equal(resolved.factor, DEFAULT_RATE_LIMIT_BACKOFF.factor);
  });

  it('throws on non-object input', () => {
    assert.throws(() => validateBackoffConfig(42 as unknown as undefined));
  });

  it('throws on a negative initialMs', () => {
    assert.throws(() => validateBackoffConfig({ initialMs: -1 }));
  });

  it('throws on a non-integer maxMs', () => {
    assert.throws(() => validateBackoffConfig({ maxMs: 1.5 }));
  });

  it('throws on factor <= 1', () => {
    assert.throws(() => validateBackoffConfig({ factor: 1 }));
  });

  it('throws when maxMs < initialMs', () => {
    assert.throws(() => validateBackoffConfig({ initialMs: 1000, maxMs: 500 }));
  });

  it('accepts a fully-specified block', () => {
    const resolved = validateBackoffConfig({ initialMs: 1000, maxMs: 4000, factor: 3 });
    assert.deepEqual(resolved, { initialMs: 1000, maxMs: 4000, factor: 3 });
  });
});

// ── isDispatchable ──────────────────────────────────────────────────

describe('isDispatchable()', () => {
  it('allows dispatch while running', () => {
    assert.equal(isDispatchable({ id: 'dispatch-status', state: 'running', backoffLevel: 0 }), true);
  });

  it('allows dispatch when paused but window has elapsed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const doc: AnimatorStatusDoc = {
      id: 'dispatch-status',
      state: 'paused',
      pausedUntil: past,
      backoffLevel: 0,
    };
    assert.equal(isDispatchable(doc), true);
  });

  it('blocks dispatch when paused and window is open', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const doc: AnimatorStatusDoc = {
      id: 'dispatch-status',
      state: 'paused',
      pausedUntil: future,
      backoffLevel: 0,
    };
    assert.equal(isDispatchable(doc), false);
  });
});

// ── back-off state machine ──────────────────────────────────────────

describe('BackoffMachine', () => {
  let stacks: StacksApi;
  let statusBook: Book<AnimatorStatusDoc>;
  let clock: number;
  const nowFn = () => clock;

  beforeEach(() => {
    const memBackend = new MemoryBackend();
    memBackend.ensureBook({ ownerId: 'animator', book: 'state' }, {});
    const apparatuses = new Map<string, unknown>();
    const fakeGuild: Guild = {
      home: '/tmp/backoff-test',
      apparatus<T>(name: string): T {
        const api = apparatuses.get(name);
        if (!api) throw new Error(`Apparatus "${name}" not installed`);
        return api as T;
      },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 't', nexus: '0.0.0', plugins: [] } as GuildConfig; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);
    const stacksPlugin = createStacksApparatus(memBackend);
    if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
    const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
    stacksPlugin.apparatus.start(noopCtx as never);
    stacks = stacksPlugin.apparatus.provides as StacksApi;
    apparatuses.set('stacks', stacks);

    statusBook = stacks.book<AnimatorStatusDoc>('animator', 'state');
    clock = Date.UTC(2026, 3, 24, 0, 0, 0);
  });

  function make(opts: {
    initialMs?: number;
    maxMs?: number;
    factor?: number;
  } = {}) {
    const cfg = {
      initialMs: opts.initialMs ?? 1000,
      maxMs: opts.maxMs ?? 8000,
      factor: opts.factor ?? 2,
    };
    return createBackoffMachine({
      statusBook,
      config: { get: () => cfg },
      now: nowFn,
      probe: createResumeProbeTracker(),
    });
  }

  it('starts in the fresh running state', async () => {
    const bm = make();
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
    assert.equal(doc.pausedUntil, undefined);
  });

  it('opens a fresh pause on a rate-limit terminal', async () => {
    const bm = make();
    await bm.read(); // warm cache
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    const doc = await bm.read();
    assert.equal(doc.state, 'paused');
    assert.equal(doc.backoffLevel, 0);
    assert.equal(doc.pauseReason, 'rate-limit');
    assert.equal(doc.lastTriggeringSession, 'ses-1');
    assert.equal(new Date(doc.pausedUntil!).getTime(), clock + 1000);
  });

  it('coalesces rate-limit hits during an already-paused window (D8)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    const firstDoc = await bm.read();
    // Second hit before any noteDispatch — should coalesce.
    clock += 50;
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'rate-limited' });
    const secondDoc = await bm.read();
    assert.equal(secondDoc.state, 'paused');
    assert.equal(secondDoc.backoffLevel, 0, 'level must not increment on coalesce');
    assert.equal(secondDoc.pausedUntil, firstDoc.pausedUntil, 'window end unchanged');
  });

  it('increments the back-off level only after a resume dispatch (D8)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    // Simulate an animate() dispatch that got past the gate.
    bm.noteDispatch();
    clock += 5_000;
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'rate-limited' });
    const doc = await bm.read();
    assert.equal(doc.backoffLevel, 1);
    assert.equal(new Date(doc.pausedUntil!).getTime(), clock + 2000);
  });

  it('caps the pause window at maxMs', async () => {
    const bm = make({ initialMs: 1000, maxMs: 3000, factor: 2 });
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    for (let i = 0; i < 5; i++) {
      bm.noteDispatch();
      clock += 100;
      await bm.observeTerminal({ sessionId: `ses-${i + 2}`, status: 'rate-limited' });
    }
    const doc = await bm.read();
    const window = new Date(doc.pausedUntil!).getTime() - clock;
    assert.ok(window <= 3000, `window ${window}ms should be capped at 3000ms`);
  });

  it('resets on a completed resume-probe terminal (D7)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    // A real resume probe — dispatch happens AFTER the pause opens,
    // then completes successfully.
    bm.noteDispatch();
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'completed' });
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
    assert.equal(doc.pausedUntil, undefined);
  });

  it('resets on a failed resume-probe terminal (non-rate-limit, post-dispatch)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    bm.noteDispatch();
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'failed' });
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
  });

  it('does NOT reset on an in-flight straggler (no dispatch since pause)', async () => {
    // Regression: under high concurrency, an in-flight session can
    // complete shortly after a rate-limit hit. That session was
    // dispatched BEFORE the pause opened — its success tells us
    // nothing about the provider's current state. Without this gate,
    // it would clear the pause and let Spider redispatch into the
    // same exhausted-token window.
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    const paused = await bm.read();
    assert.equal(paused.state, 'paused');
    // No noteDispatch() — the next terminal is an in-flight straggler.
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'completed' });
    const after = await bm.read();
    assert.equal(after.state, 'paused', 'pause must survive an in-flight-straggler completion');
    assert.equal(after.pausedUntil, paused.pausedUntil, 'window end unchanged');
    assert.equal(after.backoffLevel, paused.backoffLevel);
  });

  it('does NOT reset on an in-flight straggler that failed (no dispatch since pause)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    const paused = await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'failed' });
    const after = await bm.read();
    assert.equal(after.state, 'paused');
    assert.equal(after.pausedUntil, paused.pausedUntil);
  });

  it('is a no-op when already running and a non-rate-limit terminal arrives', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'completed' });
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
  });

  it('peek() reflects the most recent transition synchronously', async () => {
    const bm = make();
    await bm.read();
    assert.equal(bm.peek().state, 'running');
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    assert.equal(bm.peek().state, 'paused');
    bm.noteDispatch();
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'completed' });
    assert.equal(bm.peek().state, 'running');
  });

  // ── reconcileOnBoot() — eager pause-window expiry reconciliation ──

  it('reconcileOnBoot() flips a paused + elapsed doc to running (D22)', async () => {
    await statusBook.put({
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date(clock - 60_000).toISOString(),
      pausedUntil: new Date(clock - 1).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 1,
      backoffLastHitAt: new Date(clock - 60_000).toISOString(),
      lastTriggeringSession: 'ses-elapsed',
    });
    const bm = make();
    await bm.reconcileOnBoot();
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
    assert.equal(doc.pausedUntil, undefined);
    assert.equal(doc.pausedSince, undefined);
    assert.equal(doc.pauseReason, undefined);
    // Audit history preserved.
    assert.equal(doc.lastTriggeringSession, 'ses-elapsed');
    assert.ok(doc.backoffLastHitAt);
  });

  it('reconcileOnBoot() does not touch a paused doc whose window has not elapsed', async () => {
    const pausedUntil = new Date(clock + 60_000).toISOString();
    await statusBook.put({
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date(clock).toISOString(),
      pausedUntil,
      pauseReason: 'rate-limit',
      backoffLevel: 0,
    });
    const bm = make();
    await bm.reconcileOnBoot();
    const doc = await bm.read();
    assert.equal(doc.state, 'paused');
    assert.equal(doc.pausedUntil, pausedUntil);
    assert.equal(doc.backoffLevel, 0);
  });

  it('reconcileOnBoot() is a no-op on a running doc', async () => {
    const bm = make();
    await bm.reconcileOnBoot();
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
  });

  it('reconcileOnBoot() refreshes peek() so a subsequent synchronous read reflects the flip', async () => {
    await statusBook.put({
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date(clock - 60_000).toISOString(),
      pausedUntil: new Date(clock - 1).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 2,
    });
    const bm = make();
    // Warm the cache first so peek() returns the persisted paused doc.
    await bm.read();
    assert.equal(bm.peek().state, 'paused');
    await bm.reconcileOnBoot();
    // peek() must now reflect the reconciled running state.
    assert.equal(bm.peek().state, 'running');
    assert.equal(bm.peek().backoffLevel, 0);
  });
});

// ── buildPrecheckRejectionResult ────────────────────────────────────

describe('buildPrecheckRejectionResult()', () => {
  it('produces a rate-limited SessionResult with a termination tag', () => {
    const startedAt = new Date().toISOString();
    const pausedUntil = new Date(Date.now() + 60_000).toISOString();
    const result = buildPrecheckRejectionResult({
      sessionId: 'ses-gate-1',
      startedAt,
      provider: 'claude-code',
      pausedUntil,
      pauseReason: 'rate-limit',
      metadata: { writId: 'w-1' },
      conversationId: 'conv-7',
    });
    assert.equal(result.status, 'rate-limited');
    assert.equal(result.id, 'ses-gate-1');
    assert.equal(result.provider, 'claude-code');
    assert.equal(result.conversationId, 'conv-7');
    assert.deepEqual(result.metadata, { writId: 'w-1' });
    assert.ok(result.terminationTag);
    assert.equal(result.terminationTag!.kind, 'rate-limit');
    assert.match(result.error ?? '', /paused/);
  });
});

// ── freshStatusDoc ───────────────────────────────────────────────────

describe('freshStatusDoc()', () => {
  it('uses the well-known dispatch-status document id and a running default', () => {
    const doc = freshStatusDoc();
    assert.equal(doc.id, DISPATCH_STATUS_DOC_ID);
    assert.equal(DISPATCH_STATUS_DOC_ID, 'dispatch-status');
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
  });
});

// Clean up global guild after all tests in this module.
describe('teardown', () => {
  it('clears the guild singleton', () => {
    clearGuild();
  });
});

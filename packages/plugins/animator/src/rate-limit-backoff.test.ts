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
  ANIMATOR_STATUS_DOC_ID,
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
    assert.equal(isDispatchable({ id: 'current', state: 'running', backoffLevel: 0 }), true);
  });

  it('allows dispatch when paused but window has elapsed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const doc: AnimatorStatusDoc = {
      id: 'current',
      state: 'paused',
      pausedUntil: past,
      backoffLevel: 0,
    };
    assert.equal(isDispatchable(doc), true);
  });

  it('blocks dispatch when paused and window is open', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const doc: AnimatorStatusDoc = {
      id: 'current',
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
    memBackend.ensureBook({ ownerId: 'animator', book: 'status' }, {});
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

    statusBook = stacks.book<AnimatorStatusDoc>('animator', 'status');
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

  it('resets on a completed terminal (D7)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'completed' });
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
    assert.equal(doc.pausedUntil, undefined);
  });

  it('resets on a failed terminal (non-rate-limit)', async () => {
    const bm = make();
    await bm.read();
    await bm.observeTerminal({ sessionId: 'ses-1', status: 'rate-limited' });
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'failed' });
    const doc = await bm.read();
    assert.equal(doc.state, 'running');
    assert.equal(doc.backoffLevel, 0);
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
    await bm.observeTerminal({ sessionId: 'ses-2', status: 'completed' });
    assert.equal(bm.peek().state, 'running');
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
  it('uses the well-known document id and a running default', () => {
    const doc = freshStatusDoc();
    assert.equal(doc.id, ANIMATOR_STATUS_DOC_ID);
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

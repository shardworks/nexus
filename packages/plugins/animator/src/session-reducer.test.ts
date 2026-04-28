/**
 * Tests for the SessionDoc transition reducer.
 *
 * Exhaustive coverage of every transition variant against every relevant
 * existing-doc-status combination (null/undefined existing, pending,
 * running, each terminal status), plus the named merge invariants:
 *  - terminal-state immutability (no-op on terminal regression)
 *  - lastActivityAt-preserve-when-absent
 *  - deep-merge of metadata and cancelHandle
 *  - preserve-from-existing for startedAt and provider
 *  - running → running refresh inside detached-ready
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionDoc } from './types.ts';
import {
  TERMINAL_STATUSES,
  reduceSessionTransition,
  type SessionTransition,
} from './session-reducer.ts';

// ── Helpers ─────────────────────────────────────────────────────────

const TERMINAL: ReadonlyArray<SessionDoc['status']> = [
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'rate-limited',
];

function makeDoc(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    id: 'ses-existing-001',
    status: 'running',
    startedAt: '2026-04-01T10:00:00Z',
    provider: 'claude-code',
    ...overrides,
  };
}

// ── TERMINAL_STATUSES set ───────────────────────────────────────────

describe('TERMINAL_STATUSES', () => {
  it('contains exactly the five terminal statuses', () => {
    assert.equal(TERMINAL_STATUSES.size, 5);
    for (const status of TERMINAL) {
      assert.ok(TERMINAL_STATUSES.has(status), `expected ${status} to be terminal`);
    }
  });

  it('does not contain pending or running', () => {
    assert.equal(TERMINAL_STATUSES.has('pending'), false);
    assert.equal(TERMINAL_STATUSES.has('running'), false);
  });
});

// ── Terminal-state immutability rule ───────────────────────────────

describe('terminal-state immutability', () => {
  for (const status of TERMINAL) {
    it(`returns existing unchanged when existing.status is ${status}`, () => {
      const existing = makeDoc({ status, exitCode: 0, endedAt: '2026-04-01T11:00:00Z' });
      const transition: SessionTransition = {
        kind: 'attach-running',
        id: existing.id,
        startedAt: '2026-04-01T12:00:00Z',
        provider: 'other-provider',
        metadata: { writId: 'wrt-new' },
      };
      const next = reduceSessionTransition(existing, transition);
      assert.strictEqual(next, existing, 'returns the same doc reference');
    });

    it(`no-ops a terminal transition against a ${status} existing`, () => {
      const existing = makeDoc({ status });
      const transition: SessionTransition = {
        kind: 'terminal',
        id: existing.id,
        status: 'failed',
        startedAt: '2026-04-01T10:00:00Z',
        endedAt: '2026-04-01T11:00:00Z',
        durationMs: 3600_000,
        provider: 'claude-code',
        exitCode: 1,
        lastActivityAt: '2026-04-01T11:00:00Z',
      };
      assert.strictEqual(reduceSessionTransition(existing, transition), existing);
    });

    it(`no-ops a heartbeat-touch against a ${status} existing`, () => {
      const existing = makeDoc({ status, lastActivityAt: '2026-04-01T10:00:00Z' });
      const next = reduceSessionTransition(existing, {
        kind: 'heartbeat-touch',
        id: existing.id,
        lastActivityAt: '2026-04-01T11:00:00Z',
      });
      assert.strictEqual(next, existing);
    });
  }
});

// ── pending-pre-write ──────────────────────────────────────────────

describe('pending-pre-write', () => {
  it('writes a fresh pending doc when no existing', () => {
    const next = reduceSessionTransition(undefined, {
      kind: 'pending-pre-write',
      id: 'ses-001',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:00:00Z',
      metadata: { writId: 'wrt-1' },
      authorizedTools: ['session-running', 'session-record'],
    });
    assert.equal(next.id, 'ses-001');
    assert.equal(next.status, 'pending');
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(next.provider, 'claude-code');
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:00Z');
    assert.deepEqual(next.metadata, { writId: 'wrt-1' });
    assert.deepEqual(next.authorizedTools, ['session-running', 'session-record']);
  });

  it('preserves startedAt and provider from existing pending', () => {
    const existing = makeDoc({
      status: 'pending',
      startedAt: '2026-04-01T09:00:00Z',
      provider: 'older-provider',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'pending-pre-write',
      id: existing.id,
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'newer-provider',
      lastActivityAt: '2026-04-01T10:00:00Z',
    });
    assert.equal(next.startedAt, '2026-04-01T09:00:00Z');
    assert.equal(next.provider, 'older-provider');
  });

  it('deep-merges metadata when both existing and transition supply it', () => {
    const existing = makeDoc({
      status: 'pending',
      metadata: { writId: 'wrt-orig', engineId: 'eng-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'pending-pre-write',
      id: existing.id,
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:01:00Z',
      metadata: { engineId: 'eng-2', extra: 'value' },
    });
    assert.deepEqual(next.metadata, {
      writId: 'wrt-orig',
      engineId: 'eng-2',
      extra: 'value',
    });
  });

  it('refreshes lastActivityAt from the transition payload', () => {
    const existing = makeDoc({
      status: 'pending',
      lastActivityAt: '2026-04-01T10:00:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'pending-pre-write',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      lastActivityAt: '2026-04-01T10:05:00Z',
    });
    assert.equal(next.lastActivityAt, '2026-04-01T10:05:00Z');
  });
});

// ── attach-running ─────────────────────────────────────────────────

describe('attach-running', () => {
  it('writes a fresh running doc when no existing', () => {
    const next = reduceSessionTransition(null, {
      kind: 'attach-running',
      id: 'ses-001',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });
    assert.equal(next.status, 'running');
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(next.provider, 'claude-code');
  });

  it('preserves startedAt and provider from existing pending', () => {
    const existing = makeDoc({
      status: 'pending',
      startedAt: '2026-04-01T09:00:00Z',
      provider: 'pending-provider',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'attach-provider',
    });
    assert.equal(next.startedAt, '2026-04-01T09:00:00Z');
    assert.equal(next.provider, 'pending-provider');
    assert.equal(next.status, 'running');
  });

  it('does not write lastActivityAt — payload does not carry one', () => {
    const existing = makeDoc({ status: 'pending', lastActivityAt: '2026-04-01T10:00:00Z' });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });
    // lastActivityAt is preserved from existing, not refreshed.
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:00Z');
  });

  it('deep-merges metadata when both existing and transition supply it', () => {
    const existing = makeDoc({
      status: 'pending',
      metadata: { writId: 'wrt-orig', engineId: 'eng-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      metadata: { engineId: 'eng-2', trigger: 'summon' },
    });
    assert.deepEqual(next.metadata, {
      writId: 'wrt-orig',
      engineId: 'eng-2',
      trigger: 'summon',
    });
  });

  it('preserves existing metadata when transition has none', () => {
    const existing = makeDoc({ status: 'pending', metadata: { writId: 'wrt-orig' } });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
    });
    assert.deepEqual(next.metadata, { writId: 'wrt-orig' });
  });

  it('replaces cancelHandle with the transition value when both supply it', () => {
    // The reducer's cancelHandle merge is a straight replacement: the
    // transition's complete `LocalPgidHandle` wins, the existing handle
    // is dropped. Producers (the babysitter, the detached fallback)
    // always hand a fully formed handle in; partial overlays would
    // require the transition to know the existing variant.
    const existing = makeDoc({
      status: 'pending',
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      cancelHandle: { kind: 'local-pgid', pgid: 99 },
    });
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 99 });
  });

  it('prefers transition.conversationId over existing', () => {
    const existing = makeDoc({ status: 'pending', conversationId: 'conv-old' });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      conversationId: 'conv-new',
    });
    assert.equal(next.conversationId, 'conv-new');
  });

  it('preserves existing conversationId when transition omits it', () => {
    const existing = makeDoc({ status: 'pending', conversationId: 'conv-1' });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
    });
    assert.equal(next.conversationId, 'conv-1');
  });
});

// ── detached-ready ─────────────────────────────────────────────────

describe('detached-ready', () => {
  it('writes a fresh running doc when no existing (cold start)', () => {
    const next = reduceSessionTransition(undefined, {
      kind: 'detached-ready',
      id: 'ses-001',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:01:00Z',
    });
    assert.equal(next.status, 'running');
    assert.equal(next.lastActivityAt, '2026-04-01T10:01:00Z');
  });

  it('pending → running preserves startedAt and provider from existing', () => {
    const existing = makeDoc({
      status: 'pending',
      startedAt: '2026-04-01T09:00:00Z',
      provider: 'pending-provider',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'ready-provider',
      lastActivityAt: '2026-04-01T10:00:01Z',
    });
    assert.equal(next.status, 'running');
    assert.equal(next.startedAt, '2026-04-01T09:00:00Z');
    assert.equal(next.provider, 'pending-provider');
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:01Z');
  });

  it('refreshes lastActivityAt from transition payload', () => {
    const existing = makeDoc({
      status: 'pending',
      lastActivityAt: '2026-04-01T09:00:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      lastActivityAt: '2026-04-01T10:00:00Z',
    });
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:00Z');
  });

  it('running → running refresh: only lastActivityAt and cancelHandle change', () => {
    const existing = makeDoc({
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:00:00Z',
      metadata: { writId: 'wrt-orig' },
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: '2026-04-01T11:00:00Z',
      provider: 'other-provider',
      lastActivityAt: '2026-04-01T10:00:30Z',
      metadata: { writId: 'wrt-new' },
      cancelHandle: { kind: 'local-pgid', pgid: 99 },
    });
    // metadata, startedAt, provider must not change on running → running.
    assert.deepEqual(next.metadata, { writId: 'wrt-orig' });
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(next.provider, 'claude-code');
    // lastActivityAt and cancelHandle do change.
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:30Z');
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 99 });
  });

  it('running → running refresh without cancelHandle leaves the existing one alone', () => {
    const existing = makeDoc({
      status: 'running',
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
      lastActivityAt: '2026-04-01T10:00:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      lastActivityAt: '2026-04-01T10:01:00Z',
    });
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 1 });
  });

  it('replaces cancelHandle on running → running with the transition value', () => {
    // Same straight-replace rule as the attach-running path — the
    // transition supplies a complete handle, no overlay is attempted.
    const existing = makeDoc({
      status: 'running',
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      lastActivityAt: '2026-04-01T10:01:00Z',
      cancelHandle: { kind: 'local-pgid', pgid: 42 },
    });
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 42 });
  });

  it('pending → running deep-merges metadata', () => {
    const existing = makeDoc({
      status: 'pending',
      metadata: { writId: 'wrt-1', engineId: 'eng-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'detached-ready',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
      lastActivityAt: '2026-04-01T10:01:00Z',
      metadata: { engineId: 'eng-2', extra: 'val' },
    });
    assert.deepEqual(next.metadata, {
      writId: 'wrt-1',
      engineId: 'eng-2',
      extra: 'val',
    });
  });
});

// ── heartbeat-touch ────────────────────────────────────────────────

describe('heartbeat-touch', () => {
  it('updates only lastActivityAt on a running doc', () => {
    const existing = makeDoc({
      status: 'running',
      lastActivityAt: '2026-04-01T10:00:00Z',
      metadata: { writId: 'wrt-1' },
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
      provider: 'claude-code',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'heartbeat-touch',
      id: existing.id,
      lastActivityAt: '2026-04-01T10:00:30Z',
    });
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:30Z');
    // Everything else preserved.
    assert.equal(next.status, 'running');
    assert.equal(next.startedAt, existing.startedAt);
    assert.equal(next.provider, 'claude-code');
    assert.deepEqual(next.metadata, { writId: 'wrt-1' });
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 1 });
  });

  it('updates only lastActivityAt on a pending doc', () => {
    const existing = makeDoc({ status: 'pending' });
    const next = reduceSessionTransition(existing, {
      kind: 'heartbeat-touch',
      id: existing.id,
      lastActivityAt: '2026-04-01T10:00:30Z',
    });
    assert.equal(next.status, 'pending');
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:30Z');
  });

  it('throws when called without an existing doc', () => {
    assert.throws(
      () =>
        reduceSessionTransition(undefined, {
          kind: 'heartbeat-touch',
          id: 'ses-missing',
          lastActivityAt: '2026-04-01T10:00:30Z',
        }),
      /requires an existing SessionDoc/,
    );
  });
});

// ── terminal ───────────────────────────────────────────────────────

describe('terminal', () => {
  for (const status of ['completed', 'failed', 'timeout', 'rate-limited'] as const) {
    it(`writes terminal ${status} from a running existing`, () => {
      const existing = makeDoc({
        status: 'running',
        startedAt: '2026-04-01T10:00:00Z',
        provider: 'claude-code',
        cancelHandle: { kind: 'local-pgid', pgid: 1 },
        metadata: { writId: 'wrt-1' },
      });
      const next = reduceSessionTransition(existing, {
        kind: 'terminal',
        id: existing.id,
        status,
        startedAt: '2026-04-01T10:00:00Z',
        endedAt: '2026-04-01T10:05:00Z',
        durationMs: 300_000,
        provider: 'claude-code',
        exitCode: status === 'completed' ? 0 : 1,
        lastActivityAt: '2026-04-01T10:05:00Z',
      });
      assert.equal(next.status, status);
      // Preserved across the terminal write.
      assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
      assert.equal(next.provider, 'claude-code');
      assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 1 });
      assert.deepEqual(next.metadata, { writId: 'wrt-1' });
      assert.equal(next.endedAt, '2026-04-01T10:05:00Z');
      assert.equal(next.durationMs, 300_000);
      assert.equal(next.lastActivityAt, '2026-04-01T10:05:00Z');
    });
  }

  it('writes terminal from no existing (handleSessionRecord cold-start path)', () => {
    const next = reduceSessionTransition(null, {
      kind: 'terminal',
      id: 'ses-cold',
      status: 'failed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: 'claude-code',
      exitCode: 1,
      lastActivityAt: '2026-04-01T10:05:00Z',
      error: 'something went wrong',
    });
    assert.equal(next.status, 'failed');
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(next.provider, 'claude-code');
    assert.equal(next.error, 'something went wrong');
  });

  it('preserves existing metadata when transition omits it', () => {
    const existing = makeDoc({
      status: 'running',
      metadata: { writId: 'wrt-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'completed',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 0,
      lastActivityAt: '2026-04-01T10:05:00Z',
    });
    assert.deepEqual(next.metadata, { writId: 'wrt-1' });
  });

  it('deep-merges metadata when both supply it', () => {
    const existing = makeDoc({
      status: 'running',
      metadata: { writId: 'wrt-1', engineId: 'eng-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'completed',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 0,
      lastActivityAt: '2026-04-01T10:05:00Z',
      metadata: { engineId: 'eng-2', cost: 0.5 },
    });
    assert.deepEqual(next.metadata, {
      writId: 'wrt-1',
      engineId: 'eng-2',
      cost: 0.5,
    });
  });

  it('attaches optional cost / token / output / providerSessionId / terminationTag fields', () => {
    const existing = makeDoc({ status: 'running' });
    const next = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'rate-limited',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 0,
      lastActivityAt: '2026-04-01T10:05:00Z',
      costUsd: 0.5,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      output: 'final',
      providerSessionId: 'sid-99',
      terminationTag: { kind: 'rate-limit', source: 'ndjson-result' },
    });
    assert.equal(next.costUsd, 0.5);
    assert.deepEqual(next.tokenUsage, { inputTokens: 100, outputTokens: 50 });
    assert.equal(next.output, 'final');
    assert.equal(next.providerSessionId, 'sid-99');
    assert.deepEqual(next.terminationTag, { kind: 'rate-limit', source: 'ndjson-result' });
  });

  it('attaches terminationDiagnostic only when supplied', () => {
    const existing = makeDoc({ status: 'running' });
    const withDiag = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'failed',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 2,
      lastActivityAt: '2026-04-01T10:05:00Z',
      terminationDiagnostic: { exitCode: 2, stderrExcerpt: 'boom' },
    });
    assert.deepEqual(withDiag.terminationDiagnostic, { exitCode: 2, stderrExcerpt: 'boom' });

    const withoutDiag = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'completed',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 0,
      lastActivityAt: '2026-04-01T10:05:00Z',
    });
    assert.equal(withoutDiag.terminationDiagnostic, undefined);
  });

  it('falls back to transition provider/startedAt when no existing doc', () => {
    const next = reduceSessionTransition(undefined, {
      kind: 'terminal',
      id: 'ses-cold',
      status: 'failed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: 'unknown',
      exitCode: 1,
      lastActivityAt: '2026-04-01T10:05:00Z',
    });
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(next.provider, 'unknown');
  });

  it('preserves cancelHandle from existing through terminal', () => {
    const existing = makeDoc({
      status: 'running',
      cancelHandle: { kind: 'local-pgid', pgid: 42 },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'terminal',
      id: existing.id,
      status: 'completed',
      startedAt: existing.startedAt,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      provider: existing.provider,
      exitCode: 0,
      lastActivityAt: '2026-04-01T10:05:00Z',
    });
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 42 });
  });
});

// ── cancel ─────────────────────────────────────────────────────────

describe('cancel', () => {
  it('flips a running doc to cancelled, recording endedAt and durationMs', () => {
    const existing = makeDoc({
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      cancelHandle: { kind: 'local-pgid', pgid: 1 },
      metadata: { writId: 'wrt-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'cancel',
      id: existing.id,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
      reason: 'user requested',
    });
    assert.equal(next.status, 'cancelled');
    assert.equal(next.endedAt, '2026-04-01T10:05:00Z');
    assert.equal(next.durationMs, 300_000);
    assert.equal(next.error, 'user requested');
    // Other fields preserved.
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
    assert.deepEqual(next.cancelHandle, { kind: 'local-pgid', pgid: 1 });
    assert.deepEqual(next.metadata, { writId: 'wrt-1' });
  });

  it('omits error when no reason supplied', () => {
    const existing = makeDoc({ status: 'running' });
    const next = reduceSessionTransition(existing, {
      kind: 'cancel',
      id: existing.id,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300_000,
    });
    assert.equal(next.error, undefined);
  });

  it('flips a pending doc to cancelled', () => {
    const existing = makeDoc({ status: 'pending' });
    const next = reduceSessionTransition(existing, {
      kind: 'cancel',
      id: existing.id,
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 0,
    });
    assert.equal(next.status, 'cancelled');
  });

  it('throws when no existing doc', () => {
    assert.throws(
      () =>
        reduceSessionTransition(undefined, {
          kind: 'cancel',
          id: 'ses-missing',
          endedAt: '2026-04-01T10:05:00Z',
          durationMs: 0,
        }),
      /requires an existing SessionDoc/,
    );
  });
});

// ── orphan-failed ──────────────────────────────────────────────────

describe('orphan-failed', () => {
  it('flips a running doc to failed with the given diagnostic fields', () => {
    const existing = makeDoc({
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      lastActivityAt: '2026-04-01T10:00:00Z',
      metadata: { writId: 'wrt-1' },
    });
    const next = reduceSessionTransition(existing, {
      kind: 'orphan-failed',
      id: existing.id,
      endedAt: '2026-04-01T10:02:00Z',
      durationMs: 120_000,
      exitCode: 1,
      error: 'No heartbeat received for 120s',
    });
    assert.equal(next.status, 'failed');
    assert.equal(next.endedAt, '2026-04-01T10:02:00Z');
    assert.equal(next.durationMs, 120_000);
    assert.equal(next.exitCode, 1);
    assert.ok(next.error?.includes('No heartbeat received'));
    // Preserved.
    assert.deepEqual(next.metadata, { writId: 'wrt-1' });
    assert.equal(next.startedAt, '2026-04-01T10:00:00Z');
  });

  it('does NOT refresh lastActivityAt — the host is presumed dead', () => {
    const existing = makeDoc({
      status: 'running',
      lastActivityAt: '2026-04-01T10:00:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'orphan-failed',
      id: existing.id,
      endedAt: '2026-04-01T10:02:00Z',
      durationMs: 120_000,
      exitCode: 1,
      error: 'no heartbeat',
    });
    assert.equal(next.lastActivityAt, '2026-04-01T10:00:00Z');
  });

  it('throws when no existing doc', () => {
    assert.throws(
      () =>
        reduceSessionTransition(undefined, {
          kind: 'orphan-failed',
          id: 'ses-missing',
          endedAt: '2026-04-01T10:00:00Z',
          durationMs: 0,
          exitCode: 1,
          error: 'no heartbeat',
        }),
      /requires an existing SessionDoc/,
    );
  });
});

// ── lastActivityAt-preserve-when-absent ────────────────────────────

describe('lastActivityAt preserve-when-absent rule', () => {
  it('attach-running leaves existing lastActivityAt intact (no payload field)', () => {
    const existing = makeDoc({
      status: 'pending',
      lastActivityAt: '2026-04-01T09:59:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'attach-running',
      id: existing.id,
      startedAt: existing.startedAt,
      provider: existing.provider,
    });
    assert.equal(next.lastActivityAt, '2026-04-01T09:59:00Z');
  });

  it('cancel does not touch lastActivityAt', () => {
    const existing = makeDoc({
      status: 'running',
      lastActivityAt: '2026-04-01T09:59:00Z',
    });
    const next = reduceSessionTransition(existing, {
      kind: 'cancel',
      id: existing.id,
      endedAt: '2026-04-01T10:00:00Z',
      durationMs: 0,
    });
    assert.equal(next.lastActivityAt, '2026-04-01T09:59:00Z');
  });
});

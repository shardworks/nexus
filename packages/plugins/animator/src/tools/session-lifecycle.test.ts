/**
 * Tests for session-running and session-record tools,
 * DLQ drain, and orphan recovery.
 *
 * Uses the same fake guild + in-memory Stacks harness as the existing
 * session-tools tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';

import type { SessionDoc, TranscriptDoc } from '../types.ts';
import sessionRunning from './session-running.ts';
import sessionRecord from './session-record.ts';
import { drainDlq, recoverOrphans } from '../startup.ts';
import sessionHeartbeat from './session-heartbeat.ts';

// ── Test harness ────────────────────────────────────────────────────

let stacks: StacksApi;
let sessions: Book<SessionDoc>;
let transcripts: Book<TranscriptDoc>;
let apparatusMap: Map<string, unknown>;
let tmpDir: string;

function setup() {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);

  apparatusMap = new Map<string, unknown>();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animator-test-'));

  const fakeGuild: Guild = {
    home: tmpDir,
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  const sa = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  sa.start({ on: () => {}, kits: () => [] });
  stacks = sa.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  const memBe = memBackend;
  memBe.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });
  memBe.ensureBook({ ownerId: 'animator', book: 'transcripts' }, {
    indexes: ['sessionId'],
  });

  sessions = stacks.book<SessionDoc>('animator', 'sessions');
  transcripts = stacks.book<TranscriptDoc>('animator', 'transcripts');
}

function cleanup() {
  clearGuild();
  // Clean up tmp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ── session-running tool tests ─────────────────────────────────────

describe('session-running tool', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('writes a running SessionDoc', async () => {
    const result = await sessionRunning.handler({
      sessionId: 'ses-test-001',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-test-001' });

    const doc = await sessions.get('ses-test-001');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
    assert.equal(doc.startedAt, '2026-04-01T10:00:00Z');
    assert.equal(doc.provider, 'claude-code');
  });

  it('includes optional fields when provided', async () => {
    await sessionRunning.handler({
      sessionId: 'ses-test-002',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      conversationId: 'conv-abc',
      metadata: { writId: 'wrt-123', engineId: 'eng-456' },
      cancelHandle: { kind: 'local-pgid', pgid: 12345 },
    });

    const doc = await sessions.get('ses-test-002');
    assert.ok(doc);
    assert.equal(doc.conversationId, 'conv-abc');
    assert.deepEqual(doc.metadata, { writId: 'wrt-123', engineId: 'eng-456' });
    assert.deepEqual(doc.cancelHandle, { kind: 'local-pgid', pgid: 12345 });
  });

  it('handles duplicate calls gracefully (idempotent upsert)', async () => {
    await sessionRunning.handler({
      sessionId: 'ses-test-003',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    // Second call with same session ID — should succeed (upsert).
    const result = await sessionRunning.handler({
      sessionId: 'ses-test-003',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      cancelHandle: { kind: 'local-pgid', pgid: 99999 },
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-test-003' });

    const doc = await sessions.get('ses-test-003');
    assert.ok(doc);
    assert.deepEqual(doc.cancelHandle, { kind: 'local-pgid', pgid: 99999 });
  });

  it('has callableBy anima and permission write', () => {
    const callableBy = Array.isArray(sessionRunning.callableBy)
      ? sessionRunning.callableBy
      : [sessionRunning.callableBy];
    assert.ok(callableBy.includes('anima'));
    assert.equal(sessionRunning.permission, 'write');
  });

  it('already-running session refreshes lastActivityAt and cancelHandle only', async () => {
    // Seed a running session with known values
    await sessions.put({
      id: 'ses-idem-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:00:00Z',
      metadata: { writId: 'wrt-orig' },
    });

    // Call with different metadata, startedAt, provider, and a cancelHandle
    const result = await sessionRunning.handler({
      sessionId: 'ses-idem-001',
      startedAt: '2026-04-01T11:00:00Z',
      provider: 'other-provider',
      metadata: { writId: 'wrt-new' },
      cancelHandle: { kind: 'local-pgid', pgid: 55555 },
    });

    // Return value should not include status
    assert.deepEqual(result, { ok: true, sessionId: 'ses-idem-001' });

    const doc = await sessions.get('ses-idem-001');
    assert.ok(doc);
    // lastActivityAt should be refreshed
    assert.notEqual(doc.lastActivityAt, '2026-04-01T10:00:00Z');
    // cancelHandle should be updated
    assert.deepEqual(doc.cancelHandle, { kind: 'local-pgid', pgid: 55555 });
    // metadata should NOT be overwritten
    assert.deepEqual(doc.metadata, { writId: 'wrt-orig' });
    // startedAt should NOT be overwritten
    assert.equal(doc.startedAt, '2026-04-01T10:00:00Z');
    // provider should NOT be overwritten
    assert.equal(doc.provider, 'claude-code');
  });

  it('ready report against completed session does not regress state', async () => {
    await sessions.put({
      id: 'ses-term-run-001',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      exitCode: 0,
    });

    const result = await sessionRunning.handler({
      sessionId: 'ses-term-run-001',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-term-run-001', status: 'completed' });

    const doc = await sessions.get('ses-term-run-001');
    assert.ok(doc);
    assert.equal(doc.status, 'completed');
  });

  it('ready report against failed session does not regress state', async () => {
    await sessions.put({
      id: 'ses-term-run-002',
      status: 'failed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      exitCode: 1,
      error: 'reconciled',
    });

    const result = await sessionRunning.handler({
      sessionId: 'ses-term-run-002',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-term-run-002', status: 'failed' });

    const doc = await sessions.get('ses-term-run-002');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
  });

  it('ready report against cancelled session does not regress state', async () => {
    await sessions.put({
      id: 'ses-term-run-003',
      status: 'cancelled',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      error: 'User cancelled',
    });

    const result = await sessionRunning.handler({
      sessionId: 'ses-term-run-003',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-term-run-003', status: 'cancelled' });

    const doc = await sessions.get('ses-term-run-003');
    assert.ok(doc);
    assert.equal(doc.status, 'cancelled');
  });

  it('ready report against timeout session does not regress state', async () => {
    await sessions.put({
      id: 'ses-term-run-004',
      status: 'timeout',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    const result = await sessionRunning.handler({
      sessionId: 'ses-term-run-004',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-term-run-004', status: 'timeout' });

    const doc = await sessions.get('ses-term-run-004');
    assert.ok(doc);
    assert.equal(doc.status, 'timeout');
  });
});

// ── session-record tool tests ──────────────────────────────────────

describe('session-record tool', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('writes a completed SessionDoc', async () => {
    // First write a running session.
    await sessions.put({
      id: 'ses-rec-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      metadata: { writId: 'wrt-001' },
    });

    const result = await sessionRecord.handler({
      sessionId: 'ses-rec-001',
      status: 'completed',
      exitCode: 0,
      costUsd: 0.50,
      output: 'Task completed successfully.',
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');

    const doc = await sessions.get('ses-rec-001');
    assert.ok(doc);
    assert.equal(doc.status, 'completed');
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.costUsd, 0.50);
    assert.equal(doc.output, 'Task completed successfully.');
    assert.ok(doc.endedAt);
    assert.ok(typeof doc.durationMs === 'number');
    // Preserves metadata from the running doc.
    assert.deepEqual(doc.metadata, { writId: 'wrt-001' });
  });

  it('writes SessionDoc and TranscriptDoc', async () => {
    await sessions.put({
      id: 'ses-rec-002',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    const transcript = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    await sessionRecord.handler({
      sessionId: 'ses-rec-002',
      status: 'completed',
      exitCode: 0,
      transcript,
    });

    const tDoc = await transcripts.get('ses-rec-002');
    assert.ok(tDoc);
    assert.equal(tDoc.messages.length, 2);
    assert.deepEqual(tDoc.messages[0], { role: 'user', content: 'Hello' });
  });

  it('respects cancelled status — does not overwrite', async () => {
    await sessions.put({
      id: 'ses-rec-003',
      status: 'cancelled',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:02:00Z',
      durationMs: 120000,
      provider: 'claude-code',
      error: 'Cancelled by user',
    });

    const result = await sessionRecord.handler({
      sessionId: 'ses-rec-003',
      status: 'completed',
      exitCode: 0,
    });

    assert.equal(result.status, 'cancelled');

    // SessionDoc should still be cancelled.
    const doc = await sessions.get('ses-rec-003');
    assert.ok(doc);
    assert.equal(doc.status, 'cancelled');
    assert.equal(doc.error, 'Cancelled by user');
  });

  it('writes transcript even for cancelled sessions', async () => {
    await sessions.put({
      id: 'ses-rec-004',
      status: 'cancelled',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    const transcript = [{ role: 'assistant', content: 'partial output' }];

    await sessionRecord.handler({
      sessionId: 'ses-rec-004',
      status: 'completed',
      exitCode: 0,
      transcript,
    });

    const tDoc = await transcripts.get('ses-rec-004');
    assert.ok(tDoc);
    assert.equal(tDoc.messages.length, 1);
  });

  it('handles missing session gracefully (no prior running doc)', async () => {
    // No running doc exists — should still create the session doc.
    const result = await sessionRecord.handler({
      sessionId: 'ses-rec-005',
      status: 'failed',
      exitCode: 1,
      error: 'Something went wrong',
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'failed');

    const doc = await sessions.get('ses-rec-005');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
    assert.equal(doc.error, 'Something went wrong');
    assert.equal(doc.provider, 'unknown');
  });

  it('records token usage', async () => {
    await sessions.put({
      id: 'ses-rec-006',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    await sessionRecord.handler({
      sessionId: 'ses-rec-006',
      status: 'completed',
      exitCode: 0,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
      },
    });

    const doc = await sessions.get('ses-rec-006');
    assert.ok(doc);
    assert.deepEqual(doc.tokenUsage, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
    });
  });

  it('has callableBy anima and permission write', () => {
    const callableBy = Array.isArray(sessionRecord.callableBy)
      ? sessionRecord.callableBy
      : [sessionRecord.callableBy];
    assert.ok(callableBy.includes('anima'));
    assert.equal(sessionRecord.permission, 'write');
  });

  it('persists terminationDiagnostic on failed sessions', async () => {
    await sessions.put({
      id: 'ses-rec-diag-1',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    await sessionRecord.handler({
      sessionId: 'ses-rec-diag-1',
      status: 'failed',
      exitCode: 2,
      error: 'claude exited with code 2',
      terminationDiagnostic: {
        exitCode: 2,
        stderrExcerpt: 'boom: process died',
      },
    });

    const doc = await sessions.get('ses-rec-diag-1');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
    assert.deepEqual(doc.terminationDiagnostic, {
      exitCode: 2,
      stderrExcerpt: 'boom: process died',
    });
  });

  it('omits terminationDiagnostic when not supplied', async () => {
    await sessions.put({
      id: 'ses-rec-diag-2',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    await sessionRecord.handler({
      sessionId: 'ses-rec-diag-2',
      status: 'completed',
      exitCode: 0,
    });

    const doc = await sessions.get('ses-rec-diag-2');
    assert.ok(doc);
    assert.equal(doc.terminationDiagnostic, undefined);
  });
});

// ── DLQ drain tests ────────────────────────────────────────────────

describe('DLQ drain', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('processes DLQ files and deletes them', async () => {
    // Create a running session that the DLQ file will finalize.
    await sessions.put({
      id: 'ses-dlq-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    // Write a DLQ file.
    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    fs.mkdirSync(dlqDir, { recursive: true });
    fs.writeFileSync(
      path.join(dlqDir, 'ses-dlq-001.json'),
      JSON.stringify({
        sessionId: 'ses-dlq-001',
        status: 'completed',
        exitCode: 0,
        costUsd: 0.25,
      }),
    );

    const processed = await drainDlq(tmpDir);
    assert.equal(processed, 1);

    // The session should now be completed.
    const doc = await sessions.get('ses-dlq-001');
    assert.ok(doc);
    assert.equal(doc.status, 'completed');
    assert.equal(doc.costUsd, 0.25);

    // The DLQ file should be deleted.
    const remaining = fs.readdirSync(dlqDir);
    assert.equal(remaining.length, 0);
  });

  it('processes multiple DLQ files', async () => {
    await sessions.put({
      id: 'ses-dlq-a',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });
    await sessions.put({
      id: 'ses-dlq-b',
      status: 'running',
      startedAt: '2026-04-01T11:00:00Z',
      provider: 'claude-code',
    });

    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    fs.mkdirSync(dlqDir, { recursive: true });
    fs.writeFileSync(
      path.join(dlqDir, 'ses-dlq-a.json'),
      JSON.stringify({ sessionId: 'ses-dlq-a', status: 'completed', exitCode: 0 }),
    );
    fs.writeFileSync(
      path.join(dlqDir, 'ses-dlq-b.json'),
      JSON.stringify({ sessionId: 'ses-dlq-b', status: 'failed', exitCode: 1, error: 'crash' }),
    );

    const processed = await drainDlq(tmpDir);
    assert.equal(processed, 2);

    const docA = await sessions.get('ses-dlq-a');
    assert.equal(docA?.status, 'completed');

    const docB = await sessions.get('ses-dlq-b');
    assert.equal(docB?.status, 'failed');
    assert.equal(docB?.error, 'crash');
  });

  it('logs on failure and leaves file intact', async () => {
    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    fs.mkdirSync(dlqDir, { recursive: true });

    // Write an invalid JSON file.
    fs.writeFileSync(path.join(dlqDir, 'bad.json'), 'not valid json {{{');

    const processed = await drainDlq(tmpDir);
    assert.equal(processed, 0);

    // File should still exist.
    assert.ok(fs.existsSync(path.join(dlqDir, 'bad.json')));
  });

  it('returns 0 when DLQ directory is empty', async () => {
    const processed = await drainDlq(tmpDir);
    assert.equal(processed, 0);
  });

  it('creates .nexus/dlq/ directory if it does not exist', async () => {
    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    assert.ok(!fs.existsSync(dlqDir));

    await drainDlq(tmpDir);

    assert.ok(fs.existsSync(dlqDir));
  });

  it('ignores non-.json files', async () => {
    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    fs.mkdirSync(dlqDir, { recursive: true });
    fs.writeFileSync(path.join(dlqDir, 'README.txt'), 'not a DLQ file');

    const processed = await drainDlq(tmpDir);
    assert.equal(processed, 0);
  });
});

// ── DLQ-before-reconciler ordering ────────────────────────────────

describe('DLQ-before-reconciler ordering', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('DLQ drain result takes precedence over reconciler staleness detection', async () => {
    // Seed a stale running session (120s ago — well past 90s threshold)
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    await sessions.put({
      id: 'ses-order-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    // Write a DLQ file with completed status for the same session
    const dlqDir = path.join(tmpDir, '.nexus', 'dlq');
    fs.mkdirSync(dlqDir, { recursive: true });
    fs.writeFileSync(
      path.join(dlqDir, 'ses-order-001.json'),
      JSON.stringify({
        sessionId: 'ses-order-001',
        status: 'completed',
        exitCode: 0,
        costUsd: 1.23,
      }),
    );

    // Run DLQ drain first, then orphan recovery (same order as animator start())
    await drainDlq(tmpDir);
    const recovered = await recoverOrphans(sessions, 0);

    // The session should be completed (from DLQ), not failed (from reconciler)
    const doc = await sessions.get('ses-order-001');
    assert.ok(doc);
    assert.equal(doc.status, 'completed', 'DLQ result should win over reconciler staleness');
    assert.equal(doc.costUsd, 1.23, 'DLQ payload should be applied');

    // Reconciler should have recovered 0 sessions (already terminal)
    assert.equal(recovered, 0, 'reconciler should skip already-terminal session');
  });
});

// ── Heartbeat-based reconciler tests ──────────────────────────────

describe('Heartbeat-based reconciler', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('marks stale running session as failed', async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    await sessions.put({
      id: 'ses-orphan-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 1);

    const doc = await sessions.get('ses-orphan-001');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
    assert.ok(doc.error?.includes('No heartbeat received'));
    assert.ok(doc.error?.includes('session host presumed dead'));
    assert.ok(doc.endedAt);
    assert.ok(typeof doc.durationMs === 'number');
  });

  it('marks stale pending session as failed', async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    await sessions.put({
      id: 'ses-orphan-pending',
      status: 'pending',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 1);

    const doc = await sessions.get('ses-orphan-pending');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
  });

  it('leaves fresh sessions untouched', async () => {
    const freshTime = new Date(Date.now() - 10_000).toISOString();
    await sessions.put({
      id: 'ses-fresh',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: freshTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 0);

    const doc = await sessions.get('ses-fresh');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
  });

  it('applies downtime credit — session within threshold after credit', async () => {
    // Session silent for 100s, but 30s of downtime credit → effective 70s < 90s threshold
    const staleTime = new Date(Date.now() - 100_000).toISOString();
    await sessions.put({
      id: 'ses-credit',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 30_000);
    assert.equal(recovered, 0);

    const doc = await sessions.get('ses-credit');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
  });

  it('applies downtime credit — session still stale after credit', async () => {
    // Same session, no downtime credit → 100s > 90s threshold
    const staleTime = new Date(Date.now() - 100_000).toISOString();
    await sessions.put({
      id: 'ses-no-credit',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 1);

    const doc = await sessions.get('ses-no-credit');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
  });

  it('backfills lastActivityAt for legacy sessions and skips them', async () => {
    await sessions.put({
      id: 'ses-legacy',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      // No lastActivityAt
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 0);

    const doc = await sessions.get('ses-legacy');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
    assert.ok(doc.lastActivityAt, 'lastActivityAt should be backfilled');
  });

  it('returns 0 when no active sessions exist', async () => {
    await sessions.put({
      id: 'ses-done',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300000,
      provider: 'claude-code',
      exitCode: 0,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 0);
  });

  it('recovers multiple stale sessions', async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    await sessions.put({
      id: 'ses-orphan-a',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });
    await sessions.put({
      id: 'ses-orphan-b',
      status: 'running',
      startedAt: '2026-04-01T11:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 2);

    const docA = await sessions.get('ses-orphan-a');
    assert.equal(docA?.status, 'failed');

    const docB = await sessions.get('ses-orphan-b');
    assert.equal(docB?.status, 'failed');
  });

  it('ignores terminal sessions', async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    await sessions.put({
      id: 'ses-completed',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: staleTime,
    });

    const recovered = await recoverOrphans(sessions, 0);
    assert.equal(recovered, 0);
  });
});

// ── session-heartbeat tool tests ──────────────────────────────────

describe('session-heartbeat tool', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('updates lastActivityAt for a running session', async () => {
    await sessions.put({
      id: 'ses-hb-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:00:00Z',
    });

    const result = await sessionHeartbeat.handler({ sessionId: 'ses-hb-001' });
    assert.deepEqual(result, { ok: true, sessionId: 'ses-hb-001' });

    const doc = await sessions.get('ses-hb-001');
    assert.ok(doc);
    assert.notEqual(doc.lastActivityAt, '2026-04-01T10:00:00Z');
  });

  it('does not update lastActivityAt for a completed session', async () => {
    await sessions.put({
      id: 'ses-hb-002',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      lastActivityAt: '2026-04-01T10:05:00Z',
    });

    const result = await sessionHeartbeat.handler({ sessionId: 'ses-hb-002' });
    assert.deepEqual(result, { ok: true, sessionId: 'ses-hb-002', status: 'completed' });

    const doc = await sessions.get('ses-hb-002');
    assert.ok(doc);
    assert.equal(doc.lastActivityAt, '2026-04-01T10:05:00Z');
  });

  it('returns error for non-existent session', async () => {
    const result = await sessionHeartbeat.handler({ sessionId: 'ses-nonexistent' });
    assert.deepEqual(result, { ok: false, error: 'Session not found' });
  });

  it('has callableBy anima and permission write', () => {
    const callableBy = Array.isArray(sessionHeartbeat.callableBy)
      ? sessionHeartbeat.callableBy
      : [sessionHeartbeat.callableBy];
    assert.ok(callableBy.includes('anima'));
    assert.equal(sessionHeartbeat.permission, 'write');
  });
});

// ── Terminal-state immutability tests ─────────────────────────────

describe('Terminal-state immutability', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('rejects write to completed session', async () => {
    await sessions.put({
      id: 'ses-term-001',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      exitCode: 0,
    });

    const result = await sessionRecord.handler({
      sessionId: 'ses-term-001',
      status: 'failed',
      exitCode: 1,
      error: 'late failure',
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');

    const doc = await sessions.get('ses-term-001');
    assert.ok(doc);
    assert.equal(doc.status, 'completed');
  });

  it('rejects write to failed session', async () => {
    await sessions.put({
      id: 'ses-term-002',
      status: 'failed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      exitCode: 1,
      error: 'reconciled',
    });

    const result = await sessionRecord.handler({
      sessionId: 'ses-term-002',
      status: 'completed',
      exitCode: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'failed');

    const doc = await sessions.get('ses-term-002');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
  });

  it('writes transcript for duplicate terminal report', async () => {
    await sessions.put({
      id: 'ses-term-003',
      status: 'failed',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      exitCode: 1,
    });

    const transcript = [{ role: 'assistant', content: 'late transcript' }];

    const result = await sessionRecord.handler({
      sessionId: 'ses-term-003',
      status: 'completed',
      exitCode: 0,
      transcript,
    });

    assert.equal(result.status, 'failed');

    const tDoc = await transcripts.get('ses-term-003');
    assert.ok(tDoc);
    assert.equal(tDoc.messages.length, 1);
  });
});

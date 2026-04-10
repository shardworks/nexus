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
import { drainDlq, recoverOrphans, isProcessAlive } from '../startup.ts';

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
      cancelMetadata: { pid: 12345 },
    });

    const doc = await sessions.get('ses-test-002');
    assert.ok(doc);
    assert.equal(doc.conversationId, 'conv-abc');
    assert.deepEqual(doc.metadata, { writId: 'wrt-123', engineId: 'eng-456' });
    assert.deepEqual(doc.cancelMetadata, { pid: 12345 });
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
      cancelMetadata: { pid: 99999 },
    });

    assert.deepEqual(result, { ok: true, sessionId: 'ses-test-003' });

    const doc = await sessions.get('ses-test-003');
    assert.ok(doc);
    assert.deepEqual(doc.cancelMetadata, { pid: 99999 });
  });

  it('has callableBy anima and permission write', () => {
    const callableBy = Array.isArray(sessionRunning.callableBy)
      ? sessionRunning.callableBy
      : [sessionRunning.callableBy];
    assert.ok(callableBy.includes('anima'));
    assert.equal(sessionRunning.permission, 'write');
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

// ── Orphan recovery tests ──────────────────────────────────────────

describe('Orphan recovery', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  it('marks dead-PID sessions as failed', async () => {
    // Use PID 999999999 which almost certainly doesn't exist.
    await sessions.put({
      id: 'ses-orphan-001',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      cancelMetadata: { pid: 999999999 },
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 1);

    const doc = await sessions.get('ses-orphan-001');
    assert.ok(doc);
    assert.equal(doc.status, 'failed');
    assert.equal(doc.error, 'Session process died unexpectedly (orphaned)');
    assert.ok(doc.endedAt);
    assert.ok(typeof doc.durationMs === 'number');
  });

  it('skips sessions without PID', async () => {
    await sessions.put({
      id: 'ses-orphan-002',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 0);

    // Session should still be running.
    const doc = await sessions.get('ses-orphan-002');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
  });

  it('skips alive sessions', async () => {
    // Use current process PID — definitely alive.
    await sessions.put({
      id: 'ses-orphan-003',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      cancelMetadata: { pid: process.pid },
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 0);

    const doc = await sessions.get('ses-orphan-003');
    assert.ok(doc);
    assert.equal(doc.status, 'running');
  });

  it('skips sessions with non-numeric PID in cancelMetadata', async () => {
    await sessions.put({
      id: 'ses-orphan-004',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      cancelMetadata: { containerId: 'docker-xyz' },
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 0);
  });

  it('returns 0 when no running sessions exist', async () => {
    await sessions.put({
      id: 'ses-done',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:05:00Z',
      durationMs: 300000,
      provider: 'claude-code',
      exitCode: 0,
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 0);
  });

  it('recovers multiple orphans', async () => {
    await sessions.put({
      id: 'ses-orphan-a',
      status: 'running',
      startedAt: '2026-04-01T10:00:00Z',
      provider: 'claude-code',
      cancelMetadata: { pid: 999999998 },
    });
    await sessions.put({
      id: 'ses-orphan-b',
      status: 'running',
      startedAt: '2026-04-01T11:00:00Z',
      provider: 'claude-code',
      cancelMetadata: { pid: 999999997 },
    });

    const recovered = await recoverOrphans(sessions);
    assert.equal(recovered, 2);

    const docA = await sessions.get('ses-orphan-a');
    assert.equal(docA?.status, 'failed');

    const docB = await sessions.get('ses-orphan-b');
    assert.equal(docB?.status, 'failed');
  });
});

// ── isProcessAlive tests ───────────────────────────────────────────

describe('isProcessAlive', () => {
  it('returns true for current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('returns false for non-existent PID', () => {
    assert.equal(isProcessAlive(999999999), false);
  });
});

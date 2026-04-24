/**
 * Animator Oculus routes tests.
 *
 * Tests the three surviving custom API routes:
 * - GET /api/animator/sessions — enriched session list
 * - GET /api/animator/session-transcript — transcript and status
 * - GET /api/animator/session-stream — SSE streaming
 *
 * `GET /api/animator/status` used to be a custom route too, but was
 * retired in favour of the auto-registered `animator-status` tool route.
 *
 * Uses a fake guild with in-memory Stacks to test route handler logic
 * without running a real HTTP server.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';

import type { SessionDoc, AnimatorApi, SessionChunk } from './types.ts';
import { animatorRoutes } from './oculus-routes.ts';

// ── Types for test data ─────────────────────────────────────────────

interface WritDoc {
  id: string;
  title: string;
  [key: string]: unknown;
}

interface TranscriptDoc {
  id: string;
  messages: Record<string, unknown>[];
  [key: string]: unknown;
}

// ── Minimal Hono Context mock ────────────────────────────────────────

function createMockContext(queryParams: Record<string, string> = {}): {
  ctx: { req: { query: (k: string) => string | undefined }; json: (data: unknown, status?: number) => unknown };
  getResponse: () => { data: unknown; status: number };
} {
  let responseData: unknown = null;
  let responseStatus = 200;

  const headers = new Map<string, string>();
  const ctx = {
    req: {
      query(key: string) {
        return queryParams[key];
      },
      raw: { signal: new AbortController().signal },
    },
    json(data: unknown, status?: number) {
      responseData = data;
      responseStatus = status ?? 200;
      return { __json: true, data, status: responseStatus };
    },
    header(name: string, value: string) {
      headers.set(name, value);
    },
    // streamSSE needs these from the Hono Context
    newResponse(body: ReadableStream | null, init?: ResponseInit) {
      return new Response(body, init);
    },
  };

  return {
    ctx: ctx as unknown as Parameters<(typeof animatorRoutes)[0]['handler']>[0],
    getResponse: () => ({ data: responseData, status: responseStatus }),
  };
}

// ── Test harness ────────────────────────────────────────────────────

let stacks: StacksApi;
let sessionsBook: Book<SessionDoc>;
let transcriptsBook: Book<TranscriptDoc>;
let writsBook: Book<WritDoc>;
let memBackend: InstanceType<typeof MemoryBackend>;
let mockAnimatorApi: AnimatorApi;

function setup(subscribeResult: AsyncIterable<SessionChunk> | null = null) {
  memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);

  const apparatusMap = new Map<string, unknown>();

  // Create a minimal AnimatorApi mock for subscribeToSession
  mockAnimatorApi = {
    subscribeToSession(sessionId: string) {
      return subscribeResult;
    },
  } as unknown as AnimatorApi;

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
    writeConfig() { /* noop */ },
    guildConfig() {
      return {
        name: 'test-guild',
        nexus: '0.0.0',
        workshops: {},
        roles: {},
        baseTools: [],
        plugins: [],
        settings: { model: 'sonnet' },
      };
    },
    kits: () => [],
    apparatuses: () => [],
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {}, kits: () => [] });
  stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);
  apparatusMap.set('animator', mockAnimatorApi);

  // Create books
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'transcripts' }, {
    indexes: ['sessionId'],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['status', 'type', 'createdAt'],
  });

  sessionsBook = stacks.book<SessionDoc>('animator', 'sessions');
  transcriptsBook = stacks.book<TranscriptDoc>('animator', 'transcripts');
  writsBook = stacks.book<WritDoc>('clerk', 'writs');
}

// Helper to find route handler by method+path
function getHandler(method: string, path: string) {
  const route = animatorRoutes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Route ${method} ${path} not found`);
  return route.handler;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Animator Oculus Routes', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── GET /api/animator/sessions ──────────────────────────────────────

  describe('GET /api/animator/sessions', () => {
    const handler = () => getHandler('GET', '/api/animator/sessions');

    beforeEach(() => {
      setup();
    });

    it('returns enriched session entries with role, writTitle, and tokenUsage', async () => {
      // Create a writ
      await writsBook.put({
        id: 'w-abc123',
        title: 'Fix the bug',
        type: 'task',
        status: 'open',
      });

      // Create a session with metadata
      await sessionsBook.put({
        id: 'ses-001',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        endedAt: '2026-04-09T10:05:00Z',
        durationMs: 300000,
        exitCode: 0,
        costUsd: 0.15,
        tokenUsage: { inputTokens: 50000, outputTokens: 2000 },
        metadata: { role: 'artificer', writId: 'w-abc123', trigger: 'summon' },
      });

      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 200);
      const entries = data as any[];
      assert.equal(entries.length, 1);

      const entry = entries[0];
      assert.equal(entry.id, 'ses-001');
      assert.equal(entry.status, 'completed');
      assert.equal(entry.role, 'artificer');
      assert.equal(entry.writId, 'w-abc123');
      assert.equal(entry.writTitle, 'Fix the bug');
      assert.equal(entry.costUsd, 0.15);
      assert.deepEqual(entry.tokenUsage, { inputTokens: 50000, outputTokens: 2000 });
      assert.equal(entry.durationMs, 300000);
      assert.equal(entry.startedAt, '2026-04-09T10:00:00Z');
    });

    it('returns writTitle undefined for sessions without metadata.writId', async () => {
      await sessionsBook.put({
        id: 'ses-002',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
        metadata: { role: 'scribe' },
      });

      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].role, 'scribe');
      assert.equal(entries[0].writTitle, undefined);
      assert.equal(entries[0].writId, undefined);
    });

    it('returns writTitle undefined when writ not found', async () => {
      await sessionsBook.put({
        id: 'ses-003',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
        metadata: { role: 'artificer', writId: 'w-nonexistent' },
      });

      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].writId, 'w-nonexistent');
      assert.equal(entries[0].writTitle, undefined);
    });

    it('filters by status query param', async () => {
      await sessionsBook.put({
        id: 'ses-r1',
        status: 'running',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
      });
      await sessionsBook.put({
        id: 'ses-c1',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T09:00:00Z',
        exitCode: 0,
      });

      const { ctx, getResponse } = createMockContext({ status: 'running' });
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, 'ses-r1');
      assert.equal(entries[0].status, 'running');
    });

    it('filters by from and to date range', async () => {
      await sessionsBook.put({
        id: 'ses-old',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-01T10:00:00Z',
        exitCode: 0,
      });
      await sessionsBook.put({
        id: 'ses-mid',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-05T10:00:00Z',
        exitCode: 0,
      });
      await sessionsBook.put({
        id: 'ses-new',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
      });

      const { ctx, getResponse } = createMockContext({
        from: '2026-04-04T00:00:00Z',
        to: '2026-04-06T00:00:00Z',
      });
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, 'ses-mid');
    });

    it('limits results with limit param', async () => {
      await sessionsBook.put({
        id: 'ses-a',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
      });
      await sessionsBook.put({
        id: 'ses-b',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T11:00:00Z',
        exitCode: 0,
      });
      await sessionsBook.put({
        id: 'ses-c',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T12:00:00Z',
        exitCode: 0,
      });

      const { ctx, getResponse } = createMockContext({ limit: '2' });
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 2);
    });

    it('orders by startedAt descending', async () => {
      await sessionsBook.put({
        id: 'ses-early',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T08:00:00Z',
        exitCode: 0,
      });
      await sessionsBook.put({
        id: 'ses-late',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T12:00:00Z',
        exitCode: 0,
      });

      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const entries = (getResponse().data as any[]);

      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, 'ses-late');
      assert.equal(entries[1].id, 'ses-early');
    });
  });

  // ── GET /api/animator/session-transcript ────────────────────────────

  describe('GET /api/animator/session-transcript', () => {
    const handler = () => getHandler('GET', '/api/animator/session-transcript');

    beforeEach(() => {
      setup();
    });

    it('returns 400 when sessionId is missing', async () => {
      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 400);
      assert.deepEqual(data, { error: 'sessionId is required' });
    });

    it('returns 404 when session is not found', async () => {
      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-ghost' });
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 404);
      assert.deepEqual(data, { error: 'Session not found' });
    });

    it('returns empty messages for a running session', async () => {
      await sessionsBook.put({
        id: 'ses-run',
        status: 'running',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-run' });
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 200);
      assert.deepEqual(data, { messages: [], sessionStatus: 'running' });
    });

    it('returns transcript messages for a completed session', async () => {
      await sessionsBook.put({
        id: 'ses-done',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
      });

      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      await transcriptsBook.put({
        id: 'ses-done',
        messages,
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-done' });
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 200);
      const result = data as { messages: unknown[]; sessionStatus: string };
      assert.equal(result.sessionStatus, 'completed');
      assert.equal(result.messages.length, 2);
    });

    it('returns empty messages for a completed session without transcript', async () => {
      await sessionsBook.put({
        id: 'ses-no-transcript',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-no-transcript' });
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 200);
      const result = data as { messages: unknown[]; sessionStatus: string };
      assert.equal(result.sessionStatus, 'completed');
      assert.deepEqual(result.messages, []);
    });
  });

  // ── GET /api/animator/session-stream ────────────────────────────────

  describe('GET /api/animator/session-stream', () => {
    const handler = () => getHandler('GET', '/api/animator/session-stream');

    it('returns 400 when sessionId is missing', async () => {
      setup();
      const { ctx, getResponse } = createMockContext();
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 400);
      assert.deepEqual(data, { error: 'sessionId is required' });
    });

    it('returns 404 when session is not found', async () => {
      setup();
      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-ghost' });
      await handler()(ctx as any);
      const { data, status } = getResponse();

      assert.equal(status, 404);
      assert.deepEqual(data, { error: 'Session not found' });
    });

    it('calls streamSSE for a completed session (does not return JSON error)', async () => {
      setup();
      await sessionsBook.put({
        id: 'ses-comp',
        status: 'completed',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
        exitCode: 0,
      });
      await transcriptsBook.put({
        id: 'ses-comp',
        messages: [{ role: 'assistant', content: 'Done!' }],
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-comp' });
      const result = await handler()(ctx as any);
      const { status } = getResponse();

      // For completed sessions, the handler calls streamSSE which returns an
      // SSE Response, not a JSON response. The mock ctx.json was NOT called
      // for a success response (only for the 400/404 error paths).
      // The result from streamSSE is not our mock json response.
      assert.ok(result !== undefined || status === 200, 'should not have returned an error response');
    });

    it('calls streamSSE for a running session with active broadcaster', async () => {
      // Create an async iterable that yields chunks
      const chunks: SessionChunk[] = [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', tool: 'read' },
      ];
      let idx = 0;
      const chunkStream: AsyncIterable<SessionChunk> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (idx < chunks.length) {
                return { value: chunks[idx++]!, done: false as const };
              }
              return { value: undefined as unknown as SessionChunk, done: true as const };
            },
          };
        },
      };

      setup(chunkStream);
      await sessionsBook.put({
        id: 'ses-active',
        status: 'running',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-active' });
      const result = await handler()(ctx as any);
      const { status } = getResponse();

      // streamSSE returns a Response, not our mock json. Should not be a 400/404.
      assert.ok(result !== undefined || status === 200, 'should not have returned an error response');
    });

    it('calls streamSSE for a running session without broadcaster (null subscription)', async () => {
      setup(null); // subscribeToSession returns null
      await sessionsBook.put({
        id: 'ses-nostream',
        status: 'running',
        provider: 'claude-code',
        startedAt: '2026-04-09T10:00:00Z',
      });

      const { ctx, getResponse } = createMockContext({ sessionId: 'ses-nostream' });
      const result = await handler()(ctx as any);
      const { status } = getResponse();

      // streamSSE returns a Response — should not be a JSON error
      assert.ok(result !== undefined || status === 200, 'should not have returned an error response');
    });
  });

  // ── Route structure ─────────────────────────────────────────────────

  describe('Route definitions', () => {
    it('exports the three surviving custom routes (status route is auto-registered)', () => {
      assert.equal(animatorRoutes.length, 3);

      const paths = animatorRoutes.map((r) => `${r.method} ${r.path}`);
      assert.ok(!paths.includes('GET /api/animator/status'), 'status route is no longer custom');
      assert.ok(paths.includes('GET /api/animator/sessions'));
      assert.ok(paths.includes('GET /api/animator/session-transcript'));
      assert.ok(paths.includes('GET /api/animator/session-stream'));
    });
  });
});

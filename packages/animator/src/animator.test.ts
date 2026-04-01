/**
 * Animator tests.
 *
 * Uses a fake session provider apparatus and in-memory Stacks backend to
 * test the full animate() lifecycle without spawning real processes.
 *
 * The fake provider is registered as an apparatus in the guild mock,
 * matching how real providers work (the Animator discovers them via
 * guild().apparatus(config.sessionProvider)).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks';
import { MemoryBackend } from '@shardworks/stacks/testing';
import type { StacksApi } from '@shardworks/stacks';

import { createAnimator } from './animator.ts';
import type {
  AnimatorApi,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
  SessionDoc,
} from './types.ts';

// ── Fake providers ───────────────────────────────────────────────────

function createFakeProvider(
  overrides: Partial<SessionProviderResult> = {},
): AnimatorSessionProvider {
  return {
    name: 'fake',
    async launch(_config: SessionProviderConfig): Promise<SessionProviderResult> {
      return {
        status: 'completed',
        exitCode: 0,
        providerSessionId: 'fake-sess-123',
        tokenUsage: {
          inputTokens: 1000,
          outputTokens: 500,
        },
        costUsd: 0.05,
        ...overrides,
      };
    },
  };
}

function createStreamingFakeProvider(
  chunks: SessionChunk[],
  overrides: Partial<SessionProviderResult> = {},
): AnimatorSessionProvider {
  return {
    name: 'fake-streaming',
    async launch(_config: SessionProviderConfig): Promise<SessionProviderResult> {
      return {
        status: 'completed',
        exitCode: 0,
        ...overrides,
      };
    },
    launchStreaming(_config: SessionProviderConfig) {
      let idx = 0;
      const asyncChunks: AsyncIterable<SessionChunk> = {
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

      const result = Promise.resolve({
        status: 'completed' as const,
        exitCode: 0,
        providerSessionId: 'fake-stream-sess',
        ...overrides,
      });

      return { chunks: asyncChunks, result };
    },
  };
}

function createThrowingProvider(error: Error): AnimatorSessionProvider {
  return {
    name: 'fake-throwing',
    async launch(): Promise<SessionProviderResult> {
      throw error;
    },
  };
}

// ── Spy provider (captures the config passed to launch) ──────────────

function createSpyProvider(): {
  provider: AnimatorSessionProvider;
  getCapturedConfig: () => SessionProviderConfig | null;
} {
  let capturedConfig: SessionProviderConfig | null = null;

  return {
    provider: {
      name: 'fake-spy',
      async launch(config: SessionProviderConfig): Promise<SessionProviderResult> {
        capturedConfig = config;
        return { status: 'completed', exitCode: 0 };
      },
    },
    getCapturedConfig: () => capturedConfig,
  };
}

// ── Test harness ─────────────────────────────────────────────────────

let stacks: StacksApi;
let animator: AnimatorApi;

/**
 * Set up the test environment with a guild mock, in-memory Stacks,
 * and the Animator apparatus. The provider is registered as an apparatus
 * that the Animator discovers via guild().apparatus('fake-provider').
 */
function setup(
  provider: AnimatorSessionProvider = createFakeProvider(),
  sessionProviderPluginId = 'fake-provider',
) {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const animatorPlugin = createAnimator();

  // Apparatus registry for the guild mock
  const apparatusMap = new Map<string, unknown>();

  // Register the provider as an apparatus (same as a real guild would)
  apparatusMap.set(sessionProviderPluginId, provider);

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(pluginId: string): T {
      if (pluginId === 'animator') {
        return { sessionProvider: sessionProviderPluginId } as T;
      }
      return {} as T;
    },
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
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {} });
  stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure the animator's book is created
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });

  // Start animator
  const animatorApparatus = (animatorPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  animatorApparatus.start({ on: () => {} });
  animator = animatorApparatus.provides as AnimatorApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Animator', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('animate()', () => {
    beforeEach(() => {
      setup();
    });

    it('completes a session and records to Stacks', async () => {
      const result = await animator.animate({
        context: { systemPrompt: 'You are a test agent.' },
        cwd: '/tmp/workdir',
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.exitCode, 0);
      assert.equal(result.provider, 'fake');
      assert.ok(result.id.startsWith('ses-'));
      assert.ok(result.startedAt);
      assert.ok(result.endedAt);
      assert.equal(typeof result.durationMs, 'number');
      assert.equal(result.providerSessionId, 'fake-sess-123');
      assert.deepEqual(result.tokenUsage, { inputTokens: 1000, outputTokens: 500 });
      assert.equal(result.costUsd, 0.05);

      // Verify recorded in Stacks
      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.ok(doc);
      assert.equal(doc.status, 'completed');
      assert.equal(doc.provider, 'fake');
      assert.equal(doc.exitCode, 0);
    });

    it('records metadata as-is', async () => {
      const metadata = {
        trigger: 'summon',
        animaName: 'scribe',
        writId: 'wrt-abc123',
      };

      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
        metadata,
      });

      assert.deepEqual(result.metadata, metadata);

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.deepEqual(doc?.metadata, metadata);
    });

    it('passes conversationId through', async () => {
      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
        conversationId: 'conv-xyz',
      });

      assert.equal(result.conversationId, 'conv-xyz');

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.equal(doc?.conversationId, 'conv-xyz');
    });

    it('passes initialPrompt and model to provider', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider);

      await animator.animate({
        context: {
          systemPrompt: 'System prompt here',
          initialPrompt: 'Do the thing',
        },
        cwd: '/tmp/workdir',
      });

      const captured = getCapturedConfig();
      assert.ok(captured);
      assert.equal(captured!.systemPrompt, 'System prompt here');
      assert.equal(captured!.initialPrompt, 'Do the thing');
      assert.equal(captured!.model, 'sonnet');
      assert.equal(captured!.cwd, '/tmp/workdir');
    });

    it('records failed session when provider throws', async () => {
      const throwProvider = createThrowingProvider(new Error('Provider exploded'));
      setup(throwProvider);

      await assert.rejects(
        () => animator.animate({
          context: { systemPrompt: 'Test' },
          cwd: '/tmp/workdir',
        }),
        { message: 'Provider exploded' },
      );

      // Should still be recorded in Stacks
      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const allDocs = await sessions.list();
      const failedDocs = allDocs.filter((d) => d.status === 'failed');
      assert.equal(failedDocs.length, 1);
      assert.equal(failedDocs[0]!.error, 'Provider exploded');
      assert.equal(failedDocs[0]!.exitCode, 1);
    });

    it('records provider-reported failure (not throw)', async () => {
      const failProvider = createFakeProvider({
        status: 'failed',
        exitCode: 2,
        error: 'Process crashed',
      });
      setup(failProvider);

      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 2);
      assert.equal(result.error, 'Process crashed');
    });

    it('records timeout status', async () => {
      const timeoutProvider = createFakeProvider({
        status: 'timeout',
        exitCode: 124,
        error: 'Session timed out after 300s',
      });
      setup(timeoutProvider);

      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      assert.equal(result.status, 'timeout');
      assert.equal(result.exitCode, 124);
    });

    it('throws when session provider apparatus not installed', async () => {
      // Set up with a bad provider plugin id
      setup(createFakeProvider(), 'nonexistent');
      // The provider IS registered at 'nonexistent', so the lookup will work.
      // Instead, set up a guild that has no apparatus at the configured id.
      clearGuild();

      const memBackend = new MemoryBackend();
      const stacksPlugin = createStacksApparatus(memBackend);
      const animatorPlugin = createAnimator();

      const apparatusMap = new Map<string, unknown>();

      setGuild({
        home: '/tmp/fake-guild',
        apparatus<T>(name: string): T {
          const api = apparatusMap.get(name);
          if (!api) throw new Error(`Apparatus "${name}" not installed`);
          return api as T;
        },
        config<T>(pluginId: string): T {
          if (pluginId === 'animator') {
            return { sessionProvider: 'missing-provider' } as T;
          }
          return {} as T;
        },
        guildConfig: () => ({
          name: 'test', nexus: '0.0.0', workshops: {}, roles: {},
          baseTools: [], plugins: [], settings: { model: 'sonnet' },
        }),
        kits: () => [],
        apparatuses: () => [],
      });

      const sa = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
      sa.start({ on: () => {} });
      apparatusMap.set('stacks', sa.provides);
      memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, { indexes: [] });

      const aa = (animatorPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
      aa.start({ on: () => {} });
      const a = aa.provides as AnimatorApi;

      await assert.rejects(
        () => a.animate({
          context: { systemPrompt: 'Test' },
          cwd: '/tmp/workdir',
        }),
        /Session provider apparatus "missing-provider" is not available/,
      );
    });
  });

  describe('animateStreaming()', () => {
    it('streams chunks and returns result', async () => {
      const testChunks: SessionChunk[] = [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', tool: 'bash' },
        { type: 'tool_result', tool: 'bash' },
        { type: 'text', text: 'Done.' },
      ];

      setup(createStreamingFakeProvider(testChunks));

      const { chunks, result } = animator.animateStreaming({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      const collected: SessionChunk[] = [];
      for await (const chunk of chunks) {
        collected.push(chunk);
      }

      assert.equal(collected.length, 4);
      assert.deepEqual(collected[0], { type: 'text', text: 'Hello ' });
      assert.deepEqual(collected[1], { type: 'tool_use', tool: 'bash' });

      const sessionResult = await result;
      assert.equal(sessionResult.status, 'completed');
      assert.ok(sessionResult.id.startsWith('ses-'));

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(sessionResult.id);
      assert.ok(doc);
      assert.equal(doc.status, 'completed');
    });

    it('falls back to launch() when provider has no launchStreaming', async () => {
      setup(createFakeProvider());

      const { chunks, result } = animator.animateStreaming({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      const collected: SessionChunk[] = [];
      for await (const chunk of chunks) {
        collected.push(chunk);
      }
      assert.equal(collected.length, 0);

      const sessionResult = await result;
      assert.equal(sessionResult.status, 'completed');
      assert.equal(sessionResult.provider, 'fake');
    });

    it('records failed streaming session', async () => {
      const failChunks: SessionChunk[] = [
        { type: 'text', text: 'Starting...' },
      ];

      setup(createStreamingFakeProvider(failChunks, {
        status: 'failed',
        exitCode: 1,
        error: 'Stream failed',
      }));

      const { result } = animator.animateStreaming({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      const sessionResult = await result;
      assert.equal(sessionResult.status, 'failed');

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(sessionResult.id);
      assert.ok(doc);
      assert.equal(doc.status, 'failed');
    });
  });

  describe('session id generation', () => {
    beforeEach(() => {
      setup();
    });

    it('generates unique ids', async () => {
      const results = await Promise.all([
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }),
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }),
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }),
      ]);

      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 3, 'All session ids should be unique');
    });

    it('ids follow ses-{hex} format', async () => {
      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp',
      });

      assert.match(result.id, /^ses-[a-f0-9]{8}$/);
    });
  });
});

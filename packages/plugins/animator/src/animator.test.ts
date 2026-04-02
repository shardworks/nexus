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
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createLoom } from '@shardworks/loom-apparatus';
import type { LoomApi } from '@shardworks/loom-apparatus';

import { createAnimator } from './animator.ts';
import type {
  AnimatorApi,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
  SessionDoc,
} from './types.ts';

// ── Shared empty chunks iterable ─────────────────────────────────────

const emptyChunks: AsyncIterable<SessionChunk> = {
  [Symbol.asyncIterator]() {
    return {
      async next() {
        return { value: undefined as unknown as SessionChunk, done: true as const };
      },
    };
  },
};

// ── Fake providers ───────────────────────────────────────────────────

function createFakeProvider(
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
          providerSessionId: 'fake-sess-123',
          tokenUsage: {
            inputTokens: 1000,
            outputTokens: 500,
          },
          costUsd: 0.05,
          ...overrides,
        }),
      };
    },
  };
}

function createStreamingFakeProvider(
  streamChunks: SessionChunk[],
  overrides: Partial<SessionProviderResult> = {},
): AnimatorSessionProvider {
  return {
    name: 'fake-streaming',
    launch(config: SessionProviderConfig) {
      if (config.streaming) {
        let idx = 0;
        const asyncChunks: AsyncIterable<SessionChunk> = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (idx < streamChunks.length) {
                  return { value: streamChunks[idx++]!, done: false as const };
                }
                return { value: undefined as unknown as SessionChunk, done: true as const };
              },
            };
          },
        };

        return {
          chunks: asyncChunks,
          result: Promise.resolve({
            status: 'completed' as const,
            exitCode: 0,
            providerSessionId: 'fake-stream-sess',
            ...overrides,
          }),
        };
      }

      // Non-streaming: return empty chunks
      return {
        chunks: emptyChunks,
        result: Promise.resolve({
          status: 'completed' as const,
          exitCode: 0,
          providerSessionId: 'fake-stream-sess',
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

// ── Spy provider (captures the config passed to launch) ──────────────

function createSpyProvider(): {
  provider: AnimatorSessionProvider;
  getCapturedConfig: () => SessionProviderConfig | null;
} {
  let capturedConfig: SessionProviderConfig | null = null;

  return {
    provider: {
      name: 'fake-spy',
      launch(config: SessionProviderConfig) {
        capturedConfig = config;
        return {
          chunks: emptyChunks,
          result: Promise.resolve({ status: 'completed' as const, exitCode: 0 }),
        };
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
 *
 * @param opts.installLoom — if true, installs The Loom apparatus (needed for summon() tests)
 */
function setup(
  provider: AnimatorSessionProvider = createFakeProvider(),
  sessionProviderPluginId = 'fake-provider',
  opts: { installLoom?: boolean } = {},
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
    writeConfig() { /* noop in test */ },
    guildConfig() {
      return {
        name: 'test-guild',
        nexus: '0.0.0',
        workshops: {},
        roles: {},
        baseTools: [],
        plugins: [],
        settings: { model: 'sonnet' },
        animator: { sessionProvider: sessionProviderPluginId },
      };
    },
    kits: () => [],
    apparatuses: () => [],
  };

  // Must set guild before starting apparatus that call guild() in start()
  setGuild(fakeGuild);

  // Optionally install The Loom (needed for summon() tests)
  if (opts.installLoom) {
    const loomPlugin = createLoom();
    const loomApparatus = (loomPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
    loomApparatus.start({ on: () => {} });
    apparatusMap.set('loom', loomApparatus.provides);
  }

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

    it('returns an AnimateHandle with chunks and result', () => {
      const handle = animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
      });

      assert.ok(handle.chunks, 'should have chunks');
      assert.ok(handle.result instanceof Promise, 'result should be a Promise');
    });

    it('completes a session and records to Stacks', async () => {
      const result = await animator.animate({
        context: { systemPrompt: 'You are a test agent.' },
        cwd: '/tmp/workdir',
      }).result;

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
      }).result;

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
      }).result;

      assert.equal(result.conversationId, 'conv-xyz');

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.equal(doc?.conversationId, 'conv-xyz');
    });

    it('passes prompt and systemPrompt to provider', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider);

      await animator.animate({
        context: { systemPrompt: 'System prompt here' },
        prompt: 'Do the thing',
        cwd: '/tmp/workdir',
      }).result;

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
        }).result,
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
      }).result;

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
      }).result;

      assert.equal(result.status, 'timeout');
      assert.equal(result.exitCode, 124);
    });

    it('throws when session provider apparatus not installed', () => {
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
        writeConfig() { /* noop in test */ },
        guildConfig: () => ({
          name: 'test', nexus: '0.0.0', workshops: {}, roles: {},
          baseTools: [], plugins: [], settings: { model: 'sonnet' },
          animator: { sessionProvider: 'missing-provider' },
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

      // animate() resolves the provider synchronously — throws before
      // returning the AnimateHandle.
      assert.throws(
        () => a.animate({
          context: { systemPrompt: 'Test' },
          cwd: '/tmp/workdir',
        }),
        /missing-provider/,
      );
    });

    it('returns empty chunks when streaming is not requested', async () => {
      const { chunks, result } = animator.animate({
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
    });
  });

  describe('animate({ streaming: true })', () => {
    it('streams chunks and returns result', async () => {
      const testChunks: SessionChunk[] = [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', tool: 'bash' },
        { type: 'tool_result', tool: 'bash' },
        { type: 'text', text: 'Done.' },
      ];

      setup(createStreamingFakeProvider(testChunks));

      const { chunks, result } = animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
        streaming: true,
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

    it('returns empty chunks when provider ignores streaming flag', async () => {
      // createFakeProvider always returns empty chunks regardless of streaming
      setup(createFakeProvider());

      const { chunks, result } = animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
        streaming: true,
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

      const { result } = animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp/workdir',
        streaming: true,
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
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }).result,
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }).result,
        animator.animate({ context: { systemPrompt: 'Test' }, cwd: '/tmp' }).result,
      ]);

      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 3, 'All session ids should be unique');
    });

    it('ids follow ses-{base36_timestamp}{hex_random} format', async () => {
      const result = await animator.animate({
        context: { systemPrompt: 'Test' },
        cwd: '/tmp',
      }).result;

      assert.match(result.id, /^ses-[a-z0-9]+[a-f0-9]{8}$/);
    });
  });

  describe('summon()', () => {
    it('returns an AnimateHandle with chunks and result', () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const handle = animator.summon({
        prompt: 'Build the frobnicator',
        cwd: '/tmp/workdir',
      });

      assert.ok(handle.chunks, 'should have chunks');
      assert.ok(handle.result instanceof Promise, 'result should be a Promise');
    });

    it('composes context via The Loom and launches a session', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider, 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Build the frobnicator',
        cwd: '/tmp/workdir',
      }).result;

      assert.equal(result.status, 'completed');
      assert.ok(result.id.startsWith('ses-'));

      // Verify the provider received the prompt as initialPrompt
      const captured = getCapturedConfig();
      assert.ok(captured);
      assert.equal(captured!.initialPrompt, 'Build the frobnicator');
      assert.equal(captured!.cwd, '/tmp/workdir');
      assert.equal(captured!.model, 'sonnet');
    });

    it('auto-populates trigger: summon in metadata', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Do the thing',
        cwd: '/tmp/workdir',
      }).result;

      assert.equal(result.metadata?.trigger, 'summon');

      // Verify in Stacks too
      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.equal(doc?.metadata?.trigger, 'summon');
    });

    it('merges caller metadata with auto-generated metadata', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Build it',
        cwd: '/tmp/workdir',
        metadata: {
          role: 'artificer',
          writId: 'wrt-abc123',
        },
      }).result;

      assert.equal(result.metadata?.trigger, 'summon');
      assert.equal(result.metadata?.role, 'artificer');
      assert.equal(result.metadata?.writId, 'wrt-abc123');
    });

    it('passes conversationId through for resume', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider, 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Continue working',
        cwd: '/tmp/workdir',
        conversationId: 'conv-resume-123',
      }).result;

      assert.equal(result.conversationId, 'conv-resume-123');

      const captured = getCapturedConfig();
      assert.equal(captured!.conversationId, 'conv-resume-123');
    });

    it('records session to Stacks', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Build it',
        cwd: '/tmp/workdir',
      }).result;

      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const doc = await sessions.get(result.id);
      assert.ok(doc);
      assert.equal(doc.status, 'completed');
      assert.equal(doc.metadata?.trigger, 'summon');
    });

    it('throws with clear error when Loom is not installed', async () => {
      // Setup WITHOUT the Loom
      setup(createFakeProvider());

      assert.throws(
        () => animator.summon({
          prompt: 'Build it',
          cwd: '/tmp/workdir',
        }),
        /Loom apparatus/,
      );
    });

    it('records failed session when provider throws', async () => {
      const throwProvider = createThrowingProvider(new Error('Session crashed'));
      setup(throwProvider, 'fake-provider', { installLoom: true });

      await assert.rejects(
        () => animator.summon({
          prompt: 'Build it',
          cwd: '/tmp/workdir',
        }).result,
        { message: 'Session crashed' },
      );

      // Failed session should still be recorded
      const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      const allDocs = await sessions.list();
      const failedDocs = allDocs.filter((d) => d.status === 'failed');
      assert.equal(failedDocs.length, 1);
      assert.equal(failedDocs[0]!.metadata?.trigger, 'summon');
    });

    it('Loom produces undefined systemPrompt at MVP', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider, 'fake-provider', { installLoom: true });

      await animator.summon({
        prompt: 'Build the thing',
        cwd: '/tmp/workdir',
      }).result;

      const captured = getCapturedConfig();
      assert.equal(captured!.systemPrompt, undefined);
    });

    it('records role in metadata when provided', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Build it',
        role: 'artificer',
        cwd: '/tmp/workdir',
      }).result;

      assert.equal(result.metadata?.trigger, 'summon');
      assert.equal(result.metadata?.role, 'artificer');
    });

    it('omits role from metadata when not provided', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const result = await animator.summon({
        prompt: 'Build it',
        cwd: '/tmp/workdir',
      }).result;

      assert.equal(result.metadata?.trigger, 'summon');
      assert.ok(!('role' in (result.metadata ?? {})));
    });

    it('prompt bypasses the Loom and goes directly to provider', async () => {
      const { provider, getCapturedConfig } = createSpyProvider();
      setup(provider, 'fake-provider', { installLoom: true });

      await animator.summon({
        prompt: 'Build the frobnicator',
        role: 'artificer',
        cwd: '/tmp/workdir',
      }).result;

      const captured = getCapturedConfig();
      assert.ok(captured);
      assert.equal(captured!.initialPrompt, 'Build the frobnicator');
      assert.equal(captured!.systemPrompt, undefined);
    });

    it('returns empty chunks when streaming is not requested', async () => {
      setup(createFakeProvider(), 'fake-provider', { installLoom: true });

      const { chunks, result } = animator.summon({
        prompt: 'Build it',
        cwd: '/tmp/workdir',
      });

      const collected: SessionChunk[] = [];
      for await (const chunk of chunks) {
        collected.push(chunk);
      }
      assert.equal(collected.length, 0);

      const sessionResult = await result;
      assert.equal(sessionResult.status, 'completed');
    });
  });
});

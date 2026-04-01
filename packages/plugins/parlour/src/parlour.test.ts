/**
 * Parlour tests.
 *
 * Uses a fake session provider, in-memory Stacks, and the real Animator
 * and Loom apparatuses to test the full conversation lifecycle without
 * spawning real AI processes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import { createLoom } from '@shardworks/loom-apparatus';
import { createAnimator } from '@shardworks/animator-apparatus';
import type {
  AnimatorApi,
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionChunk,
} from '@shardworks/animator-apparatus';

import { createParlour } from './parlour.ts';
import type { ParlourApi } from './types.ts';

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

function createFakeProvider(): AnimatorSessionProvider {
  let callCount = 0;

  return {
    name: 'fake',
    launch(_config: SessionProviderConfig) {
      callCount++;
      return {
        chunks: emptyChunks,
        result: Promise.resolve({
          status: 'completed' as const,
          exitCode: 0,
          providerSessionId: `fake-sess-${callCount}`,
          tokenUsage: { inputTokens: 1000, outputTokens: 500 },
          costUsd: 0.05,
        }),
      };
    },
  };
}

function createStreamingFakeProvider(
  streamChunks: SessionChunk[],
): AnimatorSessionProvider {
  return {
    name: 'fake-streaming',
    launch(config: SessionProviderConfig) {
      if (config.streaming) {
        let idx = 0;
        return {
          chunks: {
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
          },
          result: Promise.resolve({
            status: 'completed' as const,
            exitCode: 0,
            providerSessionId: 'fake-stream-sess',
            costUsd: 0.10,
          }),
        };
      }
      return {
        chunks: emptyChunks,
        result: Promise.resolve({
          status: 'completed' as const,
          exitCode: 0,
          providerSessionId: 'fake-stream-sess',
          costUsd: 0.10,
        }),
      };
    },
  };
}

// ── Test harness ─────────────────────────────────────────────────────

let parlour: ParlourApi;

function setup(provider: AnimatorSessionProvider = createFakeProvider()) {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const animatorPlugin = createAnimator();
  const loomPlugin = createLoom();
  const parlourPlugin = createParlour();

  const apparatusMap = new Map<string, unknown>();
  apparatusMap.set('fake-provider', provider);

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(pluginId: string): T {
      if (pluginId === 'animator') {
        return { sessionProvider: 'fake-provider' } as T;
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
        animator: { sessionProvider: 'fake-provider' },
      };
    },
    kits: () => [],
    apparatuses: () => [],
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = (stacksPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  stacksApparatus.start({ on: () => {} });
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status', 'conversationId', 'provider'],
  });
  memBackend.ensureBook({ ownerId: 'parlour', book: 'conversations' }, {
    indexes: ['status', 'kind', 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'parlour', book: 'turns' }, {
    indexes: ['conversationId', 'turnNumber', 'participantId', 'participantKind'],
  });

  // Start loom
  const loomApparatus = (loomPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  loomApparatus.start({ on: () => {} });
  apparatusMap.set('loom', loomApparatus.provides);

  // Start animator
  const animatorApparatus = (animatorPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  animatorApparatus.start({ on: () => {} });
  apparatusMap.set('animator', animatorApparatus.provides);

  // Start parlour
  const parlourApparatus = (parlourPlugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  parlourApparatus.start({ on: () => {} });
  parlour = parlourApparatus.provides as ParlourApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Parlour', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── create() ────────────────────────────────────────────────────────

  describe('create()', () => {
    beforeEach(() => { setup(); });

    it('creates a consult conversation with two participants', async () => {
      const result = await parlour.create({
        kind: 'consult',
        topic: 'Help me refactor this code',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      assert.ok(result.conversationId.startsWith('conv-'));
      assert.equal(result.participants.length, 2);
      assert.equal(result.participants[0]!.kind, 'human');
      assert.equal(result.participants[0]!.name, 'Sean');
      assert.equal(result.participants[1]!.kind, 'anima');
      assert.equal(result.participants[1]!.name, 'Artificer');
      assert.ok(result.participants[0]!.id.startsWith('part-'));
      assert.ok(result.participants[1]!.id.startsWith('part-'));
    });

    it('creates a convene conversation with multiple anima participants', async () => {
      const result = await parlour.create({
        kind: 'convene',
        topic: 'Discuss architecture',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'anima', name: 'Architect' },
          { kind: 'anima', name: 'Reviewer' },
          { kind: 'anima', name: 'Critic' },
        ],
      });

      assert.equal(result.participants.length, 3);
      assert.ok(result.participants.every((p) => p.kind === 'anima'));
    });

    it('stores conversation in Stacks and retrieves it via show()', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        topic: 'Test topic',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.id, conversationId);
      assert.equal(detail.status, 'active');
      assert.equal(detail.kind, 'consult');
      assert.equal(detail.topic, 'Test topic');
      assert.equal(detail.turnCount, 0);
      assert.equal(detail.turns.length, 0);
    });

    it('sets optional fields to null when not provided', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.topic, null);
      assert.equal(detail.turnLimit, null);
    });
  });

  // ── takeTurn() — human turns ───────────────────────────────────────

  describe('takeTurn() — human', () => {
    beforeEach(() => { setup(); });

    it('records a human turn without launching a session', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      const result = await parlour.takeTurn({
        conversationId,
        participantId: human.id,
        message: 'Hello, anima!',
      });

      assert.equal(result.sessionResult, null);
      assert.equal(result.turnNumber, 1);
      assert.equal(result.conversationActive, true);
    });

    it('records the human message in turn history', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      await parlour.takeTurn({
        conversationId,
        participantId: human.id,
        message: 'Hello, anima!',
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turnCount, 1);
      assert.equal(detail.turns[0]!.participant, 'Sean');
      assert.equal(detail.turns[0]!.message, 'Hello, anima!');
      assert.equal(detail.turns[0]!.sessionId, null);
    });
  });

  // ── takeTurn() — anima turns (consult) ─────────────────────────────

  describe('takeTurn() — anima (consult)', () => {
    beforeEach(() => { setup(); });

    it('launches a session via the Animator for an anima turn', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Help me refactor',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      const result = await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
      });

      assert.ok(result.sessionResult);
      assert.equal(result.sessionResult.status, 'completed');
      assert.equal(result.turnNumber, 1);
      assert.equal(result.conversationActive, true);
    });

    it('uses topic as first-turn message when no explicit message', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Help me refactor',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turns[0]!.message, 'Help me refactor');
    });

    it('uses explicit message when provided (overrides topic)', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Help me refactor',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
        message: 'Actually, help me with tests',
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turns[0]!.message, 'Actually, help me with tests');
    });

    it('records sessionId on turn records', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      const result = await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
      });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turns[0]!.sessionId, result.sessionResult!.id);
    });

    it('aggregates cost from session records', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      const human = participants.find((p) => p.kind === 'human')!;

      await parlour.takeTurn({ conversationId, participantId: anima.id });
      await parlour.takeTurn({ conversationId, participantId: human.id, message: 'More' });
      await parlour.takeTurn({ conversationId, participantId: anima.id, message: 'Continue' });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.totalCostUsd, 0.10); // 2 anima turns × $0.05
    });
  });

  // ── Multi-turn consult flow ────────────────────────────────────────

  describe('multi-turn consult flow', () => {
    beforeEach(() => { setup(); });

    it('handles a full human-anima-human-anima exchange', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Architecture review',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      const anima = participants.find((p) => p.kind === 'anima')!;

      // Turn 1: anima responds to topic
      const t1 = await parlour.takeTurn({ conversationId, participantId: anima.id });
      assert.equal(t1.turnNumber, 1);
      assert.ok(t1.sessionResult);

      // Turn 2: human replies
      const t2 = await parlour.takeTurn({
        conversationId,
        participantId: human.id,
        message: 'What about the Stacks layer?',
      });
      assert.equal(t2.turnNumber, 2);
      assert.equal(t2.sessionResult, null);

      // Turn 3: anima responds to human message
      const t3 = await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
        message: 'What about the Stacks layer?',
      });
      assert.equal(t3.turnNumber, 3);
      assert.ok(t3.sessionResult);

      // Turn 4: human wraps up
      const t4 = await parlour.takeTurn({
        conversationId,
        participantId: human.id,
        message: 'Thanks, that helps.',
      });
      assert.equal(t4.turnNumber, 4);

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turnCount, 4);
      assert.equal(detail.status, 'active');
    });
  });

  // ── Turn limit enforcement ─────────────────────────────────────────

  describe('turn limit enforcement', () => {
    beforeEach(() => { setup(); });

    it('auto-concludes when turn limit is reached', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Quick question',
        turnLimit: 2,
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      const human = participants.find((p) => p.kind === 'human')!;

      // Turn 1: anima (anima turn count = 1)
      const t1 = await parlour.takeTurn({ conversationId, participantId: anima.id });
      assert.equal(t1.conversationActive, true);

      // Turn 2: human (doesn't count toward limit)
      await parlour.takeTurn({
        conversationId,
        participantId: human.id,
        message: 'Follow up',
      });

      // Turn 3: anima (anima turn count = 2 → limit reached)
      const t3 = await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
        message: 'Follow up',
      });
      assert.equal(t3.conversationActive, false);

      // Verify concluded
      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.status, 'concluded');
      assert.ok(detail.endedAt);
    });

    it('throws when taking a turn after limit reached', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Quick question',
        turnLimit: 1,
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;

      // First anima turn → concludes
      await parlour.takeTurn({ conversationId, participantId: anima.id });

      // Second attempt → should throw (conversation is concluded)
      await assert.rejects(
        () => parlour.takeTurn({ conversationId, participantId: anima.id }),
        { message: /not active/ },
      );
    });

    it('human turns do not count toward turn limit', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Quick question',
        turnLimit: 2,
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      const anima = participants.find((p) => p.kind === 'anima')!;

      // 5 human turns — none should hit the limit
      for (let i = 0; i < 5; i++) {
        const result = await parlour.takeTurn({
          conversationId,
          participantId: human.id,
          message: `Human message ${i}`,
        });
        assert.equal(result.conversationActive, true);
      }

      // First anima turn (count = 1) — still active
      const t1 = await parlour.takeTurn({ conversationId, participantId: anima.id, message: 'Hi' });
      assert.equal(t1.conversationActive, true);

      // Second anima turn (count = 2) — limit reached
      const t2 = await parlour.takeTurn({ conversationId, participantId: anima.id, message: 'Hi' });
      assert.equal(t2.conversationActive, false);
    });
  });

  // ── end() ──────────────────────────────────────────────────────────

  describe('end()', () => {
    beforeEach(() => { setup(); });

    it('concludes an active conversation', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId, 'concluded');

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.status, 'concluded');
      assert.ok(detail.endedAt);
    });

    it('abandons a conversation', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId, 'abandoned');

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.status, 'abandoned');
    });

    it('is idempotent — no error on already-ended conversation', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId, 'concluded');
      // Second call should not throw
      await parlour.end(conversationId, 'abandoned');

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      // Status should still be 'concluded' (first end wins)
      assert.equal(detail.status, 'concluded');
    });

    it('defaults to concluded when no reason given', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId);

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.status, 'concluded');
    });

    it('throws on non-existent conversation', async () => {
      await assert.rejects(
        () => parlour.end('conv-nonexistent'),
        { message: /not found/ },
      );
    });
  });

  // ── nextParticipant() ──────────────────────────────────────────────

  describe('nextParticipant()', () => {
    beforeEach(() => { setup(); });

    it('returns the anima participant for consult conversations', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const next = await parlour.nextParticipant(conversationId);
      assert.ok(next);
      assert.equal(next.kind, 'anima');
      assert.equal(next.name, 'Artificer');
    });

    it('returns round-robin participant for convene conversations', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'convene',
        topic: 'Discuss',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'anima', name: 'Alpha' },
          { kind: 'anima', name: 'Beta' },
          { kind: 'anima', name: 'Gamma' },
        ],
      });

      // No turns yet → first participant
      const next0 = await parlour.nextParticipant(conversationId);
      assert.ok(next0);
      assert.equal(next0.name, 'Alpha');

      // Take Alpha's turn
      await parlour.takeTurn({ conversationId, participantId: participants[0]!.id });

      // After 1 turn → second participant
      const next1 = await parlour.nextParticipant(conversationId);
      assert.ok(next1);
      assert.equal(next1.name, 'Beta');

      // Take Beta's turn
      await parlour.takeTurn({ conversationId, participantId: participants[1]!.id });

      // After 2 turns → third participant
      const next2 = await parlour.nextParticipant(conversationId);
      assert.ok(next2);
      assert.equal(next2.name, 'Gamma');
    });

    it('returns null for non-active conversation', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId);

      const next = await parlour.nextParticipant(conversationId);
      assert.equal(next, null);
    });

    it('returns null when turn limit reached', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test',
        turnLimit: 1,
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      await parlour.takeTurn({ conversationId, participantId: anima.id });

      const next = await parlour.nextParticipant(conversationId);
      assert.equal(next, null);
    });

    it('returns null for non-existent conversation', async () => {
      const next = await parlour.nextParticipant('conv-nonexistent');
      assert.equal(next, null);
    });
  });

  // ── list() ─────────────────────────────────────────────────────────

  describe('list()', () => {
    beforeEach(() => { setup(); });

    it('returns all conversations', async () => {
      await parlour.create({
        kind: 'consult',
        topic: 'First',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });
      await parlour.create({
        kind: 'convene',
        topic: 'Second',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'anima', name: 'Alpha' },
          { kind: 'anima', name: 'Beta' },
        ],
      });

      const result = await parlour.list();
      assert.equal(result.length, 2);
      const topics = result.map((r) => r.topic).sort();
      assert.deepEqual(topics, ['First', 'Second']);
    });

    it('filters by status', async () => {
      const { conversationId: id1 } = await parlour.create({
        kind: 'consult',
        topic: 'Active one',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });
      await parlour.create({
        kind: 'consult',
        topic: 'Will be concluded',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      // End the first one
      await parlour.end(id1, 'concluded');

      const active = await parlour.list({ status: 'active' });
      assert.equal(active.length, 1);
      assert.equal(active[0]!.topic, 'Will be concluded');

      const concluded = await parlour.list({ status: 'concluded' });
      assert.equal(concluded.length, 1);
      assert.equal(concluded[0]!.topic, 'Active one');
    });

    it('filters by kind', async () => {
      await parlour.create({
        kind: 'consult',
        topic: 'Consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });
      await parlour.create({
        kind: 'convene',
        topic: 'Convene',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'anima', name: 'Alpha' },
          { kind: 'anima', name: 'Beta' },
        ],
      });

      const consults = await parlour.list({ kind: 'consult' });
      assert.equal(consults.length, 1);
      assert.equal(consults[0]!.kind, 'consult');

      const convenes = await parlour.list({ kind: 'convene' });
      assert.equal(convenes.length, 1);
      assert.equal(convenes[0]!.kind, 'convene');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await parlour.create({
          kind: 'consult',
          topic: `Conv ${i}`,
          cwd: '/tmp/workspace',
          participants: [
            { kind: 'human', name: 'Sean' },
            { kind: 'anima', name: 'Artificer' },
          ],
        });
      }

      const limited = await parlour.list({ limit: 2 });
      assert.equal(limited.length, 2);
    });
  });

  // ── show() ─────────────────────────────────────────────────────────

  describe('show()', () => {
    beforeEach(() => { setup(); });

    it('returns null for non-existent conversation', async () => {
      const result = await parlour.show('conv-nonexistent');
      assert.equal(result, null);
    });

    it('includes turn summaries with session references', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      const anima = participants.find((p) => p.kind === 'anima')!;

      await parlour.takeTurn({ conversationId, participantId: anima.id });
      await parlour.takeTurn({ conversationId, participantId: human.id, message: 'Hello' });

      const detail = await parlour.show(conversationId);
      assert.ok(detail);
      assert.equal(detail.turns.length, 2);
      assert.ok(detail.turns[0]!.sessionId); // anima turn has session
      assert.equal(detail.turns[1]!.sessionId, null); // human turn has no session
      assert.equal(detail.turns[0]!.turnNumber, 1);
      assert.equal(detail.turns[1]!.turnNumber, 2);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    beforeEach(() => { setup(); });

    it('throws on non-existent conversation for takeTurn', async () => {
      await assert.rejects(
        () => parlour.takeTurn({
          conversationId: 'conv-nonexistent',
          participantId: 'part-whatever',
        }),
        { message: /not found/ },
      );
    });

    it('throws on non-existent participant for takeTurn', async () => {
      const { conversationId } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await assert.rejects(
        () => parlour.takeTurn({
          conversationId,
          participantId: 'part-nonexistent',
        }),
        { message: /not found/ },
      );
    });

    it('throws when taking a turn on concluded conversation', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      await parlour.end(conversationId, 'concluded');

      const human = participants.find((p) => p.kind === 'human')!;
      await assert.rejects(
        () => parlour.takeTurn({
          conversationId,
          participantId: human.id,
          message: 'Too late',
        }),
        { message: /not active/ },
      );
    });
  });

  // ── takeTurnStreaming() ────────────────────────────────────────────

  describe('takeTurnStreaming()', () => {
    it('streams chunks and returns turn result', async () => {
      const testChunks: SessionChunk[] = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
      ];
      setup(createStreamingFakeProvider(testChunks));

      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Stream test',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;
      const { chunks, result } = parlour.takeTurnStreaming({
        conversationId,
        participantId: anima.id,
      });

      // Collect all chunks
      const collected: unknown[] = [];
      for await (const chunk of chunks) {
        collected.push(chunk);
      }

      // Should have 2 text chunks + 1 turn_complete
      assert.equal(collected.length, 3);
      assert.deepEqual(collected[0], { type: 'text', text: 'Hello ' });
      assert.deepEqual(collected[1], { type: 'text', text: 'world!' });
      assert.equal((collected[2] as { type: string }).type, 'turn_complete');

      const turnResult = await result;
      assert.ok(turnResult.sessionResult);
      assert.equal(turnResult.turnNumber, 1);
    });

    it('handles human turns without streaming', async () => {
      setup();

      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const human = participants.find((p) => p.kind === 'human')!;
      const { chunks, result } = parlour.takeTurnStreaming({
        conversationId,
        participantId: human.id,
        message: 'Hello!',
      });

      // Should have no chunks for human turn
      const collected: unknown[] = [];
      for await (const chunk of chunks) {
        collected.push(chunk);
      }
      assert.equal(collected.length, 0);

      const turnResult = await result;
      assert.equal(turnResult.sessionResult, null);
      assert.equal(turnResult.turnNumber, 1);
    });
  });

  // ── Provider session continuity ────────────────────────────────────

  describe('provider session continuity', () => {
    beforeEach(() => { setup(); });

    it('stores and passes providerSessionId across turns', async () => {
      const { conversationId, participants } = await parlour.create({
        kind: 'consult',
        topic: 'Test continuity',
        cwd: '/tmp/workspace',
        participants: [
          { kind: 'human', name: 'Sean' },
          { kind: 'anima', name: 'Artificer' },
        ],
      });

      const anima = participants.find((p) => p.kind === 'anima')!;

      // First turn — providerSessionId gets set
      const t1 = await parlour.takeTurn({ conversationId, participantId: anima.id });
      assert.ok(t1.sessionResult!.providerSessionId);

      // Second turn — should resume using stored providerSessionId
      const t2 = await parlour.takeTurn({
        conversationId,
        participantId: anima.id,
        message: 'Continue',
      });
      assert.ok(t2.sessionResult);
      // The fake provider returns incrementing session ids,
      // confirming a new session was launched (the Parlour doesn't
      // control resume, it just passes the id through)
      assert.notEqual(t1.sessionResult!.id, t2.sessionResult!.id);
    });
  });
});

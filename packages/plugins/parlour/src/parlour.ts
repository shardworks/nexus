/**
 * The Parlour — multi-turn conversation management apparatus.
 *
 * Manages two kinds of conversation:
 * - consult: a human talks to an anima
 * - convene: multiple animas hold a structured dialogue
 *
 * The Parlour orchestrates turns — it decides when and for whom to call
 * The Animator, and tracks conversation state in The Stacks. It does not
 * launch sessions itself (delegates to The Animator) or assemble prompts
 * (delegates to The Loom).
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type { StacksApi, Book, ReadOnlyBook, WhereCondition } from '@shardworks/stacks-apparatus';
import type { AnimatorApi, SessionResult, SessionChunk, SessionDoc } from '@shardworks/animator-apparatus';
import type { LoomApi } from '@shardworks/loom-apparatus';

import type {
  ParlourApi,
  ConversationDoc,
  TurnDoc,
  ParticipantRecord,
  Participant,
  CreateConversationRequest,
  CreateConversationResult,
  TakeTurnRequest,
  TurnResult,
  ConversationChunk,
  ConversationSummary,
  ConversationDetail,
  TurnSummary,
  ListConversationsOptions,
} from './types.ts';

import { conversationList, conversationShow, conversationEnd } from './tools/index.ts';
import { parlourRoutes } from './routes.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Count anima turns in the conversation (for turn limit enforcement).
 * Human turns do not count toward the turn limit.
 */
async function countAnimaTurns(
  turns: ReadOnlyBook<TurnDoc>,
  conversationId: string,
): Promise<number> {
  return turns.count([
    ['conversationId', '=', conversationId],
    ['participantKind', '=', 'anima'],
  ]);
}

/**
 * Count all turns in the conversation (for turnNumber assignment).
 */
async function countAllTurns(
  turns: ReadOnlyBook<TurnDoc>,
  conversationId: string,
): Promise<number> {
  return turns.count([
    ['conversationId', '=', conversationId],
  ]);
}

/**
 * Get the most recent turn for a specific participant.
 */
async function getLastTurnForParticipant(
  turns: ReadOnlyBook<TurnDoc>,
  conversationId: string,
  participantId: string,
): Promise<TurnDoc | null> {
  const results = await turns.find({
    where: [
      ['conversationId', '=', conversationId],
      ['participantId', '=', participantId],
    ],
    orderBy: ['turnNumber', 'desc'],
    limit: 1,
  });
  return results[0] ?? null;
}

/**
 * Get turns since a given turn number (exclusive), ordered ascending.
 */
async function getTurnsSince(
  turns: ReadOnlyBook<TurnDoc>,
  conversationId: string,
  afterTurnNumber: number,
): Promise<TurnDoc[]> {
  return turns.find({
    where: [
      ['conversationId', '=', conversationId],
      ['turnNumber', '>', afterTurnNumber],
    ],
    orderBy: ['turnNumber', 'asc'],
  });
}

/**
 * Get all turns for a conversation, ordered by turnNumber ascending.
 */
async function getAllTurns(
  turns: ReadOnlyBook<TurnDoc>,
  conversationId: string,
): Promise<TurnDoc[]> {
  return turns.find({
    where: [
      ['conversationId', '=', conversationId],
    ],
    orderBy: ['turnNumber', 'asc'],
  });
}

/**
 * Map ParticipantRecord[] to Participant[] (public projection).
 */
function toParticipants(records: ParticipantRecord[]): Participant[] {
  return records.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
  }));
}

/**
 * Assemble the inter-turn message for a consult conversation.
 *
 * For consult, the pattern is simple: the human's message from the
 * TakeTurnRequest is passed directly as the prompt. If no message
 * is provided, the conversation topic is used as fallback (first turn).
 */
function assembleConsultMessage(
  request: TakeTurnRequest,
  conversation: ConversationDoc,
  isFirstTurn: boolean,
): string | undefined {
  if (request.message) return request.message;
  if (isFirstTurn && conversation.topic) return conversation.topic;
  return undefined;
}

/**
 * Assemble the inter-turn message for a convene conversation.
 *
 * For convene, each participant needs to see what other participants said
 * since their last turn. This requires reading session transcripts, which
 * depends on session record artifacts that the Animator MVP does not produce.
 *
 * At MVP, this uses the human-readable messages stored in turn records,
 * which are adequate for human turns but cannot capture anima responses
 * (the Animator does not expose transcript text). Anima contributions
 * fall back to a placeholder.
 *
 * See: parlour-implementation-tracker.md § Gap #1
 */
async function assembleConveneMessage(
  turns: ReadOnlyBook<TurnDoc>,
  conversation: ConversationDoc,
  participantId: string,
  isFirstTurn: boolean,
): Promise<string | undefined> {
  if (isFirstTurn && conversation.topic) return conversation.topic;

  // Get this participant's last turn to find intervening turns
  const lastTurn = await getLastTurnForParticipant(
    turns,
    conversation.id,
    participantId,
  );

  if (!lastTurn) {
    // Never taken a turn — use topic
    return conversation.topic ?? undefined;
  }

  // Get all turns since this participant's last turn
  const intervening = await getTurnsSince(
    turns,
    conversation.id,
    lastTurn.turnNumber,
  );

  if (intervening.length === 0) return undefined;

  // Assemble messages from other participants
  const lines: string[] = [];
  for (const turn of intervening) {
    if (turn.participantId === participantId) continue;
    if (turn.participantKind === 'human' && turn.message) {
      lines.push(`[${turn.participantName}]: ${turn.message}`);
    } else if (turn.participantKind === 'anima') {
      // Cannot extract anima response — Animator MVP has no transcript text.
      // Placeholder until session record artifacts or response capture is available.
      lines.push(`[${turn.participantName}]: [response not available]`);
    }
  }

  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

// ── Apparatus factory ────────────────────────────────────────────────

/**
 * Create the Parlour apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: ['stacks', 'animator', 'loom']` — conversation orchestration
 * - `provides: ParlourApi` — the conversation management API
 * - `supportKit` — contributes `conversations` + `turns` books + management tools
 */
export function createParlour(): Plugin {
  let conversations: Book<ConversationDoc>;
  let turns: Book<TurnDoc>;
  let sessions: ReadOnlyBook<SessionDoc>;

  const api: ParlourApi = {
    async create(request: CreateConversationRequest): Promise<CreateConversationResult> {
      const conversationId = generateId('conv');

      // Build participant records
      const participants: ParticipantRecord[] = request.participants.map((decl) => ({
        id: generateId('part'),
        kind: decl.kind,
        name: decl.name,
        animaId: null, // No Roster yet — leave null at MVP
        providerSessionId: null,
      }));

      // Write conversation document
      const doc: ConversationDoc = {
        id: conversationId,
        status: 'active',
        kind: request.kind,
        topic: request.topic ?? null,
        turnLimit: request.turnLimit ?? null,
        createdAt: new Date().toISOString(),
        endedAt: null,
        eventId: request.eventId ?? null,
        participants,
        cwd: request.cwd,
      };

      await conversations.put(doc);

      return {
        conversationId,
        participants: toParticipants(participants),
      };
    },

    async takeTurn(request: TakeTurnRequest): Promise<TurnResult> {
      // 1. Read conversation state
      const conv = await conversations.get(request.conversationId);
      if (!conv) {
        throw new Error(`Conversation "${request.conversationId}" not found.`);
      }
      if (conv.status !== 'active') {
        throw new Error(
          `Conversation "${request.conversationId}" is ${conv.status}, not active.`,
        );
      }

      // Find the participant
      const participant = conv.participants.find((p) => p.id === request.participantId);
      if (!participant) {
        throw new Error(
          `Participant "${request.participantId}" not found in conversation "${request.conversationId}".`,
        );
      }

      // 2. Determine turn number
      const totalTurns = await countAllTurns(turns, conv.id);
      const turnNumber = totalTurns + 1;

      // 3. Check turn limit (anima turns only)
      if (participant.kind === 'anima' && conv.turnLimit !== null) {
        const animaTurns = await countAnimaTurns(turns, conv.id);
        if (animaTurns >= conv.turnLimit) {
          throw new Error(
            `Conversation "${conv.id}" has reached its turn limit of ${conv.turnLimit}.`,
          );
        }
      }

      const startedAt = new Date().toISOString();

      if (participant.kind === 'human') {
        // Human turn — record the message, no session launched
        const turnId = generateId('turn', 6);
        await turns.put({
          id: turnId,
          conversationId: conv.id,
          turnNumber,
          participantId: participant.id,
          participantName: participant.name,
          participantKind: 'human',
          message: request.message ?? null,
          sessionId: null,
          startedAt,
          endedAt: new Date().toISOString(),
        });

        return {
          sessionResult: null,
          turnNumber,
          conversationActive: true,
        };
      }

      // Anima turn — weave context and call the Animator
      const loom = guild().apparatus<LoomApi>('loom');
      const animator = guild().apparatus<AnimatorApi>('animator');

      // Determine if this is the participant's first turn
      const lastTurn = await getLastTurnForParticipant(turns, conv.id, participant.id);
      const isFirstTurn = lastTurn === null;

      // Assemble the message for this turn
      let message: string | undefined;
      if (conv.kind === 'consult') {
        message = assembleConsultMessage(request, conv, isFirstTurn);
      } else {
        message = await assembleConveneMessage(turns, conv, participant.id, isFirstTurn);
      }

      // Weave anima context via The Loom
      const context = await loom.weave({ role: participant.name });

      // Call The Animator
      const { result: resultPromise } = animator.animate({
        context,
        prompt: message,
        cwd: conv.cwd,
        conversationId: participant.providerSessionId ?? undefined,
        metadata: {
          trigger: 'parlour',
          conversationId: conv.id,
          turnNumber,
          participantId: participant.id,
        },
      });

      const sessionResult = await resultPromise;

      // Update participant's providerSessionId for --resume
      const updatedParticipants = conv.participants.map((p) =>
        p.id === participant.id
          ? { ...p, providerSessionId: sessionResult.providerSessionId ?? p.providerSessionId }
          : p,
      );
      await conversations.patch(conv.id, { participants: updatedParticipants });

      // Record the turn
      const turnId = generateId('turn', 6);
      await turns.put({
        id: turnId,
        conversationId: conv.id,
        turnNumber,
        participantId: participant.id,
        participantName: participant.name,
        participantKind: 'anima',
        message: message ?? null,
        sessionId: sessionResult.id,
        startedAt,
        endedAt: new Date().toISOString(),
      });

      // Check if turn limit reached → auto-conclude
      let conversationActive = true;
      if (conv.turnLimit !== null) {
        const animaTurns = await countAnimaTurns(turns, conv.id);
        if (animaTurns >= conv.turnLimit) {
          await this.end(conv.id, 'concluded');
          conversationActive = false;
        }
      }

      return {
        sessionResult,
        turnNumber,
        conversationActive,
      };
    },

    takeTurnStreaming(request: TakeTurnRequest): {
      chunks: AsyncIterable<ConversationChunk>;
      result: Promise<TurnResult>;
    } {
      type HumanResolved = { kind: 'human'; turnResult: TurnResult };
      type AnimaResolved = {
        kind: 'anima';
        animatorChunks: AsyncIterable<SessionChunk>;
        animatorResult: Promise<SessionResult>;
        conv: ConversationDoc;
        participant: ParticipantRecord;
        turnNumber: number;
        startedAt: string;
        message: string | undefined;
      };
      type StreamResolved = HumanResolved | AnimaResolved;

      // Read conversation state and launch the turn.
      // We need to return synchronously, so wrap the async flow.
      const deferred: Promise<StreamResolved> = (async (): Promise<StreamResolved> => {
        // 1. Read conversation state
        const conv = await conversations.get(request.conversationId);
        if (!conv) {
          throw new Error(`Conversation "${request.conversationId}" not found.`);
        }
        if (conv.status !== 'active') {
          throw new Error(
            `Conversation "${request.conversationId}" is ${conv.status}, not active.`,
          );
        }

        // Find the participant
        const participant = conv.participants.find((p) => p.id === request.participantId);
        if (!participant) {
          throw new Error(
            `Participant "${request.participantId}" not found in conversation "${request.conversationId}".`,
          );
        }

        // Human turns don't stream — delegate to non-streaming path
        if (participant.kind === 'human') {
          const turnResult = await this.takeTurn(request);
          return { kind: 'human', turnResult };
        }

        // 2. Determine turn number
        const totalTurns = await countAllTurns(turns, conv.id);
        const turnNumber = totalTurns + 1;

        // 3. Check turn limit
        if (conv.turnLimit !== null) {
          const animaTurns = await countAnimaTurns(turns, conv.id);
          if (animaTurns >= conv.turnLimit) {
            throw new Error(
              `Conversation "${conv.id}" has reached its turn limit of ${conv.turnLimit}.`,
            );
          }
        }

        const startedAt = new Date().toISOString();

        const loom = guild().apparatus<LoomApi>('loom');
        const animator = guild().apparatus<AnimatorApi>('animator');

        // Determine if first turn
        const lastTurn = await getLastTurnForParticipant(turns, conv.id, participant.id);
        const isFirstTurn = lastTurn === null;

        // Assemble message
        let message: string | undefined;
        if (conv.kind === 'consult') {
          message = assembleConsultMessage(request, conv, isFirstTurn);
        } else {
          message = await assembleConveneMessage(turns, conv, participant.id, isFirstTurn);
        }

        // Weave + animate with streaming
        const context = await loom.weave({ role: participant.name });
        const handle = animator.animate({
          context,
          prompt: message,
          cwd: conv.cwd,
          conversationId: participant.providerSessionId ?? undefined,
          metadata: {
            trigger: 'parlour',
            conversationId: conv.id,
            turnNumber,
            participantId: participant.id,
          },
          streaming: true,
        });

        return {
          kind: 'anima',
          animatorChunks: handle.chunks,
          animatorResult: handle.result,
          conv,
          participant,
          turnNumber,
          startedAt,
          message,
        };
      })();

      async function* streamChunks(): AsyncIterable<ConversationChunk> {
        const resolved = await deferred;
        // Human turn — no chunks
        if (resolved.kind === 'human') return;

        const { animatorChunks, animatorResult } = resolved;

        // Pipe through Animator chunks
        yield* animatorChunks;

        // Wait for final result to emit turn_complete
        const sessionResult = await animatorResult;
        yield {
          type: 'turn_complete' as const,
          turnNumber: resolved.turnNumber,
          costUsd: sessionResult.costUsd,
        };
      }

      const result = (async (): Promise<TurnResult> => {
        const resolved = await deferred;

        // Human turn — already handled
        if (resolved.kind === 'human') return resolved.turnResult;

        const { animatorResult, conv, participant, turnNumber, startedAt, message } = resolved;
        const sessionResult = await animatorResult;

        // Update providerSessionId
        const updatedParticipants = conv.participants.map((p) =>
          p.id === participant.id
            ? { ...p, providerSessionId: sessionResult.providerSessionId ?? p.providerSessionId }
            : p,
        );
        await conversations.patch(conv.id, { participants: updatedParticipants });

        // Record turn
        const turnId = generateId('turn', 6);
        await turns.put({
          id: turnId,
          conversationId: conv.id,
          turnNumber,
          participantId: participant.id,
          participantName: participant.name,
          participantKind: 'anima',
          message: message ?? null,
          sessionId: sessionResult.id,
          startedAt,
          endedAt: new Date().toISOString(),
        });

        // Check turn limit
        let conversationActive = true;
        if (conv.turnLimit !== null) {
          const animaTurns = await countAnimaTurns(turns, conv.id);
          if (animaTurns >= conv.turnLimit) {
            await api.end(conv.id, 'concluded');
            conversationActive = false;
          }
        }

        return { sessionResult, turnNumber, conversationActive };
      })();

      return { chunks: streamChunks(), result };
    },

    async nextParticipant(conversationId: string): Promise<Participant | null> {
      const conv = await conversations.get(conversationId);
      if (!conv || conv.status !== 'active') return null;

      // Check turn limit
      if (conv.turnLimit !== null) {
        const animaTurns = await countAnimaTurns(turns, conv.id);
        if (animaTurns >= conv.turnLimit) return null;
      }

      if (conv.kind === 'consult') {
        // For consult: always return the anima participant
        const anima = conv.participants.find((p) => p.kind === 'anima');
        if (!anima) return null;
        return { id: anima.id, name: anima.name, kind: anima.kind };
      }

      // For convene: round-robin among all participants
      const totalTurns = await countAllTurns(turns, conv.id);
      const nextIndex = totalTurns % conv.participants.length;
      const next = conv.participants[nextIndex];
      return { id: next.id, name: next.name, kind: next.kind };
    },

    async end(conversationId: string, reason?: 'concluded' | 'abandoned'): Promise<void> {
      const conv = await conversations.get(conversationId);
      if (!conv) {
        throw new Error(`Conversation "${conversationId}" not found.`);
      }
      // Idempotent — no error if already ended
      if (conv.status !== 'active') return;

      await conversations.patch(conversationId, {
        status: reason ?? 'concluded',
        endedAt: new Date().toISOString(),
      });
    },

    async list(options?: ListConversationsOptions): Promise<ConversationSummary[]> {
      const where: WhereCondition[] = [];
      if (options?.status) where.push(['status', '=', options.status]);
      if (options?.kind) where.push(['kind', '=', options.kind]);

      const convs = await conversations.find({
        where: where.length > 0 ? where : undefined,
        orderBy: ['createdAt', 'desc'],
        limit: options?.limit ?? 20,
      });

      // Build summaries with turn counts and cost aggregation
      const summaries: ConversationSummary[] = [];
      for (const conv of convs) {
        const convTurns = await getAllTurns(turns, conv.id);
        const sessionIds = convTurns
          .map((t) => t.sessionId)
          .filter((id): id is string => id !== null);

        // Aggregate cost from session records
        let totalCostUsd = 0;
        for (const sessionId of sessionIds) {
          const session = await sessions.get(sessionId);
          if (session?.costUsd) totalCostUsd += session.costUsd;
        }

        summaries.push({
          id: conv.id,
          status: conv.status,
          kind: conv.kind,
          topic: conv.topic,
          turnLimit: conv.turnLimit,
          createdAt: conv.createdAt,
          endedAt: conv.endedAt,
          participants: toParticipants(conv.participants),
          turnCount: convTurns.length,
          totalCostUsd,
        });
      }

      return summaries;
    },

    async show(conversationId: string): Promise<ConversationDetail | null> {
      const conv = await conversations.get(conversationId);
      if (!conv) return null;

      const convTurns = await getAllTurns(turns, conv.id);

      // Fetch session docs for all anima turns in one pass.
      // Used for both per-turn enrichment and aggregate cost.
      const sessionDocMap = new Map<string, Awaited<ReturnType<typeof sessions.get>>>();
      for (const t of convTurns) {
        if (t.sessionId !== null) {
          const session = await sessions.get(t.sessionId);
          sessionDocMap.set(t.sessionId, session);
        }
      }

      // Aggregate cost across all anima turns
      let totalCostUsd = 0;
      for (const session of sessionDocMap.values()) {
        if (session?.costUsd) totalCostUsd += session.costUsd;
      }

      // Build enriched turn summaries
      const turnSummaries: TurnSummary[] = convTurns.map((t) => {
        if (t.sessionId === null) {
          // Human turn — no session data
          return {
            sessionId: null,
            turnNumber: t.turnNumber,
            participant: t.participantName,
            message: t.message,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            output: null,
            costUsd: null,
            tokenUsage: null,
          };
        }

        const session = sessionDocMap.get(t.sessionId);
        return {
          sessionId: t.sessionId,
          turnNumber: t.turnNumber,
          participant: t.participantName,
          message: t.message,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          output: session?.output ?? null,
          costUsd: session?.costUsd ?? null,
          tokenUsage: session?.tokenUsage ?? null,
        };
      });

      return {
        id: conv.id,
        status: conv.status,
        kind: conv.kind,
        topic: conv.topic,
        turnLimit: conv.turnLimit,
        createdAt: conv.createdAt,
        endedAt: conv.endedAt,
        participants: toParticipants(conv.participants),
        turnCount: convTurns.length,
        totalCostUsd,
        turns: turnSummaries,
      };
    },
  };

  return {
    apparatus: {
      requires: ['stacks', 'animator', 'loom'],

      supportKit: {
        books: {
          conversations: {
            indexes: ['status', 'kind', 'createdAt'],
          },
          turns: {
            indexes: ['conversationId', 'turnNumber', 'participantId', 'participantKind'],
          },
        },
        tools: [conversationList, conversationShow, conversationEnd],
        pages: [
          { id: 'parlour', title: 'Parlour', dir: 'src/static/parlour' },
        ],
        routes: parlourRoutes,
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');
        conversations = stacks.book<ConversationDoc>('parlour', 'conversations');
        turns = stacks.book<TurnDoc>('parlour', 'turns');
        sessions = stacks.readBook<SessionDoc>('animator', 'sessions');
      },
    },
  };
}

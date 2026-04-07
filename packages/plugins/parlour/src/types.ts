/**
 * The Parlour — public types.
 *
 * These types form the contract between The Parlour apparatus and all
 * callers (CLI consult command, clockworks convene handlers, etc.).
 * No implementation details.
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import type { SessionResult, SessionChunk } from '@shardworks/animator-apparatus';

// ── Conversation document (Stacks) ──────────────────────────────────

export interface ConversationDoc {
  id: string;
  status: 'active' | 'concluded' | 'abandoned';
  kind: 'consult' | 'convene';
  topic: string | null;
  turnLimit: number | null;
  createdAt: string;
  endedAt: string | null;
  eventId: string | null;
  participants: ParticipantRecord[];
  /** Stored once at creation — all turns must use the same cwd for --resume. */
  cwd: string;
  /** Index signature required by BookEntry. */
  [key: string]: unknown;
}

export interface ParticipantRecord {
  /** Stable participant id (generated at creation). */
  id: string;
  kind: 'anima' | 'human';
  name: string;
  /** Anima id, resolved at creation time. Null for human participants. */
  animaId: string | null;
  /**
   * Provider session id for --resume. Updated after each turn so
   * the next turn can continue the provider's conversation context.
   */
  providerSessionId: string | null;
}

// ── Turn tracking ───────────────────────────────────────────────────

/**
 * Internal turn record stored in the turns book.
 * One entry per takeTurn() call — both human and anima turns.
 */
export interface TurnDoc {
  id: string;
  conversationId: string;
  turnNumber: number;
  participantId: string;
  participantName: string;
  participantKind: 'anima' | 'human';
  /** The message passed to this turn (human message or inter-turn context). */
  message: string | null;
  /** Session id from The Animator (null for human turns). */
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Index signature required by BookEntry. */
  [key: string]: unknown;
}

// ── Request / Result types ──────────────────────────────────────────

export interface CreateConversationRequest {
  /** Conversation kind. */
  kind: 'consult' | 'convene';
  /** Seed topic or prompt. Used as the initial message for the first turn. */
  topic?: string;
  /** Maximum allowed turns (anima turns only). Null = unlimited. */
  turnLimit?: number;
  /** Participants in the conversation. */
  participants: ParticipantDeclaration[];
  /** Working directory — persists for the conversation's lifetime. */
  cwd: string;
  /** Triggering event id, for conversations started by clockworks. */
  eventId?: string;
}

export interface ParticipantDeclaration {
  kind: 'anima' | 'human';
  /** Display name. For anima participants, this is the anima name
   *  used to resolve identity via The Loom at turn time. */
  name: string;
}

export interface CreateConversationResult {
  conversationId: string;
  participants: Participant[];
}

export interface Participant {
  id: string;
  name: string;
  kind: 'anima' | 'human';
}

export interface TakeTurnRequest {
  conversationId: string;
  participantId: string;
  /** The message for this turn. For consult: the human's message.
   *  For convene: typically assembled by the caller, or omitted to
   *  let The Parlour assemble it automatically. */
  message?: string;
}

export interface TurnResult {
  /** The Animator's session result for this turn. Null for human turns. */
  sessionResult: SessionResult | null;
  /** Turn number within the conversation (1-indexed). */
  turnNumber: number;
  /** Whether the conversation is still active after this turn. */
  conversationActive: boolean;
}

/** A chunk of output from a conversation turn. */
export type ConversationChunk =
  | SessionChunk
  | { type: 'turn_complete'; turnNumber: number; costUsd?: number };

export interface ConversationSummary {
  id: string;
  status: 'active' | 'concluded' | 'abandoned';
  kind: 'consult' | 'convene';
  topic: string | null;
  turnLimit: number | null;
  createdAt: string;
  endedAt: string | null;
  participants: Participant[];
  /** Computed from turn records. */
  turnCount: number;
  /** Aggregate cost across all turns. */
  totalCostUsd: number;
}

export interface ConversationDetail extends ConversationSummary {
  turns: TurnSummary[];
}

export interface TurnSummary {
  sessionId: string | null;
  turnNumber: number;
  participant: string;
  message: string | null;
  startedAt: string;
  endedAt: string | null;
  /** The anima's response text. Populated from SessionDoc.output. Null for human turns or when no output was recorded. */
  output: string | null;
  /** Cost in USD for this turn. Null for human turns. */
  costUsd: number | null;
  /** Token usage for this turn. Null for human turns. */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
}

export interface ListConversationsOptions {
  status?: 'active' | 'concluded' | 'abandoned';
  kind?: 'consult' | 'convene';
  limit?: number;
}

// ── ParlourApi (the `provides` interface) ───────────────────────────

export interface ParlourApi {
  /**
   * Create a new conversation.
   *
   * Sets up conversation and participant records. Does NOT take a first
   * turn — that's a separate call to takeTurn().
   */
  create(request: CreateConversationRequest): Promise<CreateConversationResult>;

  /**
   * Take a turn in a conversation.
   *
   * For anima participants: weaves context via The Loom, assembles the
   * inter-turn message, and calls The Animator to run a session. Returns
   * the session result. For human participants: records the message as
   * context for the next turn (no session launched).
   *
   * Throws if the conversation is not active or the turn limit is reached.
   */
  takeTurn(request: TakeTurnRequest): Promise<TurnResult>;

  /**
   * Take a turn with streaming output.
   *
   * Same as takeTurn(), but yields ConversationChunks as the session
   * produces output. Includes a turn_complete chunk at the end.
   */
  takeTurnStreaming(request: TakeTurnRequest): {
    chunks: AsyncIterable<ConversationChunk>;
    result: Promise<TurnResult>;
  };

  /**
   * Get the next participant in a conversation.
   *
   * For convene: returns the next anima in round-robin order.
   * For consult: returns the anima participant (human turns are implicit).
   * Returns null if the conversation is not active or the turn limit is reached.
   */
  nextParticipant(conversationId: string): Promise<Participant | null>;

  /**
   * End a conversation.
   *
   * Sets status to 'concluded' (normal end) or 'abandoned' (e.g. timeout,
   * disconnect). Idempotent — no error if already ended.
   */
  end(conversationId: string, reason?: 'concluded' | 'abandoned'): Promise<void>;

  /**
   * List conversations with optional filters.
   */
  list(options?: ListConversationsOptions): Promise<ConversationSummary[]>;

  /**
   * Show full detail for a conversation.
   */
  show(conversationId: string): Promise<ConversationDetail | null>;
}

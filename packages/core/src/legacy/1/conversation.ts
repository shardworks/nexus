/**
 * Conversation — multi-turn interaction with animas.
 *
 * Conversations group multiple sessions (turns) into a single logical
 * interaction. Each turn is a full launchSession() call through the
 * standard session funnel — same manifest pipeline, same metrics,
 * same session records.
 *
 * Two kinds:
 * - **consult** — human talks to an anima (from dashboard or CLI)
 * - **convene** — multiple animas hold a turn-limited dialogue
 *
 * State is fully persistent in the database. The core primitive is
 * `takeTurn()` — a stateless function that reads conversation state,
 * runs one turn through the session funnel, and updates the records.
 * No in-memory state is held between turns. Any component (dashboard,
 * CLI, clockworks) can drive a turn with just a conversation ID and
 * participant ID.
 *
 * Human participants don't launch sessions. Their messages are captured
 * as the `prompt` field on the anima's session record. This means the
 * sessions table only contains anima turns — cost, tokens, and duration
 * are always agent-side metrics. For dialogue reconstruction,
 * `showConversation()` interleaves anima session rows with their prompts
 * to show the full exchange.
 */

import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { generateId } from './id.ts';
import { manifest } from './manifest.ts';
import { launchSession } from './session.ts';
import type { SessionChunk, ResolvedWorkspace } from './session.ts';

// ── Types ──────────────────────────────────────────────────────────────

/** A chunk emitted during a conversation turn. Re-exports SessionChunk
 *  with an additional turn_complete variant. */
export type ConversationChunk =
  | SessionChunk
  | { type: 'turn_complete'; turnNumber: number; costUsd?: number };

/** Options for creating a conversation. */
export interface CreateConversationOptions {
  kind: 'consult' | 'convene';
  topic?: string;
  turnLimit?: number;
  participants: Array<{
    kind: 'anima' | 'human';
    name: string;
  }>;
  /** For convene: the triggering event ID. */
  eventId?: string;
}

/** Result of creating a conversation. */
export interface CreateConversationResult {
  conversationId: string;
  participants: Array<{ id: string; name: string; kind: string }>;
}

/** Summary view for listing conversations. */
export interface ConversationSummary {
  id: string;
  status: string;
  kind: string;
  topic: string | null;
  turnLimit: number | null;
  createdAt: string;
  endedAt: string | null;
  participants: Array<{ id: string; name: string; kind: string }>;
  /** Computed from sessions table. */
  turnCount: number;
  totalCostUsd: number;
}

/** Full detail view of a conversation including turns. */
export interface ConversationDetail extends ConversationSummary {
  /** Turns are session rows, enriched with participant name. */
  turns: Array<{
    sessionId: string;
    turnNumber: number;
    participant: string;
    prompt: string | null;
    exitCode: number | null;
    costUsd: number | null;
    durationMs: number | null;
    startedAt: string;
    endedAt: string | null;
  }>;
}

/** Options for listing conversations. */
export interface ListConversationsOptions {
  status?: string;
  kind?: string;
  limit?: number;
}

// ── Lifecycle Functions ────────────────────────────────────────────────

/**
 * Create a new conversation.
 *
 * Sets up conversation and participant records. Does NOT take a first
 * turn — that's a separate call to takeTurn().
 *
 * Anima participants are identified by name. Manifesting happens at
 * turn time, not creation time.
 */
export function createConversation(
  home: string,
  options: CreateConversationOptions,
): CreateConversationResult {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const conversationId = generateId('conv');
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO conversations (id, status, kind, topic, turn_limit, created_at, event_id)
       VALUES (?, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      conversationId,
      options.kind,
      options.topic ?? null,
      options.turnLimit ?? null,
      now,
      options.eventId ?? null,
    );

    const participants: Array<{ id: string; name: string; kind: string }> = [];

    for (const p of options.participants) {
      const participantId = generateId('cpart');

      // Look up anima_id for anima participants
      let animaId: string | null = null;
      if (p.kind === 'anima') {
        const row = db.prepare(
          `SELECT id FROM animas WHERE name = ? AND status = 'active'`,
        ).get(p.name) as { id: string } | undefined;
        if (row) {
          animaId = row.id;
        }
      }

      db.prepare(
        `INSERT INTO conversation_participants (id, conversation_id, kind, name, anima_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(participantId, conversationId, p.kind, p.name, animaId);

      participants.push({ id: participantId, name: p.name, kind: p.kind });
    }

    return { conversationId, participants };
  } finally {
    db.close();
  }
}

/**
 * Take a turn in a conversation.
 *
 * For anima participants:
 *   1. Reads conversation state (checks status, turn limit)
 *   2. Manifests the anima through the standard pipeline
 *   3. Calls launchSession() with claudeSessionId for --resume
 *   4. Captures providerSessionId and updates participant record
 *   5. Yields ConversationChunks as they stream from the provider
 *
 * For human participants:
 *   - No session launched. Human messages are passed as the prompt
 *     to the next anima turn. This function is a no-op for humans
 *     (the caller passes the human's message directly to the anima's
 *     takeTurn call).
 *
 * Throws if conversation is not active or turn limit reached.
 */
export async function* takeTurn(
  home: string,
  conversationId: string,
  participantId: string,
  message: string,
): AsyncGenerator<ConversationChunk> {
  // 1. Read conversation and participant state
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  let conversation: {
    status: string;
    kind: string;
    turn_limit: number | null;
  };
  let participant: {
    kind: string;
    name: string;
    anima_id: string | null;
    claude_session_id: string | null;
  };
  let currentTurnCount: number;

  try {
    const convRow = db.prepare(
      `SELECT status, kind, turn_limit FROM conversations WHERE id = ?`,
    ).get(conversationId) as typeof conversation | undefined;

    if (!convRow) {
      throw new Error(`Conversation "${conversationId}" not found.`);
    }
    conversation = convRow;

    if (conversation.status !== 'active') {
      throw new Error(
        `Conversation "${conversationId}" is not active (status: ${conversation.status}).`,
      );
    }

    const partRow = db.prepare(
      `SELECT kind, name, anima_id, claude_session_id
       FROM conversation_participants WHERE id = ? AND conversation_id = ?`,
    ).get(participantId, conversationId) as typeof participant | undefined;

    if (!partRow) {
      throw new Error(
        `Participant "${participantId}" not found in conversation "${conversationId}".`,
      );
    }
    participant = partRow;

    // Count existing turns for this conversation
    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM sessions WHERE conversation_id = ?`,
    ).get(conversationId) as { count: number };
    currentTurnCount = countRow.count;

    // Check turn limit
    if (conversation.turn_limit !== null && currentTurnCount >= conversation.turn_limit) {
      // Auto-conclude if at limit
      db.prepare(
        `UPDATE conversations SET status = 'concluded', ended_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), conversationId);
      throw new Error(
        `Conversation "${conversationId}" has reached its turn limit (${conversation.turn_limit}).`,
      );
    }
  } finally {
    db.close();
  }

  // 2. Human participants don't launch sessions
  if (participant.kind === 'human') {
    // Nothing to do — the message will be passed as the prompt
    // to the next anima turn by the caller.
    return;
  }

  // 3. Manifest the anima
  const animaManifest = await manifest(home, participant.name);

  // 4. Determine turn number (1-indexed)
  const turnNumber = currentTurnCount + 1;

  // 5. Launch session through the funnel
  const workspace: ResolvedWorkspace = { kind: 'guildhall' };

  // Collect chunks from the streaming provider
  const collectedChunks: ConversationChunk[] = [];

  const sessionResult = await launchSession({
    home,
    manifest: animaManifest,
    prompt: message,
    interactive: false,
    workspace,
    trigger: conversation.kind as 'consult' | 'convene',
    name: `${conversation.kind}-${participant.name}-turn-${turnNumber}`,
    conversationId,
    turnNumber,
    claudeSessionId: participant.claude_session_id ?? undefined,
    onChunk: (chunk) => {
      collectedChunks.push(chunk);
    },
  });

  // Yield all collected chunks
  for (const chunk of collectedChunks) {
    yield chunk;
  }

  // 6. Update participant's claude_session_id for --resume on next turn
  if (sessionResult.providerSessionId) {
    const db2 = new Database(booksPath(home));
    db2.pragma('foreign_keys = ON');
    try {
      db2.prepare(
        `UPDATE conversation_participants SET claude_session_id = ? WHERE id = ?`,
      ).run(sessionResult.providerSessionId, participantId);
    } finally {
      db2.close();
    }
  }

  // 7. Check if we've hit the turn limit after this turn
  if (conversation.turn_limit !== null && turnNumber >= conversation.turn_limit) {
    const db3 = new Database(booksPath(home));
    db3.pragma('foreign_keys = ON');
    try {
      db3.prepare(
        `UPDATE conversations SET status = 'concluded', ended_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), conversationId);
    } finally {
      db3.close();
    }
  }

  // 8. Yield turn_complete
  yield {
    type: 'turn_complete',
    turnNumber,
    costUsd: sessionResult.costUsd,
  };
}

/**
 * End a conversation explicitly.
 *
 * Sets status to 'concluded' (normal end) or 'abandoned' (e.g.
 * browser disconnect, timeout).
 */
export function endConversation(
  home: string,
  conversationId: string,
  reason: 'concluded' | 'abandoned' = 'concluded',
): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const result = db.prepare(
      `UPDATE conversations SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'`,
    ).run(reason, new Date().toISOString(), conversationId);

    if (result.changes === 0) {
      // Either not found or already ended — check which
      const row = db.prepare(
        `SELECT status FROM conversations WHERE id = ?`,
      ).get(conversationId) as { status: string } | undefined;

      if (!row) {
        throw new Error(`Conversation "${conversationId}" not found.`);
      }
      // Already ended — no-op (idempotent)
    }
  } finally {
    db.close();
  }
}

/**
 * Get the next participant in a convene rotation.
 *
 * Reads turn history and returns whose turn it is (round-robin by
 * participant creation order). Returns null if conversation is not
 * active or turn limit reached.
 */
export function nextParticipant(
  home: string,
  conversationId: string,
): { participantId: string; name: string } | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    // Check conversation is active
    const conv = db.prepare(
      `SELECT status, turn_limit FROM conversations WHERE id = ?`,
    ).get(conversationId) as { status: string; turn_limit: number | null } | undefined;

    if (!conv || conv.status !== 'active') return null;

    // Count existing turns
    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM sessions WHERE conversation_id = ?`,
    ).get(conversationId) as { count: number };

    if (conv.turn_limit !== null && countRow.count >= conv.turn_limit) return null;

    // Get participants in creation order (by rowid)
    const participants = db.prepare(
      `SELECT id, name FROM conversation_participants
       WHERE conversation_id = ? AND kind = 'anima'
       ORDER BY rowid ASC`,
    ).all(conversationId) as Array<{ id: string; name: string }>;

    if (participants.length === 0) return null;

    // Round-robin: turn count mod participant count
    const nextIdx = countRow.count % participants.length;
    const next = participants[nextIdx]!;
    return { participantId: next.id, name: next.name };
  } finally {
    db.close();
  }
}

// ── Read Functions ─────────────────────────────────────────────────────

/**
 * List conversations with optional filters.
 */
export function listConversations(
  home: string,
  opts: ListConversationsOptions = {},
): ConversationSummary[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT c.id, c.status, c.kind, c.topic, c.turn_limit,
                        c.created_at, c.ended_at
                 FROM conversations c`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      conditions.push('c.status = ?');
      params.push(opts.status);
    }
    if (opts.kind) {
      conditions.push('c.kind = ?');
      params.push(opts.kind);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY c.created_at DESC`;
    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; status: string; kind: string; topic: string | null;
      turn_limit: number | null; created_at: string; ended_at: string | null;
    }>;

    return rows.map(row => {
      // Get participants
      const parts = db.prepare(
        `SELECT id, name, kind FROM conversation_participants WHERE conversation_id = ?`,
      ).all(row.id) as Array<{ id: string; name: string; kind: string }>;

      // Get turn count and total cost from sessions
      const metrics = db.prepare(
        `SELECT COUNT(*) as turn_count, COALESCE(SUM(cost_usd), 0) as total_cost
         FROM sessions WHERE conversation_id = ?`,
      ).get(row.id) as { turn_count: number; total_cost: number };

      return {
        id: row.id,
        status: row.status,
        kind: row.kind,
        topic: row.topic,
        turnLimit: row.turn_limit,
        createdAt: row.created_at,
        endedAt: row.ended_at,
        participants: parts,
        turnCount: metrics.turn_count,
        totalCostUsd: metrics.total_cost,
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Show full detail for a conversation, including all turns.
 *
 * Turns are session rows ordered by turn_number. Each turn includes
 * the prompt (which, in a consult, is the human's message — this is
 * how human contributions appear in the dialogue reconstruction).
 */
export function showConversation(
  home: string,
  conversationId: string,
): ConversationDetail | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT id, status, kind, topic, turn_limit, created_at, ended_at
       FROM conversations WHERE id = ?`,
    ).get(conversationId) as {
      id: string; status: string; kind: string; topic: string | null;
      turn_limit: number | null; created_at: string; ended_at: string | null;
    } | undefined;

    if (!row) return null;

    // Get participants
    const parts = db.prepare(
      `SELECT id, name, kind FROM conversation_participants WHERE conversation_id = ?`,
    ).all(row.id) as Array<{ id: string; name: string; kind: string }>;

    // Get turns (sessions for this conversation)
    const turns = db.prepare(
      `SELECT s.id, s.turn_number, a.name as participant,
              s.started_at, s.ended_at, s.exit_code, s.cost_usd, s.duration_ms
       FROM sessions s
       JOIN animas a ON a.id = s.anima_id
       WHERE s.conversation_id = ?
       ORDER BY s.turn_number ASC`,
    ).all(conversationId) as Array<{
      id: string; turn_number: number; participant: string;
      started_at: string; ended_at: string | null;
      exit_code: number | null; cost_usd: number | null; duration_ms: number | null;
    }>;

    // Get prompts from session records for dialogue reconstruction
    const turnDetails = turns.map(t => {
      // Read the prompt from the session record JSON if available
      let prompt: string | null = null;
      const recordRow = db.prepare(
        `SELECT record_path FROM sessions WHERE id = ?`,
      ).get(t.id) as { record_path: string | null } | undefined;

      if (recordRow?.record_path) {
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          const fullPath = path.join(home, recordRow.record_path);
          if (fs.existsSync(fullPath)) {
            const record = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            prompt = record.userPrompt ?? null;
          }
        } catch {
          // If we can't read the record, skip the prompt
        }
      }

      return {
        sessionId: t.id,
        turnNumber: t.turn_number,
        participant: t.participant,
        prompt,
        exitCode: t.exit_code,
        costUsd: t.cost_usd,
        durationMs: t.duration_ms,
        startedAt: t.started_at,
        endedAt: t.ended_at,
      };
    });

    // Metrics
    const metrics = db.prepare(
      `SELECT COUNT(*) as turn_count, COALESCE(SUM(cost_usd), 0) as total_cost
       FROM sessions WHERE conversation_id = ?`,
    ).get(conversationId) as { turn_count: number; total_cost: number };

    return {
      id: row.id,
      status: row.status,
      kind: row.kind,
      topic: row.topic,
      turnLimit: row.turn_limit,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      participants: parts,
      turnCount: metrics.turn_count,
      totalCostUsd: metrics.total_cost,
      turns: turnDetails,
    };
  } finally {
    db.close();
  }
}

// ── Convene Helpers ────────────────────────────────────────────────────

/**
 * Format a message for the next participant in a convene.
 *
 * Each anima has their own claude session via --resume. Their session
 * already contains their own prior messages and responses. We only
 * send them what happened since their last turn — the other
 * participants' contributions.
 *
 * On the first turn (no prior turns), returns the conversation topic.
 */
export function formatConveneMessage(
  home: string,
  conversationId: string,
  participantId: string,
): string {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    // Get the conversation topic
    const conv = db.prepare(
      `SELECT topic FROM conversations WHERE id = ?`,
    ).get(conversationId) as { topic: string | null } | undefined;

    // Find this participant's last turn number
    const participant = db.prepare(
      `SELECT name, anima_id FROM conversation_participants WHERE id = ?`,
    ).get(participantId) as { name: string; anima_id: string | null } | undefined;

    if (!participant?.anima_id) {
      return conv?.topic ?? '';
    }

    const lastTurn = db.prepare(
      `SELECT MAX(turn_number) as last_turn FROM sessions
       WHERE conversation_id = ? AND anima_id = ?`,
    ).get(conversationId, participant.anima_id) as { last_turn: number | null };

    if (lastTurn.last_turn === null) {
      // First turn for this participant — use the topic
      return conv?.topic ?? '';
    }

    // Get all turns since this participant's last turn
    const newTurns = db.prepare(
      `SELECT s.turn_number, a.name as participant_name, s.record_path
       FROM sessions s
       JOIN animas a ON a.id = s.anima_id
       WHERE s.conversation_id = ? AND s.turn_number > ?
       ORDER BY s.turn_number ASC`,
    ).all(conversationId, lastTurn.last_turn) as Array<{
      turn_number: number; participant_name: string; record_path: string | null;
    }>;

    if (newTurns.length === 0) {
      return conv?.topic ?? '';
    }

    // Build the message from session records
    const fs = require('node:fs');
    const path = require('node:path');

    const lines: string[] = [];
    for (const turn of newTurns) {
      let responseText = '[response not available]';
      if (turn.record_path) {
        try {
          const fullPath = path.join(home, turn.record_path);
          if (fs.existsSync(fullPath)) {
            const record = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            // Extract text from transcript
            const transcript = record.transcript as Array<Record<string, unknown>> | undefined;
            if (transcript) {
              const textParts: string[] = [];
              for (const msg of transcript) {
                if (msg.type === 'assistant') {
                  const message = msg.message as Record<string, unknown> | undefined;
                  const content = message?.content as Array<Record<string, unknown>> | undefined;
                  if (content) {
                    for (const block of content) {
                      if (block.type === 'text' && typeof block.text === 'string') {
                        textParts.push(block.text);
                      }
                    }
                  }
                }
              }
              if (textParts.length > 0) {
                responseText = textParts.join('');
              }
            }
          }
        } catch {
          // If we can't read the record, use placeholder
        }
      }
      lines.push(`[${turn.participant_name}]: ${responseText}`);
    }

    return lines.join('\n\n');
  } finally {
    db.close();
  }
}

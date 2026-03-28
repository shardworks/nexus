/**
 * Conversation API — the write/read API for conversations in nexus-sessions.
 *
 * Conversations group multiple sessions (turns) into a single logical
 * interaction. Two kinds:
 *   - consult — human talks to an anima (from dashboard or CLI)
 *   - convene — multiple animas hold a turn-limited dialogue
 *
 * State is fully persistent in the Books tables. The core primitive is
 * `takeTurn()` — reads conversation state, runs one turn through the session
 * funnel, and updates records. No in-memory state between turns.
 *
 * Library functions use raw SQLite against the Books tables for the same
 * reasons as session-api.ts: complex queries, aggregate metrics, and partial
 * updates (claude_session_id on participants) that the Books API doesn't support.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { manifest as assembleManifest } from '@shardworks/nexus-core';
import { openDb, SESSIONS_TABLE, CONVERSATIONS_TABLE, PARTICIPANTS_TABLE } from './db.ts';
import { launchSession } from './session-api.ts';
import type { SessionChunk, ResolvedWorkspace } from './session-api.ts';
import type { ConversationDoc, ParticipantDoc } from '../types.ts';

// ── ID generation ──────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

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
  /** Computed from sessions book. */
  turnCount: number;
  totalCostUsd: number;
}

/** Full detail view of a conversation including turns. */
export interface ConversationDetail extends ConversationSummary {
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

// ── Lifecycle functions ────────────────────────────────────────────────────

/**
 * Create a new conversation.
 *
 * Sets up conversation and participant records. Does NOT take a first
 * turn — that's a separate call to takeTurn().
 *
 * Anima participants are looked up by name at creation time to capture
 * the animaId. Manifesting happens at turn time, not creation time.
 */
export function createConversation(
  home: string,
  options: CreateConversationOptions,
): CreateConversationResult {
  const db = openDb(home);
  try {
    const conversationId = generateId('conv');
    const now = new Date().toISOString();

    const convDoc: ConversationDoc = {
      id: conversationId,
      status: 'active',
      kind: options.kind,
      topic: options.topic ?? null,
      turnLimit: options.turnLimit ?? null,
      createdAt: now,
      endedAt: null,
      eventId: options.eventId ?? null,
    };

    db.prepare(
      `INSERT INTO "${CONVERSATIONS_TABLE}" (id, content) VALUES (?, ?)`,
    ).run(conversationId, JSON.stringify(convDoc));

    const participants: Array<{ id: string; name: string; kind: string }> = [];

    for (const p of options.participants) {
      const participantId = generateId('cpart');

      // Look up animaId for anima participants from the animas table.
      // TODO: once nexus-roster is riggified, look up from the roster book.
      let animaId: string | null = null;
      if (p.kind === 'anima') {
        const row = db.prepare(
          `SELECT id FROM animas WHERE name = ? AND status = 'active'`,
        ).get(p.name) as { id: string } | undefined;
        if (row) {
          animaId = row.id;
        }
      }

      const partDoc: ParticipantDoc = {
        id: participantId,
        conversationId,
        kind: p.kind,
        name: p.name,
        animaId,
        claudeSessionId: null,
      };

      db.prepare(
        `INSERT INTO "${PARTICIPANTS_TABLE}" (id, content) VALUES (?, ?)`,
      ).run(participantId, JSON.stringify(partDoc));

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
 *   - No session launched. Returns immediately (human messages are passed
 *     as the prompt to the next anima's takeTurn call).
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
  const db = openDb(home);

  let convDoc: ConversationDoc;
  let partDoc: ParticipantDoc;
  let currentTurnCount: number;

  try {
    const convRow = db.prepare(
      `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
    ).get(conversationId) as { content: string } | undefined;

    if (!convRow) {
      throw new Error(`Conversation "${conversationId}" not found.`);
    }
    convDoc = JSON.parse(convRow.content) as ConversationDoc;

    if (convDoc.status !== 'active') {
      throw new Error(
        `Conversation "${conversationId}" is not active (status: ${convDoc.status}).`,
      );
    }

    const partRow = db.prepare(
      `SELECT content FROM "${PARTICIPANTS_TABLE}" WHERE id = ?`,
    ).get(participantId) as { content: string } | undefined;

    if (!partRow) {
      throw new Error(
        `Participant "${participantId}" not found in conversation "${conversationId}".`,
      );
    }
    partDoc = JSON.parse(partRow.content) as ParticipantDoc;

    // Verify participant belongs to this conversation
    if (partDoc.conversationId !== conversationId) {
      throw new Error(
        `Participant "${participantId}" does not belong to conversation "${conversationId}".`,
      );
    }

    // Count existing turns for this conversation
    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?`,
    ).get(conversationId) as { count: number };
    currentTurnCount = countRow.count;

    // Check turn limit
    if (convDoc.turnLimit !== null && currentTurnCount >= convDoc.turnLimit) {
      // Auto-conclude if at limit
      const updatedConv = { ...convDoc, status: 'concluded' as const, endedAt: new Date().toISOString() };
      db.prepare(
        `UPDATE "${CONVERSATIONS_TABLE}" SET content = ? WHERE id = ?`,
      ).run(JSON.stringify(updatedConv), conversationId);
      throw new Error(
        `Conversation "${conversationId}" has reached its turn limit (${convDoc.turnLimit}).`,
      );
    }
  } finally {
    db.close();
  }

  // 2. Human participants don't launch sessions
  if (partDoc.kind === 'human') {
    return;
  }

  // 3. Manifest the anima
  const animaManifest = await assembleManifest(home, partDoc.name);

  // 4. Determine turn number (1-indexed)
  const turnNumber = currentTurnCount + 1;

  // 5. Launch session through the funnel
  const workspace: ResolvedWorkspace = { kind: 'guildhall' };

  const collectedChunks: ConversationChunk[] = [];

  const sessionResult = await launchSession({
    home,
    manifest: animaManifest,
    prompt: message,
    interactive: false,
    workspace,
    trigger: convDoc.kind as 'consult' | 'convene',
    name: `${convDoc.kind}-${partDoc.name}-turn-${turnNumber}`,
    conversationId,
    turnNumber,
    claudeSessionId: partDoc.claudeSessionId ?? undefined,
    onChunk: (chunk) => {
      collectedChunks.push(chunk);
    },
  });

  // Yield all collected chunks
  for (const chunk of collectedChunks) {
    yield chunk;
  }

  // 6. Update participant's claudeSessionId for --resume on next turn
  if (sessionResult.providerSessionId) {
    const db2 = openDb(home);
    try {
      const trx = db2.transaction(() => {
        const partRow = db2.prepare(
          `SELECT content FROM "${PARTICIPANTS_TABLE}" WHERE id = ?`,
        ).get(participantId) as { content: string } | undefined;
        if (!partRow) return;
        const updated = { ...JSON.parse(partRow.content) as ParticipantDoc, claudeSessionId: sessionResult.providerSessionId };
        db2.prepare(
          `UPDATE "${PARTICIPANTS_TABLE}" SET content = ? WHERE id = ?`,
        ).run(JSON.stringify(updated), participantId);
      });
      trx();
    } finally {
      db2.close();
    }
  }

  // 7. Check if we've hit the turn limit after this turn
  if (convDoc.turnLimit !== null && turnNumber >= convDoc.turnLimit) {
    const db3 = openDb(home);
    try {
      const trx = db3.transaction(() => {
        const convRow = db3.prepare(
          `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
        ).get(conversationId) as { content: string } | undefined;
        if (!convRow) return;
        const updated = { ...JSON.parse(convRow.content) as ConversationDoc, status: 'concluded' as const, endedAt: new Date().toISOString() };
        db3.prepare(
          `UPDATE "${CONVERSATIONS_TABLE}" SET content = ? WHERE id = ?`,
        ).run(JSON.stringify(updated), conversationId);
      });
      trx();
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
 * browser disconnect, timeout). Idempotent — no error if already ended.
 */
export function endConversation(
  home: string,
  conversationId: string,
  reason: 'concluded' | 'abandoned' = 'concluded',
): void {
  const db = openDb(home);
  try {
    const trx = db.transaction(() => {
      const row = db.prepare(
        `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
      ).get(conversationId) as { content: string } | undefined;

      if (!row) {
        throw new Error(`Conversation "${conversationId}" not found.`);
      }

      const doc = JSON.parse(row.content) as ConversationDoc;
      if (doc.status !== 'active') {
        // Already ended — idempotent no-op
        return;
      }

      const updated: ConversationDoc = { ...doc, status: reason, endedAt: new Date().toISOString() };
      db.prepare(
        `UPDATE "${CONVERSATIONS_TABLE}" SET content = ? WHERE id = ?`,
      ).run(JSON.stringify(updated), conversationId);
    });
    trx();
  } finally {
    db.close();
  }
}

/**
 * Get the next participant in a convene rotation.
 *
 * Reads turn history and returns whose turn it is (round-robin by
 * participant insertion order). Returns null if conversation is not
 * active or turn limit reached.
 */
export function nextParticipant(
  home: string,
  conversationId: string,
): { participantId: string; name: string } | null {
  const db = openDb(home);
  try {
    const convRow = db.prepare(
      `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
    ).get(conversationId) as { content: string } | undefined;

    if (!convRow) return null;
    const conv = JSON.parse(convRow.content) as ConversationDoc;
    if (conv.status !== 'active') return null;

    // Count existing turns
    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?`,
    ).get(conversationId) as { count: number };

    if (conv.turnLimit !== null && countRow.count >= conv.turnLimit) return null;

    // Get anima participants in insertion order (by rowid — insertion order in Books)
    const partRows = db.prepare(
      `SELECT content, rowid FROM "${PARTICIPANTS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?
         AND json_extract(content, '$.kind') = 'anima'
       ORDER BY rowid ASC`,
    ).all(conversationId) as Array<{ content: string; rowid: number }>;

    if (partRows.length === 0) return null;

    // Round-robin: turn count mod participant count
    const nextIdx = countRow.count % partRows.length;
    const next = JSON.parse(partRows[nextIdx]!.content) as ParticipantDoc;
    return { participantId: next.id, name: next.name };
  } finally {
    db.close();
  }
}

// ── Dashboard read functions ───────────────────────────────────────────────

/**
 * List conversations with optional filters. Returns conversations ordered
 * by createdAt descending (newest first).
 */
export function listConversations(
  home: string,
  opts: ListConversationsOptions = {},
): ConversationSummary[] {
  const db = openDb(home);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      conditions.push(`json_extract(content, '$.status') = ?`);
      params.push(opts.status);
    }
    if (opts.kind) {
      conditions.push(`json_extract(content, '$.kind') = ?`);
      params.push(opts.kind);
    }

    let sql = `SELECT content FROM "${CONVERSATIONS_TABLE}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY json_extract(content, '$.createdAt') DESC, rowid DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as { content: string }[];

    return rows.map(row => {
      const conv = JSON.parse(row.content) as ConversationDoc;

      // Get participants
      const partRows = db.prepare(
        `SELECT content FROM "${PARTICIPANTS_TABLE}"
         WHERE json_extract(content, '$.conversationId') = ?`,
      ).all(conv.id) as { content: string }[];
      const parts = partRows.map(r => {
        const p = JSON.parse(r.content) as ParticipantDoc;
        return { id: p.id, name: p.name, kind: p.kind };
      });

      // Get turn count and total cost from sessions
      const metrics = db.prepare(
        `SELECT COUNT(*) as turn_count,
                COALESCE(SUM(CAST(json_extract(content, '$.costUsd') AS REAL)), 0) as total_cost
         FROM "${SESSIONS_TABLE}"
         WHERE json_extract(content, '$.conversationId') = ?`,
      ).get(conv.id) as { turn_count: number; total_cost: number };

      return {
        id: conv.id,
        status: conv.status,
        kind: conv.kind,
        topic: conv.topic,
        turnLimit: conv.turnLimit,
        createdAt: conv.createdAt,
        endedAt: conv.endedAt,
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
 * Turns are session docs ordered by turnNumber. Each turn includes the
 * prompt (read from the session record JSON on disk, where the human
 * message lives in a consult dialogue).
 */
export function showConversation(
  home: string,
  conversationId: string,
): ConversationDetail | null {
  const db = openDb(home);
  try {
    const convRow = db.prepare(
      `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
    ).get(conversationId) as { content: string } | undefined;

    if (!convRow) return null;
    const conv = JSON.parse(convRow.content) as ConversationDoc;

    // Get participants
    const partRows = db.prepare(
      `SELECT content FROM "${PARTICIPANTS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?`,
    ).all(conv.id) as { content: string }[];
    const parts = partRows.map(r => {
      const p = JSON.parse(r.content) as ParticipantDoc;
      return { id: p.id, name: p.name, kind: p.kind };
    });

    // Get session turns ordered by turnNumber
    const turnRows = db.prepare(
      `SELECT content FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?
       ORDER BY CAST(json_extract(content, '$.turnNumber') AS INTEGER) ASC`,
    ).all(conversationId) as { content: string }[];

    // Build a map from animaId → participant name for turn reconstruction
    const animaIdToName = new Map<string, string>(
      partRows
        .map(r => JSON.parse(r.content) as ParticipantDoc)
        .filter(p => p.animaId !== null)
        .map(p => [p.animaId as string, p.name] as [string, string]),
    );

    const turns = turnRows.map(r => {
      const s = JSON.parse(r.content) as import('../types.js').SessionDoc;

      // Read prompt from session record JSON if available
      let prompt: string | null = null;
      if (s.recordPath) {
        try {
          const fullPath = path.join(home, s.recordPath);
          if (fs.existsSync(fullPath)) {
            const record = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as { userPrompt?: string };
            prompt = record.userPrompt ?? null;
          }
        } catch {
          // If we can't read the record, skip the prompt
        }
      }

      // Resolve participant display name from animaId
      const participantName = animaIdToName.get(s.animaId) ?? s.animaId;

      return {
        sessionId: s.id,
        turnNumber: s.turnNumber ?? 0,
        participant: participantName,
        prompt,
        exitCode: s.exitCode,
        costUsd: s.costUsd,
        durationMs: s.durationMs,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      };
    });

    // Metrics
    const metrics = db.prepare(
      `SELECT COUNT(*) as turn_count,
              COALESCE(SUM(CAST(json_extract(content, '$.costUsd') AS REAL)), 0) as total_cost
       FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?`,
    ).get(conversationId) as { turn_count: number; total_cost: number };

    return {
      id: conv.id,
      status: conv.status,
      kind: conv.kind,
      topic: conv.topic,
      turnLimit: conv.turnLimit,
      createdAt: conv.createdAt,
      endedAt: conv.endedAt,
      participants: parts,
      turnCount: metrics.turn_count,
      totalCostUsd: metrics.total_cost,
      turns,
    };
  } finally {
    db.close();
  }
}

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
  const db = openDb(home);
  try {
    // Get conversation topic
    const convRow = db.prepare(
      `SELECT content FROM "${CONVERSATIONS_TABLE}" WHERE id = ?`,
    ).get(conversationId) as { content: string } | undefined;
    const conv = convRow ? JSON.parse(convRow.content) as ConversationDoc : null;

    // Get this participant's animaId
    const partRow = db.prepare(
      `SELECT content FROM "${PARTICIPANTS_TABLE}" WHERE id = ?`,
    ).get(participantId) as { content: string } | undefined;

    if (!partRow) {
      return conv?.topic ?? '';
    }
    const part = JSON.parse(partRow.content) as ParticipantDoc;

    if (!part.animaId) {
      return conv?.topic ?? '';
    }

    // Find this participant's last turn number
    const lastTurnRow = db.prepare(
      `SELECT MAX(CAST(json_extract(content, '$.turnNumber') AS INTEGER)) as last_turn
       FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?
         AND json_extract(content, '$.animaId') = ?`,
    ).get(conversationId, part.animaId) as { last_turn: number | null };

    if (lastTurnRow.last_turn === null) {
      // First turn — use the topic
      return conv?.topic ?? '';
    }

    // Get all turns since this participant's last turn
    const newTurnRows = db.prepare(
      `SELECT content FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?
         AND CAST(json_extract(content, '$.turnNumber') AS INTEGER) > ?
       ORDER BY CAST(json_extract(content, '$.turnNumber') AS INTEGER) ASC`,
    ).all(conversationId, lastTurnRow.last_turn) as { content: string }[];

    if (newTurnRows.length === 0) {
      return conv?.topic ?? '';
    }

    // Build the message by reading participant names and session records
    // Resolve animaId → participant name using participants book
    const allParts = db.prepare(
      `SELECT content FROM "${PARTICIPANTS_TABLE}"
       WHERE json_extract(content, '$.conversationId') = ?`,
    ).all(conversationId) as { content: string }[];
    const animaIdToName = new Map<string, string>(
      allParts.map(r => {
        const p = JSON.parse(r.content) as ParticipantDoc;
        return [p.animaId ?? '', p.name] as [string, string];
      }),
    );

    const lines: string[] = [];
    for (const r of newTurnRows) {
      const s = JSON.parse(r.content) as import('../types.js').SessionDoc;
      const participantName = animaIdToName.get(s.animaId) ?? s.animaId;
      let responseText = '[response not available]';

      if (s.recordPath) {
        try {
          const fullPath = path.join(home, s.recordPath);
          if (fs.existsSync(fullPath)) {
            const record = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as {
              transcript?: Array<Record<string, unknown>>;
            };
            if (record.transcript) {
              const textParts: string[] = [];
              for (const msg of record.transcript) {
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
          // Fall through to placeholder
        }
      }
      lines.push(`[${participantName}]: ${responseText}`);
    }

    return lines.join('\n\n');
  } finally {
    db.close();
  }
}

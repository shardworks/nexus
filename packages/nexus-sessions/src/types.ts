/**
 * Document types for the nexus-sessions plugin.
 *
 * These are the TypeScript shapes stored in Books (SQLite JSON documents).
 * All types satisfy the Books requirement that `id: string` is a top-level field.
 *
 * Conventions:
 *   snake_case → camelCase
 *   nullable string → string | null
 *   nullable number → number | null
 *   string arrays → string[] (stored as JSON array in the content blob)
 *
 * ─── Schema summary ───────────────────────────────────────────────────────────
 *
 * Books owned by this plugin:
 *
 * sessions (6 indexes: animaId, writId, conversationId, workshop, trigger, startedAt)
 *   - id, animaId, provider, trigger, workshop, workspaceKind,
 *     curriculumName, curriculumVersion, temperamentName, temperamentVersion,
 *     roles, startedAt, endedAt, exitCode, inputTokens, outputTokens,
 *     cacheReadTokens, cacheWriteTokens, costUsd, durationMs,
 *     providerSessionId, recordPath, writId, conversationId, turnNumber
 *
 * conversations (3 indexes: status, kind, createdAt)
 *   - id, status, kind, topic, turnLimit, createdAt, endedAt, eventId
 *
 * participants (2 indexes: conversationId, animaId)
 *   - id, conversationId, kind, name, animaId, claudeSessionId
 *
 * Cross-subsystem references (string IDs, no FK enforcement in Books):
 *   sessions.animaId  → animas (nexus-roster, not yet riggified)
 *   sessions.writId   → writs (nexus-writs, not yet riggified)
 *   participants.animaId → animas (nexus-roster, not yet riggified)
 *
 * Events signalled (via signalEvent from nexus-core):
 *   session.started       — when a session doc is first inserted
 *   session.ended         — when a session doc is updated at completion
 *   session.record-failed — when session doc write fails
 *
 * Framework callers:
 *   launchSession()           — summon engine, consult CLI, convene CLI
 *   registerSessionProvider() — mcp-server.ts, clock-daemon.ts (startup)
 *   getSessionProvider()      — summon engine
 *   resolveWorkspace()        — summon engine
 *   countSessionsForWrit()    — summon engine (circuit breaker)
 *   createConversation()      — convene tool, convene CLI
 *   takeTurn()                — convene tool, convene CLI
 *   nextParticipant()         — convene tool, convene CLI
 *   formatConveneMessage()    — convene tool, convene CLI
 *   showConversation()        — convene tool, convene CLI
 */

// ── Session document ───────────────────────────────────────────────────────

/**
 * A single session in the guild.
 *
 * Stored in the `sessions` book. Represents one invocation of an anima
 * through the session funnel.
 */
export interface SessionDoc {
  /** Prefixed ID, e.g. "ses-a3f7b2c1". */
  id: string;
  /** ID of the anima that ran this session. Indexed. */
  animaId: string;
  /** Session provider name, e.g. "claude-code". */
  provider: string;
  /** What triggered the session: "consult" | "summon" | "brief" | "convene". Indexed. */
  trigger: string;
  /** Workshop name, if the session ran in a workshop workspace. Indexed. */
  workshop: string | null;
  /** Workspace kind: "guildhall" | "workshop-temp" | "workshop-managed". */
  workspaceKind: string;
  /** Curriculum name at session time (snapshot). */
  curriculumName: string | null;
  /** Curriculum version at session time. */
  curriculumVersion: string | null;
  /** Temperament name at session time. */
  temperamentName: string | null;
  /** Temperament version at session time. */
  temperamentVersion: string | null;
  /** Roles the anima held during this session. */
  roles: string[];
  /** ISO-8601 start time. Indexed. */
  startedAt: string;
  /** ISO-8601 end time. Null while session is active. */
  endedAt: string | null;
  /** Exit code from the provider. Null while active. */
  exitCode: number | null;
  /** Input token count from the provider. */
  inputTokens: number | null;
  /** Output token count from the provider. */
  outputTokens: number | null;
  /** Cache read token count. */
  cacheReadTokens: number | null;
  /** Cache write token count. */
  cacheWriteTokens: number | null;
  /** Cost in USD. */
  costUsd: number | null;
  /** Wall-clock duration in milliseconds. */
  durationMs: number | null;
  /** Session ID from the provider (e.g. claude session ID for --resume). */
  providerSessionId: string | null;
  /** Relative path (from guild root) to the session record JSON. */
  recordPath: string | null;
  /** Bound writ ID, if any. Indexed. */
  writId: string | null;
  /** Conversation ID, if this session is a turn. Indexed. */
  conversationId: string | null;
  /** Turn number within the conversation (1-indexed). */
  turnNumber: number | null;
}

// ── Conversation document ──────────────────────────────────────────────────

/**
 * A multi-turn conversation between participants.
 *
 * Stored in the `conversations` book. Groups multiple sessions (turns) into
 * a single logical interaction. Kind is either "consult" (human + anima) or
 * "convene" (anima + anima).
 */
export interface ConversationDoc {
  /** Prefixed ID, e.g. "conv-a3f7b2c1". */
  id: string;
  /** Lifecycle status. Indexed. */
  status: 'active' | 'concluded' | 'abandoned';
  /** Conversation kind. Indexed. */
  kind: 'consult' | 'convene';
  /** Seed topic or prompt. */
  topic: string | null;
  /** Maximum allowed turns. Null = unlimited. */
  turnLimit: number | null;
  /** ISO-8601 creation time. Indexed. */
  createdAt: string;
  /** ISO-8601 end time. */
  endedAt: string | null;
  /** Triggering event ID, for convene sessions started by clockworks. */
  eventId: string | null;
}

// ── Participant document ───────────────────────────────────────────────────

/**
 * A participant in a conversation.
 *
 * Stored in the `participants` book. One document per participant per
 * conversation. For anima participants, `animaId` and `claudeSessionId`
 * track the anima identity and the running claude session for --resume.
 */
export interface ParticipantDoc {
  /** Prefixed ID, e.g. "cpart-a3f7b2c1". */
  id: string;
  /** Parent conversation ID. Indexed. */
  conversationId: string;
  /** Participant kind. */
  kind: 'anima' | 'human';
  /** Participant display name. */
  name: string;
  /** Anima ID for anima participants. Indexed. */
  animaId: string | null;
  /**
   * Claude session ID for --resume. Updated after each turn so the next
   * turn can continue the conversation context.
   */
  claudeSessionId: string | null;
}

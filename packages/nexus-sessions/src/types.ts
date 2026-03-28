/**
 * Document types for the nexus-sessions rig.
 *
 * These are the TypeScript shapes stored in the Books (SQLite JSON documents).
 * All types satisfy the Books requirement that `id: string` is a top-level field.
 *
 * SQL → TypeScript conventions:
 *   snake_case → camelCase
 *   TEXT NOT NULL DEFAULT (datetime('now')) → string (ISO-8601)
 *   TEXT nullable → string | null
 *   INTEGER nullable → number | null
 *   REAL nullable → number | null
 *   TEXT (JSON-serialized array) → string[] (deserialized on read, serialized on write)
 *
 * ─── Pre-flight analysis ──────────────────────────────────────────────────────
 *
 * Tables owned by this subsystem:
 *
 * sessions (001-schema.sql + ALTER in 002-writs.sql + ALTER in 003-conversations.sql)
 *   - id, anima_id, provider, model, trigger, workshop, workspace_kind,
 *     curriculum_name, curriculum_version, temperament_name, temperament_version,
 *     roles (JSON text), started_at, ended_at, exit_code, input_tokens,
 *     output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
 *     provider_session_id, record_path, writ_id, conversation_id, turn_number
 *
 * conversations (003-conversations.sql)
 *   - id, status, kind, topic, turn_limit, created_at, ended_at, event_id
 *
 * conversation_participants (003-conversations.sql)
 *   - id, conversation_id, kind, name, anima_id, claude_session_id
 *
 * Denormalization strategy:
 *
 * sessions → flat table, no joins needed (anima_id is a plain string ref)
 *   Strategy: none (already flat). Stored as SessionDoc.
 *
 * conversations → flat table, no joins within this subsystem
 *   Strategy: none. Stored as ConversationDoc.
 *
 * conversation_participants → one-to-many with conversations; queried by
 *   conversationId independently; updated individually (claude_session_id).
 *   Strategy B — separate `participants` book with conversationId indexed.
 *
 * Cross-subsystem references (string-only, no FK enforcement in Books):
 *   sessions.anima_id → animas (nexus-roster, future)
 *   sessions.writ_id → writs (nexus-writs, future)
 *   participants.anima_id → animas (nexus-roster, future)
 *
 * Query patterns:
 *   sessions: filter by animaId, writId, conversationId, workshop, trigger, status
 *     (active = no endedAt, completed = has endedAt), order by startedAt desc
 *   conversations: filter by status, kind, order by createdAt desc
 *   participants: filter by conversationId, animaId
 *
 * Events signalled (via signalEvent from nexus-core):
 *   session.started — when a session row is inserted
 *   session.ended   — when a session row is updated at end
 *   session.record-failed — when session row write fails
 *
 * Framework dependencies:
 *   launchSession()           — called by summon engine, consult CLI, convene CLI
 *   registerSessionProvider() — called at startup by mcp-server.ts, clock-daemon.ts
 *   getSessionProvider()      — called by summon.ts engine
 *   resolveWorkspace()        — called by summon.ts engine
 *   countSessionsForWrit()    — called by summon.ts engine (circuit breaker)
 *   createConversation()      — called by convene tool, convene CLI
 *   takeTurn()                — called by convene tool, convene CLI
 *   nextParticipant()         — called by convene tool, convene CLI
 *   formatConveneMessage()    — called by convene tool, convene CLI
 *   showConversation()        — called by convene tool, convene CLI
 */

// ── Session document ───────────────────────────────────────────────────────

/**
 * A single session in the guild.
 *
 * Stored in the `sessions` book. Represents one invocation of an anima
 * through the session funnel.
 *
 * Maps from legacy SQL tables: `sessions` (core), with columns added by
 * migrations 002-writs.sql and 003-conversations.sql.
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
 *
 * Maps from legacy SQL table: `conversations` (003-conversations.sql).
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
 *
 * Maps from legacy SQL table: `conversation_participants` (003-conversations.sql).
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

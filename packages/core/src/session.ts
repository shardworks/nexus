/**
 * Session infrastructure — the unified session funnel.
 *
 * ALL sessions (interactive, commissioned, briefed) flow through
 * `launchSession()`. This provides unified logging, events, metrics,
 * workspace lifecycle, and session record persistence.
 *
 * Session providers (e.g. claude-code, claude-api) implement the
 * `SessionProvider` interface and are registered at startup.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { booksPath, nexusDir, workshopBarePath } from './nexus-home.ts';
import { generateId } from './id.ts';
import { signalEvent } from './events.ts';
import type { ManifestResult } from './manifest.ts';

// ── Dashboard Read Types ────────────────────────────────────────────────

/** Summary view of a session — for list views. */
export interface SessionSummary {
  id: string;
  animaId: string;
  provider: string;
  trigger: string;
  workshop: string | null;
  workspaceKind: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

/** Full session detail — all columns from the sessions table. */
export interface SessionDetail {
  id: string;
  animaId: string;
  provider: string;
  trigger: string;
  workshop: string | null;
  workspaceKind: string;
  curriculumName: string | null;
  curriculumVersion: string | null;
  temperamentName: string | null;
  temperamentVersion: string | null;
  roles: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  providerSessionId: string | null;
  recordPath: string | null;
}

export interface ListSessionsOptions {
  anima?: string;
  workshop?: string;
  trigger?: string;
  /** Filter by active (no ended_at) or completed (has ended_at). */
  status?: 'active' | 'completed';
  /** Filter by bound writ ID. */
  writId?: string;
  /** Maximum number of results. */
  limit?: number;
}

// ── Dashboard Read Functions ────────────────────────────────────────────

/**
 * List sessions with optional filters.
 */
export function listSessions(home: string, opts: ListSessionsOptions = {}): SessionSummary[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT s.id, s.anima_id, s.provider, s.trigger, s.workshop, s.workspace_kind,
                        s.started_at, s.ended_at, s.exit_code, s.cost_usd, s.duration_ms
                 FROM sessions s`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.anima) {
      query = `SELECT s.id, s.anima_id, s.provider, s.trigger, s.workshop, s.workspace_kind,
                      s.started_at, s.ended_at, s.exit_code, s.cost_usd, s.duration_ms
               FROM sessions s JOIN animas a ON a.id = s.anima_id`;
      conditions.push(`(a.name = ? OR a.id = ?)`);
      params.push(opts.anima, opts.anima);
    }

    if (opts.workshop) {
      conditions.push(`s.workshop = ?`);
      params.push(opts.workshop);
    }

    if (opts.trigger) {
      conditions.push(`s.trigger = ?`);
      params.push(opts.trigger);
    }

    if (opts.writId) {
      conditions.push(`s.writ_id = ?`);
      params.push(opts.writId);
    }

    if (opts.status === 'active') {
      conditions.push(`s.ended_at IS NULL`);
    } else if (opts.status === 'completed') {
      conditions.push(`s.ended_at IS NOT NULL`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY s.started_at DESC`;

    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; anima_id: string; provider: string; trigger: string;
      workshop: string | null; workspace_kind: string; started_at: string;
      ended_at: string | null; exit_code: number | null;
      cost_usd: number | null; duration_ms: number | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      animaId: r.anima_id,
      provider: r.provider,
      trigger: r.trigger,
      workshop: r.workshop,
      workspaceKind: r.workspace_kind,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      exitCode: r.exit_code,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
    }));
  } finally {
    db.close();
  }
}

/**
 * Count sessions bound to a given writ. Used by circuit breakers to cap
 * retry attempts without fetching full session rows.
 */
export function countSessionsForWrit(home: string, writId: string): number {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as n FROM sessions WHERE writ_id = ?',
    ).get(writId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/**
 * Show full details for a single session.
 */
export function showSession(home: string, sessionId: string): SessionDetail | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT id, anima_id, provider, trigger, workshop, workspace_kind,
              curriculum_name, curriculum_version, temperament_name, temperament_version,
              roles, started_at, ended_at, exit_code,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_usd, duration_ms, provider_session_id, record_path
       FROM sessions WHERE id = ?`,
    ).get(sessionId) as {
      id: string; anima_id: string; provider: string; trigger: string;
      workshop: string | null; workspace_kind: string;
      curriculum_name: string | null; curriculum_version: string | null;
      temperament_name: string | null; temperament_version: string | null;
      roles: string | null; started_at: string; ended_at: string | null;
      exit_code: number | null; input_tokens: number | null;
      output_tokens: number | null; cache_read_tokens: number | null;
      cache_write_tokens: number | null; cost_usd: number | null;
      duration_ms: number | null; provider_session_id: string | null;
      record_path: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      animaId: row.anima_id,
      provider: row.provider,
      trigger: row.trigger,
      workshop: row.workshop,
      workspaceKind: row.workspace_kind,
      curriculumName: row.curriculum_name,
      curriculumVersion: row.curriculum_version,
      temperamentName: row.temperament_name,
      temperamentVersion: row.temperament_version,
      roles: row.roles ? JSON.parse(row.roles) : [],
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      providerSessionId: row.provider_session_id,
      recordPath: row.record_path,
    };
  } finally {
    db.close();
  }
}

// ── Types ──────────────────────────────────────────────────────────────

/** A chunk emitted during streaming session output. */
export type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };

/** What a session provider must implement. */
export interface SessionProvider {
  /** Provider identifier (e.g. "claude-code", "claude-api", "bedrock"). */
  name: string;
  /** Launch a session and return when it completes. */
  launch(options: SessionProviderLaunchOptions): Promise<SessionProviderResult>;
  /**
   * Launch a session with streaming output.
   *
   * Returns an async iterable of chunks for real-time output AND a promise
   * for the final result. Used by conversation turns to stream responses
   * to the dashboard while still capturing the full result for the funnel.
   *
   * Optional — providers that don't support streaming just omit this.
   * The conversation system falls back to launch() (no streaming, just
   * the final result).
   */
  launchStreaming?(options: SessionProviderLaunchOptions): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}

/** Options passed to the provider's launch() — provider-specific subset. */
export interface SessionProviderLaunchOptions {
  /** Guild root path. */
  home: string;
  /** The manifest result — system prompt + resolved tools. */
  manifest: ManifestResult;
  /** The user-facing prompt (commission spec, consultation topic, brief). */
  prompt: string | null;
  /** Whether the session is interactive (human at keyboard) or autonomous. */
  interactive: boolean;
  /** Resolved working directory for the session. */
  cwd: string;
  /** Display name for tracking. */
  name?: string;
  /** Budget cap, if any. */
  maxBudgetUsd?: number;
  /**
   * Claude session ID to resume. When provided, the provider uses --resume
   * to continue an existing conversation instead of starting fresh.
   */
  claudeSessionId?: string;
}

/** What comes back from the provider (before the funnel adds its own fields). */
export interface SessionProviderResult {
  exitCode: number;
  /** Provider-reported token usage, if available. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Provider-reported cost in USD, if available. */
  costUsd?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Session ID from the provider, if available (e.g. claude session ID). */
  providerSessionId?: string;
  /**
   * Full conversation transcript — raw provider output, minimally typed.
   * Stored as-is in the session record; typed normalization deferred.
   */
  transcript?: Record<string, unknown>[];
}

/** Everything needed to launch a session through the funnel. */
export interface SessionLaunchOptions {
  /** Guild root path. */
  home: string;
  /** The manifest result — system prompt + resolved tools. */
  manifest: ManifestResult;
  /** The user-facing prompt (commission spec, consultation topic, brief). */
  prompt: string | null;
  /** Whether the session is interactive (human at keyboard) or autonomous. */
  interactive: boolean;
  /** Workspace context. */
  workspace: ResolvedWorkspace;
  /** What triggered this session. */
  trigger: 'consult' | 'summon' | 'brief' | 'convene';
  /** Display name for tracking. */
  name?: string;
  /** Budget cap, if any. */
  maxBudgetUsd?: number;
  /** Bound writ ID, if any. Set by clockworks for writ-driven sessions. */
  writId?: string;
  /**
   * Pre-generated session ID. If provided, launchSession uses this instead of
   * generating one internally. This allows callers to bind resources (e.g. writs)
   * to the session ID before the provider launches.
   */
  sessionId?: string;
  /** Conversation ID, if this session is a turn in a conversation. */
  conversationId?: string;
  /** Turn number within the conversation (1-indexed). */
  turnNumber?: number;
  /**
   * Claude session ID to resume. Passed through to the provider for
   * --resume support in multi-turn conversations.
   */
  claudeSessionId?: string;
  /**
   * Callback for streaming chunks during the session. When provided and
   * the provider supports launchStreaming(), chunks are forwarded here
   * as they arrive.
   */
  onChunk?: (chunk: SessionChunk) => void;
  /**
   * Additional content appended to the system prompt after manifest assembly.
   * Used by clockworks to inject session protocol (e.g. writ completion requirements).
   * Keeps dispatch concerns separate from manifest (identity).
   */
  systemPromptAppendix?: string;
}

/** What the funnel returns to callers. */
export interface SessionResult {
  /** Ledger row ID — written by the funnel before provider launch. */
  sessionId: string;
  exitCode: number;
  /** Provider-reported token usage, if available. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Provider-reported cost in USD, if available. */
  costUsd?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Session ID from the provider, if available. */
  providerSessionId?: string;
  /** Raw transcript from the provider. */
  transcript?: Record<string, unknown>[];
  /** Bound writ ID, if any. */
  writId?: string;
  /** Conversation ID, if this session is a turn in a conversation. */
  conversationId?: string;
  /** Turn number within the conversation. */
  turnNumber?: number;
}

/**
 * Standard optional fields on event payloads. Any event can carry these.
 * The session launcher inspects the triggering event's payload and uses
 * them to determine the working directory for the session.
 */
export interface WorkspaceContext {
  /** Workshop name — session gets a fresh temporary worktree of main. */
  workshop?: string;
  /** Explicit worktree path — used as-is (caller owns the lifecycle). */
  worktreePath?: string;
}

/** The resolved working directory for a session. */
export type ResolvedWorkspace =
  | { kind: 'guildhall' }
  | { kind: 'workshop-temp'; workshop: string; worktreePath: string }
  | { kind: 'workshop-managed'; workshop: string; worktreePath: string };

/** Full session record written to disk as JSON. */
export interface SessionRecord {
  /** Ledger session row ID (for cross-reference). */
  sessionId: string;
  /** The anima that ran this session, with full composition provenance. */
  anima: {
    id: string;
    name: string;
    roles: string[];
    codex: string;
    roleInstructions: string;
    curriculum: { name: string; version: string; content: string } | null;
    temperament: { name: string; version: string; content: string } | null;
    toolInstructions: Array<{ toolName: string; instructions: string }>;
  };
  /** The final assembled system prompt. */
  systemPrompt: string;
  /** Tools available to the anima. */
  tools: Array<{ name: string }>;
  /** Tools that were resolved but failed preconditions. */
  unavailableTools: Array<{ name: string; reasons: string[] }>;
  /** The user-facing prompt. */
  userPrompt: string | null;
  /** Raw conversation transcript from the provider. */
  transcript: Record<string, unknown>[];
}

// ── Provider Registration ──────────────────────────────────────────────

let _provider: SessionProvider | null = null;

/**
 * Register a session provider. Called once at startup.
 */
export function registerSessionProvider(provider: SessionProvider): void {
  _provider = provider;
}

/** Get the registered session provider. */
export function getSessionProvider(): SessionProvider | null {
  return _provider;
}

// ── Workspace Helpers ──────────────────────────────────────────────────

/**
 * Resolve workspace context from an event payload's standard fields.
 */
export function resolveWorkspace(
  payload: Record<string, unknown> | null,
): ResolvedWorkspace {
  if (!payload) return { kind: 'guildhall' };

  const worktreePath = payload.worktreePath as string | undefined;
  const workshop = payload.workshop as string | undefined;

  if (worktreePath && workshop) {
    return { kind: 'workshop-managed', workshop, worktreePath };
  }

  if (workshop) {
    // workshop-temp: worktreePath gets set by createTempWorktree before launch
    // We return a placeholder — the funnel fills in the actual path
    return { kind: 'workshop-temp', workshop, worktreePath: '' };
  }

  return { kind: 'guildhall' };
}

/**
 * Create a temporary worktree from a workshop's bare repo, checked out to main.
 *
 * Uses a crypto-safe random hash for the directory name. The worktree is
 * a fresh snapshot — no branch management, no merge-back lifecycle.
 *
 * @returns Absolute path to the worktree directory.
 */
export function createTempWorktree(home: string, workshop: string): string {
  const hash = crypto.randomBytes(8).toString('hex');
  const worktreeDir = path.join(nexusDir(home), 'worktrees', workshop, hash);
  const barePath = workshopBarePath(home, workshop);

  if (!fs.existsSync(barePath)) {
    throw new Error(
      `Workshop "${workshop}" bare repo not found at ${barePath}. ` +
      `Has the workshop been added with 'nsg workshop add'?`,
    );
  }

  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, 'main'], {
    cwd: barePath,
    stdio: 'pipe',
  });

  return worktreeDir;
}

/**
 * Remove a temporary worktree.
 *
 * Logs but does not throw on failure — stale worktrees are assumed to be
 * reaped by a separate mechanism.
 */
export function removeTempWorktree(home: string, workshop: string, worktreePath: string): void {
  const barePath = workshopBarePath(home, workshop);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: barePath,
      stdio: 'pipe',
    });
  } catch (err) {
    console.error(
      `[session] Warning: failed to remove temp worktree ${worktreePath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Session Record Helpers ─────────────────────────────────────────────

/** Path to the sessions directory. */
function sessionsDir(home: string): string {
  return path.join(nexusDir(home), 'sessions');
}

/**
 * Build a SessionRecord from the manifest and provider result.
 */
function buildSessionRecord(
  sessionId: string,
  manifest: ManifestResult,
  prompt: string | null,
  providerResult: SessionProviderResult | null,
): SessionRecord {
  return {
    sessionId,
    anima: {
      id: manifest.anima.id,
      name: manifest.anima.name,
      roles: manifest.anima.roles,
      codex: manifest.composition.codex,
      roleInstructions: manifest.composition.roleInstructions,
      curriculum: manifest.composition.curriculum,
      temperament: manifest.composition.temperament,
      toolInstructions: manifest.composition.toolInstructions,
    },
    systemPrompt: manifest.systemPrompt,
    tools: manifest.tools.map(t => ({ name: t.name })),
    unavailableTools: manifest.unavailable,
    userPrompt: prompt,
    transcript: providerResult?.transcript ?? [],
  };
}

/**
 * Write a session record to disk.
 * @returns The relative record_path (relative to guild root).
 */
function writeSessionRecord(home: string, record: SessionRecord): string {
  const dir = sessionsDir(home);
  fs.mkdirSync(dir, { recursive: true });

  const uuid = crypto.randomUUID();
  const filename = `${uuid}.json`;
  const fullPath = path.join(dir, filename);
  const relativePath = path.relative(home, fullPath);

  fs.writeFileSync(fullPath, JSON.stringify(record, null, 2));
  return relativePath;
}

// ── Daybook Helpers ────────────────────────────────────────────────────

/**
 * Insert a session.started row in the Daybook.
 * @returns The session row ID.
 */
function insertSessionRow(
  home: string,
  opts: {
    sessionId?: string;
    animaId: string;
    provider: string;
    trigger: string;
    workshop: string | null;
    workspaceKind: string;
    curriculumName: string | null;
    curriculumVersion: string | null;
    temperamentName: string | null;
    temperamentVersion: string | null;
    roles: string[];
    startedAt: string;
    writId?: string;
    conversationId?: string;
    turnNumber?: number;
  },
): string {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const id = opts.sessionId ?? generateId('ses');
    db.prepare(
      `INSERT INTO sessions (id, anima_id, provider, trigger, workshop, workspace_kind,
        curriculum_name, curriculum_version, temperament_name, temperament_version,
        roles, started_at, writ_id, conversation_id, turn_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.animaId,
      opts.provider,
      opts.trigger,
      opts.workshop,
      opts.workspaceKind,
      opts.curriculumName,
      opts.curriculumVersion,
      opts.temperamentName,
      opts.temperamentVersion,
      JSON.stringify(opts.roles),
      opts.startedAt,
      opts.writId ?? null,
      opts.conversationId ?? null,
      opts.turnNumber ?? null,
    );
    return id;
  } finally {
    db.close();
  }
}

/**
 * Update a session row with end-of-session data.
 */
function updateSessionRow(
  home: string,
  sessionId: string,
  opts: {
    endedAt: string;
    exitCode: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    durationMs?: number;
    providerSessionId?: string;
    recordPath?: string;
  },
): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    db.prepare(
      `UPDATE sessions SET
        ended_at = ?, exit_code = ?,
        input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?,
        cost_usd = ?, duration_ms = ?,
        provider_session_id = ?, record_path = ?
       WHERE id = ?`,
    ).run(
      opts.endedAt,
      opts.exitCode,
      opts.inputTokens ?? null,
      opts.outputTokens ?? null,
      opts.cacheReadTokens ?? null,
      opts.cacheWriteTokens ?? null,
      opts.costUsd ?? null,
      opts.durationMs ?? null,
      opts.providerSessionId ?? null,
      opts.recordPath ?? null,
      sessionId,
    );
  } finally {
    db.close();
  }
}

// ── The Session Funnel ─────────────────────────────────────────────────

/**
 * Launch a session through the registered provider.
 *
 * This is THE code path for all sessions. It:
 * 1. If workspace is workshop-temp: create fresh worktree from main
 * 2. Records session.started in the Daybook → gets sessionId
 * 3. Signals session.started event
 * 4. Delegates to the provider (passing resolved cwd)
 * 5. Records session.ended in the Daybook (with metrics)
 * 6. Writes the SessionRecord JSON to .nexus/sessions/{uuid}.json
 * 7. Signals session.ended event (with full metrics + sessionId in payload)
 * 8. If workspace is workshop-temp AND session is autonomous: tear down the worktree
 *    (interactive sessions leave the worktree for manual cleanup)
 * 9. Returns the result (including sessionId)
 *
 * Error handling guarantee: Steps 5–8 MUST execute even if the provider
 * throws. The funnel wraps step 4 in try/finally. If the provider crashes,
 * the session row still gets ended_at, exit_code, and the session.ended
 * event still fires (with error details in the payload). If the funnel
 * itself fails during recording (e.g. Ledger locked), it signals
 * session.record-failed as a core event and continues with remaining
 * cleanup steps. Worktree teardown failures are logged but do not throw —
 * stale worktrees are assumed to be reaped by a separate mechanism.
 */
export async function launchSession(options: SessionLaunchOptions): Promise<SessionResult> {
  if (!_provider) {
    throw new Error(
      'No session provider registered. Call registerSessionProvider() at startup.',
    );
  }

  const { home, prompt, interactive, trigger, name, maxBudgetUsd, writId,
    sessionId: preGeneratedSessionId,
    conversationId, turnNumber, claudeSessionId, onChunk, systemPromptAppendix } = options;

  // Apply system prompt appendix (e.g. writ protocol) if provided.
  // This keeps dispatch concerns (clockworks) separate from identity (manifest).
  const manifest = systemPromptAppendix
    ? { ...options.manifest, systemPrompt: options.manifest.systemPrompt + '\n\n' + systemPromptAppendix }
    : options.manifest;
  let { workspace } = options;

  // Step 1: If workshop-temp, create fresh worktree
  if (workspace.kind === 'workshop-temp') {
    const worktreePath = createTempWorktree(home, workspace.workshop);
    workspace = { ...workspace, worktreePath };
  }

  // Resolve cwd from workspace
  const cwd = workspace.kind === 'guildhall'
    ? home
    : workspace.worktreePath;

  const startedAt = new Date().toISOString();

  // Derive workshop name from workspace
  const workshopName = workspace.kind === 'guildhall' ? null : workspace.workshop;

  // Step 2: Record session.started in the Daybook
  let sessionId: string;
  try {
    sessionId = insertSessionRow(home, {
      sessionId: preGeneratedSessionId,
      animaId: manifest.anima.id,
      provider: _provider.name,
      trigger,
      workshop: workshopName,
      workspaceKind: workspace.kind,
      curriculumName: manifest.composition.curriculum?.name ?? null,
      curriculumVersion: manifest.composition.curriculum?.version ?? null,
      temperamentName: manifest.composition.temperament?.name ?? null,
      temperamentVersion: manifest.composition.temperament?.version ?? null,
      roles: manifest.anima.roles,
      startedAt,
      writId,
      conversationId,
      turnNumber,
    });
  } catch (err) {
    // If we can't even write the session row, signal failure and abort
    try {
      signalEvent(home, 'session.record-failed', {
        error: err instanceof Error ? err.message : String(err),
        phase: 'insert',
        anima: manifest.anima.name,
      }, 'framework');
    } catch { /* swallow — best effort */ }
    throw err;
  }

  // Step 3: Signal session.started event
  try {
    signalEvent(home, 'session.started', {
      sessionId,
      anima: manifest.anima.name,
      trigger,
      workshop: workshopName,
      workspaceKind: workspace.kind,
    }, 'framework');
  } catch { /* swallow — event signalling is best-effort */ }

  // Step 4: Delegate to the provider (wrapped in try/finally for guarantees)
  let providerResult: SessionProviderResult | null = null;
  let providerError: Error | null = null;

  try {
    const launchOpts: SessionProviderLaunchOptions = {
      home,
      manifest,
      prompt,
      interactive,
      cwd,
      name,
      maxBudgetUsd,
      claudeSessionId,
    };

    // Use streaming provider if available and caller wants chunks
    if (onChunk && _provider.launchStreaming) {
      const { chunks, result } = _provider.launchStreaming(launchOpts);
      for await (const chunk of chunks) {
        onChunk(chunk);
      }
      providerResult = await result;
    } else {
      providerResult = await _provider.launch(launchOpts);
    }
  } catch (err) {
    providerError = err instanceof Error ? err : new Error(String(err));
  }

  // Steps 5–8: Always execute, even if the provider threw
  const endedAt = new Date().toISOString();
  const exitCode = providerResult?.exitCode ?? 1;
  const durationMs = providerResult?.durationMs ?? (Date.now() - new Date(startedAt).getTime());

  // Step 5: Update session row in Ledger
  let recordPath: string | undefined;
  try {
    // Step 6: Write SessionRecord JSON
    const record = buildSessionRecord(sessionId, manifest, prompt, providerResult);
    recordPath = writeSessionRecord(home, record);
  } catch (err) {
    try {
      signalEvent(home, 'session.record-failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        phase: 'write-record',
      }, 'framework');
    } catch { /* swallow */ }
  }

  try {
    updateSessionRow(home, sessionId, {
      endedAt,
      exitCode,
      inputTokens: providerResult?.tokenUsage?.inputTokens,
      outputTokens: providerResult?.tokenUsage?.outputTokens,
      cacheReadTokens: providerResult?.tokenUsage?.cacheReadTokens,
      cacheWriteTokens: providerResult?.tokenUsage?.cacheWriteTokens,
      costUsd: providerResult?.costUsd,
      durationMs,
      providerSessionId: providerResult?.providerSessionId,
      recordPath,
    });
  } catch (err) {
    try {
      signalEvent(home, 'session.record-failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        phase: 'update-row',
      }, 'framework');
    } catch { /* swallow */ }
  }

  // Step 7: Signal session.ended event
  try {
    signalEvent(home, 'session.ended', {
      sessionId,
      anima: manifest.anima.name,
      trigger,
      workshop: workshopName,
      exitCode,
      durationMs,
      costUsd: providerResult?.costUsd ?? null,
      error: providerError?.message ?? null,
    }, 'framework');
  } catch { /* swallow */ }

  // Step 8: Teardown temp worktree (autonomous only)
  if (workspace.kind === 'workshop-temp' && !interactive) {
    removeTempWorktree(home, workspace.workshop, workspace.worktreePath);
  }

  // Step 9: Return result
  if (providerError && !providerResult) {
    // Provider threw without returning — re-throw so caller knows
    throw providerError;
  }

  return {
    sessionId,
    exitCode,
    tokenUsage: providerResult?.tokenUsage,
    costUsd: providerResult?.costUsd,
    durationMs,
    providerSessionId: providerResult?.providerSessionId,
    transcript: providerResult?.transcript,
    writId,
    conversationId,
    turnNumber,
  };
}

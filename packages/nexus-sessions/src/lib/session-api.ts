/**
 * Session API — the write/read API for the nexus-sessions rig.
 *
 * This module contains the full session funnel (`launchSession`) and all
 * supporting functions. Functions accept `home: string` (the guild root path)
 * so they can be called from anywhere — including startup code and engines —
 * without requiring a RigContext.
 *
 * Internal implementation: library functions use raw SQLite against the Books
 * tables (books_nexus_sessions_*) rather than going through the Books API.
 * This provides partial-update semantics (updateSessionDoc), complex filters,
 * and avoids the overhead of creating a full RigContext for each call.
 *
 * Provider registry: `registerSessionProvider` and `getSessionProvider` live in
 * `@shardworks/nexus-core` (legacy/1/session.ts) to avoid a circular dependency
 * with `clock-daemon.ts` in core which also registers the provider. This module
 * re-exports them so callers can import from either package.
 *
 * Event signalling: `signalEvent` is imported from `@shardworks/nexus-core`,
 * which re-exports it from the clockworks legacy module. Once nexus-clockworks
 * is committed and widely available, this should be imported from
 * `@shardworks/nexus-clockworks` directly.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  nexusDir,
  workshopBarePath,
  signalEvent,
  registerSessionProvider as _registerSessionProvider,
  getSessionProvider as _getSessionProvider,
} from '@shardworks/nexus-core';
import type {
  ManifestResult,
  SessionProvider,
  SessionProviderLaunchOptions,
  SessionProviderResult,
} from '@shardworks/nexus-core';
import { openDb, SESSIONS_TABLE } from './db.ts';
import type { SessionDoc } from '../types.ts';

// ── Provider registry (delegated to core's singleton) ─────────────────────

/**
 * Register a session provider. Called once at startup by the MCP server or
 * clock daemon before any sessions are launched.
 *
 * Delegates to core's singleton registry to remain compatible with
 * `clock-daemon.ts` in core, which also imports `registerSessionProvider`
 * from `./session.ts` (the legacy module in core).
 */
export { _registerSessionProvider as registerSessionProvider };
export { _getSessionProvider as getSessionProvider };

// Re-export provider types for callers that import from nexus-sessions
export type { SessionProvider, SessionProviderLaunchOptions, SessionProviderResult };

// ── ID generation ──────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

/** A chunk emitted during streaming session output. */
export type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };

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

/** Everything needed to launch a session through the funnel. */
export interface SessionLaunchOptions {
  /** Guild root path. */
  home: string;
  /** The manifest result — system prompt + resolved tools. */
  manifest: ManifestResult;
  /** The user-facing prompt (writ spec, consultation topic, brief). */
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
  /** Session ID — written by the funnel before provider launch. */
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

/** Full session record written to disk as JSON. */
export interface SessionRecord {
  /** Session row ID (for cross-reference). */
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

/** Full session detail — all fields from the session doc. */
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

/** Options for listSessions(). */
export interface ListSessionsOptions {
  /**
   * Filter by anima ID. Note: name-based lookup requires nexus-roster (not yet
   * riggified) — pass an animaId, not an anima name.
   */
  anima?: string;
  workshop?: string;
  trigger?: string;
  /** Filter by active (no endedAt) or completed (has endedAt). */
  status?: 'active' | 'completed';
  /** Filter by bound writ ID. */
  writId?: string;
  /** Maximum number of results. */
  limit?: number;
}

// ── Workspace helpers ──────────────────────────────────────────────────────

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
      `[nexus-sessions] Warning: failed to remove temp worktree ${worktreePath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Session record helpers ─────────────────────────────────────────────────

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

// ── Books table helpers ────────────────────────────────────────────────────

/**
 * Insert a session document into the sessions book.
 * @returns The session ID.
 */
function insertSessionDoc(
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
  const db = openDb(home);
  try {
    const id = opts.sessionId ?? generateId('ses');
    const doc: SessionDoc = {
      id,
      animaId: opts.animaId,
      provider: opts.provider,
      trigger: opts.trigger,
      workshop: opts.workshop,
      workspaceKind: opts.workspaceKind,
      curriculumName: opts.curriculumName,
      curriculumVersion: opts.curriculumVersion,
      temperamentName: opts.temperamentName,
      temperamentVersion: opts.temperamentVersion,
      roles: opts.roles,
      startedAt: opts.startedAt,
      endedAt: null,
      exitCode: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      durationMs: null,
      providerSessionId: null,
      recordPath: null,
      writId: opts.writId ?? null,
      conversationId: opts.conversationId ?? null,
      turnNumber: opts.turnNumber ?? null,
    };
    db.prepare(
      `INSERT INTO "${SESSIONS_TABLE}" (id, content) VALUES (?, ?)`,
    ).run(id, JSON.stringify(doc));
    return id;
  } finally {
    db.close();
  }
}

/**
 * Update a session document with end-of-session data.
 *
 * Uses read-modify-write to keep the document shape canonical.
 */
function updateSessionDoc(
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
  const db = openDb(home);
  try {
    const trx = db.transaction(() => {
      const row = db.prepare(
        `SELECT content FROM "${SESSIONS_TABLE}" WHERE id = ?`,
      ).get(sessionId) as { content: string } | undefined;
      if (!row) return;

      const doc = JSON.parse(row.content) as SessionDoc;
      doc.endedAt = opts.endedAt;
      doc.exitCode = opts.exitCode;
      doc.inputTokens = opts.inputTokens ?? null;
      doc.outputTokens = opts.outputTokens ?? null;
      doc.cacheReadTokens = opts.cacheReadTokens ?? null;
      doc.cacheWriteTokens = opts.cacheWriteTokens ?? null;
      doc.costUsd = opts.costUsd ?? null;
      doc.durationMs = opts.durationMs ?? null;
      doc.providerSessionId = opts.providerSessionId ?? null;
      doc.recordPath = opts.recordPath ?? null;

      db.prepare(
        `UPDATE "${SESSIONS_TABLE}" SET content = ? WHERE id = ?`,
      ).run(JSON.stringify(doc), sessionId);
    });
    trx();
  } finally {
    db.close();
  }
}

// ── Dashboard read functions ───────────────────────────────────────────────

/**
 * List sessions with optional filters. Returns sessions ordered by
 * startedAt descending (newest first).
 *
 * Note: the `anima` filter matches against `animaId` only. Name-based lookup
 * requires nexus-roster (not yet riggified). Callers should resolve anima names
 * to IDs before calling this function.
 */
export function listSessions(home: string, opts: ListSessionsOptions = {}): SessionSummary[] {
  const db = openDb(home);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.anima) {
      conditions.push(`json_extract(content, '$.animaId') = ?`);
      params.push(opts.anima);
    }
    if (opts.workshop) {
      conditions.push(`json_extract(content, '$.workshop') = ?`);
      params.push(opts.workshop);
    }
    if (opts.trigger) {
      conditions.push(`json_extract(content, '$.trigger') = ?`);
      params.push(opts.trigger);
    }
    if (opts.writId) {
      conditions.push(`json_extract(content, '$.writId') = ?`);
      params.push(opts.writId);
    }
    if (opts.status === 'active') {
      conditions.push(`json_extract(content, '$.endedAt') IS NULL`);
    } else if (opts.status === 'completed') {
      conditions.push(`json_extract(content, '$.endedAt') IS NOT NULL`);
    }

    let sql = `SELECT content FROM "${SESSIONS_TABLE}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY json_extract(content, '$.startedAt') DESC, rowid DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as { content: string }[];
    return rows.map(r => {
      const doc = JSON.parse(r.content) as SessionDoc;
      return {
        id: doc.id,
        animaId: doc.animaId,
        provider: doc.provider,
        trigger: doc.trigger,
        workshop: doc.workshop,
        workspaceKind: doc.workspaceKind,
        startedAt: doc.startedAt,
        endedAt: doc.endedAt,
        exitCode: doc.exitCode,
        costUsd: doc.costUsd,
        durationMs: doc.durationMs,
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Count sessions bound to a given writ. Used by circuit breakers to cap
 * retry attempts without fetching full session rows.
 */
export function countSessionsForWrit(home: string, writId: string): number {
  const db = openDb(home);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM "${SESSIONS_TABLE}"
       WHERE json_extract(content, '$.writId') = ?`,
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
  const db = openDb(home);
  try {
    const row = db.prepare(
      `SELECT content FROM "${SESSIONS_TABLE}" WHERE id = ?`,
    ).get(sessionId) as { content: string } | undefined;

    if (!row) return null;

    const doc = JSON.parse(row.content) as SessionDoc;
    return {
      id: doc.id,
      animaId: doc.animaId,
      provider: doc.provider,
      trigger: doc.trigger,
      workshop: doc.workshop,
      workspaceKind: doc.workspaceKind,
      curriculumName: doc.curriculumName,
      curriculumVersion: doc.curriculumVersion,
      temperamentName: doc.temperamentName,
      temperamentVersion: doc.temperamentVersion,
      roles: doc.roles,
      startedAt: doc.startedAt,
      endedAt: doc.endedAt,
      exitCode: doc.exitCode,
      inputTokens: doc.inputTokens,
      outputTokens: doc.outputTokens,
      cacheReadTokens: doc.cacheReadTokens,
      cacheWriteTokens: doc.cacheWriteTokens,
      costUsd: doc.costUsd,
      durationMs: doc.durationMs,
      providerSessionId: doc.providerSessionId,
      recordPath: doc.recordPath,
    };
  } finally {
    db.close();
  }
}

// ── The Session Funnel ─────────────────────────────────────────────────────

/**
 * Launch a session through the registered provider.
 *
 * This is THE code path for all sessions. It:
 * 1. If workspace is workshop-temp: create fresh worktree from main
 * 2. Records session.started in the sessions book → gets sessionId
 * 3. Signals session.started event
 * 4. Delegates to the provider (passing resolved cwd)
 * 5. Records session.ended in the sessions book (with metrics)
 * 6. Writes the SessionRecord JSON to .nexus/sessions/{uuid}.json
 * 7. Signals session.ended event (with full metrics + sessionId in payload)
 * 8. If workspace is workshop-temp AND session is autonomous: tear down the worktree
 *    (interactive sessions leave the worktree for manual cleanup)
 * 9. Returns the result (including sessionId)
 *
 * Error handling guarantee: Steps 5–8 MUST execute even if the provider
 * throws. The funnel wraps step 4 in try/finally. If the provider crashes,
 * the session doc still gets endedAt, exitCode, and the session.ended
 * event still fires (with error details in the payload). If the funnel
 * itself fails during recording (e.g. DB locked), it signals
 * session.record-failed as a core event and continues with remaining
 * cleanup steps. Worktree teardown failures are logged but do not throw.
 */
export async function launchSession(options: SessionLaunchOptions): Promise<SessionResult> {
  const provider = _getSessionProvider();
  if (!provider) {
    throw new Error(
      'No session provider registered. Call registerSessionProvider() at startup.',
    );
  }

  const { home, prompt, interactive, trigger, name, maxBudgetUsd, writId,
    sessionId: preGeneratedSessionId,
    conversationId, turnNumber, claudeSessionId, onChunk, systemPromptAppendix } = options;

  // Apply system prompt appendix (e.g. writ protocol) if provided.
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
  const workshopName = workspace.kind === 'guildhall' ? null : workspace.workshop;

  // Step 2: Record session.started in the sessions book
  let sessionId: string;
  try {
    sessionId = insertSessionDoc(home, {
      sessionId: preGeneratedSessionId,
      animaId: manifest.anima.id,
      provider: provider.name,
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
    if (onChunk && provider.launchStreaming) {
      const { chunks, result } = provider.launchStreaming(launchOpts);
      for await (const chunk of chunks) {
        onChunk(chunk as SessionChunk);
      }
      providerResult = await result;
    } else {
      providerResult = await provider.launch(launchOpts);
    }
  } catch (err) {
    providerError = err instanceof Error ? err : new Error(String(err));
  }

  // Steps 5–8: Always execute, even if the provider threw
  const endedAt = new Date().toISOString();
  const exitCode = providerResult?.exitCode ?? 1;
  const durationMs = providerResult?.durationMs ?? (Date.now() - new Date(startedAt).getTime());

  // Step 6: Write SessionRecord JSON
  let recordPath: string | undefined;
  try {
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

  // Step 5: Update session doc in books table
  try {
    updateSessionDoc(home, sessionId, {
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
        phase: 'update-doc',
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

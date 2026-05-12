/**
 * SessionDoc transition reducer — the single writeback merge function for
 * the Animator's `sessions` book.
 *
 * Every in-package SessionDoc writer (the in-process attached path's
 * `recordRunning` / `recordSession` / `cancel` in animator.ts, the
 * detached `handleSessionRecord` in session-record-handler.ts, the
 * `session-running` and `session-heartbeat` tools, and orphan recovery
 * in startup.ts) funnels through this reducer. Concentrating the merge
 * rules here removes the silent-drift surface that nine bespoke per-writer
 * call sites used to share by hand.
 *
 * ## Merge invariants
 *
 *  - **Preserve from existing:** `startedAt`, `provider`, `authorizedTools`,
 *    `prompt`, `systemPrompt`. Once these are set on the row they never
 *    get rewritten — the canonical first-write owns them. (`prompt` and
 *    `systemPrompt` are captured at first-write to record the exact
 *    bytes that hit the provider so debugging/ethnography/lab probes
 *    don't have to re-execute engine prompt builders to learn what was
 *    asked.)
 *  - **Deep-merge:** `metadata`. Existing keys win when the transition
 *    does not provide a replacement; transition keys overlay existing
 *    keys when both are present.
 *  - **Replace:** `cancelHandle`. The handle is a tagged union the
 *    provider owns end-to-end (see `CancelHandle`); a transition that
 *    supplies one supplies a complete handle. Partial overlays would
 *    require the transition to know the existing variant — simpler to
 *    let the producer hand a fresh handle in.
 *  - **Refresh `lastActivityAt` only from per-variant payload.** Variants
 *    whose payload carries a `lastActivityAt` field write it; other
 *    variants leave the existing value untouched. This makes the
 *    "lifecycle signal vs. structural update" contract explicit at the
 *    type level: `heartbeat-touch` is the lastActivityAt-only variant;
 *    `orphan-failed` legitimately does not refresh lastActivityAt because
 *    the host is dead.
 *  - **No-op on terminal-state regression.** Any transition whose
 *    `existing` is already in a terminal state (`completed`, `failed`,
 *    `timeout`, `cancelled`, or `rate-limited`) returns the existing doc
 *    unchanged. Call sites that need to take additional action on the
 *    no-op path (the session-record-handler's transcript-write-on-
 *    duplicate-terminal branch) detect this themselves by comparing the
 *    pre-reducer existing.status against the post-reducer doc.
 *
 * ## Purity
 *
 * The reducer is a pure synchronous function. It performs no I/O, takes
 * no clock dependency, and never emits. `lastActivityAt` is supplied by
 * the caller per variant (the call site reads `Date.now()` and passes it
 * in). Lifecycle event emission (`animator.session.started`,
 * `animator.session.ended`, `animator.session.record-failed`) stays at
 * the call sites — they compare pre-reducer `existing?.status` against
 * the post-reducer doc's status to decide whether to emit.
 */

import type {
  CancelHandle,
  SessionDoc,
  SessionTerminationTag,
  TerminationDiagnostic,
  TokenUsage,
} from './types.ts';

// ── Terminal status set ──────────────────────────────────────────────

/**
 * Terminal SessionDoc statuses — any of these means the session is done.
 * Single source of truth for the package; consumed by the reducer's
 * terminal-immutability rule and by every call site that needs to gate
 * behavior on "is this row already terminal".
 *
 * `rate-limit-backoff.ts` derives its own non-rate-limit subset from this
 * set rather than maintaining a hand-listed inverse.
 */
export const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'rate-limited',
]);

// ── Per-variant transition shapes ────────────────────────────────────

/**
 * Pre-write a `pending` SessionDoc before the babysitter is spawned.
 * Used by `launchDetached()` so the authorization callback has an
 * authoritative row to read before the babysitter's first tool call
 * arrives. Seeds `lastActivityAt` so the reconciler has a fair starting
 * point for the staleness calculation.
 */
interface PendingPreWriteTransition {
  kind: 'pending-pre-write';
  id: string;
  startedAt: string;
  provider: string;
  /** ISO timestamp of the moment the pre-write happened. */
  lastActivityAt: string;
  metadata?: Record<string, unknown>;
  /** The full anima-callable tool set authorized for this session. */
  authorizedTools?: string[];
  /**
   * The user-side initial prompt (with cwd preamble for non-resumed
   * sessions) — i.e. `SessionProviderConfig.initialPrompt`. Captured
   * at first-write so historical reconstruction doesn't have to
   * re-execute engine prompt builders.
   */
  prompt?: string;
  /**
   * The Loom-composed system prompt — i.e.
   * `SessionProviderConfig.systemPrompt`. Today's MVP Loom returns no
   * systemPrompt for summoned sessions, so this is typically absent or
   * empty.
   */
  systemPrompt?: string;
}

/**
 * In-process attached `recordRunning` write — the canonical first-time
 * write of a `running` SessionDoc when animate() launches a session
 * directly (no detached babysitter).
 */
interface AttachRunningTransition {
  kind: 'attach-running';
  id: string;
  startedAt: string;
  provider: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  cancelHandle?: CancelHandle;
  /**
   * The user-side initial prompt (with cwd preamble for non-resumed
   * sessions) — i.e. `SessionProviderConfig.initialPrompt`. Captured
   * at first-write so historical reconstruction doesn't have to
   * re-execute engine prompt builders.
   */
  prompt?: string;
  /**
   * The Loom-composed system prompt — i.e.
   * `SessionProviderConfig.systemPrompt`. Today's MVP Loom returns no
   * systemPrompt for summoned sessions, so this is typically absent or
   * empty.
   */
  systemPrompt?: string;
}

/**
 * The detached `session-running` tool's ready-report write. Handles
 * pending → running, cold-start (no existing), and the running → running
 * refresh (only `lastActivityAt` and `cancelHandle` change — metadata,
 * startedAt, and provider are preserved unchanged because they were
 * already set during the initial pending → running transition).
 *
 * The reducer detects the running → running refresh internally; callers
 * do not need a separate variant for it.
 */
interface DetachedReadyTransition {
  kind: 'detached-ready';
  id: string;
  startedAt: string;
  provider: string;
  /** ISO timestamp of the ready report. */
  lastActivityAt: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  cancelHandle?: CancelHandle;
}

/**
 * Heartbeat-only refresh — bumps `lastActivityAt` and nothing else.
 * Used by the `session-heartbeat` tool and by orphan-recovery's legacy
 * `lastActivityAt` backfill. Caller must guarantee an existing doc;
 * the reducer throws on a missing `existing` because the operation is
 * meaningless without a row to refresh.
 */
interface HeartbeatTouchTransition {
  kind: 'heartbeat-touch';
  id: string;
  /** ISO timestamp to write. */
  lastActivityAt: string;
}

/**
 * Terminal-state write — the in-process attached path's `recordSession`
 * and the detached `handleSessionRecord` both write through this. Status
 * is carried as a sub-discriminator across the four terminal statuses
 * because the merge logic is uniform across them.
 */
interface TerminalTransition {
  kind: 'terminal';
  id: string;
  status: 'completed' | 'failed' | 'timeout' | 'rate-limited';
  /** Fallback when no existing row carries one. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Fallback when no existing row carries one. */
  provider: string;
  exitCode: number;
  /** ISO timestamp of the terminal report. */
  lastActivityAt: string;
  error?: string;
  costUsd?: number;
  tokenUsage?: TokenUsage;
  output?: string;
  providerSessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  terminationTag?: SessionTerminationTag;
  terminationDiagnostic?: TerminationDiagnostic;
}

/**
 * Cancel write — flips `running`/`pending` to `cancelled`. Caller must
 * guarantee an existing doc; the reducer throws on missing `existing`
 * because cancelling a session that was never written is a contract
 * violation (the AnimatorApi.cancel() call site already throws "Session
 * not found" if it can't find the row).
 */
interface CancelTransition {
  kind: 'cancel';
  id: string;
  endedAt: string;
  durationMs: number;
  reason?: string;
}

/**
 * Orphan-recovery write — flips a stale running/pending session to
 * `failed` because no recent heartbeat was observed. Does NOT refresh
 * `lastActivityAt`: the host is presumed dead, so the heartbeat field
 * tells the truth that the session has been silent. Caller must
 * guarantee an existing doc.
 */
interface OrphanFailedTransition {
  kind: 'orphan-failed';
  id: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  error: string;
}

export type SessionTransition =
  | PendingPreWriteTransition
  | AttachRunningTransition
  | DetachedReadyTransition
  | HeartbeatTouchTransition
  | TerminalTransition
  | CancelTransition
  | OrphanFailedTransition;

// ── Reducer ──────────────────────────────────────────────────────────

/**
 * Merge a `SessionTransition` into the existing SessionDoc, encoding
 * every merge invariant in one place. See the module-level docstring
 * for the invariant catalog.
 *
 * Returns the next SessionDoc to write. Returns `existing` unchanged
 * when the existing row is already terminal, regardless of the
 * transition's intent (terminal-immutability rule).
 */
export function reduceSessionTransition(
  existing: SessionDoc | null | undefined,
  transition: SessionTransition,
): SessionDoc {
  // Terminal-state immutability — any transition against a terminal row
  // returns the existing doc unchanged. Call sites that need to detect
  // this case (transcript-write-on-duplicate-terminal, etc.) compare
  // pre-reducer existing.status against the post-reducer doc themselves.
  if (existing && TERMINAL_STATUSES.has(existing.status)) {
    return existing;
  }

  switch (transition.kind) {
    case 'pending-pre-write':
      return reducePendingPreWrite(existing, transition);
    case 'attach-running':
      return reduceAttachRunning(existing, transition);
    case 'detached-ready':
      return reduceDetachedReady(existing, transition);
    case 'heartbeat-touch':
      return reduceHeartbeatTouch(existing, transition);
    case 'terminal':
      return reduceTerminal(existing, transition);
    case 'cancel':
      return reduceCancel(existing, transition);
    case 'orphan-failed':
      return reduceOrphanFailed(existing, transition);
  }
}

// ── Per-variant reducers ─────────────────────────────────────────────

function reducePendingPreWrite(
  existing: SessionDoc | null | undefined,
  t: PendingPreWriteTransition,
): SessionDoc {
  const merged: SessionDoc = {
    ...(existing ?? {}),
    id: t.id,
    status: 'pending',
    startedAt: existing?.startedAt ?? t.startedAt,
    provider: existing?.provider ?? t.provider,
    lastActivityAt: t.lastActivityAt,
  };
  if (t.metadata !== undefined || existing?.metadata !== undefined) {
    merged.metadata = { ...(existing?.metadata ?? {}), ...(t.metadata ?? {}) };
  }
  if (t.authorizedTools !== undefined) {
    merged.authorizedTools = t.authorizedTools;
  } else if (existing?.authorizedTools !== undefined) {
    merged.authorizedTools = existing.authorizedTools;
  }
  // First-write fields: write if the transition provides them, otherwise
  // preserve any value already on the existing doc. Never overwrite an
  // existing non-empty value with an absent one — the first-writer owns
  // these like `startedAt` and `provider`.
  if (t.prompt !== undefined) {
    merged.prompt = t.prompt;
  } else if (existing?.prompt !== undefined) {
    merged.prompt = existing.prompt;
  }
  if (t.systemPrompt !== undefined) {
    merged.systemPrompt = t.systemPrompt;
  } else if (existing?.systemPrompt !== undefined) {
    merged.systemPrompt = existing.systemPrompt;
  }
  return merged;
}

function reduceAttachRunning(
  existing: SessionDoc | null | undefined,
  t: AttachRunningTransition,
): SessionDoc {
  const merged: SessionDoc = {
    ...(existing ?? {}),
    id: t.id,
    status: 'running',
    startedAt: existing?.startedAt ?? t.startedAt,
    provider: existing?.provider ?? t.provider,
  };
  if (t.conversationId !== undefined) {
    merged.conversationId = t.conversationId;
  } else if (existing?.conversationId !== undefined) {
    merged.conversationId = existing.conversationId;
  }
  if (t.metadata !== undefined || existing?.metadata !== undefined) {
    merged.metadata = { ...(existing?.metadata ?? {}), ...(t.metadata ?? {}) };
  }
  if (t.cancelHandle !== undefined) {
    merged.cancelHandle = t.cancelHandle;
  }
  // First-write fields: write if the transition provides them, otherwise
  // preserve any value already on the existing doc. The in-process
  // attached path is the canonical first writer for non-detached sessions.
  if (t.prompt !== undefined) {
    merged.prompt = t.prompt;
  } else if (existing?.prompt !== undefined) {
    merged.prompt = existing.prompt;
  }
  if (t.systemPrompt !== undefined) {
    merged.systemPrompt = t.systemPrompt;
  } else if (existing?.systemPrompt !== undefined) {
    merged.systemPrompt = existing.systemPrompt;
  }
  return merged;
}

function reduceDetachedReady(
  existing: SessionDoc | null | undefined,
  t: DetachedReadyTransition,
): SessionDoc {
  // Already-running refresh path (D9): preserve metadata, startedAt,
  // provider; only refresh lastActivityAt and cancelHandle. The reducer
  // detects this internally so callers don't need a separate variant.
  if (existing && existing.status === 'running') {
    const merged: SessionDoc = {
      ...existing,
      lastActivityAt: t.lastActivityAt,
    };
    if (t.cancelHandle !== undefined) {
      merged.cancelHandle = t.cancelHandle;
    }
    return merged;
  }

  // Normal path: pending → running transition or cold start.
  const merged: SessionDoc = {
    ...(existing ?? {}),
    id: t.id,
    status: 'running',
    startedAt: existing?.startedAt ?? t.startedAt,
    provider: existing?.provider ?? t.provider,
    lastActivityAt: t.lastActivityAt,
  };
  if (t.conversationId !== undefined) {
    merged.conversationId = t.conversationId;
  }
  if (t.metadata !== undefined) {
    merged.metadata = { ...(existing?.metadata ?? {}), ...t.metadata };
  }
  if (t.cancelHandle !== undefined) {
    merged.cancelHandle = t.cancelHandle;
  }
  return merged;
}

function reduceHeartbeatTouch(
  existing: SessionDoc | null | undefined,
  t: HeartbeatTouchTransition,
): SessionDoc {
  if (!existing) {
    throw new Error(
      `[animator] heartbeat-touch transition requires an existing SessionDoc (id: ${t.id})`,
    );
  }
  return {
    ...existing,
    lastActivityAt: t.lastActivityAt,
  };
}

function reduceTerminal(
  existing: SessionDoc | null | undefined,
  t: TerminalTransition,
): SessionDoc {
  const merged: SessionDoc = {
    ...(existing ?? {}),
    id: t.id,
    status: t.status,
    startedAt: existing?.startedAt ?? t.startedAt,
    endedAt: t.endedAt,
    durationMs: t.durationMs,
    provider: existing?.provider ?? t.provider,
    exitCode: t.exitCode,
    lastActivityAt: t.lastActivityAt,
  };
  if (t.error !== undefined) merged.error = t.error;
  if (t.costUsd !== undefined) merged.costUsd = t.costUsd;
  if (t.tokenUsage !== undefined) merged.tokenUsage = t.tokenUsage;
  if (t.output !== undefined) merged.output = t.output;
  if (t.providerSessionId !== undefined) merged.providerSessionId = t.providerSessionId;
  if (t.conversationId !== undefined) {
    merged.conversationId = t.conversationId;
  } else if (existing?.conversationId !== undefined) {
    merged.conversationId = existing.conversationId;
  }
  if (t.metadata !== undefined || existing?.metadata !== undefined) {
    merged.metadata = { ...(existing?.metadata ?? {}), ...(t.metadata ?? {}) };
  }
  if (t.terminationTag !== undefined) merged.terminationTag = t.terminationTag;
  if (t.terminationDiagnostic !== undefined) {
    merged.terminationDiagnostic = t.terminationDiagnostic;
  }
  return merged;
}

function reduceCancel(
  existing: SessionDoc | null | undefined,
  t: CancelTransition,
): SessionDoc {
  if (!existing) {
    throw new Error(
      `[animator] cancel transition requires an existing SessionDoc (id: ${t.id})`,
    );
  }
  return {
    ...existing,
    status: 'cancelled',
    endedAt: t.endedAt,
    durationMs: t.durationMs,
    ...(t.reason ? { error: t.reason } : {}),
  };
}

function reduceOrphanFailed(
  existing: SessionDoc | null | undefined,
  t: OrphanFailedTransition,
): SessionDoc {
  if (!existing) {
    throw new Error(
      `[animator] orphan-failed transition requires an existing SessionDoc (id: ${t.id})`,
    );
  }
  return {
    ...existing,
    status: 'failed',
    endedAt: t.endedAt,
    durationMs: t.durationMs,
    exitCode: t.exitCode,
    error: t.error,
  };
}

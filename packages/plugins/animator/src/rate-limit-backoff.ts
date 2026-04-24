/**
 * Animator rate-limit back-off state machine.
 *
 * Owns the `'dispatch-status'` document in the shared animator `state`
 * book and translates terminal session outcomes into pause / resume
 * transitions.
 *
 * Design references:
 *  - D7  — "successful dispatch after resume" = any terminal other than
 *          rate-limited resets `backoffLevel`.
 *  - D8  — hits while already paused coalesce; only a rate-limit hit
 *          arriving *after* a resume attempt dispatched bumps the level.
 *  - D11 — `getStatus()` returns the doc verbatim; no composed
 *          dispatchability predicate lives here.
 *  - D12 — `animate()` rejects at the top with a synthesized
 *          rate-limited SessionResult when paused.
 *  - D24 — daemon restart leaves state untouched; the first dispatch
 *          that happens while `pausedUntil <= now` naturally flips the
 *          state to `running`.
 *
 * The machine is intentionally small — consumers (Spider's crawl gate,
 * Oculus banner, CLI tool) compose their own dispatchability predicate
 * over the returned doc.
 */

import type { Book } from '@shardworks/stacks-apparatus';
import type {
  AnimatorRateLimitBackoffConfig,
  AnimatorStatusDoc,
  SessionTerminationTag,
} from './types.ts';

/**
 * Well-known document id for the single animator dispatch-status row in
 * the shared `animator/state` book. Sibling of `'guild-heartbeat'`.
 */
export const DISPATCH_STATUS_DOC_ID = 'dispatch-status';

/** Defaults applied when the caller omits the corresponding config field. */
export const DEFAULT_RATE_LIMIT_BACKOFF = Object.freeze({
  initialMs: 15 * 60_000, // 15 minutes
  maxMs: 60 * 60_000,     // 1 hour
  factor: 2,
}) satisfies Required<AnimatorRateLimitBackoffConfig>;

/**
 * Validate a back-off config block fail-loud (D10 patron override).
 *
 * Missing block → caller should apply DEFAULT_RATE_LIMIT_BACKOFF. When a
 * block is provided, every supplied value must be well-formed or this
 * throws. Partial overrides (e.g. just `initialMs`) are allowed; each
 * omitted field falls back to its default.
 *
 * Returns a resolved config with all three fields populated, suitable
 * for passing to the back-off machine.
 */
export function validateBackoffConfig(
  raw: AnimatorRateLimitBackoffConfig | undefined,
): Required<AnimatorRateLimitBackoffConfig> {
  if (raw === undefined) return { ...DEFAULT_RATE_LIMIT_BACKOFF };

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `[animator] animator.rateLimitBackoff must be an object; received ${typeof raw}`,
    );
  }

  const resolved: Required<AnimatorRateLimitBackoffConfig> = { ...DEFAULT_RATE_LIMIT_BACKOFF };

  if (raw.initialMs !== undefined) {
    if (!Number.isInteger(raw.initialMs) || raw.initialMs <= 0) {
      throw new Error(
        `[animator] animator.rateLimitBackoff.initialMs must be a positive integer; received ${String(raw.initialMs)}`,
      );
    }
    resolved.initialMs = raw.initialMs;
  }

  if (raw.maxMs !== undefined) {
    if (!Number.isInteger(raw.maxMs) || raw.maxMs <= 0) {
      throw new Error(
        `[animator] animator.rateLimitBackoff.maxMs must be a positive integer; received ${String(raw.maxMs)}`,
      );
    }
    resolved.maxMs = raw.maxMs;
  }

  if (raw.factor !== undefined) {
    if (typeof raw.factor !== 'number' || !Number.isFinite(raw.factor) || raw.factor <= 1) {
      throw new Error(
        `[animator] animator.rateLimitBackoff.factor must be a finite number greater than 1; received ${String(raw.factor)}`,
      );
    }
    resolved.factor = raw.factor;
  }

  if (resolved.maxMs < resolved.initialMs) {
    throw new Error(
      `[animator] animator.rateLimitBackoff.maxMs (${resolved.maxMs}) must be >= initialMs (${resolved.initialMs})`,
    );
  }

  return resolved;
}

/** The default status doc used when nothing has been persisted yet. */
export function freshStatusDoc(): AnimatorStatusDoc {
  return {
    id: DISPATCH_STATUS_DOC_ID,
    state: 'running',
    backoffLevel: 0,
  };
}

/**
 * Terminal statuses that count as "session made it through without a
 * rate-limit termination" for the purposes of the reset rule (D7).
 *
 * Includes `'completed'`, `'failed'`, `'timeout'`, and `'cancelled'`.
 * Any one of these, when observed after a pause window has opened a
 * resume attempt, counts as a successful probe and resets the level
 * to 0. Observing one of these while running is a no-op.
 */
const NON_RATE_LIMIT_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'timeout',
  'cancelled',
]);

export interface BackoffReadConfig {
  /** Read the current back-off config — called at each transition. */
  get(): Required<AnimatorRateLimitBackoffConfig>;
}

export interface NowFn {
  (): number;
}

/**
 * Per-process in-memory flag tracking whether a resume dispatch has
 * happened since the current pause began. Necessary because D8 says
 * "hits during a paused window coalesce; only a hit after a resume
 * attempt dispatches increments." On a single-process daemon this is
 * sufficient; multi-process deployments are out of scope here.
 */
export interface ResumeProbeTracker {
  /**
   * Record that `animate()` successfully dispatched a session (i.e.
   * passed its pre-check). The next rate-limit terminal will now
   * increment the back-off level instead of coalescing.
   */
  noteDispatch(): void;
  /**
   * Return true if a dispatch has been observed since the last pause
   * was opened. Called on the pause-transition path to decide whether
   * to coalesce or increment.
   */
  hasDispatchedSinceLastPause(): boolean;
  /**
   * Reset the "dispatched since last pause" counter. Called each time
   * the machine opens a fresh pause window.
   */
  resetOnPause(): void;
}

export function createResumeProbeTracker(): ResumeProbeTracker {
  let dispatched = false;
  return {
    noteDispatch() { dispatched = true; },
    hasDispatchedSinceLastPause() { return dispatched; },
    resetOnPause() { dispatched = false; },
  };
}

export interface BackoffMachine {
  /**
   * Load and return the current status document. Falls back to a fresh
   * "running" default if the row has never been written.
   *
   * Also updates the in-memory cache consulted by `peek()`.
   */
  read(): Promise<AnimatorStatusDoc>;
  /**
   * Synchronous read of the most recently observed status document.
   * Used by the `animate()` pre-check so the handle can return
   * immediately without awaiting a status-book round-trip. Initialised
   * from the first `read()` at startup; subsequent `observeTerminal()`
   * calls keep it in sync.
   */
  peek(): AnimatorStatusDoc;
  /**
   * Observe a terminal session outcome and update the status book in
   * response. Idempotent — safe to call twice for the same session.
   *
   * Rate-limited terminals open a pause (or coalesce into the current
   * one). Any other terminal resets the back-off level if the machine
   * was paused.
   */
  observeTerminal(params: {
    sessionId: string;
    status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
    terminationTag?: SessionTerminationTag;
  }): Promise<void>;
  /**
   * Note a successful `animate()` dispatch so the next rate-limit
   * terminal increments back-off rather than coalescing.
   */
  noteDispatch(): void;
}

export function createBackoffMachine(params: {
  statusBook: Book<AnimatorStatusDoc>;
  config: BackoffReadConfig;
  now?: NowFn;
  probe?: ResumeProbeTracker;
}): BackoffMachine {
  const { statusBook, config } = params;
  const now = params.now ?? (() => Date.now());
  const probe = params.probe ?? createResumeProbeTracker();

  // Cached view of the status doc so the animate() pre-check can read
  // it synchronously. Updated on every read() and after every mutation.
  let cached: AnimatorStatusDoc = freshStatusDoc();

  async function read(): Promise<AnimatorStatusDoc> {
    const doc = await statusBook.get(DISPATCH_STATUS_DOC_ID);
    cached = doc ?? freshStatusDoc();
    return cached;
  }

  function peek(): AnimatorStatusDoc {
    return cached;
  }

  function computeNextWindow(
    prev: AnimatorStatusDoc,
    cfg: Required<AnimatorRateLimitBackoffConfig>,
  ): { pausedUntilMs: number; backoffLevel: number } {
    // D8: hits during an already-paused window coalesce (do not
    // increment). Only a hit that arrives after a resume attempt
    // dispatched increments the level and extends the window.
    if (prev.state === 'paused' && !probe.hasDispatchedSinceLastPause()) {
      // Coalesce — keep the existing window bounds.
      const existing = prev.pausedUntil ? new Date(prev.pausedUntil).getTime() : (now() + cfg.initialMs);
      return { pausedUntilMs: existing, backoffLevel: prev.backoffLevel };
    }

    // Either we were running (fresh pause) or we were paused AND a
    // resume attempt has dispatched since the last pause opened.
    const isFreshPause = prev.state !== 'paused';
    const nextLevel = isFreshPause
      ? 0
      : Math.min(prev.backoffLevel + 1, Number.MAX_SAFE_INTEGER);
    const pausedUntilMs = Math.min(
      now() + cfg.initialMs * Math.pow(cfg.factor, nextLevel),
      now() + cfg.maxMs,
    );
    return { pausedUntilMs, backoffLevel: nextLevel };
  }

  async function onRateLimitTerminal(
    sessionId: string,
    terminationTag: SessionTerminationTag | undefined,
  ): Promise<void> {
    const prev = await read();
    const cfg = config.get();
    const { pausedUntilMs, backoffLevel } = computeNextWindow(prev, cfg);
    const isCoalesce = prev.state === 'paused' && !probe.hasDispatchedSinceLastPause();

    const nowIso = new Date(now()).toISOString();
    const next: AnimatorStatusDoc = {
      id: DISPATCH_STATUS_DOC_ID,
      state: 'paused',
      pausedSince: isCoalesce ? (prev.pausedSince ?? nowIso) : nowIso,
      pausedUntil: new Date(pausedUntilMs).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel,
      backoffLastHitAt: nowIso,
      lastTriggeringSession: sessionId,
    };
    void terminationTag; // consumed elsewhere (the SessionDoc carries it too)
    await statusBook.put(next);
    cached = next;
    // A fresh or escalated pause starts a new resume probe window; a
    // coalesced hit leaves the counter alone because no resume has
    // actually dispatched yet.
    if (!isCoalesce) {
      probe.resetOnPause();
    }
  }

  async function onOtherTerminal(): Promise<void> {
    // Any non-rate-limit terminal counts as a successful probe from the
    // back-off machine's perspective (D7): reset the level and, if
    // paused, return to running.
    const prev = await read();
    if (prev.state === 'running' && prev.backoffLevel === 0) {
      // Nothing to do — already reset.
      return;
    }
    const nowIso = new Date(now()).toISOString();
    const next: AnimatorStatusDoc = {
      id: DISPATCH_STATUS_DOC_ID,
      state: 'running',
      backoffLevel: 0,
      // Clear window fields; keep backoffLastHitAt for audit trail.
      ...(prev.backoffLastHitAt ? { backoffLastHitAt: prev.backoffLastHitAt } : {}),
      // lastTriggeringSession is preserved for audit; callers reading a
      // running doc typically ignore it.
      ...(prev.lastTriggeringSession ? { lastTriggeringSession: prev.lastTriggeringSession } : {}),
    };
    // Explicitly drop pausedSince/pausedUntil/pauseReason from the row.
    void nowIso;
    await statusBook.put(next);
    cached = next;
    probe.resetOnPause();
  }

  async function observeTerminal(params: {
    sessionId: string;
    status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
    terminationTag?: SessionTerminationTag;
  }): Promise<void> {
    if (params.status === 'rate-limited') {
      await onRateLimitTerminal(params.sessionId, params.terminationTag);
      return;
    }
    if (NON_RATE_LIMIT_TERMINAL_STATUSES.has(params.status)) {
      await onOtherTerminal();
      return;
    }
    // Unknown status — no-op. Exhaustiveness is enforced at the call
    // site's type signature.
  }

  return {
    read,
    peek,
    observeTerminal,
    noteDispatch: probe.noteDispatch,
  };
}

/**
 * Build a synthesized SessionResult for an `animate()` pre-check
 * rejection (D12). The session never gets a SessionDoc — this shape is
 * returned directly from `handle.result` so every caller sees the same
 * rejection contract as an in-flight rate-limited terminal.
 */
export function buildPrecheckRejectionResult(params: {
  sessionId: string;
  startedAt: string;
  provider: string;
  pausedUntil: string;
  pauseReason: string;
  metadata?: Record<string, unknown>;
  conversationId?: string;
}): import('./types.ts').SessionResult {
  const endedAt = new Date().toISOString();
  const startedMs = new Date(params.startedAt).getTime();
  const endedMs = new Date(endedAt).getTime();
  const durationMs = Math.max(0, endedMs - startedMs);
  const detail = `Anima provider is paused (${params.pauseReason}); try again after ${params.pausedUntil}`;
  return {
    id: params.sessionId,
    status: 'rate-limited',
    startedAt: params.startedAt,
    endedAt,
    durationMs,
    provider: params.provider,
    exitCode: 0,
    error: detail,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    terminationTag: {
      kind: 'rate-limit',
      source: 'ndjson-result',
      detail,
    },
  };
}

/**
 * Compute the dispatchability predicate declared by D24: dispatch is
 * allowed when the Animator is running OR the current pause window has
 * already elapsed. Exposed here so callers (Spider's crawl gate, the
 * Oculus banner, the `animator-status` CLI) compose the same rule.
 */
export function isDispatchable(doc: AnimatorStatusDoc, nowMs: number = Date.now()): boolean {
  if (doc.state === 'running') return true;
  if (!doc.pausedUntil) return true;
  return new Date(doc.pausedUntil).getTime() <= nowMs;
}

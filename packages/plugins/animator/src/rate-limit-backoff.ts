/**
 * Animator rate-limit back-off state machine.
 *
 * Owns the `'dispatch-status'` document in the shared animator `state`
 * book and translates terminal session outcomes into pause / resume
 * transitions.
 *
 * Design references — short rule names, with the canonical Dn index in
 * the package README's "Design decisions index" appendix:
 *  - D7  — "non-rate-limit-terminal reset gate": any terminal other
 *          than rate-limited resets `backoffLevel`, but only when the
 *          session was dispatched after the current pause opened.
 *  - D8  — "coalesce-vs-increment rule": hits while already paused
 *          coalesce; only a rate-limit hit arriving *after* a resume
 *          attempt dispatched bumps the level.
 *  - D11 — "verbatim getStatus": `getStatus()` returns the doc
 *          verbatim; no composed dispatchability predicate lives here.
 *  - D12 — "pre-check rejection": `animate()` rejects at the top with
 *          a synthesized rate-limited SessionResult when paused.
 *  - D24 — "canonical dispatchability predicate / first-dispatch-flips-state":
 *          daemon restart leaves state untouched; the first dispatch
 *          that happens while `pausedUntil <= now` naturally flips the
 *          state to `running`.
 *
 * The machine is intentionally small. Consumers that need a
 * dispatchability decision (Spider's crawl gate, the `animator-paused`
 * block-type, the `animate()` pre-check) call the canonical
 * `isDispatchable(doc)` helper exported below — re-exported from the
 * package index so cross-plugin callers import a single implementation.
 * Non-TypeScript consumers (the Oculus banner) read the server-computed
 * `dispatchable` field enriched onto the `animator-status` tool /
 * `/api/animator/status` route response at request time.
 */

import type { Book } from '@shardworks/stacks-apparatus';
import type {
  AnimatorRateLimitBackoffConfig,
  AnimatorStatusDoc,
  SessionTerminationTag,
} from './types.ts';
import { TERMINAL_STATUSES } from './session-reducer.ts';

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
      `[animator] animator.rateLimit.backoff must be an object; received ${typeof raw}`,
    );
  }

  const resolved: Required<AnimatorRateLimitBackoffConfig> = { ...DEFAULT_RATE_LIMIT_BACKOFF };

  if (raw.initialMs !== undefined) {
    if (!Number.isInteger(raw.initialMs) || raw.initialMs <= 0) {
      throw new Error(
        `[animator] animator.rateLimit.backoff.initialMs must be a positive integer; received ${String(raw.initialMs)}`,
      );
    }
    resolved.initialMs = raw.initialMs;
  }

  if (raw.maxMs !== undefined) {
    if (!Number.isInteger(raw.maxMs) || raw.maxMs <= 0) {
      throw new Error(
        `[animator] animator.rateLimit.backoff.maxMs must be a positive integer; received ${String(raw.maxMs)}`,
      );
    }
    resolved.maxMs = raw.maxMs;
  }

  if (raw.factor !== undefined) {
    if (typeof raw.factor !== 'number' || !Number.isFinite(raw.factor) || raw.factor <= 1) {
      throw new Error(
        `[animator] animator.rateLimit.backoff.factor must be a finite number greater than 1; received ${String(raw.factor)}`,
      );
    }
    resolved.factor = raw.factor;
  }

  if (resolved.maxMs < resolved.initialMs) {
    throw new Error(
      `[animator] animator.rateLimit.backoff.maxMs (${resolved.maxMs}) must be >= initialMs (${resolved.initialMs})`,
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
 * Derived from the reducer module's consolidated `TERMINAL_STATUSES`
 * minus `'rate-limited'`, so the two sets move in lockstep — any future
 * change to the SessionDoc terminal-status family updates the
 * consolidated set and the inverse derives automatically. Includes
 * `'completed'`, `'failed'`, `'timeout'`, and `'cancelled'` today.
 *
 * Any one of these, when observed after a pause window has opened a
 * resume attempt, counts as a successful probe and resets the level
 * to 0. Observing one of these while running is a no-op.
 */
const NON_RATE_LIMIT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(
  Array.from(TERMINAL_STATUSES).filter((status) => status !== 'rate-limited'),
);

interface BackoffReadConfig {
  /** Read the current back-off config — called at each transition. */
  get(): Required<AnimatorRateLimitBackoffConfig>;
}

interface NowFn {
  (): number;
}

/**
 * Per-process in-memory flag tracking whether a resume dispatch has
 * happened since the current pause began. Necessary because D8 says
 * "hits during a paused window coalesce; only a hit after a resume
 * attempt dispatches increments." On a single-process daemon this is
 * sufficient; multi-process deployments are out of scope here.
 */
interface ResumeProbeTracker {
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
  /**
   * Reconcile persisted pause state against the wall clock at boot
   * time. If the doc is `state: 'paused'` AND `pausedUntil <= now`,
   * transition it to `'running'` with `backoffLevel: 0` and the pause
   * window fields cleared; `backoffLastHitAt` and
   * `lastTriggeringSession` are preserved for audit. No-op when the
   * doc is already running or the pause window has not elapsed.
   *
   * Runs once during animator startup, after DLQ drain and before
   * orphan recovery / timer starts. Keeps the persisted state and the
   * observed state from drifting during the boot window before any
   * dispatch happens.
   */
  reconcileOnBoot(): Promise<void>;
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

  /**
   * Reset the persisted dispatch-status doc to `running` with
   * `backoffLevel: 0`, preserving `backoffLastHitAt` and
   * `lastTriggeringSession` as audit history. Shared between the
   * "non-rate-limit terminal after a pause" reset (D7) and the boot
   * reconciler (D24 eager flip). Writes to the book, updates the
   * cache, and resets the probe counter.
   */
  async function resetToRunning(prev: AnimatorStatusDoc): Promise<void> {
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
    await statusBook.put(next);
    cached = next;
    probe.resetOnPause();
  }

  async function onOtherTerminal(): Promise<void> {
    // D7: a non-rate-limit terminal resets the back-off level only when
    // it counts as a successful resume probe — i.e. the session was
    // dispatched AFTER the current pause opened. Symmetric with D8's
    // rate-limit gate: a terminal from a session that was already in
    // flight when the pause opened (an "in-flight straggler") tells us
    // nothing about the provider's current state and must not clear
    // the pause. Without this gate, high-concurrency dispatch can mask
    // every pause — an in-flight straggler completing seconds after a
    // rate-limit hit would reset the level, and Spider would happily
    // dispatch fresh sessions into the same exhausted-token window.
    const prev = await read();
    if (prev.state === 'running' && prev.backoffLevel === 0) {
      // Nothing to do — already reset.
      return;
    }
    if (prev.state === 'paused' && !probe.hasDispatchedSinceLastPause()) {
      // In-flight straggler from before the pause — not a probe.
      // Leave the pause window alone; the next dispatch-after-resume
      // (post pausedUntil elapsing, isDispatchable=true) will be the
      // real probe that decides whether to reset or escalate.
      return;
    }
    await resetToRunning(prev);
  }

  async function reconcileOnBoot(): Promise<void> {
    // Align persisted pause state with the wall clock. Two no-op paths:
    //   1. The doc is already running — nothing to do.
    //   2. The doc is paused but the window has not elapsed — honour
    //      the persisted decision until the timer fires.
    // The third path flips the doc back to running, preserving audit
    // fields via the shared reset helper. This runs once at boot, after
    // DLQ drain and before orphan recovery / timers — so a subsequent
    // `animate()` pre-check reads a reconciled `peek()` rather than a
    // stale paused snapshot.
    const prev = await read();
    if (prev.state !== 'paused') return;
    const pausedUntilMs = prev.pausedUntil
      ? new Date(prev.pausedUntil).getTime()
      : undefined;
    if (pausedUntilMs !== undefined && pausedUntilMs > now()) return;
    await resetToRunning(prev);
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
    reconcileOnBoot,
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
 * Canonical dispatchability predicate (D24): dispatch is allowed when
 * the Animator is `state: 'running'` OR the current pause window has
 * already elapsed (`pausedUntil <= now`). This is the single source of
 * truth — re-exported from the package index so every TypeScript
 * consumer (Spider's crawl gate, the `animator-paused` block-type, the
 * `animate()` pre-check) calls the same function. Non-TypeScript
 * callers read the server-computed `dispatchable` field that the
 * `animator-status` tool / `/api/animator/status` route enriches onto
 * its response.
 */
export function isDispatchable(doc: AnimatorStatusDoc, nowMs: number = Date.now()): boolean {
  if (doc.state === 'running') return true;
  if (!doc.pausedUntil) return true;
  return new Date(doc.pausedUntil).getTime() <= nowMs;
}

/**
 * Shared session emission helpers.
 *
 * Every terminal session site (in-process attached dispatch, detached
 * `handleSessionRecord`, the detached `session-running` tool, orphan
 * recovery in `startup.ts`) routes through this module so the
 * `animator.session.started`, `animator.session.ended`, and
 * `animator.session.record-failed` events fire from a single
 * payload-shape source of truth. Names follow the catalog (past tense,
 * `animator.` prefix per the events-kit contribution) — see
 * `docs/reference/event-catalog.md`.
 *
 * `ClockworksApi` is resolved lazily via `guild().tryApparatus()`. When
 * the Clockworks is not installed (it is in Animator's `recommends`, not
 * `requires`) the helper silently no-ops — the same idiom `summon()`
 * already uses for `LoomApi`.
 *
 * Every `emit()` is wrapped in best-effort try/catch with a `console.warn`
 * breadcrumb. A Clockworks emission failure must never roll back the
 * originating session-record write.
 *
 * Payloads omit `workshop` and `workspaceKind` because the data model
 * doesn't carry those fields — the "skip-when-unset" rule.
 */

import { guild } from '@shardworks/nexus-core';
import type { ClockworksApi, EventSpec } from '@shardworks/clockworks-apparatus';

import type { SessionDoc, SessionResult } from './types.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Plugin id used as the literal `emitter` value on every framework event. */
const FRAMEWORK_EMITTER = 'framework';

/**
 * The events kit-contribution surface for the Animator apparatus.
 *
 * Wired into the apparatus literal as `supportKit.events` so the
 * Clockworks's `start()`-time merge marks these names framework-owned
 * and rejects unprivileged emit attempts. Co-location rule (D3): the
 * kit-declared names and the literals the helpers pass to `safeEmit`
 * live in this file together, so the registry and the call sites
 * cannot drift out of sync.
 */
export const ANIMATOR_EVENTS: Record<string, EventSpec> = {
  'animator.session.started': {
    description:
      'A session has transitioned from pending to running — the Animator has dispatched the provider and the run is in flight.',
  },
  'animator.session.ended': {
    description:
      'A session has reached a terminal status (completed, failed, timeout, cancelled, or rate-limited). Payload carries exitCode, durationMs, costUsd, and (when present) error.',
  },
  'animator.session.record-failed': {
    description:
      'A SessionDoc / transcript write failed inside the Animator\'s session-record path. `phase` distinguishes the failing write: `insert` (initial running row), `write-record` (transcript JSON), or `update-row` (terminal overwrite).',
  },
};

// ── Apparatus resolution ─────────────────────────────────────────────

/**
 * Resolve the Clockworks at call time. Returns null when it is not
 * installed (animator declares clockworks in `recommends`, not
 * `requires`). Mirrors the lazy resolution `summon()` uses for
 * `LoomApi`. Delegates to the framework's `tryApparatus<T>` primitive
 * — the optional-dependency counterpart to `apparatus<T>`.
 */
function tryResolveClockworks(): ClockworksApi | null {
  return guild().tryApparatus<ClockworksApi>('clockworks');
}

// ── Best-effort emit ─────────────────────────────────────────────────

async function safeEmit(
  clockworks: ClockworksApi,
  name: string,
  payload: unknown,
): Promise<void> {
  try {
    await clockworks.emit(name, payload, FRAMEWORK_EMITTER);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[animator] best-effort emit of "${name}" failed: ${reason}`,
    );
  }
}

// ── Payload shape ────────────────────────────────────────────────────

interface SessionLifecyclePayload {
  sessionId: string;
  /**
   * Anima role recorded on the session's metadata, if present.
   * Populated from `metadata.role`. Omitted entirely when the data
   * model does not carry it ("skip-when-unset").
   */
  anima?: string;
  /** What kicked off the session, recorded on `metadata.trigger`. */
  trigger?: string;
  /** Terminal exit code (terminal-emit only). */
  exitCode?: number;
  /** Wall-clock duration in ms (terminal-emit only). */
  durationMs?: number;
  /** Cost in USD as reported by the provider (terminal-emit only). */
  costUsd?: number;
  /** Error message when the session failed. */
  error?: string;
  // NB: `workshop` and `workspaceKind` are intentionally omitted — the
  // data model does not carry those fields. "skip-when-unset" rule.
}

function buildBasePayload(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
): SessionLifecyclePayload {
  const out: SessionLifecyclePayload = { sessionId };
  if (metadata && typeof metadata.role === 'string') {
    out.anima = metadata.role;
  }
  if (metadata && typeof metadata.trigger === 'string') {
    out.trigger = metadata.trigger;
  }
  return out;
}

// ── Emit helpers ─────────────────────────────────────────────────────

/**
 * Emit `animator.session.started` for a session that has just begun
 * (in-process attached, detached `session-running` ready report, etc.).
 * The doc must carry the canonical `metadata` set by the caller
 * (`role`, `trigger`, etc.). No-op when Clockworks is not installed.
 */
export async function emitSessionStarted(doc: SessionDoc): Promise<void> {
  const clockworks = tryResolveClockworks();
  if (!clockworks) return;

  const payload = buildBasePayload(doc.id, doc.metadata);
  await safeEmit(clockworks, 'animator.session.started', payload);
}

/**
 * Emit `animator.session.ended` for a terminal session. Accepts either
 * a `SessionResult` (in-process path) or a `SessionDoc` (detached /
 * orphan-recovery paths) — they share the field set this helper reads.
 */
export async function emitSessionEnded(
  result: SessionResult | SessionDoc,
): Promise<void> {
  const clockworks = tryResolveClockworks();
  if (!clockworks) return;

  const metadata = result.metadata as Record<string, unknown> | undefined;
  const payload: SessionLifecyclePayload = buildBasePayload(result.id, metadata);

  if (typeof result.exitCode === 'number') payload.exitCode = result.exitCode;
  if (typeof result.durationMs === 'number') payload.durationMs = result.durationMs;
  if (typeof result.costUsd === 'number') payload.costUsd = result.costUsd;
  if (typeof result.error === 'string') payload.error = result.error;

  await safeEmit(clockworks, 'animator.session.ended', payload);
}

/**
 * Catalog-defined phases for a session-record-write failure (see
 * `docs/reference/event-catalog.md`).
 *
 *   - `'insert'`      — initial row write failed (the running-state
 *                       SessionDoc could not be created).
 *   - `'write-record'` — transcript JSON write failed.
 *   - `'update-row'`  — final / terminal SessionDoc overwrite failed.
 */
export type SessionRecordFailurePhase = 'insert' | 'write-record' | 'update-row';

/**
 * Emit `animator.session.record-failed` from the catch path of a
 * session-record write that itself failed.
 *
 * `phase` follows the catalog's three-phase taxonomy: `'insert'` for the
 * initial running-row write, `'update-row'` for terminal SessionDoc
 * overwrites, and `'write-record'` for transcript writes. Call sites
 * pass the phase that matches the failing write — see the catch sites
 * in `animator.ts` and `session-record-handler.ts` for examples.
 */
export async function emitSessionRecordFailed(
  sessionId: string,
  phase: SessionRecordFailurePhase,
  error: unknown,
): Promise<void> {
  const clockworks = tryResolveClockworks();
  if (!clockworks) return;

  const message = error instanceof Error ? error.message : String(error);
  await safeEmit(clockworks, 'animator.session.record-failed', {
    sessionId,
    phase,
    error: message,
  });
}

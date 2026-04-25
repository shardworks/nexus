/**
 * Shared session emission helpers.
 *
 * Every terminal session site (in-process attached dispatch, detached
 * `handleSessionRecord`, the detached `session-running` tool, orphan
 * recovery in `startup.ts`) routes through this module so the
 * `session.started`, `session.ended`, `session.record-failed`, and
 * `commission.session.ended` events fire from a single payload-shape
 * source of truth. Names follow the catalog (past tense) — see
 * `docs/reference/event-catalog.md`.
 *
 * Also fires the `anima.*` lifecycle events for sessions that carry an
 * anima `role` on their metadata: `anima.manifested` at the canonical
 * pending → running transition, `anima.session.ended` alongside the
 * terminal-emit pair. The catalog's other two `anima.*` events
 * (`anima.instantiated`, `anima.state.changed`) are deferred until the
 * Roster apparatus lands — there is no aspirant → active state machine
 * to observe today, so emitting from here would invent semantics. See
 * the README for the deferral.
 *
 * `ClockworksApi` is resolved lazily via `guild().apparatus()` inside a
 * try/catch. When the Clockworks is not installed (it is in Animator's
 * `recommends`, not `requires`) the helper silently no-ops — the same
 * idiom `summon()` already uses for `LoomApi`.
 *
 * Every `emit()` is wrapped in best-effort try/catch with a `console.warn`
 * breadcrumb (commission decision D13). A Clockworks emission failure
 * must never roll back the originating session-record write.
 *
 * `commissionId` for `commission.session.ended` is derived at emit time
 * by reading `metadata.writId` and walking the writ's `parentId` chain
 * to a root mandate (D6). Sessions without `metadata.writId` (or where
 * the chain doesn't resolve to a root mandate) emit `session.ended`
 * only.
 *
 * Payloads omit `workshop` and `workspaceKind` because the data model
 * doesn't carry those fields — D7's "skip-when-unset" rule.
 */

import { guild } from '@shardworks/nexus-core';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

import type { SessionDoc, SessionResult } from './types.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Plugin id used as the literal `emitter` value on every framework event. */
const FRAMEWORK_EMITTER = 'framework';

// ── Apparatus resolution ─────────────────────────────────────────────

/**
 * Resolve the Clockworks at call time. Returns null when it is not
 * installed (animator declares clockworks in `recommends`, not
 * `requires`). Mirrors the lazy resolution `summon()` uses for
 * `LoomApi`.
 */
function tryResolveClockworks(): ClockworksApi | null {
  try {
    return guild().apparatus<ClockworksApi>('clockworks');
  } catch {
    return null;
  }
}

/**
 * Resolve the Clerk at call time. Returns null when it isn't installed
 * — `commission.session.ended` simply does not fire in that case.
 */
function tryResolveClerk(): ClerkApi | null {
  try {
    return guild().apparatus<ClerkApi>('clerk');
  } catch {
    return null;
  }
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
   * Populated from `metadata.role`. Per D7, omitted entirely when the
   * data model does not carry it.
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
  // data model does not carry those fields. D7 "skip-when-unset".
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

// ── Commission discovery ─────────────────────────────────────────────

/**
 * Walk `metadata.writId` to the root mandate. Returns the root id when
 * the chain resolves to a root mandate (`type === 'mandate'` AND no
 * `parentId`); returns null otherwise — no `writId`, the writ doesn't
 * exist, the chain dead-ends at a non-mandate root, or Clerk isn't
 * installed.
 *
 * Per D6, `commission.session.ended` only fires when this returns a
 * non-null id.
 */
async function deriveCommissionIdForSession(
  metadata: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!metadata || typeof metadata.writId !== 'string') return null;
  const clerk = tryResolveClerk();
  if (!clerk) return null;

  let current: WritDoc;
  try {
    current = await clerk.show(metadata.writId);
  } catch {
    return null;
  }

  // Walk up to the root.
  while (current.parentId) {
    try {
      current = await clerk.show(current.parentId);
    } catch {
      return null;
    }
  }

  return current.type === 'mandate' ? current.id : null;
}

// ── Emit helpers ─────────────────────────────────────────────────────

/**
 * Emit `session.started` for a session that has just begun (in-process
 * attached, detached `session-running` ready report, etc.). When the
 * session's metadata carries a `role`, also emits `anima.manifested`
 * with the same payload — per the catalog: "an anima is launched for a
 * session". The doc must carry the canonical `metadata` set by the
 * caller (`role`, `trigger`, etc.). No-op when Clockworks is not
 * installed.
 */
export async function emitSessionStarted(doc: SessionDoc): Promise<void> {
  const clockworks = tryResolveClockworks();
  if (!clockworks) return;

  const payload = buildBasePayload(doc.id, doc.metadata);
  await safeEmit(clockworks, 'session.started', payload);

  // anima.manifested — catalog semantics: "an anima is launched for a
  // session". The pending → running transition is the precise moment
  // the anima becomes active in a session, so we co-emit here. We only
  // fire when an anima role is actually known; sessions without a role
  // (e.g. a detached `animate()` call with no metadata) don't have an
  // anima to announce.
  if (typeof payload.anima === 'string') {
    await safeEmit(clockworks, 'anima.manifested', payload);
  }
}

/**
 * Emit `session.ended` (and, when the chain resolves to a root mandate,
 * `commission.session.ended`) for a terminal session. When the session
 * carries an anima `role` on its metadata, also emits
 * `anima.session.ended` with the same payload. Accepts either a
 * `SessionResult` (in-process path) or a `SessionDoc` (detached /
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

  await safeEmit(clockworks, 'session.ended', payload);

  // anima.session.ended — co-emitted alongside `session.ended` when an
  // anima role is recorded on the session. Same payload as
  // `session.ended` so subscribers can switch on event name without
  // having to re-derive context.
  if (typeof payload.anima === 'string') {
    await safeEmit(clockworks, 'anima.session.ended', payload);
  }

  // Derive the root mandate via Clerk and emit
  // `commission.session.ended` when it resolves. Per D6 we degrade
  // cleanly when there is no `writId` or the chain doesn't lead to a
  // root mandate.
  const commissionId = await deriveCommissionIdForSession(metadata);
  if (commissionId !== null) {
    await safeEmit(clockworks, 'commission.session.ended', {
      ...payload,
      commissionId,
    });
  }
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
 * Emit `session.record-failed` from the catch path of a session-record
 * write that itself failed.
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
  await safeEmit(clockworks, 'session.record-failed', {
    sessionId,
    phase,
    error: message,
  });
}

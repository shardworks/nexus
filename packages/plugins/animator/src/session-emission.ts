/**
 * Shared session emission helpers.
 *
 * Every terminal session site (in-process attached dispatch, detached
 * `handleSessionRecord`, the detached `session-running` tool, orphan
 * recovery in `startup.ts`) routes through this module so the
 * `session.start`, `session.end`, `session.record-failed`, and
 * `commission.session.ended` events fire from a single payload-shape
 * source of truth.
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
 * Emit `session.start` for a session that has just begun (in-process
 * attached, detached `session-running` ready report, etc.). The doc must
 * carry the canonical `metadata` set by the caller (`role`, `trigger`,
 * etc.). No-op when Clockworks is not installed.
 */
export async function emitSessionStarted(doc: SessionDoc): Promise<void> {
  const clockworks = tryResolveClockworks();
  if (!clockworks) return;

  const payload = buildBasePayload(doc.id, doc.metadata);
  await safeEmit(clockworks, 'session.start', payload);
}

/**
 * Emit `session.end` (and, when the chain resolves to a root mandate,
 * `commission.session.ended`) for a terminal session. Accepts either a
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

  await safeEmit(clockworks, 'session.end', payload);

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

/** The `phase` of a session-record-write failure, mirroring the actual write site. */
export type SessionRecordFailurePhase = 'session-doc' | 'transcript';

/**
 * Emit `session.record-failed` from the catch path of a session-record
 * write that itself failed.
 *
 * Per D22, `phase` is `'session-doc'` or `'transcript'` mirroring the
 * current write-site name. The catalog's three-phase taxonomy doesn't
 * match the current code; that mismatch is documented here in a code
 * comment and surfaced as a follow-up observation.
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
    // NB: D22 — `phase` mirrors the current write-site name and diverges
    // from the catalog's three-phase taxonomy. Follow-up: align catalog
    // and code.
    phase,
    error: message,
  });
}

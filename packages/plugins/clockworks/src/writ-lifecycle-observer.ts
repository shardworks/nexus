/**
 * The Clockworks-owned CDC observer on `clerk/writs` that turns writ
 * lifecycle transitions into framework events.
 *
 * Two event families fire from this observer:
 *
 *   - **Writ-lifecycle events** — `{type}.{ready|completed|stuck|failed}`
 *     for every writ regardless of where it sits in the hierarchy. The
 *     observer maps the *target* phase to the catalog suffix per
 *     commission decision D2:
 *
 *       phase → open       ⇒ `{type}.ready`
 *       phase → stuck      ⇒ `{type}.stuck`
 *       phase → completed  ⇒ `{type}.completed`
 *       phase → failed     ⇒ `{type}.failed`
 *
 *     Transitions into `new` (D17) or `cancelled` (D3) are silent — the
 *     event catalog does not list those phases.
 *
 *   - **Commission events** for root mandates only (`type === 'mandate'`
 *     AND `parentId == null`) per D5/D15/D19:
 *
 *       entry → open       ⇒ `commission.posted`
 *       any phase change   ⇒ `commission.state.changed`
 *       entry → completed  ⇒ `commission.sealed` AND `commission.completed`
 *                            (the duplicate is intentional per D5; doc
 *                            consolidation is a follow-up observation)
 *       entry → failed     ⇒ `commission.failed`
 *
 * The observer accepts BOTH `create` and `update` events (D14): a writ
 * created directly in `open` phase via `post(draft=false)` fires
 * `{type}.ready` (and, for root mandates, `commission.posted`); subsequent
 * transitions fire from `update` events on real phase deltas. Stuck → open
 * re-entry re-emits `{type}.ready` per D21; the catalog says "ready" means
 * "available for dispatch" and an unstuck writ is again available.
 *
 * `commissionId` is derived at emit time by walking `parentId` to the
 * root via the writs book (D4). No `commissionId` column is added to
 * `WritDoc`.
 *
 * Every `emit()` is wrapped in a best-effort try/catch with a
 * `console.warn` breadcrumb (D13). A Clockworks emission failure must
 * never roll back the originating writ transition.
 *
 * The observer registers as a Phase 2 watcher (`failOnError: false`):
 * emission lives outside the writ-transition transaction so a slow events
 * book write cannot stall a writ transition, and a thrown error is
 * already swallowed by the per-emit try/catch above.
 */

import type { ChangeEvent, ReadOnlyBook } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

import type { ClockworksApi } from './types.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Plugin id used as the literal `emitter` value on every framework event. */
const FRAMEWORK_EMITTER = 'framework';

/**
 * Map a writ target phase to the writ-lifecycle suffix from the catalog.
 *
 * Accepts any phase string — `WritDoc.phase` is structurally typed as
 * `string` since plugin-registered writ types may carry non-canonical
 * state names (commit b98151f). Returns null for phases that are not
 * part of the catalog (`new`, `cancelled`, and any non-canonical phase
 * registered by a plugin), which the caller treats as "emit nothing".
 *
 * Non-canonical phases will need their own observation story (catalog
 * expansion, plugin-specific observer, etc.); silently ignoring them
 * here preserves the universal-lifecycle contract for canonical-phase
 * writs (mandate plus any plugin type that adopts the canonical state
 * names) while staying safe for the rest.
 */
function lifecycleSuffix(phase: string): string | null {
  switch (phase) {
    case 'open':
      return 'ready';
    case 'stuck':
      return 'stuck';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'new':
    case 'cancelled':
      return null;
    default:
      return null;
  }
}

/**
 * Walk `parentId` to the root and return the root writ's id. For a writ
 * with no parent, returns its own id. Bounded by the depth of the tree
 * — Clerk's parentId-immutability invariant is assumed; no cycle guard
 * is needed.
 *
 * Reads tolerate the parent disappearing mid-walk (a rare race against
 * deletion) by stopping at the last reachable ancestor and returning
 * its id.
 */
async function deriveCommissionId(
  writsBook: ReadOnlyBook<WritDoc>,
  writ: WritDoc,
): Promise<string> {
  let current: WritDoc = writ;
  while (current.parentId) {
    const parent = await writsBook.get(current.parentId);
    if (!parent) return current.id;
    current = parent;
  }
  return current.id;
}

/** A root mandate is the entry point for the `commission.*` namespace. */
function isRootMandate(writ: WritDoc): boolean {
  return writ.type === 'mandate' && !writ.parentId;
}

// ── Observer ─────────────────────────────────────────────────────────

export interface WritLifecycleObserverDeps {
  readonly clockworks: ClockworksApi;
  readonly writsBook: ReadOnlyBook<WritDoc>;
}

/**
 * Best-effort emit — swallows any error from the Clockworks write path
 * with a `console.warn` breadcrumb. Decision D13: an emission failure
 * must never propagate back to the originating writ transition.
 */
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
      `[clockworks] best-effort emit of "${name}" failed: ${reason}`,
    );
  }
}

/**
 * React to a single CDC event on `clerk/writs` and fire the writ-lifecycle
 * and commission events that correspond to the target phase.
 *
 * Exported so unit tests can drive the observer directly with synthetic
 * events without exercising the Stacks CDC machinery.
 */
export async function handleWritLifecycle(
  deps: WritLifecycleObserverDeps,
  event: ChangeEvent<WritDoc>,
): Promise<void> {
  if (event.type === 'delete') return;

  const writ = event.entry;

  // For update events gate emission on a real phase delta. Metadata-only
  // patches (title rename, codex inheritance, etc.) must not produce
  // lifecycle events. For create events the "delta" is the writ entering
  // existence at its initial phase.
  if (event.type === 'update') {
    if (writ.phase === event.prev.phase) return;
  }

  const suffix = lifecycleSuffix(writ.phase);
  if (suffix === null) {
    // No catalog entry for this phase — `new` (drafts) and `cancelled`
    // are silent per D3 / D17.
    return;
  }

  // Derive commissionId by walking parentId. Done once per fire and
  // shared between writ-lifecycle and commission emissions.
  let commissionId: string;
  try {
    commissionId = await deriveCommissionId(deps.writsBook, writ);
  } catch (err) {
    // A writs-book read failure is unexpected at this layer; degrade by
    // tagging the writ's own id and continuing — emission must remain
    // best-effort per D13.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[clockworks] failed to derive commissionId for writ "${writ.id}": ${reason}`,
    );
    commissionId = writ.id;
  }

  // ── Writ-lifecycle event ───────────────────────────────────────────
  const lifecycleName = `${writ.type}.${suffix}`;
  await safeEmit(deps.clockworks, lifecycleName, {
    writId: writ.id,
    writType: writ.type,
    phase: writ.phase,
    commissionId,
    title: writ.title,
    ...(writ.parentId !== undefined ? { parentId: writ.parentId } : {}),
  });

  // ── Commission events (root mandates only — D5/D15/D19) ───────────
  if (!isRootMandate(writ)) return;

  const commissionPayloadBase = {
    commissionId: writ.id,
    writId: writ.id,
    phase: writ.phase,
    title: writ.title,
  };

  // `commission.posted` fires every time a root mandate enters `open`
  // (D15) — direct creation in open OR new → open via writ-publish OR
  // stuck → open re-entry. The catalog uses "posted" to mean "in the
  // queue", which is exactly the meaning of phase entry into `open`.
  if (writ.phase === 'open') {
    await safeEmit(deps.clockworks, 'commission.posted', commissionPayloadBase);
  }

  // Every phase change on a root mandate fires a `state.changed` event.
  // For `create` events this is the initial phase entry; for `update`
  // events the phase delta was already gated above.
  await safeEmit(deps.clockworks, 'commission.state.changed', {
    ...commissionPayloadBase,
    ...(event.type === 'update' ? { previousPhase: event.prev.phase } : {}),
  });

  // Both `commission.sealed` AND `commission.completed` fire on entry
  // into `completed` (D5). Documenting the sealed/completed duplicate
  // is a follow-up observation; this commission ships both as the
  // catalog enumerates them.
  if (writ.phase === 'completed') {
    await safeEmit(deps.clockworks, 'commission.sealed', commissionPayloadBase);
    await safeEmit(deps.clockworks, 'commission.completed', commissionPayloadBase);
  }

  if (writ.phase === 'failed') {
    await safeEmit(deps.clockworks, 'commission.failed', {
      ...commissionPayloadBase,
      ...(typeof writ.resolution === 'string' ? { resolution: writ.resolution } : {}),
    });
  }
}

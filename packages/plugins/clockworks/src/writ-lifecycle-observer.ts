/**
 * The Clockworks-owned CDC observer on `clerk/writs` that turns writ
 * lifecycle transitions into framework events.
 *
 * Universal contract: every writ status transition fires exactly one
 * `writ.<type>.<phase>` event whose suffix is the writ's `phase`
 * verbatim. The contract is uniform across the builtin `mandate` type
 * and any plugin-registered writ type — entry into `new` (draft
 * creation), entry into `cancelled` (cancellation), and every active
 * transition all fire. Metadata-only patches (title rename, codex
 * inheritance, etc.) are gated by the same per-update phase-delta check
 * the previous observer used: an update event whose `phase` is
 * unchanged emits nothing.
 *
 * Payload shape is unchanged from the prior `{type}.<canonical-suffix>`
 * vocabulary: every emitted row carries
 *
 *   {
 *     writId,        // the writ's id
 *     writType,      // its registered writ-type name
 *     phase,         // verbatim from the writ
 *     commissionId,  // root-walk via parentId; preserved per the brief
 *     title,         // the writ's title
 *     parentId?,     // present when the writ has a parent
 *   }
 *
 * `commissionId` is derived at emit time by walking `parentId` to the
 * root via the writs book — a name kept verbatim so subscribers that
 * already keyed on the field continue to work. Renaming the field to a
 * more precise name is a deferred follow-up.
 *
 * Every `emit()` is wrapped in a best-effort try/catch with a
 * `console.warn` breadcrumb. A Clockworks emission failure must never
 * roll back the originating writ transition.
 *
 * The observer registers as a Phase 2 watcher (`failOnError: false`):
 * emission lives outside the writ-transition transaction so a slow
 * events book write cannot stall a writ transition, and a thrown error
 * is already swallowed by the per-emit try/catch above.
 */

import type { ChangeEvent, ReadOnlyBook } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

import type { ClockworksApi } from './types.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Plugin id used as the literal `emitter` value on every framework event. */
const FRAMEWORK_EMITTER = 'framework';

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

// ── Observer ─────────────────────────────────────────────────────────

interface WritLifecycleObserverDeps {
  readonly clockworks: ClockworksApi;
  readonly writsBook: ReadOnlyBook<WritDoc>;
}

/**
 * Best-effort emit — swallows any error from the Clockworks write path
 * with a `console.warn` breadcrumb. An emission failure must never
 * propagate back to the originating writ transition.
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
 * React to a single CDC event on `clerk/writs` and fire the
 * `writ.<type>.<phase>` event for the target phase.
 *
 * Exported so unit tests can drive the observer directly with synthetic
 * events without exercising the Stacks CDC machinery.
 */
export async function handleWritLifecycle(
  deps: WritLifecycleObserverDeps,
  event: ChangeEvent<WritDoc>,
): Promise<void> {
  // Only row-level create/update carry the writ payload that drives
  // lifecycle emission. Row-level `delete` and book-level `delete-book`
  // are intentional no-ops here — the writs book is never dropped at
  // runtime, but the union exhaustiveness still has to be honoured.
  if (event.type !== 'create' && event.type !== 'update') return;

  const writ = event.entry;

  // For update events gate emission on a real phase delta. Metadata-only
  // patches (title rename, codex inheritance, etc.) must not produce
  // lifecycle events. For create events the "delta" is the writ entering
  // existence at its initial phase.
  if (event.type === 'update') {
    if (writ.phase === event.prev.phase) return;
  }

  // Derive commissionId by walking parentId. Done once per fire and
  // included on every emitted payload (the field name is preserved
  // verbatim from the prior contract).
  let commissionId: string;
  try {
    commissionId = await deriveCommissionId(deps.writsBook, writ);
  } catch (err) {
    // A writs-book read failure is unexpected at this layer; degrade by
    // tagging the writ's own id and continuing — emission must remain
    // best-effort.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[clockworks] failed to derive commissionId for writ "${writ.id}": ${reason}`,
    );
    commissionId = writ.id;
  }

  // ── Universal `writ.<type>.<phase>` emit ──────────────────────────
  //
  // The suffix is the writ's `phase` verbatim — no canonical-phase
  // mapping, no silent gating on `new` / `cancelled`. Per D9 we trust
  // the substrate: if `phase` somehow drifts off the type's declared
  // states, the row still lands and operators see drift by name rather
  // than via a silent skip. Per D5/D6 the contract fires on entry into
  // `new` (draft creation) and `cancelled` (cancellation) too.
  const lifecycleName = `writ.${writ.type}.${writ.phase}`;
  await safeEmit(deps.clockworks, lifecycleName, {
    writId: writ.id,
    writType: writ.type,
    phase: writ.phase,
    commissionId,
    title: writ.title,
    ...(writ.parentId !== undefined ? { parentId: writ.parentId } : {}),
  });
}

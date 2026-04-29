/**
 * Reckoner staleness-diagnostic snapshot.
 *
 * The Reckoner-owned sub-slot of `WritDoc.status` (`status['reckoner']`)
 * is a derived snapshot maintained by a Phase-2 CDC watcher on the
 * Reckoner's own `reckonings` book. Every `create` event on that book
 * runs through the handler factory below, which re-derives the writ's
 * snapshot via the pure `computeNextStatus()` function and writes it
 * back through `clerk.setWritStatus(writId, 'reckoner', next)`.
 *
 * The split between `computeNextStatus()` (pure) and
 * `createStalenessHandler()` (the CDC factory) mirrors
 * `clerk/children-behavior-engine.ts` — derived-observation handlers
 * live in a sibling module so the apparatus core stays thin and the
 * pure helper is testable in isolation.
 *
 * **Phase-2 watcher.** The watcher is registered in the apparatus's
 * `start()` with `{ failOnError: false }`. A snapshot-write failure
 * must never roll back the journal entry that drove it — the
 * Reckonings row is the durable record; the snapshot is best-effort
 * derived state.
 *
 * **Fail-loud on shape mismatch.** Per the patron override (D8), when
 * a pre-existing `writ.status['reckoner']` block fails to type-narrow
 * against the current `ReckonerStatus` shape, `computeNextStatus()`
 * throws. The handler does not catch that throw — it propagates to
 * the Stacks Phase-2 error path so migration drift surfaces loudly
 * rather than masquerading as silent data loss. (`setWritStatus`
 * failures, by contrast, are caught and logged with a `[reckoner]`
 * prefix per D14/D18.)
 *
 * See: docs/architecture/apparatus/reckoner.md §"Staleness diagnostic"
 * and the originating commission brief.
 */

import type { ChangeEvent } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import type {
  ReckonerStatus,
  ReckoningDeferReason,
  ReckoningDoc,
  ReckoningOutcome,
} from './types.ts';
import { RECKONER_STATUS_SLOT } from './types.ts';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Closed enum of recognized Reckoner outcomes used by the shape
 * validator. Mirrors the `ReckoningOutcome` type byte-for-byte.
 */
const RECKONING_OUTCOME_VALUES: readonly ReckoningOutcome[] = [
  'accepted',
  'deferred',
  'declined',
  'no-op',
];

/**
 * Closed enum of recognized defer reasons. Mirrors the
 * `ReckoningDeferReason` type byte-for-byte.
 */
const RECKONING_DEFER_REASON_VALUES: readonly ReckoningDeferReason[] = [
  'priority',
  'queue_depth',
  'time_hold',
  'patron_policy',
  'dependency_pending',
  'dependency_failed',
  'other',
];

// ── Shape validation (D8) ─────────────────────────────────────────────

/**
 * Validate a pre-existing `writ.status['reckoner']` block against the
 * current `ReckonerStatus` shape. Throws fail-loud (D8, patron
 * override) on shape drift so a migration-induced mismatch surfaces
 * visibly instead of being silently absorbed.
 *
 * Returns nothing on success; the caller may then treat `prior` as
 * `ReckonerStatus`.
 */
function validatePriorSnapshot(prior: unknown, writId: string): asserts prior is ReckonerStatus {
  if (typeof prior !== 'object' || prior === null || Array.isArray(prior)) {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" has a malformed status['reckoner'] block — expected an object, got ${
        prior === null ? 'null' : Array.isArray(prior) ? 'array' : typeof prior
      }.`,
    );
  }
  const block = prior as Record<string, unknown>;

  if (typeof block.decision !== 'string') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].decision must be a string (got ${typeof block.decision}).`,
    );
  }
  if (!(RECKONING_OUTCOME_VALUES as readonly string[]).includes(block.decision)) {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].decision "${block.decision}" is not a recognized ReckoningOutcome (expected one of ${RECKONING_OUTCOME_VALUES.map((v) => `"${v}"`).join(', ')}).`,
    );
  }
  if (typeof block.lastEvaluatedAt !== 'string') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].lastEvaluatedAt must be an ISO string (got ${typeof block.lastEvaluatedAt}).`,
    );
  }

  if (block.deferReason !== undefined) {
    if (typeof block.deferReason !== 'string') {
      throw new Error(
        `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].deferReason must be a string when present (got ${typeof block.deferReason}).`,
      );
    }
    if (!(RECKONING_DEFER_REASON_VALUES as readonly string[]).includes(block.deferReason)) {
      throw new Error(
        `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].deferReason "${block.deferReason}" is not a recognized ReckoningDeferReason.`,
      );
    }
  }
  if (block.deferCount !== undefined && typeof block.deferCount !== 'number') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].deferCount must be a number when present (got ${typeof block.deferCount}).`,
    );
  }
  if (block.firstDeferredAt !== undefined && typeof block.firstDeferredAt !== 'string') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].firstDeferredAt must be an ISO string when present (got ${typeof block.firstDeferredAt}).`,
    );
  }
  if (block.lastDeferredAt !== undefined && typeof block.lastDeferredAt !== 'string') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].lastDeferredAt must be an ISO string when present (got ${typeof block.lastDeferredAt}).`,
    );
  }
  if (block.stalled !== undefined && typeof block.stalled !== 'boolean') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].stalled must be a boolean when present (got ${typeof block.stalled}).`,
    );
  }
  if (block.stalledReason !== undefined) {
    if (typeof block.stalledReason !== 'string') {
      throw new Error(
        `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].stalledReason must be a string when present (got ${typeof block.stalledReason}).`,
      );
    }
    if (block.stalledReason !== 'dependency_failed') {
      throw new Error(
        `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].stalledReason "${block.stalledReason}" is not a recognized ReckonerStalledReason (expected "dependency_failed").`,
      );
    }
  }
  if (block.stalledSince !== undefined && typeof block.stalledSince !== 'string') {
    throw new Error(
      `[reckoner] staleness snapshot: writ "${writId}" status['reckoner'].stalledSince must be an ISO string when present (got ${typeof block.stalledSince}).`,
    );
  }
}

// ── Pure snapshot derivation (D9, D10, D11, D12, D17, D19) ───────────

/**
 * Derive the next `ReckonerStatus` snapshot from the prior snapshot
 * (which may be `undefined` on the first row, or shape-mismatched on
 * a migration boundary) and a freshly-created Reckonings row.
 *
 * Per D8 (patron override), shape drift on `prior` throws fail-loud
 * — there is no defensive merge or best-effort fallback path.
 *
 * Per D9, `deferCount` advances only when `row.outcome === 'deferred'`.
 * No-op rows and terminal rows do not advance the counter.
 *
 * Per D10, the running counters are preserved verbatim across the
 * `deferred → accepted` and `deferred → declined` transitions. The
 * counters record historical deferrals; clearing them on a terminal
 * decision would lose the "deferred N times before being accepted"
 * signal.
 *
 * Per D11, the stalled-flag transitions are:
 *   - false → true: `stalledSince` set to the row's `consideredAt`.
 *   - true → true: `stalledSince` preserved verbatim.
 *   - any → false: `stalled` and `stalledSince` cleared.
 *
 * Per D12, the v0 `stalledReason` enum is the singleton literal
 * `'dependency_failed'`.
 *
 * Per D17, the threshold gate is `defer_count >= 1` for
 * `dependency_failed`.
 *
 * Per D19, `'no-op'` rows are handled uniformly through this
 * function: lastEvaluatedAt advances, every other field is preserved
 * verbatim from `prior`. The handler does not branch on outcome
 * before invoking the function.
 */
export function computeNextStatus(
  prior: ReckonerStatus | undefined,
  row: ReckoningDoc,
): ReckonerStatus {
  // Validate prior shape on every call where prior is defined. The
  // validator is also (and primarily) the entry point for the patron-
  // override fail-loud path: a pre-existing block that no longer
  // type-narrows surfaces here as a thrown error.
  if (prior !== undefined) {
    validatePriorSnapshot(prior, row.writId);
  }

  // ── No-op outcome (D19) ───────────────────────────────────────────
  //
  // No state change; only the "when did the Reckoner last consider
  // this writ?" timestamp advances. Every other field is preserved
  // verbatim from `prior` so a no-op interleaved between meaningful
  // rows does not erase the writ's running counters or stalled flag.
  if (row.outcome === 'no-op') {
    if (prior === undefined) {
      return {
        decision: 'no-op',
        lastEvaluatedAt: row.consideredAt,
      };
    }
    return {
      ...prior,
      lastEvaluatedAt: row.consideredAt,
    };
  }

  // ── Counter rollover (D9, D10) ────────────────────────────────────
  //
  // Carry the prior counters forward as the baseline. For a
  // `'deferred'` row the counters advance below; for `'accepted'` /
  // `'declined'` rows the prior values are preserved verbatim per D10.
  let deferCount = prior?.deferCount;
  let firstDeferredAt = prior?.firstDeferredAt;
  let lastDeferredAt = prior?.lastDeferredAt;

  if (row.outcome === 'deferred') {
    deferCount = (deferCount ?? 0) + 1;
    if (firstDeferredAt === undefined) {
      firstDeferredAt = row.consideredAt;
    }
    lastDeferredAt = row.consideredAt;
  }

  // ── Stalled-flag (D11, D12, D17) ─────────────────────────────────
  //
  // v0 sets the stalled flag iff the most-recent row is a deferred
  // row carrying `dependency_failed` AND `defer_count >= 1` (the v0
  // threshold per D17). Any other outcome shape clears the flag and
  // the `stalledSince` marker.
  let stalled: true | undefined;
  let stalledReason: 'dependency_failed' | undefined;
  let stalledSince: string | undefined;

  const meetsStaleThreshold =
    row.outcome === 'deferred' &&
    row.deferReason === 'dependency_failed' &&
    (deferCount ?? 0) >= 1;

  if (meetsStaleThreshold) {
    stalled = true;
    stalledReason = 'dependency_failed';
    if (prior?.stalled === true && prior.stalledSince !== undefined) {
      // true → true: preserve `stalledSince` verbatim.
      stalledSince = prior.stalledSince;
    } else {
      // false → true (or undefined → true): set `stalledSince` to the
      // row's `consideredAt`.
      stalledSince = row.consideredAt;
    }
  }
  // Else: any → false; both stalled and stalledSince stay undefined,
  // which clears them on the rebuilt snapshot.

  // ── Build the result ──────────────────────────────────────────────
  //
  // Optional fields are only set when their value is meaningful so
  // the on-disk snapshot never carries `undefined` keys.
  const result: ReckonerStatus = {
    decision: row.outcome,
    lastEvaluatedAt: row.consideredAt,
  };

  if (row.outcome === 'deferred' && row.deferReason !== undefined) {
    result.deferReason = row.deferReason;
  }
  if (deferCount !== undefined) {
    result.deferCount = deferCount;
  }
  if (firstDeferredAt !== undefined) {
    result.firstDeferredAt = firstDeferredAt;
  }
  if (lastDeferredAt !== undefined) {
    result.lastDeferredAt = lastDeferredAt;
  }
  if (stalled === true) {
    result.stalled = true;
    if (stalledReason !== undefined) {
      result.stalledReason = stalledReason;
    }
    if (stalledSince !== undefined) {
      result.stalledSince = stalledSince;
    }
  }

  return result;
}

// ── CDC handler factory (D2, D6, D13, D14, D18) ──────────────────────

/**
 * Dependencies the staleness handler needs from the surrounding
 * Reckoner runtime. The same `clerk` handle the apparatus uses for
 * `transition()` and `setWritStatus()` is threaded in here.
 */
export interface StalenessHandlerDeps {
  clerk: ClerkApi;
}

/**
 * Build the staleness-snapshot CDC handler. Returns an async
 * function suitable for passing to
 * `stacks.watch('reckoner', 'reckonings', handler, { failOnError: false })`.
 *
 * Per D13, the handler filters to `event.type === 'create'` and
 * returns early on any other event type — the Reckonings book is
 * append-only-immutable by contract, so non-create events would
 * indicate substrate drift and are ignored.
 *
 * Per D2, the next snapshot is written via
 * `clerk.setWritStatus(writId, 'reckoner', next)` — the sanctioned
 * slot-write path on the `status` map.
 *
 * Per D14, `setWritStatus` failures (and the writ-not-found case
 * called out by D18) are caught with an inline try/catch and logged
 * with a `[reckoner]` prefix and the offending writ id. The Phase-2
 * watcher's own error log path would lose the `[reckoner]` prefix;
 * rewrapping here keeps grep affinity with the rest of the
 * apparatus's diagnostics.
 *
 * Shape-mismatch errors thrown by `computeNextStatus()` are NOT
 * caught — they propagate to Stacks' Phase-2 error path so migration
 * drift is loud, per the patron override on D8.
 */
export function createStalenessHandler(
  deps: StalenessHandlerDeps,
): (event: ChangeEvent<ReckoningDoc>) => Promise<void> {
  const { clerk } = deps;

  return async function handle(event: ChangeEvent<ReckoningDoc>): Promise<void> {
    // D13: process only create events. The Reckonings book is
    // append-only-immutable by contract; updates and deletes here
    // would indicate substrate drift and should be ignored.
    if (event.type !== 'create') return;

    const row = event.entry;
    const writId = row.writId;

    // Read the prior snapshot off the writ's current status sub-slot.
    // We could refresh this through `clerk.show(writId)` to get the
    // freshest read-modify-write basis; reading via `clerk.show()`
    // also lets us catch the writ-not-found case (D18) before
    // attempting the slot write.
    let prior: ReckonerStatus | undefined;
    try {
      const writ = await clerk.show(writId);
      const slot = writ.status?.[RECKONER_STATUS_SLOT];
      if (slot !== undefined) {
        // Note: the type assertion is unsafe by design — the validator
        // in computeNextStatus() is the trust boundary. Passing
        // through as `unknown`-equivalent here so the validator
        // throws fail-loud on shape drift rather than the assertion
        // silently coercing.
        prior = slot as ReckonerStatus | undefined;
      }
    } catch (err) {
      // Writ-not-found (or any other read failure): log with the
      // `[reckoner]` prefix per D18 and skip. The journal stands.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] staleness snapshot: writ "${writId}" cannot be read for snapshot derivation (skipping): ${msg}`,
      );
      return;
    }

    // Compute the next snapshot. computeNextStatus() may throw on a
    // shape-mismatched prior — let that propagate so Stacks' Phase-2
    // path surfaces the migration drift loudly (D8).
    const next = computeNextStatus(prior, row);

    // Write the snapshot back through the sanctioned slot-write API.
    // Inline try/catch per D14: any failure here is logged with the
    // `[reckoner]` prefix and the offending writ id. The journal is
    // already committed; the snapshot is best-effort derived state.
    try {
      await clerk.setWritStatus(writId, RECKONER_STATUS_SLOT, next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] staleness snapshot: failed to persist snapshot for writ "${writId}": ${msg}`,
      );
    }
  };
}

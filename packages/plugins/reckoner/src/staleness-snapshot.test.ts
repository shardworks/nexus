/**
 * Reckoner staleness snapshot — pure-function unit tests.
 *
 * Drives `computeNextStatus()` with synthetic Reckonings rows and
 * asserts on the resulting `ReckonerStatus` shape. Tests are
 * organized around the eight enumerated behavioral cases plus the
 * shape-mismatch fail-loud path:
 *
 *   1. First dependency_failed row → flagged stalled, deferCount=1,
 *      stalledSince matches row consideredAt.
 *   2. First dependency_pending row → not stalled, deferCount=1.
 *   3. dependency_failed → dependency_pending: clears stalled and
 *      stalledSince, preserves deferCount.
 *   4. dependency_pending → dependency_failed: stalled becomes true
 *      with stalledSince taking the new row's consideredAt.
 *   5. dependency_failed → dependency_failed (same shape): stalled
 *      stays true, stalledSince preserved verbatim, deferCount
 *      increments.
 *   6. deferred → accepted: counters preserved, decision flips,
 *      stalled clears.
 *   7. deferred → declined: counters preserved, decision flips,
 *      stalled clears.
 *   8. no-op row: lastEvaluatedAt advances, deferCount preserved
 *      verbatim, stalled state preserved verbatim.
 *   + Shape-mismatch on prior throws fail-loud (D8).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeNextStatus } from './staleness-snapshot.ts';
import type {
  ReckoningDoc,
  ReckonerStatus,
} from './types.ts';

// ── Synthetic-row helpers ────────────────────────────────────────────

/**
 * Build a synthetic Reckonings row with sensible defaults so each
 * test can supply just the fields it cares about. The row schema is
 * faithful to `ReckoningDoc` — every required field is populated.
 */
function makeRow(overrides: Partial<ReckoningDoc> & {
  outcome: ReckoningDoc['outcome'];
  consideredAt: string;
  writId?: string;
}): ReckoningDoc {
  const writId = overrides.writId ?? 'w-test';
  return {
    id: `rk-test-${overrides.consideredAt}`,
    writId,
    writUpdatedAt: overrides.consideredAt,
    source: 'tester.dep',
    visionRelation: 'vision-neutral',
    severity: 'minor',
    ...overrides,
  } as ReckoningDoc;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('computeNextStatus — pure snapshot derivation', () => {
  // ── Case 1: first dependency_failed row → stalled ──────────────────
  it('flags stalled on first dependency_failed row', () => {
    const row = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const next = computeNextStatus(undefined, row);
    assert.equal(next.decision, 'deferred');
    assert.equal(next.deferReason, 'dependency_failed');
    assert.equal(next.deferCount, 1);
    assert.equal(next.firstDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(next.lastDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(next.stalled, true);
    assert.equal(next.stalledReason, 'dependency_failed');
    assert.equal(next.stalledSince, '2026-04-29T12:00:00.000Z');
    assert.equal(next.lastEvaluatedAt, '2026-04-29T12:00:00.000Z');
  });

  // ── Case 2: first dependency_pending row → not stalled ─────────────
  it('does not flag stalled on dependency_pending', () => {
    const row = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_pending',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const next = computeNextStatus(undefined, row);
    assert.equal(next.decision, 'deferred');
    assert.equal(next.deferReason, 'dependency_pending');
    assert.equal(next.deferCount, 1);
    assert.equal(next.stalled, undefined);
    assert.equal(next.stalledReason, undefined);
    assert.equal(next.stalledSince, undefined);
  });

  // ── Case 3: dependency_failed → dependency_pending clears stalled ─
  it('clears stalled and stalledSince when dep set transitions failed → pending', () => {
    const failedRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, failedRow);
    assert.equal(after1.stalled, true);
    assert.equal(after1.stalledSince, '2026-04-29T12:00:00.000Z');

    const pendingRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_pending',
      consideredAt: '2026-04-29T12:01:00.000Z',
    });
    const after2 = computeNextStatus(after1, pendingRow);
    assert.equal(after2.decision, 'deferred');
    assert.equal(after2.deferReason, 'dependency_pending');
    assert.equal(after2.stalled, undefined);
    assert.equal(after2.stalledSince, undefined);
    // deferCount preserved + advanced
    assert.equal(after2.deferCount, 2);
    // firstDeferredAt preserved across the transition
    assert.equal(after2.firstDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(after2.lastDeferredAt, '2026-04-29T12:01:00.000Z');
  });

  // ── Case 4: dependency_pending → dependency_failed sets stalled ───
  it('sets stalled with stalledSince matching the new row when dep set transitions pending → failed', () => {
    const pendingRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_pending',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, pendingRow);
    assert.equal(after1.stalled, undefined);

    const failedRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:01:00.000Z',
    });
    const after2 = computeNextStatus(after1, failedRow);
    assert.equal(after2.stalled, true);
    assert.equal(after2.stalledReason, 'dependency_failed');
    assert.equal(after2.stalledSince, '2026-04-29T12:01:00.000Z');
    assert.equal(after2.deferCount, 2);
    assert.equal(after2.firstDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(after2.lastDeferredAt, '2026-04-29T12:01:00.000Z');
  });

  // ── Case 5: dependency_failed → dependency_failed preserves stalledSince ─
  it('preserves stalledSince across consecutive dependency_failed rows', () => {
    const row1 = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, row1);
    assert.equal(after1.stalledSince, '2026-04-29T12:00:00.000Z');

    const row2 = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:05:00.000Z',
    });
    const after2 = computeNextStatus(after1, row2);
    assert.equal(after2.stalled, true);
    // stalledSince preserved verbatim (true → true rule)
    assert.equal(after2.stalledSince, '2026-04-29T12:00:00.000Z');
    // deferCount advances
    assert.equal(after2.deferCount, 2);
    // lastDeferredAt updates to the new row
    assert.equal(after2.lastDeferredAt, '2026-04-29T12:05:00.000Z');
    // firstDeferredAt preserved
    assert.equal(after2.firstDeferredAt, '2026-04-29T12:00:00.000Z');
  });

  // ── Case 6: deferred → accepted preserves counters, clears stalled ─
  it('preserves counters and clears stalled across deferred → accepted', () => {
    const failedRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, failedRow);
    assert.equal(after1.deferCount, 1);
    assert.equal(after1.stalled, true);

    const acceptedRow = makeRow({
      outcome: 'accepted',
      consideredAt: '2026-04-29T12:05:00.000Z',
    });
    const after2 = computeNextStatus(after1, acceptedRow);
    assert.equal(after2.decision, 'accepted');
    assert.equal(after2.deferReason, undefined);
    // Counters preserved verbatim — historical record
    assert.equal(after2.deferCount, 1);
    assert.equal(after2.firstDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(after2.lastDeferredAt, '2026-04-29T12:00:00.000Z');
    // stalled cleared
    assert.equal(after2.stalled, undefined);
    assert.equal(after2.stalledReason, undefined);
    assert.equal(after2.stalledSince, undefined);
    // lastEvaluatedAt bumped
    assert.equal(after2.lastEvaluatedAt, '2026-04-29T12:05:00.000Z');
  });

  // ── Case 7: deferred → declined preserves counters, clears stalled ─
  it('preserves counters and clears stalled across deferred → declined', () => {
    const failedRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, failedRow);

    const declinedRow = makeRow({
      outcome: 'declined',
      declineReason: 'other',
      consideredAt: '2026-04-29T12:05:00.000Z',
    });
    const after2 = computeNextStatus(after1, declinedRow);
    assert.equal(after2.decision, 'declined');
    assert.equal(after2.deferCount, 1);
    assert.equal(after2.firstDeferredAt, '2026-04-29T12:00:00.000Z');
    assert.equal(after2.stalled, undefined);
  });

  // ── Case 8: no-op row preserves everything except lastEvaluatedAt ──
  it('bumps lastEvaluatedAt only on a no-op row; counters and stalled state preserved', () => {
    const failedRow = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_failed',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const after1 = computeNextStatus(undefined, failedRow);
    assert.equal(after1.deferCount, 1);
    assert.equal(after1.stalled, true);

    const noOpRow = makeRow({
      outcome: 'no-op',
      consideredAt: '2026-04-29T12:01:00.000Z',
    });
    const after2 = computeNextStatus(after1, noOpRow);
    // lastEvaluatedAt advances
    assert.equal(after2.lastEvaluatedAt, '2026-04-29T12:01:00.000Z');
    // deferCount unchanged
    assert.equal(after2.deferCount, 1);
    // stalled preserved verbatim
    assert.equal(after2.stalled, true);
    assert.equal(after2.stalledReason, 'dependency_failed');
    assert.equal(after2.stalledSince, '2026-04-29T12:00:00.000Z');
    // decision preserved verbatim — no-op is not a state change
    assert.equal(after2.decision, 'deferred');
    assert.equal(after2.deferReason, 'dependency_failed');
  });

  // ── No-op with no prior produces a minimal snapshot ────────────────
  it('produces a minimal snapshot when the very first row is a no-op', () => {
    const row = makeRow({
      outcome: 'no-op',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });
    const next = computeNextStatus(undefined, row);
    assert.equal(next.decision, 'no-op');
    assert.equal(next.lastEvaluatedAt, '2026-04-29T12:00:00.000Z');
    assert.equal(next.deferCount, undefined);
    assert.equal(next.stalled, undefined);
  });

  // ── Shape-mismatch on prior throws (D8, patron override) ───────────
  describe('shape-mismatch on prior throws fail-loud (D8)', () => {
    const row = makeRow({
      outcome: 'deferred',
      deferReason: 'dependency_pending',
      consideredAt: '2026-04-29T12:00:00.000Z',
    });

    it('throws when prior is not an object', () => {
      assert.throws(
        () => computeNextStatus('not-an-object' as unknown as ReckonerStatus, row),
        /\[reckoner\] staleness snapshot:.*malformed/,
      );
    });

    it('throws when prior is null', () => {
      assert.throws(
        () => computeNextStatus(null as unknown as ReckonerStatus, row),
        /\[reckoner\] staleness snapshot:.*malformed/,
      );
    });

    it('throws when prior.decision is missing', () => {
      const malformed = { lastEvaluatedAt: '2026-04-29T12:00:00.000Z' } as unknown as ReckonerStatus;
      assert.throws(
        () => computeNextStatus(malformed, row),
        /\[reckoner\] staleness snapshot:.*decision/,
      );
    });

    it('throws when prior.decision is not a recognized outcome', () => {
      const malformed = {
        decision: 'made-up-outcome',
        lastEvaluatedAt: '2026-04-29T12:00:00.000Z',
      } as unknown as ReckonerStatus;
      assert.throws(
        () => computeNextStatus(malformed, row),
        /\[reckoner\] staleness snapshot:.*decision "made-up-outcome"/,
      );
    });

    it('throws when prior.lastEvaluatedAt is missing', () => {
      const malformed = { decision: 'deferred' } as unknown as ReckonerStatus;
      assert.throws(
        () => computeNextStatus(malformed, row),
        /\[reckoner\] staleness snapshot:.*lastEvaluatedAt/,
      );
    });

    it('throws when prior.deferCount is the wrong type', () => {
      const malformed = {
        decision: 'deferred',
        lastEvaluatedAt: '2026-04-29T12:00:00.000Z',
        deferCount: 'not-a-number',
      } as unknown as ReckonerStatus;
      assert.throws(
        () => computeNextStatus(malformed, row),
        /\[reckoner\] staleness snapshot:.*deferCount/,
      );
    });

    it('throws when prior.stalledReason is an unrecognized literal', () => {
      const malformed = {
        decision: 'deferred',
        lastEvaluatedAt: '2026-04-29T12:00:00.000Z',
        stalledReason: 'made-up-reason',
      } as unknown as ReckonerStatus;
      assert.throws(
        () => computeNextStatus(malformed, row),
        /\[reckoner\] staleness snapshot:.*stalledReason/,
      );
    });

    it('error message names the offending writId', () => {
      const rowWithWritId = makeRow({
        outcome: 'deferred',
        deferReason: 'dependency_pending',
        consideredAt: '2026-04-29T12:00:00.000Z',
        writId: 'w-offender',
      });
      assert.throws(
        () => computeNextStatus('not-an-object' as unknown as ReckonerStatus, rowWithWritId),
        /writ "w-offender"/,
      );
    });
  });
});

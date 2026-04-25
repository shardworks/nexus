/**
 * writ-rescue-stuck tool — list and (with --apply) requeue legacy
 * `engine-failure` stuck writs that predate the engine-level-retry
 * commission.
 *
 * Background. Before the engine-level-retry reshape, Spider's
 * `failEngine` path wrote `status.spider.stuckCause = 'engine-failure'`
 * onto the writ and transitioned it to `phase=stuck`. The current
 * Spider no longer writes that cause: transient failures retry in
 * place inside the rig, and permanent failures cascade straight to
 * `phase=failed`. `autoUnstick` only releases dependency-recovery
 * causes (`failed-blocker` / `cycle`), so writs already stuck under
 * the legacy `engine-failure` cause have no automated recovery path.
 *
 * This tool is the deliberate operator-driven rescue surface for
 * those writs. Default invocation lists candidates without mutating
 * anything; `--apply` transitions each matched writ to `open`,
 * clears its `status.spider` slot, and cancels every legacy
 * `'stuck'`/`'blocked'` rig that would otherwise prevent
 * `trySpawn` from spawning a fresh rig (or clutter the rigs book).
 *
 * The matcher reads `status.spider?.stuckCause === 'engine-failure'`
 * as an off-union string — the legacy value is no longer in the
 * `SpiderStuckCause` union, but the slot is unstructured `unknown`
 * on the WritDoc so the comparison is type-safe.
 *
 * Surfaces under `nsg writ rescue-stuck` via the framework CLI's
 * existing hyphen-prefix auto-grouping; no CLI plumbing changes.
 */

import { z } from 'zod';
import { guild, shortId } from '@shardworks/nexus-core';
import type { StacksApi, ReadOnlyBook, Book } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, RigDoc } from '../types.ts';

/** The legacy off-union cause this tool exists to drain. */
const LEGACY_CAUSE = 'engine-failure';

/** Statuses that mark a rig as a legacy artifact needing cancellation. */
const LEGACY_RIG_STATUSES = new Set<string>(['stuck', 'blocked']);

/**
 * Off-union read of `status.spider?.stuckCause`. The current
 * `SpiderStuckCause` union no longer contains `'engine-failure'`,
 * but the slot is `unknown` at the WritDoc level — so we read it
 * as `string | undefined` here without widening the canonical
 * union.
 */
function legacyStuckCause(writ: WritDoc): string | undefined {
  const slot = writ.status?.spider as { stuckCause?: unknown } | undefined;
  const cause = slot?.stuckCause;
  return typeof cause === 'string' ? cause : undefined;
}

/** Read the legacy `retryable` flag (also off-union for legacy writs). */
function legacyRetryable(writ: WritDoc): boolean | undefined {
  const slot = writ.status?.spider as { retryable?: unknown } | undefined;
  return typeof slot?.retryable === 'boolean' ? slot.retryable : undefined;
}

/** Read the legacy `observedAt` timestamp. */
function legacyObservedAt(writ: WritDoc): string | undefined {
  const slot = writ.status?.spider as { observedAt?: unknown } | undefined;
  return typeof slot?.observedAt === 'string' ? slot.observedAt : undefined;
}

/** Strict matcher — must be in `phase=stuck` AND carry the legacy cause. */
function isLegacyEngineFailureStuck(writ: WritDoc): boolean {
  return writ.phase === 'stuck' && legacyStuckCause(writ) === LEGACY_CAUSE;
}

/** Diagnostic snapshot of a rescue candidate. */
interface RescueCandidate {
  writId: string;
  shortWritId: string;
  title: string;
  rigCount: number;
  retryable?: boolean;
  observedAt?: string;
}

/** Per-writ apply result row. */
interface RescueApplied {
  writId: string;
  shortWritId: string;
  title: string;
  status: 'rescued' | 'failed' | 'skipped';
  rigsCancelled: number;
  resolution?: string;
  error?: string;
  reason?: string;
}

/** Aggregate summary returned in apply mode. */
interface RescueSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  totalRigsCancelled: number;
}

/** Tabular text rendering of the list-mode candidate set. */
function renderListTable(rows: RescueCandidate[]): string {
  if (rows.length === 0) {
    return 'No legacy engine-failure stuck writs found.';
  }

  const headers: Array<[keyof RescueCandidate | 'rigs', string]> = [
    ['shortWritId', 'ID'],
    ['title', 'TITLE'],
    ['rigs', 'RIGS'],
    ['retryable', 'RETRYABLE'],
    ['observedAt', 'OBSERVED'],
  ];

  function cell(row: RescueCandidate, key: typeof headers[number][0]): string {
    if (key === 'rigs') return String(row.rigCount);
    if (key === 'retryable') {
      return row.retryable === undefined ? '-' : row.retryable ? 'true' : 'false';
    }
    if (key === 'observedAt') return row.observedAt ?? '-';
    if (key === 'shortWritId') return row.shortWritId;
    if (key === 'title') return row.title;
    return '';
  }

  const widths = headers.map(([key, label]) => {
    let w = label.length;
    for (const row of rows) {
      const len = cell(row, key).length;
      if (len > w) w = len;
    }
    return w;
  });

  const lines: string[] = [];
  lines.push(headers.map(([, label], i) => label.padEnd(widths[i])).join('  '));
  lines.push(headers.map((_, i) => '─'.repeat(widths[i])).join('  '));
  for (const row of rows) {
    lines.push(headers.map(([key], i) => cell(row, key).padEnd(widths[i])).join('  '));
  }
  lines.push('');
  lines.push(
    `${rows.length} candidate${rows.length === 1 ? '' : 's'}. ` +
      'Pass --apply to requeue them (stuck → open).',
  );
  return lines.join('\n');
}

/** Tabular text rendering of the apply-mode result set. */
function renderApplyReport(
  applied: RescueApplied[],
  summary: RescueSummary,
): string {
  if (applied.length === 0) {
    return 'No legacy engine-failure stuck writs found. Nothing to do.';
  }

  const lines: string[] = [];
  for (const row of applied) {
    const tag =
      row.status === 'rescued'
        ? 'rescued'
        : row.status === 'failed'
          ? 'FAILED'
          : 'skipped';
    const detail =
      row.status === 'rescued'
        ? `rigs cancelled: ${row.rigsCancelled}`
        : row.status === 'failed'
          ? `error: ${row.error ?? 'unknown error'}`
          : `reason: ${row.reason ?? 'unknown'}`;
    lines.push(`  ${tag}  ${row.shortWritId}  ${row.title} — ${detail}`);
  }
  lines.push('');
  lines.push(
    `summary: ${summary.succeeded} rescued, ${summary.failed} failed, ` +
      `${summary.skipped} skipped; ${summary.totalRigsCancelled} legacy rig(s) cancelled.`,
  );
  return lines.join('\n');
}

/** Build the templated resolution string for an apply transition. */
function buildResolution(observedAt: string | undefined): string {
  const obs = observedAt ?? 'unknown';
  return `Rescued from legacy "${LEGACY_CAUSE}" stuck (observedAt=${obs}) by writ-rescue-stuck.`;
}

/**
 * Per-writ rescue primitive. Mirrors `autoUnstick`'s release pair
 * (`clerk.transition(id, 'open', { resolution })` + `clerk.setWritStatus(id, 'spider', {})`)
 * and additionally cancels every legacy `'stuck'`/`'blocked'` rig
 * tied to this writ. The transition resolution is recorded best-effort —
 * Clerk persists `resolution` only on terminal transitions; the
 * `stuck → open` move silently drops it. We still pass the value so a
 * future Clerk that opens the slot up gets it for free, and we surface
 * the same string on the apply-report row so the audit trail is
 * complete regardless of where the Clerk lands.
 */
async function rescueWrit(
  clerk: ClerkApi,
  spider: SpiderApi,
  rigsBook: ReadOnlyBook<RigDoc> | Book<RigDoc>,
  writ: WritDoc,
): Promise<{ rigsCancelled: number; resolution: string }> {
  const observedAt = legacyObservedAt(writ);
  const resolution = buildResolution(observedAt);

  // 1. Transition stuck → open. Clerk's transition() validates that
  //    the type config allows this move (mandate's stuck → open is
  //    legal). Transition first, status-slot clear second — same
  //    order as autoUnstick.
  await clerk.transition(writ.id, 'open', { resolution });
  await clerk.setWritStatus(writ.id, 'spider', {});

  // 2. Cancel every legacy 'stuck'/'blocked' rig for this writ. Both
  //    statuses must go: a 'blocked' legacy rig keeps trySpawn from
  //    issuing a fresh one (forWrit returns the latest), and 'stuck'
  //    rigs are persistent clutter. We tolerate spider.cancel
  //    accepting the legacy strings — that path is exercised by
  //    spider.ts's own legacy-tolerance branch.
  const rigs = await rigsBook.find({
    where: [['writId', '=', writ.id]],
  });
  let rigsCancelled = 0;
  for (const rig of rigs) {
    if (LEGACY_RIG_STATUSES.has(String(rig.status))) {
      await spider.cancel(rig.id, {
        reason: `Cancelled by writ-rescue-stuck while rescuing legacy "${LEGACY_CAUSE}" writ ${writ.id}.`,
      });
      rigsCancelled++;
    }
  }

  return { rigsCancelled, resolution };
}

/** Count the rigs persisted for a writ, regardless of status. */
async function countRigsForWrit(
  rigsBook: ReadOnlyBook<RigDoc> | Book<RigDoc>,
  writId: string,
): Promise<number> {
  return rigsBook.count([['writId', '=', writId]]);
}

/** Build a diagnostic candidate row from a writ + its rig count. */
function makeCandidate(writ: WritDoc, rigCount: number): RescueCandidate {
  return {
    writId: writ.id,
    shortWritId: shortId(writ.id),
    title: writ.title ?? '',
    rigCount,
    retryable: legacyRetryable(writ),
    observedAt: legacyObservedAt(writ),
  };
}

export default tool({
  name: 'writ-rescue-stuck',
  description:
    'List and (with --apply) requeue legacy "engine-failure" stuck writs ' +
    'that predate the engine-level-retry commission',
  instructions:
    'Default invocation lists writs in phase=stuck whose status.spider.stuckCause ' +
    'is the legacy "engine-failure" string. Pass --apply to transition each match ' +
    'to phase=open, clear its status.spider slot, and cancel every legacy ' +
    "'stuck' or 'blocked' rig for that writ. Use --id to scope the operation to a " +
    'single writ; the strict matcher rejects non-matches before any mutation. ' +
    'Failures on individual writs are reported but do not abort the bulk run. ' +
    "Pass --format json for machine-readable output. Operator-stuck writs (no " +
    'status.spider slot) and dependency-cause stucks (failed-blocker / cycle) are ' +
    'never touched — those are handled by autoUnstick or human intervention.',
  params: {
    id: z
      .string()
      .optional()
      .describe(
        'Optional writ id. When supplied, the tool operates on this writ only ' +
          'and rejects it (with a clear message) if it does not match the ' +
          'strict legacy "engine-failure" predicate.',
      ),
    apply: z
      .boolean()
      .default(false)
      .describe(
        'When false (default), list candidates without mutating anything. ' +
          'When true, transition each match stuck → open, clear the spider status ' +
          "slot, and cancel every legacy 'stuck'/'blocked' rig for that writ.",
      ),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe(
        'Output format. "text" (default) renders a human-readable table or ' +
          'apply report. "json" returns the structured candidate list or apply ' +
          'summary.',
      ),
  },
  permission: 'write',
  handler: async (params) => {
    const g = guild();
    const stacks = g.apparatus<StacksApi>('stacks');
    const clerk = g.apparatus<ClerkApi>('clerk');
    const spider = g.apparatus<SpiderApi>('spider');

    const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
    const rigsBook = stacks.book<RigDoc>('spider', 'rigs');

    // ── 1. Build the candidate set ────────────────────────────────
    let candidateWrits: WritDoc[];
    if (params.id !== undefined) {
      const writ = await writsBook.get(params.id);
      if (!writ) {
        const message = `Writ "${params.id}" not found.`;
        if (params.format === 'json') {
          return {
            mode: params.apply ? 'apply' : 'list',
            id: params.id,
            matches: false,
            reason: 'not-found',
            message,
            candidates: [],
            ...(params.apply ? { applied: [], summary: { succeeded: 0, failed: 0, skipped: 0, totalRigsCancelled: 0 } } : {}),
          };
        }
        return message;
      }
      if (!isLegacyEngineFailureStuck(writ)) {
        const cause = legacyStuckCause(writ);
        const reason =
          writ.phase !== 'stuck'
            ? `writ phase is "${writ.phase}", expected "stuck"`
            : cause === undefined
              ? 'writ has no status.spider.stuckCause (operator-stuck)'
              : `writ stuckCause is "${cause}", expected "${LEGACY_CAUSE}"`;
        const message = `Writ "${params.id}" does not match the strict rescue predicate: ${reason}.`;
        if (params.format === 'json') {
          return {
            mode: params.apply ? 'apply' : 'list',
            id: params.id,
            matches: false,
            reason: 'predicate-mismatch',
            phase: writ.phase,
            stuckCause: cause,
            message,
            candidates: [],
            ...(params.apply ? { applied: [], summary: { succeeded: 0, failed: 0, skipped: 0, totalRigsCancelled: 0 } } : {}),
          };
        }
        return message;
      }
      candidateWrits = [writ];
    } else {
      const stuckWrits = await writsBook.find({
        where: [['phase', '=', 'stuck']],
      });
      candidateWrits = stuckWrits.filter(isLegacyEngineFailureStuck);
    }

    // ── 2. Build the diagnostic snapshots (used in both modes) ────
    const candidates: RescueCandidate[] = [];
    for (const writ of candidateWrits) {
      const rigCount = await countRigsForWrit(rigsBook, writ.id);
      candidates.push(makeCandidate(writ, rigCount));
    }

    // ── 3. List mode ──────────────────────────────────────────────
    if (!params.apply) {
      if (params.format === 'json') {
        return {
          mode: 'list',
          candidates,
        };
      }
      return renderListTable(candidates);
    }

    // ── 4. Apply mode ─────────────────────────────────────────────
    const applied: RescueApplied[] = [];
    const summary: RescueSummary = {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      totalRigsCancelled: 0,
    };

    for (const writ of candidateWrits) {
      const shortWritId = shortId(writ.id);
      try {
        // Re-validate at apply time — the writ may have moved between
        // the list snapshot and the per-writ commit. Strict predicate
        // is the only safe check here.
        const fresh = await writsBook.get(writ.id);
        if (!fresh || !isLegacyEngineFailureStuck(fresh)) {
          applied.push({
            writId: writ.id,
            shortWritId,
            title: writ.title ?? '',
            status: 'skipped',
            rigsCancelled: 0,
            reason: 'no longer matches the rescue predicate',
          });
          summary.skipped++;
          continue;
        }
        const { rigsCancelled, resolution } = await rescueWrit(
          clerk,
          spider,
          rigsBook,
          fresh,
        );
        applied.push({
          writId: writ.id,
          shortWritId,
          title: writ.title ?? '',
          status: 'rescued',
          rigsCancelled,
          resolution,
        });
        summary.succeeded++;
        summary.totalRigsCancelled += rigsCancelled;
      } catch (err) {
        applied.push({
          writId: writ.id,
          shortWritId,
          title: writ.title ?? '',
          status: 'failed',
          rigsCancelled: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        summary.failed++;
      }
    }

    if (params.format === 'json') {
      return {
        mode: 'apply',
        candidates,
        applied,
        summary,
      };
    }
    return renderApplyReport(applied, summary);
  },
});

/**
 * The Reckoner — observer that emits Lattice pulses when commissions stall,
 * fail, or when the guild's work queue drains.
 *
 * A Phase 2 CDC watcher on `clerk/writs`. No persistent state, no config.
 * Install = on; uninstall = off.
 *
 * Three trigger types (D24):
 *
 *   - `reckoner.writ-stuck`  — a root writ enters `stuck`.
 *   - `reckoner.writ-failed` — a root writ enters `failed`.
 *   - `reckoner.queue-drained` — after any terminal writ transition, the
 *     queue has 0 `open` writs and 0 active rigs.
 *
 * Roots-only (D23): non-root writs never emit stuck/failed pulses; leaf
 * cause information is surfaced by the Clerk's children-behavior cascade
 * engine, which records the immediate triggering child id under the
 * parent's `status['clerk'].triggeringChildId` slot before each cascaded
 * transition. The Reckoner walks that chain at emit time (chase-chain) to
 * surface the full leaf-cause list on the parent pulse.
 *
 * Idempotency under CDC replay: every emission site is routed through a
 * dedupe guard that queries the persisted pulses book for a prior pulse
 * matching the same `(writId, triggerType, writUpdatedAt)` identity (or
 * `(lastTerminalWritId, writUpdatedAt)` for drain). If a prior pulse
 * exists, the emission is skipped. Because the check hits the persisted
 * book — not an in-memory set — it survives a process restart. See
 * `docs/architecture/apparatus/reckoner.md` §"Idempotency under replay".
 *
 * See: docs/architecture/apparatus/reckoner.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, shortId } from '@shardworks/nexus-core';
import type {
  ChangeEvent,
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { isQueueDrained } from './drain.ts';
import { resolveEngineFailureContext } from './engine-context.ts';
import {
  RECKONER_PLUGIN_ID,
  TRIGGER_QUEUE_DRAINED,
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
  type QueueDrainedContext,
  type ReckonerApi,
  type WritFailedContext,
  type WritStuckContext,
} from './types.ts';

/**
 * Narrow consumer-side shape of the Clerk-owned `status['clerk']` sub-slot.
 *
 * Re-declared locally — mirroring the Spider precedent — to keep the
 * Reckoner's import graph independent of any specific Clerk type-export
 * surface beyond `WritDoc`. The Clerk's children-behavior cascade engine
 * is the producer of this slot; this type captures only the fields the
 * Reckoner reads.
 */
interface ClerkChildCascadeStatus {
  /**
   * Id of the immediate child whose terminal transition fired the cascade
   * onto this writ. Absent on writs that reached a terminal state through
   * a direct (non-cascaded) transition.
   */
  triggeringChildId?: string;
}

/**
 * Local re-declaration of the per-attempt history entry on a Spider
 * engine instance. Mirrors `EngineAttempt` from `@shardworks/spider-apparatus`
 * narrowly — every field is kept optional to match the source type's
 * "in-flight or terminal" optionality. Re-declared here so the Reckoner's
 * import graph does not depend on Spider for one read-only row shape.
 */
interface EngineAttempt {
  startedAt?: string;
  endedAt?: string;
  status?: 'completed' | 'failed';
  error?: string;
  sessionId?: string;
  /**
   * Yields are intentionally read but not surfaced on the engine-failure
   * context block — the diagnostic pulse trades fidelity for size.
   */
  yields?: unknown;
}

/**
 * Local re-declaration of a Spider engine instance. Captures only the
 * fields the engine-context resolver reads: the engine identity, the
 * status, the retry-budget counter, and the per-attempt history.
 */
interface EngineInstance {
  id: string;
  designId: string;
  status: string;
  attemptCount?: number;
  attempts?: EngineAttempt[];
}

/**
 * Minimal shape of a Spider rig row — `writId`, `status`, `createdAt`,
 * and the engine pipeline. The engine-context resolver scans `engines`
 * for a `status === 'failed'` slot to enrich the writ-failed pulse;
 * `createdAt` orders the rigs-for-writ scan to pick the most recent
 * failed rig when more than one exists. Declared locally to avoid a
 * hard Spider dependency.
 */
interface RigRow extends Record<string, unknown> {
  id: string;
  writId: string;
  status: string;
  createdAt?: string;
  engines?: EngineInstance[];
}

/**
 * Walk the cascade chain starting at `writ` and return the ordered list of
 * triggering child ids — outer (closest to `writ`) to inner (the leaf
 * cause).
 *
 * The chain is read directly from each successive writ's
 * `status['clerk'].triggeringChildId`: starting from `writ`, we read its
 * own slot, then fetch that child writ via the Clerk and read its slot,
 * and so on until a writ has no triggeringChildId. That terminal writ is
 * the leaf cause and is the last id in the returned chain.
 *
 * Returns an empty array when the starting writ carries no
 * `status['clerk'].triggeringChildId` slot — the typical case for a
 * directly-failed writ that did not result from a cascade.
 *
 * Cascade depth is bounded by the Stacks `MAX_CASCADE_DEPTH = 16`
 * invariant (re-stated in the brief); the loop terminates naturally when
 * the chain runs out, but we also defensively cap the walk at a small
 * upper bound to avoid an unbounded read in the presence of a corrupt
 * forward-cycle, which a future cascade-engine bug could in principle
 * produce. `MAX_CASCADE_WALK` is set above the framework cap so a
 * legitimate cascade is never truncated.
 */
const MAX_CASCADE_WALK = 32;

async function chaseTriggeringChildren(
  clerk: ClerkApi,
  writ: WritDoc,
): Promise<string[]> {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: WritDoc | null = writ;

  while (current && chain.length < MAX_CASCADE_WALK) {
    const status = current.status?.clerk as ClerkChildCascadeStatus | undefined;
    const next = status?.triggeringChildId;
    if (typeof next !== 'string' || next.length === 0) break;
    if (visited.has(next)) break; // defensive — should not happen
    visited.add(next);
    chain.push(next);
    // Read the next writ in the chain. `show` throws on missing writs;
    // wrap so a corrupt forward reference does not crash the pulse path.
    try {
      current = await clerk.show(next);
    } catch {
      current = null;
    }
  }

  return chain;
}

// ── Observer helper (exported for unit testing) ────────────────────────

/**
 * Dependencies the Phase 2 observer needs to evaluate a writ transition.
 *
 * Extracted so `handleWritChange` can be invoked directly from unit tests
 * with the same books / api handles the production observer receives.
 */
export interface ReckonerObserverDeps {
  /** Lattice API — used to emit pulses (after the dedupe guard). */
  readonly lattice: LatticeApi;
  /**
   * Clerk API — drives the classification-aware drain count
   * (`countActive()`) and the terminal-trigger classification check
   * (`isTerminal(writ)`). Replaces the prior `writsBook` handle —
   * the Reckoner reads writ-side state through the Clerk's typed
   * surface so non-mandate writ types observe the correct drain
   * moment.
   */
  readonly clerk: ClerkApi;
  /**
   * Read-only handle on `spider/rigs` — consumed by `isQueueDrained`
   * (in `drain.ts`) to count active rigs. The Reckoner itself does not
   * read rig counts directly any longer.
   */
  readonly rigsBook: ReadOnlyBook<RigRow>;
  /** Read-only handle on `lattice/pulses` — dedupe lookup. */
  readonly pulsesBook: ReadOnlyBook<PulseDoc>;
}

/**
 * Query the pulses book for a prior pulse that matches the dedupe identity
 * and return true when a match exists. The query hits the indexed columns
 * (`writId`, `triggerType`) on the book and filters the handful of
 * candidates in-process on `context.writUpdatedAt`.
 *
 * Per-writ pulses key on `(writId, triggerType, writUpdatedAt)`. Drain
 * pulses key on `(triggerType = reckoner.queue-drained, writId = null)`
 * narrowed to `(lastTerminalWritId, writUpdatedAt)` inside context.
 */
async function alreadyEmitted(
  pulsesBook: ReadOnlyBook<PulseDoc>,
  params: {
    triggerType: string;
    /** Writ id the pulse is keyed to; `null` for drain pulses. */
    writId: string | null;
    /** The triggering writ's `updatedAt` — the dedupe-identity field. */
    writUpdatedAt: string;
    /** For drain pulses only: the triggering terminal writ id. */
    lastTerminalWritId?: string;
  },
): Promise<boolean> {
  const where =
    params.writId === null
      ? // Drain pulses always have writId === null. The pulses book
        // supports 'IS NULL' and, importantly, `writId` is an indexed
        // column — so this narrows to the small "all drain pulses"
        // candidate set.
        ([
          ['triggerType', '=', params.triggerType],
          ['writId', 'IS NULL'],
        ] as const)
      : ([
          ['triggerType', '=', params.triggerType],
          ['writId', '=', params.writId],
        ] as const);

  const candidates = await pulsesBook.find({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: where as any,
  });

  for (const candidate of candidates) {
    const ctx = candidate.context as
      | {
          writUpdatedAt?: string;
          lastTerminalWritId?: string;
        }
      | undefined;
    if (!ctx) continue;
    if (ctx.writUpdatedAt !== params.writUpdatedAt) continue;
    if (params.lastTerminalWritId !== undefined) {
      if (ctx.lastTerminalWritId !== params.lastTerminalWritId) continue;
    }
    return true;
  }
  return false;
}

/**
 * Build and emit a stuck pulse for `writ`, guarded by the idempotency
 * check against the pulses book.
 */
async function emitStuck(
  deps: ReckonerObserverDeps,
  writ: WritDoc,
): Promise<void> {
  if (
    await alreadyEmitted(deps.pulsesBook, {
      triggerType: TRIGGER_WRIT_STUCK,
      writId: writ.id,
      writUpdatedAt: writ.updatedAt,
    })
  ) {
    return;
  }

  const spiderStatus = writ.status?.spider as { stuckCause?: string } | undefined;
  const context: WritStuckContext = {
    writShortId: shortId(writ.id),
    writPhase: 'stuck',
    writTitle: writ.title,
    writType: writ.type,
    writUpdatedAt: writ.updatedAt,
    ...(typeof spiderStatus?.stuckCause === 'string' ? { stuckCause: spiderStatus.stuckCause } : {}),
  };
  const title = `Writ stuck: ${writ.title}`;
  const summaryParts: string[] = [
    `${shortId(writ.id)} ("${writ.title}") is stuck.`,
  ];
  if (spiderStatus?.stuckCause) {
    summaryParts.push(`Cause: ${spiderStatus.stuckCause}.`);
  }
  const leafFailures = await chaseTriggeringChildren(deps.clerk, writ);
  if (leafFailures.length > 0) {
    summaryParts.push(
      `Originated from child ${leafFailures.map(shortId).join(', ')}.`,
    );
  }
  await deps.lattice.emit({
    source: RECKONER_PLUGIN_ID,
    triggerType: TRIGGER_WRIT_STUCK,
    writId: writ.id,
    title,
    summary: summaryParts.join(' '),
    linkUrl: null,
    context: context as unknown as Record<string, unknown>,
  });
}

/** Build and emit a failed pulse for `writ`, guarded by the idempotency check. */
async function emitFailed(
  deps: ReckonerObserverDeps,
  writ: WritDoc,
): Promise<void> {
  if (
    await alreadyEmitted(deps.pulsesBook, {
      triggerType: TRIGGER_WRIT_FAILED,
      writId: writ.id,
      writUpdatedAt: writ.updatedAt,
    })
  ) {
    return;
  }

  const childFailures = await chaseTriggeringChildren(deps.clerk, writ);
  // Engine-failure enrichment (D1, D3): when the failed mandate's rig
  // carries a failed engine, attach a structured `engineFailure` block so
  // the patron sees the engine identity, retry count, last error, and
  // attempt history without dropping into `nsg rig show`. The resolver
  // never throws — it returns undefined on missing rig / missing failed
  // engine / book-read error — so a non-engine failure path emits with
  // the legacy shape unchanged (D5).
  let engineFailure;
  try {
    engineFailure = await resolveEngineFailureContext(deps.rigsBook, writ.id);
  } catch {
    engineFailure = undefined;
  }
  const context: WritFailedContext = {
    writShortId: shortId(writ.id),
    writTitle: writ.title,
    writType: writ.type,
    writUpdatedAt: writ.updatedAt,
    ...(typeof writ.resolution === 'string' ? { resolution: writ.resolution } : {}),
    ...(childFailures.length > 0
      ? { childFailures: childFailures.map(shortId) }
      : {}),
    ...(engineFailure ? { engineFailure } : {}),
  };
  const title = `Writ failed: ${writ.title}`;
  const summaryParts: string[] = [
    `${shortId(writ.id)} ("${writ.title}") failed.`,
  ];
  if (writ.resolution) {
    summaryParts.push(`Resolution: ${writ.resolution}`);
  }
  if (childFailures.length > 0) {
    summaryParts.push(
      `Originated from child ${childFailures.map(shortId).join(', ')}.`,
    );
  }
  await deps.lattice.emit({
    source: RECKONER_PLUGIN_ID,
    triggerType: TRIGGER_WRIT_FAILED,
    writId: writ.id,
    title,
    summary: summaryParts.join(' '),
    linkUrl: null,
    context: context as unknown as Record<string, unknown>,
  });
}

/**
 * Build and emit a queue-drained pulse triggered by `lastTerminal`,
 * guarded by the idempotency check.
 */
async function emitDrained(
  deps: ReckonerObserverDeps,
  lastTerminal: WritDoc,
): Promise<void> {
  if (
    await alreadyEmitted(deps.pulsesBook, {
      triggerType: TRIGGER_QUEUE_DRAINED,
      writId: null,
      writUpdatedAt: lastTerminal.updatedAt,
      lastTerminalWritId: lastTerminal.id,
    })
  ) {
    return;
  }

  const now = new Date().toISOString();
  const context: QueueDrainedContext = {
    drainedAt: now,
    lastTerminalWritId: lastTerminal.id,
    writUpdatedAt: lastTerminal.updatedAt,
  };
  const title = 'Queue drained';
  const summary = `Queue drained after ${shortId(lastTerminal.id)} ("${lastTerminal.title}") reached a terminal state.`;
  await deps.lattice.emit({
    source: RECKONER_PLUGIN_ID,
    triggerType: TRIGGER_QUEUE_DRAINED,
    writId: null,
    title,
    summary,
    linkUrl: null,
    context: context as unknown as Record<string, unknown>,
  });
}

/**
 * The body of the Phase 2 CDC observer — reacts to a single `ChangeEvent`
 * on `clerk/writs` and drives the three emission paths (stuck / failed /
 * drain) with their predicates and idempotency guards.
 *
 * Exported so tests can drive the observer directly with synthetic events
 * and assert the same-transition-twice → exactly-one-pulse invariant
 * without also exercising Stacks' CDC machinery.
 */
export async function handleWritChange(
  deps: ReckonerObserverDeps,
  event: ChangeEvent<WritDoc>,
): Promise<void> {
  // Only react to phase transitions on existing writs.
  if (event.type !== 'update') return;
  const writ = event.entry;
  const prev = event.prev;
  if (writ.phase === prev.phase) return;

  const enteredStuck = writ.phase === 'stuck' && prev.phase !== 'stuck';
  const enteredFailed = writ.phase === 'failed' && prev.phase !== 'failed';
  // Classification-driven terminal gate (D3): no prev comparison
  // needed because terminal states have no outbound transitions, so
  // a writ in a terminal state means the transition into it just
  // fired. A throw from `isTerminal` (unknown type / unknown state)
  // propagates per D8 — the Phase 2 framework's `failOnError: false`
  // logs and skips the event so a registry-data-integrity bug is
  // surfaced loudly without taking the whole watcher down.
  const enteredTerminal = deps.clerk.isTerminal(writ);

  // Mandate gate for stuck/failed pulses (D4): per the brief, those
  // pulses stay mandate-only for v0. Computed once and AND'd into
  // each branch gate below so non-mandate writs short-circuit
  // before the predicate's Spider-status lookup (D7).
  const isMandate = writ.type === 'mandate';

  // Roots-only gate for the per-writ pulses. Children never emit
  // their own stuck/failed pulses — their cause surfaces in the
  // parent's resolution.
  const isRoot = !writ.parentId;

  if (isMandate && isRoot && enteredStuck) {
    await emitStuck(deps, writ);
  }

  if (isMandate && isRoot && enteredFailed) {
    await emitFailed(deps, writ);
  }

  // Drain check runs after every terminal transition — even
  // non-root ones, and across every registered writ type.
  if (enteredTerminal) {
    const drained = await isQueueDrained(deps.clerk, deps.rigsBook);
    if (drained) {
      await emitDrained(deps, writ);
    }
  }
}

// ── Plugin factory ─────────────────────────────────────────────────────

export function createReckoner(): Plugin {
  const triggerTypes = [
    TRIGGER_WRIT_STUCK,
    TRIGGER_WRIT_FAILED,
    TRIGGER_QUEUE_DRAINED,
  ] as const;

  const api: ReckonerApi = {
    source: RECKONER_PLUGIN_ID,
    triggerTypes: [...triggerTypes],
  };

  return {
    apparatus: {
      // Lattice and Clerk are hard requires — without them the Reckoner
      // has nothing to observe or nowhere to emit. Spider is a soft
      // dependency: Spider owns the rigs book the Reckoner reads for
      // drain-evaluation. The path degrades gracefully — no Spider →
      // no rigs book → rig counts return 0.
      requires: ['clerk', 'lattice', 'stacks'],
      recommends: ['spider', 'oculus'],

      provides: api,

      async start(_ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');
        const lattice = g.apparatus<LatticeApi>('lattice');
        const clerk = g.apparatus<ClerkApi>('clerk');

        // Read-only handles. Spider's rigs book may not exist if Spider
        // is not installed — readBook still returns a valid handle but
        // find/count calls on it resolve to empty/zero. That is the
        // intended degradation path.
        const rigsBook: ReadOnlyBook<RigRow> = stacks.readBook<RigRow>('spider', 'rigs');
        const pulsesBook: ReadOnlyBook<PulseDoc> = stacks.readBook<PulseDoc>('lattice', 'pulses');

        const deps: ReckonerObserverDeps = {
          lattice,
          clerk,
          rigsBook,
          pulsesBook,
        };

        // ── Observer ────────────────────────────────────────────

        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          (event) => handleWritChange(deps, event),
          { failOnError: false },
        );
      },
    },
  };
}

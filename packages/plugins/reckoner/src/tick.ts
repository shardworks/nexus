/**
 * `reckoner.tick` — periodic tick relay.
 *
 * Wired into the apparatus's `supportKit.relays` so the Clockworks
 * dispatches every fire of the Reckoner's standing order
 * (`@every 60s` → `reckoner.tick`) into this handler. The standing
 * order itself ships from `apparatus.supportKit.standingOrders`; no
 * operator action is required to enable the tick.
 *
 * Per-fire sequence (the canonical evaluation entry):
 *
 *   1. Resolve the active scheduler. If the scheduler reference is not
 *      yet populated (`phase:started` has not fired), throw fail-loud.
 *      Production never trips this — the framework gates `start()` on
 *      `requires: ['clerk']` and seals the registry on `phase:started`,
 *      both before the Clockworks could possibly schedule a tick — but
 *      tests can assert the throw, and a silent skip would hide
 *      ordering drift.
 *
 *   2. Query held petitions (writs in `new` phase carrying
 *      `ext.reckoner`) by reading `clerk/writs` directly,
 *      deliberately literal-phase-only — the type-agnostic
 *      generalization (iterating Clerk's writ-type registry for
 *      non-`'new'` initial phases) is observed and lifted as a
 *      separate concern.
 *
 *   3. Apply source / disabled-source gates inline. Each writ that
 *      fails a gate produces a `declined` Reckonings row and a
 *      transition to its cancelled-target phase, then is filtered out
 *      of the candidate set.
 *
 *   4. Filter the candidate set against the
 *      `(writId, writUpdatedAt)` dedupe lookup before building
 *      `SchedulerInput`. Already-considered writs never reach the
 *      scheduler. Deferred rows do not count as "already
 *      considered" — the dependency-aware defer path writes
 *      state-change audit entries that must not gate next-tick
 *      re-evaluation.
 *
 *   5. Run the dependency-aware consideration gate (D1–D13 of the
 *      dependency-aware-consideration commission) on each surviving
 *      candidate. A writ with one or more outbound `depends-on`
 *      links whose targets are not all `cleared` produces a
 *      deferred Reckonings row (with no-op-row suppression on the
 *      same outcome shape) and is dropped from the candidate set.
 *      Failed-precedence aggregation chooses between
 *      `dependency_pending` and `dependency_failed`.
 *
 *   6. Re-read and validate `reckoner.schedulerConfig`. On a
 *      `validateConfig` throw, log fail-loud and skip the entire
 *      tick.
 *
 *   7. Build a single `SchedulerInput { candidates, capacity, now,
 *      config }` (capacity is the v0 stub) and call `evaluate`. On a
 *      throw or non-array return, log fail-loud and skip the tick.
 *
 *   8. Validate decisions. Filter-and-warn on stranger writIds (apply
 *      only in-scope decisions). Fail-loud-skip the entire tick on
 *      multi-decision-per-writ.
 *
 *   9. Apply decisions. `approve` → transition to active target via
 *      `resolveActiveTargetPhase`; `decline` → transition to
 *      cancelled with the decision's reason as the resolution
 *      string; `defer` → no transition. Append one Reckonings row
 *      per writ considered. `defer` rows carry
 *      `deferReason: 'other'` and the decision's reason in
 *      `deferNote`.
 *
 *  10. Stamp `tickEventId` on every row from the triggering
 *      `clockworks.timer` event id when present; omit the field when
 *      absent (e.g. test paths driving the handler with `null`).
 *
 * Source-file layout follows the established stdlib-relay pattern
 * (`packages/plugins/clockworks/src/summon-relay.ts`,
 * `packages/plugins/vision-keeper/src/decline-relay.ts`). The relay
 * factory and the pure handler-body helper are co-located here so
 * unit tests can drive the helper without booting Clockworks.
 *
 * See: docs/architecture/apparatus/reckoner.md (the apparatus shape),
 * docs/architecture/reckonings-book.md (the Reckonings book schema
 * and tick-event contract).
 */

import type { GuildEvent, RelayDefinition } from '@shardworks/clockworks-apparatus';
import { relay } from '@shardworks/clockworks-apparatus';
import type {
  Book,
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc, WritPhase } from '@shardworks/clerk-apparatus';

import type {
  ReckoningDoc,
  ReckonerExt,
  Scheduler,
  SchedulerDecision,
} from './types.ts';

/** Plugin id stamped on `writ.ext['reckoner']`. Hardcoded literal — same constant the apparatus core uses. */
const RECKONER_PLUGIN_ID = 'reckoner';

/** Relay name registered with the Clockworks. Matches the standing-order `run:` field byte-for-byte. */
export const RECKONER_TICK_RELAY_NAME = 'reckoner.tick';

/** Schedule string the Reckoner contributes via `apparatus.supportKit.standingOrders`. */
export const RECKONER_TICK_SCHEDULE = '@every 60s';

// ── Tick handler context ───────────────────────────────────────────

/**
 * The dependency context the tick handler closes over. The factory
 * inside `buildReckoner()` constructs this from its own closure-scoped
 * state (the registry maps, the resolved active scheduler, the
 * Reckonings book handle, the config / scheduler-config resolvers,
 * the type-aware target-phase resolver, the dedupe lookup, the row
 * builder) and threads it through the relay factory.
 *
 * The same shape is consumed by `runTickHandler` so unit tests can
 * drive the per-fire sequence without booting Clockworks.
 */
export interface TickContext {
  /** Clerk handle. Used for `transition` and `getWritTypeConfig`. */
  clerk: ClerkApi;
  /** Stacks handle. Used to read `clerk/writs`. */
  stacks: StacksApi;
  /** Writable Reckonings book handle. */
  reckoningsBook: Book<ReckoningDoc>;
  /**
   * Late-bound accessor for the resolved active scheduler. Returns
   * `undefined` until `phase:started` resolves the selector.
   */
  getActiveScheduler: () => Scheduler | undefined;
  /** Resolves the live source / disabled-source config slice. */
  resolveConfig: () => ResolvedReckonerConfig;
  /** Re-reads `reckoner.schedulerConfig` from `guild.json`. */
  resolveSchedulerConfig: () => unknown;
  /** Returns `true` when `source` is in the petitioner registry. */
  isSourceRegistered: (source: string) => boolean;
  /**
   * Resolves the type-aware active target phase for a writ. Throws
   * fail-loud on ambiguity or on a missing/unconfigured type.
   */
  resolveActiveTargetPhase: (writ: WritDoc) => string;
  /**
   * Dedupe lookup. Returns `true` when a Reckonings row already
   * exists for the (writId, writUpdatedAt) pair. Deferred rows do
   * not count — the dependency-aware defer path writes deferred
   * rows as state-change audit entries while leaving the writ in
   * `new` phase, and subsequent ticks must remain free to re-run
   * the gate at the same `writUpdatedAt`.
   */
  alreadyConsidered: (writId: string, writUpdatedAt: string) => Promise<boolean>;
  /** Build a Reckonings row from in-flight consideration state. */
  buildReckoningRow: (params: BuildReckoningRowParams) => ReckoningDoc;
  /**
   * Run the dependency-aware consideration gate against a single
   * held petition under tick consideration (D1–D13 of the
   * dependency-aware-consideration commission). Returns
   * `proceed: true` when the writ should remain in the candidate
   * set for the scheduler; `proceed: false` when the writ has been
   * deferred (a deferred Reckonings row may have been written, with
   * no-op-row suppression applied) and should be dropped from the
   * candidate set. The dep gate runs every tick — outside the
   * `(writId, writUpdatedAt)` dedupe short-circuit — so a writ
   * deferred on dependencies keeps being re-evaluated as those
   * dependencies clear.
   */
  runDependencyGate: (args: {
    writ: WritDoc;
    ext: ReckonerExt;
    now: Date;
    tickEventId?: string;
  }) => Promise<{ proceed: boolean }>;
}

/**
 * Concrete shape of the resolved config slice the tick reads. Mirrors
 * the apparatus core's `ResolvedReckonerConfig` byte-for-byte —
 * defined here too so tests can construct a minimal context without
 * importing the apparatus's internal helpers.
 */
export interface ResolvedReckonerConfig {
  enforceRegistration: boolean;
  disabledSources: string[];
}

/**
 * Parameters accepted by the row builder. Keeps the row construction
 * shape uniform across the apparatus core and the tick handler so a
 * future row-shape change lands in one place.
 */
export interface BuildReckoningRowParams {
  now: Date;
  writ: WritDoc;
  ext: ReckonerExt;
  outcome: 'accepted' | 'declined' | 'deferred';
  declineReason?: ReckoningDoc['declineReason'];
  remediationHint?: string;
  deferReason?: ReckoningDoc['deferReason'];
  deferNote?: string;
  weight?: number;
  tickEventId?: string;
}

// ── Pure handler-body helper ───────────────────────────────────────

/**
 * The pure tick handler body. Drives the per-fire sequence end-to-end
 * against an injected `TickContext`. Exported so unit tests can
 * exercise it directly (the test-only `hooks.runTick(event?)` hook
 * forwards into this function).
 *
 * Production-wise: the relay factory below wraps this same call,
 * sourcing the context from the apparatus closure.
 *
 * @param ctx   Dependency-injection context supplied by the caller.
 * @param event Triggering Clockworks event, or `null` when tests drive
 *              the handler without a synthesised event. The event id
 *              (when present) lands on every Reckonings row this tick
 *              writes via `tickEventId`.
 */
export async function runTickHandler(
  ctx: TickContext,
  event: GuildEvent | null,
): Promise<void> {
  // 1. Resolve the active scheduler. Pre-seal ticks are loud — the
  //    framework's start ordering should make this unreachable in
  //    production; surfacing it as a throw keeps test-fixture drift
  //    from masquerading as silent dead air.
  const activeScheduler = ctx.getActiveScheduler();
  if (!activeScheduler) {
    throw new Error(
      `[reckoner] tick: activeScheduler not resolved — phase:started has not fired.`,
    );
  }

  // Sample `now` once at handler entry so every row written this
  // tick shares a single `consideredAt` timestamp basis.
  const now = new Date();

  // The tickEventId stamp is omitted (not synthesized) when the
  // triggering event lacks an id — typically the test-only path that
  // calls the handler directly with `null`. Synthesizing a fallback
  // would pollute rows with non-joinable ids; absence is meaningful.
  const tickEventId: string | undefined = event?.id ?? undefined;

  // 2. Query held petitions. Direct read of `clerk/writs` rather than
  //    `clerk.list({ phase: 'new' })` because Clerk's list applies an
  //    implicit `type = 'mandate'` filter when phase is supplied
  //    without a type — a non-mandate held petition (with its own
  //    type carrying a `new` initial state) would not surface
  //    through that path.
  const writsBook: ReadOnlyBook<WritDoc> = ctx.stacks.readBook<WritDoc>(
    'clerk',
    'writs',
  );
  const heldRaw: WritDoc[] = await writsBook.find({
    where: [['phase', '=', 'new']],
    orderBy: ['createdAt', 'asc'],
  });

  // Cheap pre-filter: drop writs that lack the Reckoner ext slot or
  // carry an invalid source string. Treats a malformed source as a
  // skip rather than a row write — matches the apparatus core's
  // earlier ext-gate semantics.
  const heldPetitions: Array<{ writ: WritDoc; ext: ReckonerExt }> = [];
  for (const w of heldRaw) {
    const ext = w.ext?.[RECKONER_PLUGIN_ID] as ReckonerExt | undefined;
    if (!ext) continue;
    if (typeof ext.source !== 'string' || ext.source.length === 0) continue;
    heldPetitions.push({ writ: w, ext });
  }

  // 3. Source / disabled-source gates. Each gate rejection produces
  //    a `declined` row and a `cancelled` transition; the writ falls
  //    out of the candidate set.
  const config = ctx.resolveConfig();
  const survivors: Array<{ writ: WritDoc; ext: ReckonerExt }> = [];
  for (const entry of heldPetitions) {
    const { writ, ext } = entry;

    // Disabled-source gate (D2): explicit operator action via
    // `disabledSources`. Mirrors the unregistered-strict decline
    // shape but with its own reason / template.
    if (config.disabledSources.includes(ext.source)) {
      const handled = await applyGateDecline({
        ctx,
        writ,
        ext,
        now,
        ...(tickEventId !== undefined ? { tickEventId } : {}),
        declineReason: 'source_banned',
        remediationHint: ext.source,
        resolution: `[reckoner] declined: source '${ext.source}' is in reckoner.disabledSources.`,
        loggingContext: 'disabled-source',
      });
      if (!handled) continue;
      // Transition / row write succeeded; fall through (writ is
      // dropped from the candidate set regardless).
      continue;
    }

    // Source-registration gate. Permissive when
    // `enforceRegistration` is false; strict otherwise — the only
    // path that produces the `source_unregistered` decline.
    if (!ctx.isSourceRegistered(ext.source) && config.enforceRegistration) {
      await applyGateDecline({
        ctx,
        writ,
        ext,
        now,
        ...(tickEventId !== undefined ? { tickEventId } : {}),
        declineReason: 'source_unregistered',
        remediationHint: ext.source,
        resolution: `[reckoner] declined: source '${ext.source}' is not registered (enforceRegistration: true).`,
        loggingContext: 'unregistered-strict',
      });
      continue;
    }

    survivors.push(entry);
  }

  // 4. Dedupe lookup before building the scheduler input. Pre-write
  //    dedupe lets the scheduler emit decisions the row writer would
  //    silently discard, which would hide drift; pre-build dedupe
  //    keeps the scheduler honest. Deferred rows do not count as
  //    "already considered" — the dependency-aware defer path writes
  //    state-change audit entries that must not gate the next tick's
  //    re-evaluation.
  const dedupedCandidates: Array<{ writ: WritDoc; ext: ReckonerExt }> = [];
  for (const entry of survivors) {
    const seen = await ctx.alreadyConsidered(entry.writ.id, entry.writ.updatedAt);
    if (seen) continue;
    dedupedCandidates.push(entry);
  }

  // 5. Dependency-aware consideration gate (D1–D13 of the
  //    dependency-aware-consideration commission). Runs every tick —
  //    a writ deferred on dependencies keeps being re-evaluated until
  //    those dependencies clear (or fail). The gate writes a
  //    `dependency_pending` / `dependency_failed` deferred row when
  //    the writ has gating or failed deps (with no-op-row suppression
  //    when the outcome shape matches the writ's most-recent deferred
  //    row), and drops the writ from the candidate set so the
  //    scheduler does not see it.
  const candidates: Array<{ writ: WritDoc; ext: ReckonerExt }> = [];
  for (const entry of dedupedCandidates) {
    const result = await ctx.runDependencyGate({
      writ: entry.writ,
      ext: entry.ext,
      now,
      ...(tickEventId !== undefined ? { tickEventId } : {}),
    });
    if (result.proceed) {
      candidates.push(entry);
    }
  }

  // 6. Empty-candidate early return: write nothing, call no scheduler.
  if (candidates.length === 0) return;

  // 7. Re-read and validate `reckoner.schedulerConfig`. Throw on
  //    `validateConfig` is fail-loud-skip-the-tick — every candidate
  //    is left in `new` and no row is written.
  const rawSchedulerConfig = ctx.resolveSchedulerConfig();
  let validatedConfig: unknown = rawSchedulerConfig;
  if (typeof activeScheduler.validateConfig === 'function') {
    try {
      validatedConfig = activeScheduler.validateConfig(rawSchedulerConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" validateConfig threw — skipping tick. ${msg}`,
      );
      return;
    }
  }

  // 8. Evaluate. The scheduler sees the entire surviving candidate
  //    set in one call (D7 from the registry commission's input
  //    contract). v0 capacity is the empty stub; future commissions
  //    populate it without touching this call site.
  let decisions: readonly SchedulerDecision[];
  try {
    const result = await activeScheduler.evaluate({
      candidates: candidates.map((c) => c.writ),
      capacity: {},
      now,
      config: validatedConfig,
    });
    decisions = result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] scheduler: "${activeScheduler.id}" evaluate threw — skipping tick. ${msg}`,
    );
    return;
  }

  if (!Array.isArray(decisions)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] scheduler: "${activeScheduler.id}" evaluate did not return an array — skipping tick.`,
    );
    return;
  }

  // 9. Validate decisions: filter stranger writIds; fail-loud-skip on
  //    multi-decision-per-writ. The candidate-id set is the closed
  //    universe of writs the scheduler may decide on this tick.
  const candidateIds = new Set<string>(candidates.map((c) => c.writ.id));
  const inScope: SchedulerDecision[] = [];
  for (const decision of decisions) {
    if (
      decision === null ||
      typeof decision !== 'object' ||
      typeof decision.writId !== 'string' ||
      decision.writId.length === 0
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" returned a malformed decision (missing writId) — ignoring.`,
      );
      continue;
    }
    if (!candidateIds.has(decision.writId)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" returned a decision for writ "${decision.writId}" which was not in the candidate set — ignoring.`,
      );
      continue;
    }
    inScope.push(decision);
  }

  const grouped = new Map<string, SchedulerDecision[]>();
  for (const decision of inScope) {
    const list = grouped.get(decision.writId) ?? [];
    list.push(decision);
    grouped.set(decision.writId, list);
  }
  for (const [writId, list] of grouped) {
    if (list.length > 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" returned ${list.length} decisions for writ "${writId}" — refusing to apply any. Schedulers must emit at most one decision per candidate.`,
      );
      return;
    }
  }

  // 10. Apply decisions. Per-decision sequencing is independent —
  //     one writ's transition / row failure does not stop sibling
  //     writs in the same tick.
  for (const candidate of candidates) {
    const decision = grouped.get(candidate.writ.id)?.[0];
    if (!decision) {
      // No decision for this candidate — defer-equivalent absence.
      continue;
    }
    await applyDecision({
      ctx,
      writ: candidate.writ,
      ext: candidate.ext,
      now,
      ...(tickEventId !== undefined ? { tickEventId } : {}),
      decision,
      schedulerId: activeScheduler.id,
    });
  }
}

// ── Gate-decline helper ────────────────────────────────────────────

/**
 * Common path for the inline source / disabled-source gate declines.
 * Walks the dedupe lookup first so a re-tick on the same writ-version
 * does not produce a duplicate row. Returns `true` once it has
 * persisted a row and driven the transition (or returned via dedupe);
 * returns `false` when the transition or row write threw.
 */
async function applyGateDecline(args: {
  ctx: TickContext;
  writ: WritDoc;
  ext: ReckonerExt;
  now: Date;
  tickEventId?: string;
  declineReason: NonNullable<ReckoningDoc['declineReason']>;
  remediationHint: string;
  resolution: string;
  loggingContext: 'unregistered-strict' | 'disabled-source';
}): Promise<boolean> {
  const { ctx, writ, ext, now, declineReason, remediationHint, resolution, loggingContext } = args;

  if (await ctx.alreadyConsidered(writ.id, writ.updatedAt)) {
    return true;
  }

  try {
    await ctx.clerk.transition(writ.id, 'cancelled' as WritPhase, { resolution });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] tick (${loggingContext}): failed to transition writ "${writ.id}" to cancelled: ${msg}`,
    );
    return false;
  }

  const row = ctx.buildReckoningRow({
    now,
    writ,
    ext,
    outcome: 'declined',
    declineReason,
    remediationHint,
    ...(args.tickEventId !== undefined ? { tickEventId: args.tickEventId } : {}),
  });
  try {
    await ctx.reckoningsBook.put(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] tick (${loggingContext}): failed to persist Reckonings row for writ "${writ.id}": ${msg}`,
    );
  }
  return true;
}

// ── Decision-application helper ────────────────────────────────────

/**
 * Apply a single scheduler `SchedulerDecision` to its target writ:
 * transition (or skip) and persist a Reckonings row.
 *
 * The three outcome paths mirror the doc's outcome-mapping table:
 *
 * - `approve` — transition to the writ-type's active target phase
 *   and append an `accepted` row.
 * - `decline` — transition to the writ-type's cancelled phase with
 *   the decision's reason as the resolution string; append a
 *   `declined` row carrying `declineReason: 'other'` and the reason
 *   in `remediationHint`.
 * - `defer` — no transition. Append a `deferred` row carrying
 *   `deferReason: 'other'` and the decision's reason in
 *   `deferNote`. Other defer-metadata fields stay absent.
 */
async function applyDecision(args: {
  ctx: TickContext;
  writ: WritDoc;
  ext: ReckonerExt;
  now: Date;
  tickEventId?: string;
  decision: SchedulerDecision;
  schedulerId: string;
}): Promise<void> {
  const { ctx, writ, ext, now, decision, schedulerId } = args;

  if (
    decision.outcome !== 'approve' &&
    decision.outcome !== 'decline' &&
    decision.outcome !== 'defer'
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] scheduler: "${schedulerId}" returned an unknown outcome "${String((decision as { outcome?: unknown }).outcome)}" for writ "${writ.id}" — ignoring.`,
    );
    return;
  }

  if (decision.outcome === 'defer') {
    const row = ctx.buildReckoningRow({
      now,
      writ,
      ext,
      outcome: 'deferred',
      deferReason: 'other',
      deferNote: decision.reason,
      ...(decision.weight !== undefined ? { weight: decision.weight } : {}),
      ...(args.tickEventId !== undefined ? { tickEventId: args.tickEventId } : {}),
    });
    try {
      await ctx.reckoningsBook.put(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] tick: failed to persist Reckonings row for writ "${writ.id}" (scheduler defer): ${msg}`,
      );
    }
    return;
  }

  if (decision.outcome === 'decline') {
    try {
      await ctx.clerk.transition(writ.id, 'cancelled' as WritPhase, {
        resolution: decision.reason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] tick: failed to transition writ "${writ.id}" to cancelled (scheduler decline): ${msg}`,
      );
      return;
    }

    const row = ctx.buildReckoningRow({
      now,
      writ,
      ext,
      outcome: 'declined',
      declineReason: 'other',
      remediationHint: decision.reason,
      ...(decision.weight !== undefined ? { weight: decision.weight } : {}),
      ...(args.tickEventId !== undefined ? { tickEventId: args.tickEventId } : {}),
    });
    try {
      await ctx.reckoningsBook.put(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] tick: failed to persist Reckonings row for writ "${writ.id}" (scheduler decline): ${msg}`,
      );
    }
    return;
  }

  // approve.
  let target: string;
  try {
    target = ctx.resolveActiveTargetPhase(writ);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] tick: writ "${writ.id}" has no resolvable active target — leaving in new. ${msg}`,
    );
    return;
  }

  try {
    await ctx.clerk.transition(writ.id, target as WritPhase, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] tick: failed to transition writ "${writ.id}" to "${target}" (scheduler approve): ${msg}`,
    );
    return;
  }

  const row = ctx.buildReckoningRow({
    now,
    writ,
    ext,
    outcome: 'accepted',
    ...(decision.weight !== undefined ? { weight: decision.weight } : {}),
    ...(args.tickEventId !== undefined ? { tickEventId: args.tickEventId } : {}),
  });
  try {
    await ctx.reckoningsBook.put(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[reckoner] tick: failed to persist Reckonings row for writ "${writ.id}" (scheduler approve): ${msg}`,
    );
  }
}

// ── Relay factory ───────────────────────────────────────────────────

/**
 * Build the `reckoner.tick` `RelayDefinition`. Exported so the
 * apparatus boot path can wire it into `supportKit.relays`, and so
 * unit tests can drive the relay's handler directly.
 *
 * The relay's handler closes over the supplied `TickContext` — the
 * same context the pure helper above takes. Production wires the
 * context from `buildReckoner()`'s closure-scoped state; tests can
 * pass a hand-built one.
 */
export function createTickRelay(ctx: TickContext): RelayDefinition {
  return relay({
    name: RECKONER_TICK_RELAY_NAME,
    description:
      'Periodic Reckoner tick — sweeps held petitions through the configured scheduler and applies decisions.',
    handler: async (event) => {
      await runTickHandler(ctx, event);
    },
  });
}

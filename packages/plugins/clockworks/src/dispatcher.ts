/**
 * Event-triggered standing-order dispatcher.
 *
 * This module is the consumer side of the event substrate. Given the
 * events book, the dispatches book, a relay resolver, the current
 * standing-order array, the guild home, and a clock, it performs one
 * full sweep of the queue:
 *
 *   1. Re-validate the standing-order array against the canonical
 *      shape (`standing-order-validator.ts`). If any order is
 *      malformed, throw aggregated and process nothing.
 *   2. Query the events book for unprocessed events ordered by id
 *      ascending (event ids are roughly chronological).
 *   3. For each event in id order, find every standing order whose
 *      `on:` matches the event name, in registration order.
 *   4. For each matching order, look up the relay by `run:`. If the
 *      relay is missing, write a single error dispatch row and move
 *      on. Otherwise invoke the handler with a clean `GuildEvent`
 *      view (no internal `processed` flag) and a fresh
 *      `RelayContext { home, params: order.with ?? {} }`. Wrap the
 *      invocation in its own try/catch so one throw never blocks
 *      sibling handlers.
 *   5. After every order for an event has been attempted, mark the
 *      event `processed: true`.
 *
 * The module is pure plumbing — no apparatus imports, no `guild()`
 * calls, no `Date.now()` directly. Every dependency is passed in so
 * the dispatcher can be unit-tested without booting Stacks.
 *
 * Cross-process invariant. Steps 2–5 (read-pending → invoke →
 * patch-processed) are sequential within a single sweep but **not
 * atomic across processes**. When two `processEvents` callers overlap
 * (e.g. the unattended daemon plus a manual `nsg clock run`, or two
 * manual runs), each can read the same unprocessed events before
 * either has flipped `processed: true`, and a relay handler may
 * therefore be invoked more than once for the same event. This is by
 * design: substrate-level row locking is intentionally deferred (see
 * the architecture doc's Deferred section). The contract is upheld by
 * relay-author idempotency, not by dispatcher coordination — relay
 * handlers MUST be safe to invoke more than once for the same
 * triggering event (see the `RelayHandler` JSDoc and
 * `docs/guides/building-relays.md`). Future commissions modifying the
 * sweep must preserve this contract or coordinate the change with the
 * relay-author surface.
 *
 * Commission decisions honored: D1, D2, D8–D14, D17–D26.
 */

import { generateId } from '@shardworks/nexus-core';
import type { Book, BookQuery, WhereClause } from '@shardworks/stacks-apparatus';

import { STANDING_ORDER_FAILED_EVENT } from './event-names.ts';
import type { GuildEvent, RelayContext, RelayDefinition } from './relay.ts';
import type {
  DispatchObservation,
  EventDispatchDoc,
  EventDoc,
  StandingOrder,
} from './types.ts';

export type { DispatchObservation } from './types.ts';

/**
 * One entry in the merged standing-order list the dispatcher consumes.
 *
 * The apparatus is the single owner of this merge — kit-layer entries
 * are sealed at apparatus boot, the operator layer is read fresh on
 * every `processEvents` call, and the two slices are concatenated in
 * `[...kit, ...operator]` order before being handed to the dispatcher.
 *
 * The dispatcher trusts its merged input (D3): kit-layer validation
 * already ran at apparatus boot through the source-aware validator,
 * and operator-layer validation runs in the apparatus's `processEvents`
 * path before this list is built. The dispatcher itself does NOT
 * re-validate.
 *
 * `orderIndex` is per-source — the index within the entry's own source
 * array (D7) — so error messages quote a number the operator (or kit
 * author) can match against the array they wrote. `source` is `null`
 * for the operator slice and the contributing pluginId for kit entries
 * (D8).
 */
export interface SourcedStandingOrder {
  /** The verbatim standing order from the contributing source. */
  order: StandingOrder;
  /** `null` for operator entries, contributing pluginId for kit entries. */
  source: string | null;
  /** Per-source index — position within `source`'s own array (D7). */
  orderIndex: number;
}

/**
 * Counts returned by a single sweep.
 *
 *   - `processedEvents` — events whose `processed` flag was flipped
 *     to true this sweep.
 *   - `dispatches` — total number of dispatch rows written across
 *     every event (every status variant counted).
 *   - `errors` — subset of `dispatches` whose `status` is `'error'`.
 *     Loop-guard `'skipped'` rows do NOT increment this counter:
 *     skips are policy decisions, not failures, and conflating them
 *     would break exit-code semantics in the CLI.
 *   - `skipped` — subset of `dispatches` whose `status` is
 *     `'skipped'`. Surfaced as a distinct counter so operators can
 *     see loop-guard activity without flipping a non-zero exit code
 *     on every cascade-suppressed `clockworks.standing-order.failed` event.
 */
export interface DispatchSummary {
  processedEvents: number;
  dispatches: number;
  errors: number;
  skipped: number;
}

/**
 * Inputs to `runDispatchSweep`. All dependencies are passed in so the
 * function is fully unit-testable against in-memory fakes.
 */
interface DispatchSweepInputs {
  /** Writable handle on `clockworks/events`. */
  events: Book<EventDoc>;
  /** Writable handle on `clockworks/event_dispatches`. */
  dispatches: Book<EventDispatchDoc>;
  /**
   * Resolves a relay name to its registered `RelayDefinition`, or
   * `undefined` when no relay with that name is registered.
   */
  resolveRelay: (name: string) => RelayDefinition | undefined;
  /**
   * The merged standing-order list — kit-layer entries first (sealed
   * at apparatus boot), operator-layer entries second (read fresh per
   * call so operators can hot-edit, D15). Each entry carries its own
   * source attribution (D7, D8) so error messages can name the
   * contributing kit when applicable.
   *
   * The apparatus owns the merge and the per-layer validation; the
   * dispatcher trusts this input verbatim (D3) and does not re-validate.
   */
  standingOrders: readonly SourcedStandingOrder[];
  /** Absolute path to the guild home. Forwarded into `RelayContext`. */
  home: string;
  /** ISO-string clock — defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /**
   * Optional event-id filter. When supplied, the sweep processes only
   * the matching event (still subject to the `processed: false`
   * predicate). Defaults to the full unprocessed queue.
   */
  eventId?: string;
  /**
   * Optional cap on the number of events processed in this sweep.
   * Defaults to no cap (full drain). When set to a positive integer
   * the dispatcher reads at most this many events from the queue.
   */
  max?: number;
  /**
   * Optional per-dispatch observer. Invoked once per dispatch row
   * after the row is persisted, regardless of status. The dispatcher
   * wraps the call in try/catch — a throwing observer cannot break
   * the dispatch loop or block sibling rows.
   *
   * Observers that need null-handler-match visibility should look at
   * the per-event diff in `summary.dispatches` between successive
   * sweeps; the events with zero rows are surfaced separately by the
   * CLI via the events-book read it does either way.
   */
  onDispatch?: (observation: DispatchObservation) => void;
  /**
   * Optional callback invoked once per real failure (thrown relay or
   * unresolved relay) so the apparatus can re-emit the failure as a
   * `clockworks.standing-order.failed` event into the events book. The dispatcher
   * never invokes this for loop-guard `'skipped'` rows — emitting on a
   * skip would re-open the cascade the guard exists to suppress.
   *
   * The callback is wrapped in try/catch by the dispatcher: if the
   * callback throws, the dispatch row that preceded it stays
   * persisted, the throw is logged via `console.warn`, and the sweep
   * continues. This mirrors the per-observer isolation idiom used for
   * `onDispatch`.
   */
  signalStandingOrderFailed?: (
    payload: StandingOrderFailedPayload,
  ) => Promise<void> | void;
}

/**
 * Payload shape signalled out via `signalStandingOrderFailed`. Mirrors
 * the field set the apparatus then forwards through `api.emit`. The
 * triggering-event projection is intentionally narrowed to `id` and
 * `name` only — the loop-guard reads `payload.triggeringEvent.name`
 * defensively, so any larger projection would just expand the cost of
 * a JSON serialize without giving consumers anything actionable.
 */
export interface StandingOrderFailedPayload {
  /** The standing order that failed, verbatim from the config array. */
  standingOrder: StandingOrder;
  /** Minimal projection of the event that triggered the failed dispatch. */
  triggeringEvent: { id: string; name: string };
  /** The same error string written to the dispatch row's `error` column. */
  error: string;
}

/**
 * Run one full dispatch sweep. See module docstring for the contract.
 *
 * @throws Error from `validateStandingOrders` when any order is
 *         malformed; in that case no events are read or written this
 *         sweep.
 */
export async function runDispatchSweep(
  inputs: DispatchSweepInputs,
): Promise<DispatchSummary> {
  const {
    events,
    dispatches,
    resolveRelay,
    standingOrders,
    home,
    now = () => new Date().toISOString(),
    eventId,
    max,
    onDispatch,
    signalStandingOrderFailed,
  } = inputs;

  // D3 (this commission): the dispatcher trusts its merged input. Both
  // layers were already validated by the apparatus — kit entries at
  // apparatus boot through the source-aware validator, operator entries
  // per-call in the apparatus's `processEvents` path before the merge.
  // Re-validating here would either re-throw on the kit layer's
  // already-validated entries (with the wrong attribution) or force the
  // dispatcher to re-thread the per-source labels — neither pays for
  // itself.

  // D13, D23: single full-drain query with no count() pre-check. Event
  // ids (`e-<base36_ts>-<hex>`) sort roughly chronologically, so id
  // ascending matches firedAt ascending closely enough for this
  // commission's purposes.
  //
  // The new optional fields add to the query without changing the
  // default-everything behavior:
  //   - `eventId` narrows the scan via an additional WHERE clause so
  //     only the targeted (still-unprocessed) row is read.
  //   - `max`, when provided as a positive integer, applies a `limit`
  //     so the dispatcher reads only what it will process.
  const where: WhereClause = [['processed', '=', false]];
  if (eventId !== undefined) {
    where.push(['id', '=', eventId]);
  }
  const query: BookQuery = {
    where,
    orderBy: [['id', 'asc']],
  };
  if (typeof max === 'number' && max > 0 && Number.isFinite(max)) {
    (query as { limit?: number }).limit = max;
  }
  const pending = await events.find(query);

  const summary: DispatchSummary = {
    processedEvents: 0,
    dispatches: 0,
    errors: 0,
    skipped: 0,
  };

  for (const eventDoc of pending) {
    // D18: build a clean event view without the bookkeeping flag so
    // handlers cannot accidentally depend on internal state.
    const guildEvent: GuildEvent = {
      id: eventDoc.id,
      name: eventDoc.name,
      payload: eventDoc.payload,
      emitter: eventDoc.emitter,
      firedAt: eventDoc.firedAt,
    };

    // D9, D15: cheap per-event probe of the loop-guard condition.
    // We read the persisted payload defensively against arbitrary
    // shape — `payload` is `unknown` and only the immediate
    // `triggeringEvent.name` field is consulted (D15 caps the check
    // at one level, since D14 suppresses dispatcher-emitted SOF on
    // the skipped row, so chains never exceed depth two via the
    // dispatcher's own emissions).
    const isLoopGuardEvent = isStandingOrderFailedTrigger(eventDoc.payload);

    // D8: match purely on string equality of `on:`. Undeclared event
    // names naturally match no orders. Each candidate carries its own
    // per-source `orderIndex` and `source` label, so the dispatcher's
    // error messages can name the offending position the operator (or
    // kit author) recognizes.
    for (const sourced of standingOrders) {
      const order = sourced.order;
      if (order.on !== eventDoc.name) continue;

      await dispatchOrder({
        order,
        index: sourced.orderIndex,
        source: sourced.source,
        eventDoc,
        guildEvent,
        dispatches,
        resolveRelay,
        home,
        now,
        summary,
        onDispatch,
        signalStandingOrderFailed,
        isLoopGuardEvent,
      });
    }

    // D14: minimal patch flips only the bookkeeping flag. The
    // processed-flip happens once every order has been attempted —
    // both success and failure rows are already persisted.
    await events.patch(eventDoc.id, { processed: true });
    summary.processedEvents += 1;
  }

  return summary;
}

interface DispatchOrderInputs {
  order: StandingOrder;
  /** Per-source index for the order — matches the operator's mental model. */
  index: number;
  /** `null` for operator entries, contributing pluginId for kit entries (D8). */
  source: string | null;
  eventDoc: EventDoc;
  guildEvent: GuildEvent;
  dispatches: Book<EventDispatchDoc>;
  resolveRelay: (name: string) => RelayDefinition | undefined;
  home: string;
  now: () => string;
  summary: DispatchSummary;
  onDispatch?: (observation: DispatchObservation) => void;
  signalStandingOrderFailed?: (
    payload: StandingOrderFailedPayload,
  ) => Promise<void> | void;
  /**
   * Pre-computed loop-guard flag (D9, D13). Set per event in
   * `runDispatchSweep` so the per-order branch is a single boolean
   * read; D13 puts the branch first inside `dispatchOrder`.
   */
  isLoopGuardEvent: boolean;
}

/**
 * Resolve and invoke a single standing order, then write a one-phase
 * dispatch row reflecting the outcome (D9). Captured here so the main
 * sweep loop stays linear and the per-handler isolation (D24) is
 * obvious from the try/catch placement.
 */
async function dispatchOrder(args: DispatchOrderInputs): Promise<void> {
  const {
    order,
    index,
    source,
    eventDoc,
    guildEvent,
    dispatches,
    resolveRelay,
    home,
    now,
    summary,
    onDispatch,
    signalStandingOrderFailed,
    isLoopGuardEvent,
  } = args;

  const handlerName = order.run;
  const params: Record<string, unknown> = order.with ?? {};

  // D13, D14, D18, D19: loop-guard branch sits FIRST so the relay is
  // never resolved, never invoked, and no SOF event is emitted on
  // skipped rows. The persisted row carries the loop-guard reason in
  // its `error` column (D10) and uses the unresolved-relay timestamp
  // convention (`startedAt = endedAt = now()`, durationMs = 0).
  if (isLoopGuardEvent) {
    const ts = now();
    const reason = `loop-guard: triggering event was a ${STANDING_ORDER_FAILED_EVENT}`;
    await writeDispatchRow({
      dispatches,
      eventId: eventDoc.id,
      handlerName,
      startedAt: ts,
      endedAt: ts,
      status: 'skipped',
      error: reason,
    });
    summary.dispatches += 1;
    summary.skipped += 1;
    notifyObserver(onDispatch, {
      eventId: eventDoc.id,
      eventName: eventDoc.name,
      handlerName,
      status: 'skipped',
      durationMs: 0,
      error: reason,
    });
    return;
  }

  // D20: unresolved relay produces one error row with the
  // index-naming message and does not block sibling orders. D8: the
  // message attributes the kit when the entry came from a kit
  // contribution; operator entries continue to read as before.
  const relay = resolveRelay(handlerName);
  if (!relay) {
    const ts = now();
    const sourceTag = source === null ? '' : ` (kit "${source}")`;
    const errorMsg = `clockworks: relay "${handlerName}" referenced by standing order ${index}${sourceTag} is not registered.`;
    await writeDispatchRow({
      dispatches,
      eventId: eventDoc.id,
      handlerName,
      startedAt: ts,
      endedAt: ts,
      status: 'error',
      error: errorMsg,
    });
    summary.dispatches += 1;
    summary.errors += 1;
    notifyObserver(onDispatch, {
      eventId: eventDoc.id,
      eventName: eventDoc.name,
      handlerName,
      status: 'error',
      durationMs: 0,
      error: errorMsg,
    });
    // D3, D7: SOF emission for the unresolved-relay failure path.
    // The same string already written to the row's error column is
    // forwarded so subscribers can correlate (eventId, handlerName).
    await signalFailure(signalStandingOrderFailed, {
      standingOrder: order,
      triggeringEvent: { id: eventDoc.id, name: eventDoc.name },
      error: errorMsg,
    });
    return;
  }

  // D11: per-call RelayContext with `home` straight from inputs and
  // `params` defaulted to `{}` when `with:` is absent.
  const context: RelayContext = { home, params };

  // D22: capture timestamps immediately around the await so the
  // recorded interval reflects the actual handler runtime.
  const startedAt = now();
  let status: 'success' | 'error' = 'success';
  let error: string | null = null;

  // D24: per-handler try/catch — one throw never blocks sibling
  // handlers or sibling events. D19: the apparatus's existing idiom
  // for non-Error throws (`String(err)`).
  try {
    await relay.handler(guildEvent, context);
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
  const endedAt = now();

  await writeDispatchRow({
    dispatches,
    eventId: eventDoc.id,
    handlerName,
    startedAt,
    endedAt,
    status,
    error,
  });
  summary.dispatches += 1;
  if (status === 'error') summary.errors += 1;
  notifyObserver(onDispatch, {
    eventId: eventDoc.id,
    eventName: eventDoc.name,
    handlerName,
    status,
    durationMs: computeDurationMs(startedAt, endedAt),
    error,
  });
  // D3, D7: SOF emission for the thrown-relay failure path. Mirror
  // the unresolved-relay branch; the same string already written to
  // the dispatch row is forwarded to the apparatus.
  if (status === 'error') {
    await signalFailure(signalStandingOrderFailed, {
      standingOrder: order,
      triggeringEvent: { id: eventDoc.id, name: eventDoc.name },
      error: error ?? '',
    });
  }
}

/**
 * Compute the wall-clock interval between two ISO timestamps in
 * milliseconds. Returns 0 when either timestamp is unparseable; the
 * dispatcher's clock fixture always supplies parseable strings, so
 * the fallback only matters under hand-injected pathological inputs.
 */
function computeDurationMs(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  // Clamp negative deltas (out-of-order clock) to 0; surfacing a
  // negative duration would only confuse operators.
  return Math.max(0, end - start);
}

/**
 * Invoke the per-dispatch observer with isolation: a thrown observer
 * is caught and ignored so it cannot block the dispatch loop. This
 * mirrors the per-handler isolation idiom used for relays themselves
 * (D24 in the dispatcher commission).
 */
function notifyObserver(
  observer: ((observation: DispatchObservation) => void) | undefined,
  observation: DispatchObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch {
    // Intentionally swallow — observer errors are operator-side
    // formatting concerns, not dispatch-loop concerns.
  }
}

/**
 * Invoke the failure callback with isolation: a thrown callback is
 * caught and logged via `console.warn`, then the sweep continues. The
 * dispatch row that triggered the SOF emit is already persisted by
 * the time we land here, so the operator-visible record of the
 * underlying failure stays intact even when emission itself misfires
 * (D4). Mirrors the `notifyObserver` idiom used for the per-dispatch
 * observer.
 */
async function signalFailure(
  signaler:
    | ((payload: StandingOrderFailedPayload) => Promise<void> | void)
    | undefined,
  payload: StandingOrderFailedPayload,
): Promise<void> {
  if (!signaler) return;
  try {
    await signaler(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[clockworks] failed to emit ${STANDING_ORDER_FAILED_EVENT} for event "${payload.triggeringEvent.id}": ${message}`,
    );
  }
}

/**
 * Defensive probe: returns true when `payload` looks like the SOF
 * payload shape this dispatcher writes. Only `triggeringEvent.name`
 * is consulted (D15: immediate-parent only); arbitrary payload shapes
 * (null, primitives, arrays, foreign objects) safely return false.
 *
 * Module-internal helper — the production caller is the per-event probe
 * in `runDispatchSweep`.
 */
function isStandingOrderFailedTrigger(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const triggering = (payload as { triggeringEvent?: unknown }).triggeringEvent;
  if (typeof triggering !== 'object' || triggering === null) return false;
  const name = (triggering as { name?: unknown }).name;
  return name === STANDING_ORDER_FAILED_EVENT;
}

interface WriteDispatchInputs {
  dispatches: Book<EventDispatchDoc>;
  eventId: string;
  handlerName: string;
  startedAt: string;
  endedAt: string;
  // `'pending'` is part of the persisted row's union but the dispatcher
  // only ever writes terminal rows in this commission, so the input
  // shape is deliberately narrowed to the terminal subset.
  status: 'success' | 'error' | 'skipped';
  error: string | null;
}

/**
 * Compose and persist a single `event_dispatches` row. Centralized so
 * the schema-shape constants (`handlerType: 'relay'`,
 * `targetRole: null`, `noticeType: null`, the `d-` id prefix) live in
 * exactly one place per D10 / D17.
 */
async function writeDispatchRow(inputs: WriteDispatchInputs): Promise<void> {
  const {
    dispatches,
    eventId,
    handlerName,
    startedAt,
    endedAt,
    status,
    error,
  } = inputs;

  const doc: EventDispatchDoc = {
    id: generateId('d'),
    eventId,
    handlerType: 'relay',
    handlerName,
    // D10: explicit nulls — the field contract is non-optional so
    // omitting them would let `undefined` leak across the boundary.
    targetRole: null,
    noticeType: null,
    startedAt,
    endedAt,
    status,
    error,
  };

  await dispatches.put(doc);
}

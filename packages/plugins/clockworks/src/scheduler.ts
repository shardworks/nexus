/**
 * Time-driven standing-order scheduler.
 *
 * Companion to `dispatcher.ts`. The dispatcher consumes the events
 * book; the scheduler synthesizes events for time-driven standing
 * orders that bind via `schedule:` instead of `on:`.
 *
 * Per tick:
 *
 *   1. Iterate the in-memory schedule table in `orderIndex` ascending
 *      order (D13). For each entry whose `nextFireTime <= now`:
 *      a. Persist a `schedule.fired` event row with `processed: true`
 *         (D5) carrying the verbatim standing order, the order's
 *         array index, and the fire time (D2).
 *      b. Synthesize a matching `GuildEvent` view (no internal
 *         `processed` flag) so the relay handler sees the exact same
 *         shape as the dispatcher path.
 *      c. Resolve the relay by `run:`. Unresolved relay → write an
 *         error dispatch row, fire the SOF callback, advance
 *         `nextFireTime`, continue (D15).
 *      d. Invoke the relay handler with isolated try/catch (matches
 *         the dispatcher's per-handler isolation idiom). A throw is
 *         captured into the dispatch row's error column and forwarded
 *         to the SOF callback.
 *      e. Persist the dispatch row via the existing helper (D5) —
 *         scheduled fires share the row shape with event-driven
 *         dispatches; only the synthesized `eventId` distinguishes
 *         them.
 *      f. Notify the observer (D16 — same shape as the dispatcher's
 *         `onDispatch` callback so the daemon's log formatter handles
 *         both passes uniformly).
 *      g. Advance `nextFireTime` via the schedule parser. Within a
 *         single tick we fire at most once per order even if
 *         `nextFireTime + duration` is still in the past (D10's
 *         in-tick guard); subsequent ticks will catch up one fire at
 *         a time.
 *   2. Return per-tick counts for observability.
 *
 * Pure plumbing — no apparatus imports, no `guild()`, no `Date.now()`
 * directly. Every dependency is parameter-injected so unit tests can
 * drive the primitive against `MemoryBackend` with a virtual clock.
 *
 * Honors decisions D2, D4, D5, D8–D16, D18.
 */

import { generateId } from '@shardworks/nexus-core';
import type { Book } from '@shardworks/stacks-apparatus';

import type { GuildEvent, RelayContext, RelayDefinition } from './relay.ts';
import { computeNextFireTime, type ParsedSchedule } from './schedule-parser.ts';
import type {
  DispatchObservation,
  EventDispatchDoc,
  EventDoc,
  StandingOrder,
} from './types.ts';
import type { StandingOrderFailedPayload } from './dispatcher.ts';

// ── Public types ─────────────────────────────────────────────────────

/**
 * One row of the in-memory schedule table — built fresh on apparatus
 * `start()` (D11), keyed by the order's `orderIndex` so the apparatus
 * can read both the verbatim order and its parsed schedule handle
 * without re-walking the config array on every tick.
 */
export interface ScheduleEntry {
  /**
   * Stable index into `guildConfig().clockworks.standingOrders`. Used
   * for fire-ordering when multiple entries are due simultaneously
   * (D13) and for surfacing the offending index in error messages.
   */
  readonly orderIndex: number;
  /** The verbatim standing order from `guild.json`. */
  readonly order: StandingOrder;
  /** Parsed schedule handle from {@link parseSchedule}. */
  readonly parsed: ParsedSchedule;
  /**
   * Mutable: the absolute fire time. Initially seeded at apparatus
   * start to `computeNextFireTime(parsed, startTime)`; advanced
   * through the same helper after each fire.
   */
  nextFireTime: Date;
}

/**
 * Counts returned by a single scheduler tick. Mirrors the
 * `DispatchSummary` field set so daemon-side observers can trivially
 * sum scheduler+dispatcher tick output.
 */
export interface ScheduleSweepSummary {
  /** Number of scheduled orders that fired this tick. */
  fired: number;
  /** Subset of `fired` where the relay reported error / was missing. */
  errors: number;
}

/** Inputs to {@link runScheduleSweep}. */
export interface ScheduleSweepInputs {
  /** The schedule table, mutated in place to advance `nextFireTime`. */
  schedule: ScheduleEntry[];
  /** Writable handle on `clockworks/events`. */
  events: Book<EventDoc>;
  /** Writable handle on `clockworks/event_dispatches`. */
  dispatches: Book<EventDispatchDoc>;
  /** Resolve a relay name to its `RelayDefinition`, or `undefined`. */
  resolveRelay: (name: string) => RelayDefinition | undefined;
  /** Absolute path to the guild home — forwarded into RelayContext. */
  home: string;
  /**
   * Time source — returns the current wall-clock instant. Tests pass
   * a virtual clock; production passes `() => new Date()`. Per D14 a
   * single source so ms and ISO derivations stay in lockstep.
   */
  now: () => Date;
  /**
   * Optional per-fire observer. Invoked once per dispatch row after
   * the row is persisted, regardless of status. Throws are isolated.
   * Defaulting to undefined means the daemon hooks the same callback
   * the dispatcher's `onDispatch` uses (D16).
   */
  onDispatch?: (observation: DispatchObservation) => void;
  /**
   * Optional callback invoked once per real failure (thrown relay or
   * unresolved relay). The apparatus passes the same lambda it gives
   * the dispatcher so a `standing-order.failed` event lands in the
   * events book (D15). Throws are isolated.
   */
  signalStandingOrderFailed?: (
    payload: StandingOrderFailedPayload,
  ) => Promise<void> | void;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run one tick of the scheduler. Returns counts; mutates `schedule[*].nextFireTime`.
 *
 * Sequential by design — `Promise.all` would lose the strict array-order
 * fire-ordering contract (D13) and complicate the loop-guard reasoning.
 */
export async function runScheduleSweep(
  inputs: ScheduleSweepInputs,
): Promise<ScheduleSweepSummary> {
  const {
    schedule,
    events,
    dispatches,
    resolveRelay,
    home,
    now,
    onDispatch,
    signalStandingOrderFailed,
  } = inputs;

  const summary: ScheduleSweepSummary = { fired: 0, errors: 0 };

  // D13: iterate in `orderIndex` ascending. The schedule table is
  // populated in array order so a positional walk already honors the
  // contract; we do not re-sort on every tick.
  const tickStart = now();

  for (const entry of schedule) {
    if (entry.nextFireTime.getTime() > tickStart.getTime()) {
      // Not due yet. The strict `>` keeps the "fire when nextFireTime <=
      // now" boundary inclusive on the tick clock.
      continue;
    }

    await fireScheduleEntry({
      entry,
      events,
      dispatches,
      resolveRelay,
      home,
      now,
      onDispatch,
      signalStandingOrderFailed,
      summary,
    });

    // D10 / D11: advance from the *prior* fire time, not from `now`.
    // For `@every` this preserves cadence (every Nm anchored on the
    // initial seed); for cron it picks up the next boundary after the
    // fire we just performed. The in-tick guard is the single
    // continue-fire — even if the new nextFireTime is still in the
    // past (we missed N intervals), we wait until the next tick to
    // fire again.
    entry.nextFireTime = computeNextFireTime(entry.parsed, entry.nextFireTime);
  }

  return summary;
}

// ── Internals ─────────────────────────────────────────────────────────

interface FireEntryInputs {
  entry: ScheduleEntry;
  events: Book<EventDoc>;
  dispatches: Book<EventDispatchDoc>;
  resolveRelay: (name: string) => RelayDefinition | undefined;
  home: string;
  now: () => Date;
  onDispatch?: (observation: DispatchObservation) => void;
  signalStandingOrderFailed?: (
    payload: StandingOrderFailedPayload,
  ) => Promise<void> | void;
  summary: ScheduleSweepSummary;
}

/**
 * Fire a single scheduled entry: persist `schedule.fired`, resolve the
 * relay, invoke (with isolation), persist a dispatch row, notify the
 * observer, and forward failures via the SOF callback.
 */
async function fireScheduleEntry(args: FireEntryInputs): Promise<void> {
  const {
    entry,
    events,
    dispatches,
    resolveRelay,
    home,
    now,
    onDispatch,
    signalStandingOrderFailed,
    summary,
  } = args;

  const fireTime = now();
  const fireTimeIso = fireTime.toISOString();

  // ── (a) Persist `schedule.fired` event row with processed=true ──
  //
  // D5: the row is the durable record of the fire. Marking it
  // processed at write time means the dispatcher's event-sweep does
  // not pick it up — the scheduler is the only authorized consumer
  // of `schedule.*` events (the reserved-namespace allowlist enforces
  // the symmetric rule on emit).
  const eventId = generateId('e');
  const eventName = 'schedule.fired';
  const payload = {
    standingOrder: entry.order,
    orderIndex: entry.orderIndex,
    fireTime: fireTimeIso,
  };
  const eventDoc: EventDoc = {
    id: eventId,
    name: eventName,
    payload,
    emitter: 'framework',
    firedAt: fireTimeIso,
    processed: true,
  };
  await events.put(eventDoc);

  // (b) Synthesized GuildEvent view — same shape the dispatcher hands
  // to relay handlers, so authoring a relay that handles both event
  // and scheduled triggers needs no special-casing.
  const guildEvent: GuildEvent = {
    id: eventId,
    name: eventName,
    payload,
    emitter: 'framework',
    firedAt: fireTimeIso,
  };

  // (c) / (d): resolve and invoke.
  const handlerName = entry.order.run;
  const params: Record<string, unknown> = entry.order.with ?? {};

  summary.fired += 1;

  const relay = resolveRelay(handlerName);
  if (!relay) {
    const errorMsg =
      `clockworks: relay "${handlerName}" referenced by scheduled order ` +
      `${entry.orderIndex} is not registered.`;
    await writeDispatchRow({
      dispatches,
      eventId,
      handlerName,
      startedAt: fireTimeIso,
      endedAt: fireTimeIso,
      status: 'error',
      error: errorMsg,
    });
    summary.errors += 1;
    notifyObserver(onDispatch, {
      eventId,
      eventName,
      handlerName,
      status: 'error',
      durationMs: 0,
      error: errorMsg,
    });
    await signalFailure(signalStandingOrderFailed, {
      standingOrder: entry.order,
      triggeringEvent: { id: eventId, name: eventName },
      error: errorMsg,
    });
    return;
  }

  const context: RelayContext = { home, params };

  const startedAt = now();
  let status: 'success' | 'error' = 'success';
  let error: string | null = null;

  try {
    await relay.handler(guildEvent, context);
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
  const endedAt = now();

  await writeDispatchRow({
    dispatches,
    eventId,
    handlerName,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    status,
    error,
  });
  if (status === 'error') summary.errors += 1;

  notifyObserver(onDispatch, {
    eventId,
    eventName,
    handlerName,
    status,
    durationMs: computeDurationMs(startedAt, endedAt),
    error,
  });

  if (status === 'error') {
    await signalFailure(signalStandingOrderFailed, {
      standingOrder: entry.order,
      triggeringEvent: { id: eventId, name: eventName },
      error: error ?? '',
    });
  }
}

function computeDurationMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function notifyObserver(
  observer: ((observation: DispatchObservation) => void) | undefined,
  observation: DispatchObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch {
    // observer errors are formatting concerns, not loop concerns
  }
}

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
      `[clockworks] failed to emit standing-order.failed for scheduled fire "${payload.triggeringEvent.id}": ${message}`,
    );
  }
}

interface WriteDispatchInputs {
  dispatches: Book<EventDispatchDoc>;
  eventId: string;
  handlerName: string;
  startedAt: string;
  endedAt: string;
  status: 'success' | 'error';
  error: string | null;
}

/**
 * Compose and persist a single `event_dispatches` row for a scheduled
 * fire. Mirrors the dispatcher's `writeDispatchRow` field-by-field —
 * scheduled fires deliberately reuse the same row shape so operators
 * grep the dispatches book uniformly. The dispatcher writes
 * `'pending' | 'success' | 'error' | 'skipped'`; the scheduler is
 * narrower (no loop-guard, no pending) and writes only success/error.
 */
async function writeDispatchRow(inputs: WriteDispatchInputs): Promise<void> {
  const { dispatches, eventId, handlerName, startedAt, endedAt, status, error } = inputs;

  const doc: EventDispatchDoc = {
    id: generateId('d'),
    eventId,
    handlerType: 'relay',
    handlerName,
    targetRole: null,
    noticeType: null,
    startedAt,
    endedAt,
    status,
    error,
  };

  await dispatches.put(doc);
}

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
 * Commission decisions honored: D1, D2, D8–D14, D17–D26.
 */

import { generateId } from '@shardworks/nexus-core';
import type { Book } from '@shardworks/stacks-apparatus';

import type { GuildEvent, RelayContext, RelayDefinition } from './relay.ts';
import { validateStandingOrders } from './standing-order-validator.ts';
import type { EventDispatchDoc, EventDoc, StandingOrder } from './types.ts';

/**
 * Counts returned by a single sweep. `processedEvents` is the count
 * of events whose `processed` flag was flipped to true; `dispatches`
 * is the total number of dispatch rows written across every event;
 * `errors` is the subset of those rows whose `status` is `'error'`.
 */
export interface DispatchSummary {
  processedEvents: number;
  dispatches: number;
  errors: number;
}

/**
 * Inputs to `runDispatchSweep`. All dependencies are passed in so the
 * function is fully unit-testable against in-memory fakes.
 */
export interface DispatchSweepInputs {
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
   * The current standing-order array, typically read fresh from
   * `g.guildConfig().clockworks?.standingOrders ?? []` per call so
   * operators can hot-edit (D15).
   */
  standingOrders: readonly StandingOrder[];
  /** Absolute path to the guild home. Forwarded into `RelayContext`. */
  home: string;
  /** ISO-string clock — defaults to `() => new Date().toISOString()`. */
  now?: () => string;
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
  } = inputs;

  // D3, D4, D26: re-validate every sweep; aggregated throw on any
  // violation; no events read or written when validation fails.
  validateStandingOrders(standingOrders as readonly unknown[]);

  // D13, D23: single full-drain query with no count() pre-check. Event
  // ids (`e-<base36_ts>-<hex>`) sort roughly chronologically, so id
  // ascending matches firedAt ascending closely enough for this
  // commission's purposes.
  const pending = await events.find({
    where: [['processed', '=', false]],
    orderBy: [['id', 'asc']],
  });

  const summary: DispatchSummary = {
    processedEvents: 0,
    dispatches: 0,
    errors: 0,
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

    // D8: match purely on string equality of `on:`. Undeclared event
    // names naturally match no orders. Orders are visited in
    // registration order with their original index preserved (D20
    // requires the index in error messages).
    for (let index = 0; index < standingOrders.length; index += 1) {
      const order = standingOrders[index];
      if (order.on !== eventDoc.name) continue;

      await dispatchOrder({
        order,
        index,
        eventDoc,
        guildEvent,
        dispatches,
        resolveRelay,
        home,
        now,
        summary,
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
  index: number;
  eventDoc: EventDoc;
  guildEvent: GuildEvent;
  dispatches: Book<EventDispatchDoc>;
  resolveRelay: (name: string) => RelayDefinition | undefined;
  home: string;
  now: () => string;
  summary: DispatchSummary;
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
    eventDoc,
    guildEvent,
    dispatches,
    resolveRelay,
    home,
    now,
    summary,
  } = args;

  const handlerName = order.run;
  const params: Record<string, unknown> = order.with ?? {};

  // D20: unresolved relay produces one error row with the
  // index-naming message and does not block sibling orders.
  const relay = resolveRelay(handlerName);
  if (!relay) {
    const ts = now();
    await writeDispatchRow({
      dispatches,
      eventId: eventDoc.id,
      handlerName,
      startedAt: ts,
      endedAt: ts,
      status: 'error',
      error: `clockworks: relay "${handlerName}" referenced by standing order ${index} is not registered.`,
    });
    summary.dispatches += 1;
    summary.errors += 1;
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

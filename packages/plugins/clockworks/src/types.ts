/**
 * Clockworks public types.
 *
 * All types exported from `@shardworks/clockworks-apparatus`.
 *
 * The Clockworks is the guild's event substrate (Pillar 5). It declares
 * events, accepts emissions into the `clockworks/events` book, and —
 * once runtime behavior lands in later commissions — dispatches each
 * event to every matching standing order, recording one
 * `clockworks/event_dispatches` document per handler invocation.
 *
 * This commission ships the type surface and the module augmentation
 * only. The apparatus factory and the CLI stubs live next to it; the
 * runtime (emit, dispatch, runner, CDC auto-wiring, daemon) arrives in
 * later commissions.
 */

// The explicit import anchors this file to `@shardworks/nexus-core` so
// TypeScript treats the `declare module` block below as an
// external-module augmentation (vs. a global augmentation). Without at
// least one import from the target module TS2664 fires at compile time.
import type { Kit } from '@shardworks/nexus-core';
import type { BookEntry } from '@shardworks/stacks-apparatus';

import type { RelayDefinition } from './relay.ts';

// ── Config ───────────────────────────────────────────────────────────

/**
 * A custom event declaration in `guild.json` under `clockworks.events`.
 *
 * Framework events (e.g. `writ.stuck`, `session.end`) are declared by
 * the plugins that produce them; only operator-defined events need to
 * appear here.
 */
export interface EventDeclaration {
  /** Human-readable description of what this event means. */
  description?: string;
  /** Optional payload schema hint (not enforced in Phase 1). */
  schema?: Record<string, string>;
}

/**
 * A standing order — a registered response to an event or schedule.
 *
 * A standing order names exactly one trigger (either `on:` for an
 * event-driven order or `schedule:` for a time-driven order) and
 * exactly one relay to invoke (`run:`), with an optional parameter
 * object (`with:`) handed to the relay as `RelayContext.params`.
 *
 * Per commission decision D1 the TypeScript type leaves both `on:`
 * and `schedule:` optional — the canonical-shape XOR rule (exactly
 * one of `on:`/`schedule:` must be present) lives in the
 * standing-order validator. The same module is the load-time owner
 * for ruling out earlier sugar forms (`summon:`, `brief:`,
 * flat-spread params), unknown top-level keys, and invalid `with:`
 * shapes.
 */
export interface StandingOrder {
  /**
   * Event name to subscribe to — exact match against `EventDoc.name`.
   * Mutually exclusive with `schedule:`; exactly one must be present.
   */
  on?: string;
  /**
   * Time-trigger expression. Either `@every <N><s|m|h>` or a standard
   * 5-field unix cron expression. Mutually exclusive with `on:`;
   * exactly one must be present. The validator parse-checks the value
   * at guild.json load time using the shared schedule parser, so
   * malformed expressions fail loud at boot rather than at first fire.
   */
  schedule?: string;
  /** Name of the relay to invoke when the order fires. */
  run: string;
  /**
   * Optional parameter object passed through to the relay handler as
   * `RelayContext.params`. Plain object only; null, arrays, and
   * primitives are rejected by the validator.
   */
  with?: Record<string, unknown>;
}

/**
 * The Clockworks configuration block in `guild.json` under the
 * `clockworks` key.
 */
export interface ClockworksConfig {
  /** Custom event declarations keyed by event name. */
  events?: Record<string, EventDeclaration>;
  /** Standing orders — event → action mappings. */
  standingOrders?: StandingOrder[];
}

// Augment GuildConfig so `guild().guildConfig().clockworks` is typed
// without requiring a manual type parameter at the call site. Every
// sibling apparatus owns its own config shape this way.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    clockworks?: ClockworksConfig;
  }
}

// ── Book documents ───────────────────────────────────────────────────

// Id schemes for this apparatus's two books, mirroring the
// `generateId`-produced shape used by pulses and writs. Events use
// `e-<base36_ts>-<hex>`; dispatches use `d-<base36_ts>-<hex>`.

/**
 * One document per emission into `clockworks/events`.
 *
 * The Clockworks itself assigns the id, records the emitter and fire
 * time, and — once runtime behavior lands — flips `processed` to true
 * after every matching standing order has been dispatched (or found to
 * have no match).
 */
export interface EventDoc extends BookEntry {
  /** Unique event id (`e-<base36_ts>-<hex>`). Sortable by creation time. */
  id: string;
  /**
   * Event name — framework events use `{pluginId}.{kebab-suffix}`
   * (e.g. `clerk.writ-stuck`); operator-defined events follow the same
   * grammar.
   */
  name: string;
  /**
   * Structured payload. Shape is keyed by event name; the Clockworks
   * does not enforce a schema in Phase 1.
   */
  payload: unknown;
  /** Plugin id of the emitter that produced this event. */
  emitter: string;
  /** ISO timestamp when the event was emitted. */
  firedAt: string;
  /**
   * Whether every matching standing order has been dispatched. The
   * runner flips this to true after dispatch; the CDC auto-wiring task
   * will rely on it to filter the work queue.
   */
  processed: boolean;
}

/**
 * One document per handler invocation triggered by an event, stored
 * in `clockworks/event_dispatches`.
 *
 * Each standing order that matches an event produces exactly one
 * dispatch row; the row carries its own lifecycle from `pending` to
 * `success` or `error` as the runner works through it.
 */
export interface EventDispatchDoc extends BookEntry {
  /** Unique dispatch id (`d-<base36_ts>-<hex>`). */
  id: string;
  /** Id of the event that produced this dispatch (foreign key into `events`). */
  eventId: string;
  /** Whether this dispatch runs a relay or summons an anima session. */
  handlerType: 'relay' | 'anima';
  /**
   * Name of the handler — relay name for `handlerType: 'relay'`,
   * role id for `handlerType: 'anima'`.
   */
  handlerName: string;
  /**
   * For `handlerType: 'anima'`, the role id the session is opened in.
   * Always null for `handlerType: 'relay'`.
   */
  targetRole: string | null;
  /**
   * Emitted pulse kind, if the dispatcher raised a notice (e.g. a
   * summon invitation). Null when the dispatcher did not emit a pulse.
   */
  noticeType: 'summon' | null;
  /** ISO timestamp when handler execution began, or null while pending. */
  startedAt: string | null;
  /** ISO timestamp when handler execution ended, or null if still pending. */
  endedAt: string | null;
  /**
   * Lifecycle state of this dispatch.
   *
   *   - `'pending'` — dispatch row written, handler not yet attempted.
   *   - `'success'` — handler ran and returned without throwing.
   *   - `'error'`   — handler threw, OR the standing order's `run:`
   *     name did not resolve to a registered relay.
   *   - `'skipped'` — the dispatcher's loop-guard policy elided the
   *     invocation (e.g. the triggering event was itself a
   *     `standing-order.failed`). The relay was not called and no
   *     `standing-order.failed` event was emitted; this is policy
   *     suppression, not a failure, and must not count toward operator
   *     error metrics.
   */
  status: 'pending' | 'success' | 'error' | 'skipped';
  /**
   * Error text when `status === 'error'`, the loop-guard reason
   * (prefixed with `loop-guard:`) when `status === 'skipped'`, and
   * null otherwise.
   */
  error: string | null;
}

// ── API & Kit ────────────────────────────────────────────────────────

/**
 * The Clockworks' runtime API — retrieved via
 * `guild().apparatus<ClockworksApi>('clockworks')`.
 *
 * This commission extends the surface with both `emit()` (the trusted
 * write path) and `resolveRelay()` (the registry read method). The
 * dispatcher, runner, standing-order engine, and CDC auto-wiring arrive
 * in later commissions and will extend this surface as needed.
 */
export interface ClockworksApi {
  /**
   * Persist an event into the `clockworks/events` book and return the
   * generated event id.
   *
   * The Clockworks eagerly attempts `JSON.stringify` on the payload
   * before writing so non-serializable values (circular references,
   * `BigInt`, functions, …) are surfaced as a descriptive error at the
   * API boundary rather than as an opaque failure inside the Stacks
   * persistence layer. An `undefined` payload is coerced to `null` so
   * the stored row shape stays predictable.
   *
   * @param name    Event name — framework events use `{pluginId}.{suffix}`;
   *                operator-defined events follow the same grammar.
   * @param payload JSON-serializable payload, or `null`/`undefined`.
   * @param emitter Identifier of the caller that produced this event —
   *                plugin id, anima name, `'framework'`, `'operator'`, etc.
   * @returns       The generated event id (`e-<base36_ts>-<hex>`).
   * @throws        When `payload` cannot be JSON-serialized.
   */
  emit(name: string, payload: unknown, emitter: string): Promise<string>;

  /**
   * Look up a registered relay by name.
   *
   * Returns the `RelayDefinition` registered under `name` — sourced from
   * either a standalone kit's `relays` contribution or the apparatus's
   * own `supportKit.relays` slot — or `undefined` when no relay with that
   * name is registered. The dispatcher (future task) calls this when
   * resolving a standing order's `run:` field.
   *
   * Lookup is exact-match on the registration name; no prefix or case
   * folding is applied.
   */
  resolveRelay(name: string): RelayDefinition | undefined;

  /**
   * Drain every unprocessed event from the `events` book in one pass:
   * resolve each event's matching standing orders, invoke each named
   * relay, persist a dispatch row per invocation, then mark the event
   * processed.
   *
   * The current standing-order array is re-read from
   * `guildConfig().clockworks?.standingOrders` at the start of every
   * call so operators can hot-edit `guild.json` without restarting
   * the apparatus. The full set is validated against the canonical
   * shape; any malformed order causes the whole sweep to throw and no
   * events are processed that call.
   *
   * Per-handler isolation: a thrown handler does not block sibling
   * handlers or sibling events. Both success and error outcomes are
   * recorded as one-phase dispatch rows; the event is marked
   * `processed: true` after every matching order has been attempted
   * (regardless of outcome).
   *
   * Sequential, single-pass — no scheduling, no parallelism, no retry.
   * The CLI / daemon / cron loops compose on top of this primitive.
   *
   * Optional `opts` (all strictly additive — every default-everything
   * call site keeps current behavior):
   *   - `eventId` — process only the matching unprocessed event.
   *   - `max` — cap the number of events processed in this sweep.
   *   - `onDispatch` — observer invoked once per dispatch row after
   *     it is persisted; throwing observers are caught so they cannot
   *     break the dispatch loop.
   *
   * @returns Counts for the sweep: total events whose `processed`
   *          flag was flipped, total dispatch rows written, and the
   *          subset of those rows whose `status` is `'error'`.
   * @throws  Error from the standing-order validator when any order
   *          in the current `clockworks.standingOrders` array is
   *          malformed; in that case no events are processed and no
   *          rows are written.
   */
  processEvents(opts?: ProcessEventsOptions): Promise<{
    processedEvents: number;
    dispatches: number;
    errors: number;
    /**
     * Subset of `dispatches` whose `status` is `'skipped'` — rows the
     * dispatcher's loop-guard suppressed without invoking the relay.
     * Reported separately so callers can surface loop-guard activity
     * without conflating it with real failures (`errors`).
     */
    skipped: number;
  }>;
}

/**
 * Per-dispatch observation passed to `ProcessEventsOptions.onDispatch`.
 *
 * Every field the CLI's per-dispatch summary line needs without
 * forcing a second book read. `durationMs` is `endedAt - startedAt`
 * computed by the dispatcher.
 *
 * `status` mirrors the persisted `EventDispatchDoc.status` shape (sans
 * the `'pending'` variant, which observers never see — observations
 * fire after the row reaches a terminal state):
 *
 *   - `'success'` / `'error'` — relay was invoked; outcome captured.
 *   - `'skipped'` — dispatcher's loop-guard suppressed the invocation.
 *     The relay was not called, no `standing-order.failed` event was
 *     emitted, and `error` carries the loop-guard reason (prefixed
 *     with `loop-guard:`). Observers that count failures must skip
 *     this status — it is not a failure.
 */
export interface DispatchObservation {
  eventId: string;
  eventName: string;
  handlerName: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  error: string | null;
}

/**
 * Optional knobs accepted by `ClockworksApi.processEvents`. All three
 * fields are strictly additive — any combination (including the
 * empty-options call) preserves the legacy drain-everything contract
 * for callers who omit the options.
 */
export interface ProcessEventsOptions {
  /** Process only the matching unprocessed event. */
  eventId?: string;
  /** Cap on the number of events processed this sweep. */
  max?: number;
  /** Per-dispatch observer; throwing observers are isolated. */
  onDispatch?: (observation: DispatchObservation) => void;
}

/**
 * Kit contribution interface for plugins that extend the Clockworks.
 *
 * Plugins contribute relays — named event-handler functions resolved by
 * the dispatcher via a standing order's `run:` field — by exporting a
 * kit whose `relays` field is an array of `RelayDefinition` values
 * produced by the `relay()` factory.
 *
 * Inherits `requires` / `recommends` from the framework `Kit` base so a
 * kit can declare that its relay handlers depend on other apparatuses
 * being installed.
 *
 * @example
 * ```typescript
 * import { relay } from '@shardworks/clockworks-apparatus';
 *
 * export default {
 *   recommends: ['nexus-clockworks'],
 *   relays: [
 *     relay({
 *       name: 'log-event',
 *       handler: async (event) => { console.log(event.name); },
 *     }),
 *   ],
 * } satisfies ClockworksKit;
 * ```
 */
export interface ClockworksKit extends Kit {
  /**
   * Relay handlers contributed under the `relays` kit type. Optional —
   * a `ClockworksKit` may carry only `requires` / `recommends` from the
   * framework base, in which case it is a metadata-only contribution.
   */
  relays?: RelayDefinition[];
}

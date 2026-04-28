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
import type { Kit, StartupContext } from '@shardworks/nexus-core';
import type { BookEntry } from '@shardworks/stacks-apparatus';

import type { RelayDefinition } from './relay.ts';

// ── Config ───────────────────────────────────────────────────────────

/**
 * A single event specification — the value side of the events kit
 * contribution and the `guild.json` `clockworks.events` map.
 *
 * Framework events are declared by the plugins that produce them via
 * the `events` kit contribution (`supportKit.events` on apparatuses, or
 * a top-level `events` field on standalone kits). The kit-contributed
 * names plus the `guild.json` operator-declared names are merged at
 * Clockworks `start()` into a single authoritative set; `signal`
 * surfaces (the anima tool, the operator CLI) consult that set.
 *
 * `description` is human-readable purpose. `schema` reserves a slot
 * for future structural payload validation — accepted but not
 * interpreted at runtime today (the field is `unknown` so today's
 * documentation-shape entries pass through ergonomically).
 */
export interface EventSpec {
  /** Human-readable description of what this event means. */
  description?: string;
  /**
   * Reserved slot for structural payload validation. Present in
   * existing `guild.json` entries as a documentation shape; ignored at
   * runtime in the current commission. A future commission may give
   * this field a typed shape and a payload-validation runtime.
   */
  schema?: unknown;
}

/**
 * Kit contribution shape for the `events` kit type.
 *
 * Plugins claim event names by exporting an `events` kit whose value is
 * either a flat record `Record<string, EventSpec>` keyed by event name,
 * or a pure function of the `StartupContext` returning the same record.
 * The function form runs once at Clockworks `start()` after the kit's
 * `requires:` deps have started; throwing or returning a non-record
 * fails the apparatus boot loud (no silent fallback).
 *
 * The flat-map shape composes naturally with `guild.json`'s
 * `clockworks.events` record-keyed-by-name shape — the Clockworks
 * merges both layers into one authoritative set.
 */
export type EventsKitContribution =
  | Record<string, EventSpec>
  | ((ctx: StartupContext) => Record<string, EventSpec>);

/**
 * One row of the merged event set assembled at apparatus `start()` —
 * what `validateSignal` consults per call.
 *
 * `source` records where the entry's active metadata came from — the
 * contributing pluginId, or the literal string `'guild.json'` when the
 * operator-declared entry shadowed (or originated) the row.
 *
 * `pluginDeclared` is sticky-true: once any plugin has claimed a name,
 * the framework treats that name as plugin-owned even when a
 * `guild.json` override later replaces the active spec. The two-check
 * validator routes plugin-owned names away from anima-emit channels
 * regardless of which layer's spec is currently active.
 */
export interface MergedEventEntry {
  /** Active spec (record or function-form) — replaced verbatim on collision. */
  spec: EventSpec;
  /** `'guild.json'` or a contributing pluginId. */
  source: string;
  /** Sticky-true once any plugin claimed this name. */
  pluginDeclared: boolean;
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
  events?: Record<string, EventSpec>;
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
   * Validate that an event name is permitted to be emitted from an
   * unprivileged surface (the anima `signal` tool, the operator
   * `nsg signal` CLI).
   *
   * Two checks, in order, against the merged set assembled from the
   * `events` kit (start-scoped) plus `guild.json` `clockworks.events`
   * (re-read per call so operator hot-edits land without restart):
   *
   *   1. The name must be present in the merged set. Otherwise: `signal:
   *      "<name>" is not declared …`.
   *   2. Names declared by a plugin contribution are framework-owned and
   *      cannot be emitted from anima/operator surfaces — even when a
   *      `guild.json` entry now provides the active spec, the
   *      `pluginDeclared` flag is sticky. Otherwise: `signal: "<name>"
   *      …`.
   *
   * Throws a plain `Error` on rejection; rejection messages start with
   * `signal: "<name>" …` (operator-facing). Pre-start invocation throws
   * a `clockworks: …` not-yet-ready error attributing the problem to
   * the package.
   *
   * `emit()` deliberately does NOT call this method — framework-owned
   * emit sites are unchecked by design.
   */
  validateSignal(name: string): void;

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
   * **Cross-process delivery.** The read-pending → invoke →
   * patch-processed sequence is not atomic across processes. When two
   * callers overlap (e.g. the unattended daemon plus a manual
   * `nsg clock run`, or two manual runs), both can see the same
   * unprocessed events and a relay may be invoked more than once for
   * the same event. Substrate-level row locking is intentionally
   * deferred; the contract is upheld by relay-author idempotency —
   * handlers MUST be safe to invoke more than once for the same
   * triggering event. See `RelayHandler` for the contract and
   * `docs/guides/building-relays.md` for the worked pattern.
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

  /**
   * Run one tick of the scheduler pass: iterate the in-memory schedule
   * table populated at apparatus `start()` and fire every entry whose
   * `nextFireTime <= now`.
   *
   * Each fire writes a `schedule.fired` event row (with
   * `processed: true` so the event-sweep skips it) plus a matching
   * dispatch row through the same plumbing the event-driven path
   * uses. Failures (thrown relay or unresolved relay) emit a
   * `standing-order.failed` event via the same SOF callback the
   * dispatcher uses, so subscribers do not have to special-case
   * scheduled fires.
   *
   * Sequential by `orderIndex` ascending — multiple-due orders fire
   * one after another, never via `Promise.all`. The schedule table
   * itself is built once at startup; operators editing
   * `clockworks.standingOrders` schedule entries must restart the
   * apparatus for the change to take effect (commission decision
   * D11; documented as a follow-up observation).
   */
  processSchedules(opts?: ProcessSchedulesOptions): Promise<{
    fired: number;
    errors: number;
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
 * Optional knobs accepted by `ClockworksApi.processSchedules`. The
 * shape mirrors `ProcessEventsOptions` so the daemon's loop can pass
 * the same observer to both passes, but without the `eventId` / `max`
 * fields — a scheduler tick has no equivalent of "drain a specific
 * event" and the in-tick fire ordering is deterministic.
 */
export interface ProcessSchedulesOptions {
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
  /**
   * Event declarations contributed under the `events` kit type. Either
   * a flat record of event-name → `EventSpec`, or a pure function of
   * the `StartupContext` returning the same record. Plugin-declared
   * events are framework-owned; operator-defined events live in
   * `guild.json` under `clockworks.events`. The Clockworks merges both
   * layers at `start()` and consults the merged set per call to
   * `validateSignal`.
   */
  events?: EventsKitContribution;
}

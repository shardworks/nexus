/**
 * The Clockworks — event substrate and standing-order engine (Pillar 5).
 *
 * The factory:
 *
 *   - Declares plugin id `clockworks` (derived from the package name).
 *   - Requires the Stacks and Clerk; consumes the `relays` and
 *     `events` kit vocabularies.
 *   - Publishes two books (`events`, `event_dispatches`) under owner id
 *     `clockworks`, with the index set anticipated by the runner /
 *     status query patterns in `docs/architecture/clockworks.md`.
 *   - Resolves the Stacks during `start()` and obtains writable handles
 *     on both books so `emit()`, `processEvents()`, and the future
 *     daemon can use them without re-resolving Stacks.
 *   - Provides the `ClockworksApi` (`emit()`, `validateSignal()`,
 *     `resolveRelay()`, `processEvents()`) that downstream tasks extend.
 *   - Builds a name-keyed relay registry from `ctx.kits('relays')`
 *     entries merged with the apparatus's own `supportKit.relays`. The
 *     registry is closure-scoped, cleared at the top of every `start()`
 *     for idempotent restart semantics, and uses first-writer-wins on
 *     duplicate names with a lattice-format warning. Reachable from the
 *     api via `resolveRelay(name)`.
 *   - Builds a merged event set from `ctx.kits('events')` contributions
 *     plus `guild.json clockworks.events`. The plugin layer is start-
 *     scoped (built once); the operator layer is re-read per call to
 *     `validateSignal` so hot-edits land without restart. The four
 *     fail-loud boot guards — plugin-vs-plugin name collision, function-
 *     form throw or non-object return, malformed kit value, malformed
 *     guild.json value — surface at apparatus boot time.
 *   - Exposes `processEvents()` — the event-triggered dispatch entry
 *     point. Each call re-reads `clockworks.standingOrders` from
 *     `guild.json`, validates them via the standing-order validator,
 *     and delegates to the pure `runDispatchSweep` primitive in
 *     `dispatcher.ts`. The CLI (later commission) and daemon (later
 *     commission) compose on top of the same primitive.
 *
 * `start()` primes the book handles, the registry, and the dispatch
 * path; `stop()` is currently a no-op — Arbor's
 * `StartedGuild.shutdown()` invokes it during reverse-topo teardown
 * (the apparatus has no in-flight handles of its own to release; the
 * Clockworks daemon's poll loop is owned by `runForegroundDaemon`,
 * not the apparatus).
 *
 * See: docs/architecture/clockworks.md
 */

import type { KitEntry, Plugin, StartupContext } from '@shardworks/nexus-core';
import { generateId, guild } from '@shardworks/nexus-core';
import type {
  Book,
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
  EventSpec,
  MergedEventEntry,
  StandingOrder,
} from './types.ts';

import {
  runDispatchSweep,
  type DispatchObservation,
  type DispatchSummary,
  type SourcedStandingOrder,
} from './dispatcher.ts';
import {
  CLOCKWORKS_TIMER_EVENT,
  STANDING_ORDER_FAILED_EVENT,
} from './event-names.ts';
import { isRelayDefinition, type RelayDefinition } from './relay.ts';
import { computeNextFireTime, parseSchedule } from './schedule-parser.ts';
import {
  runScheduleSweep,
  type ScheduleEntry,
  type ScheduleSweepSummary,
} from './scheduler.ts';
import { validateStandingOrders } from './standing-order-validator.ts';
import { createSummonRelay } from './summon-relay.ts';
import { clockStatusTool, signal } from './tools/index.ts';
import { handleWritLifecycle } from './writ-lifecycle-observer.ts';

// ── Function-form `events` kit contribution ─────────────────────────
//
// Clockworks's own `events` kit declaration. Returns the union of the
// two intrinsic Clockworks events plus one `writ.<type>.<status>` entry
// per `(writType, state)` pair currently registered with Clerk. Lives
// at module scope so the supportKit reference is a stable function id
// (no closure capture quirks under repeated start() / stop() cycles).
function buildEventsContribution(
  _ctx: StartupContext,
): Record<string, EventSpec> {
  const events: Record<string, EventSpec> = {
    [STANDING_ORDER_FAILED_EVENT]: {
      description:
        'A standing-order dispatch failed — either the named relay threw or its `run:` did not resolve to a registered relay. The dispatcher writes one row per failure; the loop-guard suppresses cascades.',
    },
    [CLOCKWORKS_TIMER_EVENT]: {
      description:
        'A scheduled standing order fired at its `nextFireTime`. The row is persisted with `processed: true` so the event-sweep does not pick it up — the scheduler is the only authorized consumer of timer events.',
    },
  };

  // Reach Clerk via the guild singleton — same idiom as the Stacks
  // resolution in start(). In production Clerk is always installed
  // because Clockworks declares `requires: ['clerk']`. Test fixtures
  // that bypass that dependency contract fall through to the static
  // intrinsic set (with a warn breadcrumb so the discrepancy surfaces).
  let writTypes: ReturnType<ClerkApi['listWritTypes']> = [];
  try {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    writTypes = clerk.listWritTypes();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[clockworks] events kit: Clerk not reachable when assembling writ-lifecycle declarations (${reason}); only intrinsic events declared.`,
    );
    return events;
  }

  // D22: enumerate every declared state for every type, unconditionally
  // — no reachability filter. D23: include the builtin `mandate` on
  // equal footing with plugin-registered types. D19: trust Clerk's
  // validator — no defensive guard for malformed configs.
  for (const type of writTypes) {
    for (const state of type.states) {
      events[`writ.${type.name}.${state.name}`] = {
        description:
          `A writ of type "${type.name}" entered the "${state.name}" phase. Fired by the framework's writ-lifecycle observer on every status transition.`,
      };
    }
  }

  return events;
}

// ── Kit contribution vocabulary ─────────────────────────────────────

// The `relays` kit type carries plugin-contributed relay handlers. The
// Clockworks declares `consumes: [RELAYS_KIT]` so the framework's
// unconsumed-kit warning stays quiet, and resolves contributions during
// `start()` into a name-keyed registry. The constant is load-bearing —
// the existing test asserts the exact string.
const RELAYS_KIT = 'relays';

// The `events` kit type carries plugin-contributed event declarations.
// Clockworks walks contributions at `start()` after `requires:` deps
// have started, evaluates function-form contributions, and assembles
// the plugin layer of the merged event set. The `guild.json`
// `clockworks.events` map is layered on per call to `validateSignal`
// so operator hot-edits land without restart.
const EVENTS_KIT = 'events';

// The `standingOrders` kit type carries plugin-contributed default
// standing orders. Clockworks walks contributions at `start()`,
// validates each through the shared source-aware validator, and seals
// the resulting kit layer for the life of the apparatus. The merge with
// the operator-supplied `guild.json clockworks.standingOrders` array is
// purely additive — `[...kit, ...operator]` — at dispatch and schedule
// time. Listing this token under the apparatus's `consumes` array keeps
// the framework's unconsumed-kit warning quiet for legitimate kit
// authors.
const STANDING_ORDERS_KIT = 'standingOrders';

// ── Registry ────────────────────────────────────────────────────────

interface RegisteredRelay {
  pluginId: string;
  relay: RelayDefinition;
}

export function createClockworks(): Plugin {
  // Handles primed during start() and retained for the factory's
  // closure-scoped api methods (and by downstream commissions that
  // extend this factory with additional runtime behavior).
  let events: Book<EventDoc>;
  let dispatches: Book<EventDispatchDoc>;

  // Registered relays keyed by `name` — first writer wins, with a
  // warning for duplicates. Built fresh on every `start()` (so the
  // future daemon-restart path stays idempotent).
  const relays = new Map<string, RegisteredRelay>();

  // ── Schedule table ─────────────────────────────────────────────────
  //
  // In-memory list of time-driven standing orders. Built once in
  // `start()` (D4, D11) — operators editing schedule entries in
  // `guild.json` must restart the apparatus for the change to take
  // effect. The dispatcher path re-reads `standingOrders` per call so
  // event-driven hot-edit still works; only the scheduler path is
  // build-once.
  const schedule: ScheduleEntry[] = [];

  // ── Plugin-layer event set ─────────────────────────────────────────
  //
  // The plugin-contributed half of the merged event set. Built once in
  // `start()` from `ctx.kits('events')` — function-form contributions
  // are evaluated, plugin-vs-plugin name collisions throw fail-loud
  // naming both contributors. Per-call `validateSignal` layers the
  // `guild.json clockworks.events` map on top of this snapshot
  // (full-replacement on collision; sticky `pluginDeclared`).
  //
  // `pluginEventSetReady` is the gate on the not-yet-ready throw —
  // calling `validateSignal` before `start()` has primed the set
  // surfaces a `clockworks: validateSignal() called before start() …`
  // error attributing the problem to the package.
  const pluginEventSet = new Map<string, MergedEventEntry>();
  let pluginEventSetReady = false;

  // ── Kit-layer standing orders ──────────────────────────────────────
  //
  // The kit-contributed half of the merged standing-order list. Built
  // once in `start()` from `ctx.kits('standingOrders')` (D10) — every
  // kit's contribution is validated through the source-aware shared
  // validator (D6) and the resulting entries are sealed for the life
  // of the apparatus. Subsequent `processEvents` / `processSchedules`
  // calls read from this closure-scoped layer; the operator-layer
  // hot-edit path lives in `processEvents` and merges the operator
  // slice on top per call.
  //
  // Each entry carries a `source` label (the contributing pluginId)
  // and a per-source `orderIndex` — the position within that kit's
  // contributed array — so error-attribution surfaces (D7, D8) can
  // name the contributing kit and the operator's mental model of
  // "index #N in `guild.json`" stays stable when kit defaults change
  // out from under them.
  const kitStandingOrders: SourcedStandingOrder[] = [];

  /**
   * Register a single kit's `relays` contribution. Mirrors the lattice's
   * factory-registration shape: warn-and-skip on a malformed top-level
   * entry value, warn-and-skip per-element on a malformed relay, and
   * warn-and-keep-first on a duplicate name. Survivable — a malformed
   * third-party kit must not take down Clockworks.
   */
  function registerKitRelays(entry: KitEntry): void {
    const { pluginId } = entry;
    const raw = entry.value;
    if (!Array.isArray(raw)) {
      console.warn(
        `[clockworks] Kit "${pluginId}" relays: expected an array, got ${typeof raw} — skipped.`,
      );
      return;
    }

    for (const candidate of raw) {
      if (!isRelayDefinition(candidate)) {
        console.warn(
          `[clockworks] Kit "${pluginId}" relays: entry is not a valid RelayDefinition — skipped.`,
        );
        continue;
      }
      if (relays.has(candidate.name)) {
        const existing = relays.get(candidate.name)!;
        console.warn(
          `[clockworks] Kit "${pluginId}" relays: relay name "${candidate.name}" is already registered by kit "${existing.pluginId}" — duplicate skipped.`,
        );
        continue;
      }
      relays.set(candidate.name, { pluginId, relay: candidate });
    }
  }

  /**
   * Resolve a single `events` kit contribution to its declared event
   * record. The contribution may be a plain `Record<string, EventSpec>`
   * or a pure function of the `StartupContext` returning the same.
   *
   * Per commission decisions D5 / D6, contributions that are neither a
   * plain object nor a function (D6), or function-form contributions
   * that throw or return a non-object value (D5), throw fail-loud at
   * `start()` — the apparatus boot fails so the kit author hears about
   * the bug at first run rather than silently degrading.
   */
  function resolveEventsContribution(
    pluginId: string,
    raw: unknown,
    ctx: StartupContext,
  ): Record<string, unknown> {
    if (typeof raw === 'function') {
      // D5: a throw inside the function-form propagates verbatim from
      // start(). We do not trap it — the kit author's stack trace is
      // exactly what surfaces in the boot error.
      const result = (raw as (ctx: StartupContext) => unknown)(ctx);
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error(
          `clockworks: events kit "${pluginId}" function-form contribution returned ` +
            `${result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result}, ` +
            `expected an object.`,
        );
      }
      return result as Record<string, unknown>;
    }
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    // D6: malformed kit value (neither Record nor function).
    throw new Error(
      `clockworks: events kit "${pluginId}" contribution must be a record or a ` +
        `function, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}.`,
    );
  }

  /**
   * Walk every `events` kit contribution and assemble the plugin layer
   * of the merged event set into the closure-scoped `pluginEventSet`.
   * Called once at `start()`. Per D4 (plugin-vs-plugin collision),
   * D5 (function-form throw / non-object return), D6 (malformed kit
   * value): every shape error throws and fails apparatus boot.
   */
  function buildPluginEventSet(ctx: StartupContext): void {
    pluginEventSet.clear();
    for (const entry of ctx.kits(EVENTS_KIT)) {
      const events = resolveEventsContribution(entry.pluginId, entry.value, ctx);
      for (const [name, rawSpec] of Object.entries(events)) {
        if (typeof rawSpec !== 'object' || rawSpec === null || Array.isArray(rawSpec)) {
          // Mirror the operator-side D19 guard: a malformed per-event
          // value from a plugin contribution is also a kit-author bug
          // that the operator cannot fix — fail loud at boot.
          throw new Error(
            `clockworks: events kit "${entry.pluginId}" entry "${name}": expected ` +
              `object, got ${rawSpec === null ? 'null' : Array.isArray(rawSpec) ? 'array' : typeof rawSpec}.`,
          );
        }
        const existing = pluginEventSet.get(name);
        if (existing && existing.source !== entry.pluginId) {
          // D4: plugin-vs-plugin collision. Naming both contributors is
          // load-bearing — operators need to know which two plugins are
          // claiming the same name.
          throw new Error(
            `clockworks: events kit collision on "${name}" — declared by both ` +
              `"${existing.source}" and "${entry.pluginId}".`,
          );
        }
        pluginEventSet.set(name, {
          spec: rawSpec as EventSpec,
          source: entry.pluginId,
          pluginDeclared: true,
        });
      }
    }
  }

  /**
   * Walk every `standingOrders` kit contribution and assemble the kit
   * layer of the merged standing-order list into the closure-scoped
   * `kitStandingOrders`. Called once at `start()`.
   *
   * For each kit:
   *
   *   - The contributed value MUST be an array. A non-array value is
   *     fail-loud at apparatus boot with kit attribution (D9), mirroring
   *     the events kit's malformed-value guard.
   *   - The shared standing-order validator runs with the contributing
   *     pluginId so any malformed entry surfaces with the kit-attributed
   *     header / per-bullet shape (D5, D6).
   *   - On success, a shallow copy of the entries is appended to the
   *     closure-scoped layer (D15), each tagged with the contributing
   *     pluginId and its per-kit `orderIndex` (D7).
   *
   * Silent on the happy path (D17) — mirrors the events kit's build
   * path; no info logging announces the kit-layer build.
   */
  function buildKitStandingOrders(ctx: StartupContext): void {
    kitStandingOrders.length = 0;
    for (const entry of ctx.kits(STANDING_ORDERS_KIT)) {
      const { pluginId, value } = entry;
      if (!Array.isArray(value)) {
        // D9: fail-loud, kit-attributed. Mirrors the events kit's
        // malformed-value guard and the brief's "fail loud for
        // kit-author bugs" mandate.
        throw new Error(
          `clockworks: standingOrders kit "${pluginId}" contribution must be an array, got ` +
            `${value === null ? 'null' : typeof value}.`,
        );
      }
      // D6: source-aware validator call. The validator owns the
      // per-bullet kit attribution and the source-labeled header text.
      validateStandingOrders(value, pluginId);
      // D15: shallow copy preserves array identity protection without
      // paying for deep cloning of declarative records.
      const arr = value as readonly StandingOrder[];
      for (let i = 0; i < arr.length; i += 1) {
        kitStandingOrders.push({
          order: arr[i]!,
          source: pluginId,
          orderIndex: i,
        });
      }
    }
  }

  /**
   * Layer the per-call `guild.json clockworks.events` snapshot on top
   * of the plugin layer and return the merged map. Per D7 the
   * guild.json layer is re-read every call so operator hot-edits land
   * without an apparatus restart.
   *
   * Per D20, on a name collision the plugin spec is fully replaced by
   * the operator spec; `source` flips to `'guild.json'`; `pluginDeclared`
   * stays sticky-true. Per D19, a malformed `guild.json` per-event
   * value throws a `clockworks:` error attributing the problem to the
   * package — the operator is the one who can fix it.
   */
  function buildMergedEventSet(): Map<string, MergedEventEntry> {
    const merged = new Map<string, MergedEventEntry>(pluginEventSet);
    const g = guild();
    const operatorEvents = g.guildConfig().clockworks?.events;
    if (operatorEvents !== undefined && operatorEvents !== null) {
      if (typeof operatorEvents !== 'object' || Array.isArray(operatorEvents)) {
        throw new Error(
          `clockworks: guild.json clockworks.events: expected object, got ` +
            `${Array.isArray(operatorEvents) ? 'array' : typeof operatorEvents}.`,
        );
      }
      for (const [name, rawSpec] of Object.entries(operatorEvents)) {
        if (typeof rawSpec !== 'object' || rawSpec === null || Array.isArray(rawSpec)) {
          // D19: malformed guild.json value.
          throw new Error(
            `clockworks: guild.json clockworks.events.${name}: expected object, got ` +
              `${rawSpec === null ? 'null' : Array.isArray(rawSpec) ? 'array' : typeof rawSpec}.`,
          );
        }
        const existing = merged.get(name);
        merged.set(name, {
          spec: rawSpec as EventSpec,
          source: 'guild.json',
          // Sticky: once any plugin claimed this name, it stays
          // plugin-declared even when an operator-supplied entry now
          // provides the active spec.
          pluginDeclared: existing?.pluginDeclared ?? false,
        });
      }
    }
    return merged;
  }

  // ── API ────────────────────────────────────────────────────────

  const api: ClockworksApi = {
    async emit(name: string, payload: unknown, emitter: string): Promise<string> {
      if (!events) {
        throw new Error(
          'clockworks: emit() called before start() primed the events book handle.',
        );
      }

      // Coerce undefined to null so the stored row shape is predictable
      // — decision D8 in the commission spec. null is valid JSON and
      // matches the optional payload type signature.
      const storedPayload = payload === undefined ? null : payload;

      // Pre-serialize-check (D2, D11) — fail loud at the API boundary
      // rather than surfacing an obscure SQLite-layer throw later.
      // The attempted serialize value is discarded; Stacks owns the
      // final persistence-format decision.
      try {
        JSON.stringify(storedPayload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `clockworks: event "${name}" payload is not JSON-serializable: ${reason}`,
        );
      }

      const id = generateId('e');
      const firedAt = new Date().toISOString();

      const doc: EventDoc = {
        id,
        name,
        payload: storedPayload,
        emitter,
        firedAt,
        processed: false,
      };

      await events.put(doc);
      return id;
    },

    resolveRelay(name: string): RelayDefinition | undefined {
      const entry = relays.get(name);
      return entry?.relay;
    },

    validateSignal(name: string): void {
      // D10: pre-start guard — attribute the failure to the package
      // and to the unprimed merged set (mirrors emit()'s shape).
      if (!pluginEventSetReady) {
        throw new Error(
          'clockworks: validateSignal() called before start() primed the merged event set.',
        );
      }

      // D7 / D20: layer the guild.json snapshot on top of the plugin
      // layer per call so operator hot-edits land without restart;
      // collisions full-replace the spec, `pluginDeclared` stays
      // sticky-true.
      const merged = buildMergedEventSet();

      // D12: typo-first check ordering — operator hears "not declared"
      // before "framework-owned" so the most-common case (a typo'd
      // event name) gets the most actionable message.
      const entry = merged.get(name);
      if (entry === undefined) {
        // D11: operator-facing rejection prefix `signal: "<name>" …`.
        throw new Error(
          `signal: "${name}" is not a declared event. Declare it under ` +
            `clockworks.events in guild.json (or via a plugin's events kit) ` +
            `before emitting it.`,
        );
      }

      // D12 check 2: framework-owned (any plugin has claimed this name
      // — sticky regardless of which layer's spec is active).
      if (entry.pluginDeclared) {
        throw new Error(
          `signal: "${name}" is a framework-owned event and cannot be emitted ` +
            `from the signal surface. Framework-owned events are claimed by a ` +
            `plugin's events kit; only the framework may emit them.`,
        );
      }
    },

    async processSchedules(opts?: {
      onDispatch?: (observation: DispatchObservation) => void;
    }): Promise<ScheduleSweepSummary> {
      if (!events || !dispatches) {
        throw new Error(
          'clockworks: processSchedules() called before start() primed the book handles.',
        );
      }

      const g = guild();

      // D4, D11: the schedule table is closure-scoped and built once
      // in `start()`. We do not re-read `standingOrders` per tick — a
      // schedule edit requires an apparatus restart. Same SOF lambda
      // the dispatcher uses (D15) so subscribers see a uniform
      // `clockworks.standing-order.failed` shape regardless of trigger
      // source. The literal lives in `event-names.ts` (D20) so the
      // dispatcher's loop-guard probe and this emit cannot drift apart.
      return runScheduleSweep({
        schedule,
        events,
        dispatches,
        resolveRelay: api.resolveRelay,
        home: g.home,
        now: () => new Date(),
        signalStandingOrderFailed: async (payload) => {
          await api.emit(STANDING_ORDER_FAILED_EVENT, payload, 'framework');
        },
        ...(opts?.onDispatch !== undefined ? { onDispatch: opts.onDispatch } : {}),
      });
    },

    async processEvents(opts?: {
      eventId?: string;
      max?: number;
      onDispatch?: (observation: DispatchObservation) => void;
    }): Promise<DispatchSummary> {
      if (!events || !dispatches) {
        throw new Error(
          'clockworks: processEvents() called before start() primed the book handles.',
        );
      }

      // D15: re-read the operator standing-order array per call so
      // operators can hot-edit guild.json without restarting the
      // apparatus. D3: the apparatus owns operator-layer validation —
      // we run the no-source validator path here so any malformed
      // operator entry surfaces with the byte-for-byte historical
      // message text. Kit-layer entries were already validated at
      // apparatus boot through `buildKitStandingOrders` and are not
      // re-validated here (the dispatcher trusts its merged input).
      const g = guild();
      const operatorStandingOrders =
        g.guildConfig().clockworks?.standingOrders ?? [];
      validateStandingOrders(operatorStandingOrders as readonly unknown[]);

      // D2 / D11: build the merged dispatch list with kit entries
      // first, operator entries second. Each entry carries its own
      // per-source `orderIndex` (D7) and `source` label (null for the
      // operator slice, contributing pluginId for kit entries) so the
      // dispatcher's relay-not-registered error attribution (D8) can
      // name the contributing kit when applicable.
      const mergedStandingOrders: SourcedStandingOrder[] = [
        ...kitStandingOrders,
        ...operatorStandingOrders.map((order, idx) => ({
          order,
          source: null as string | null,
          orderIndex: idx,
        })),
      ];

      // D11: per-call read of `home`. D21: pure dispatcher receives
      // every dependency by parameter so unit tests can drive it
      // without booting Stacks.
      //
      // The `signalStandingOrderFailed` lambda routes dispatcher
      // failures back through the apparatus's own `emit()` path —
      // re-using emit's payload pre-validation and id generation
      // rather than re-implementing them here. The emitter string
      // `'framework'` matches the events-table convention used by
      // every framework-internal emit site.
      return runDispatchSweep({
        events,
        dispatches,
        resolveRelay: api.resolveRelay,
        standingOrders: mergedStandingOrders,
        home: g.home,
        signalStandingOrderFailed: async (payload) => {
          await api.emit(STANDING_ORDER_FAILED_EVENT, payload, 'framework');
        },
        ...(opts?.eventId !== undefined ? { eventId: opts.eventId } : {}),
        ...(opts?.max !== undefined ? { max: opts.max } : {}),
        ...(opts?.onDispatch !== undefined ? { onDispatch: opts.onDispatch } : {}),
      });
    },
  };

  return {
    apparatus: {
      // Clerk is required because the writ-lifecycle observer reads
      // `clerk/writs` to fan `writ.<type>.<phase>` events into the
      // events book.
      requires: ['stacks', 'clerk'],
      // Animator and Loom are soft dependencies — needed by the stdlib
      // `summon-relay` (resolved lazily at handler-call time) so a guild
      // that uses Clockworks for non-anima relays can install Clockworks
      // without dragging in the session-launch stack.
      recommends: ['animator', 'loom'],
      consumes: [RELAYS_KIT, EVENTS_KIT, STANDING_ORDERS_KIT],

      provides: api,

      supportKit: {
        books: {
          events: {
            indexes: [
              'name',
              'processed',
              'firedAt',
              ['processed', 'firedAt'],
            ],
          },
          event_dispatches: {
            indexes: [
              'eventId',
              'status',
              ['eventId', 'status'],
            ],
          },
        },
        tools: [signal, clockStatusTool],
        // Stdlib relays. Today this is just the `summon-relay` — the
        // bridge between event dispatch and anima sessions. Authors of
        // additional stdlib relays append here; third-party relays use
        // a standalone `relays` kit.
        relays: [createSummonRelay()] as RelayDefinition[],
        // Function-form `events` kit contribution — the first in-tree
        // consumer of C1's kit-contribution mechanism. Returns the
        // union of:
        //
        //   - the two intrinsic Clockworks events
        //     (`clockworks.standing-order.failed`, `clockworks.timer`)
        //   - one `writ.<type>.<status>` entry per `(writType, state)`
        //     pair known to Clerk's writ-type registry at the moment
        //     Clockworks starts (D3: snapshot at start; no in-tree
        //     downstream registers writ types after Clockworks).
        //
        // We trust Clerk's validator (D19) — no defensive guard against
        // malformed type configs. C1's build path evaluates this once
        // per Clockworks start; no further memoization (D18).
        //
        // Clerk is reached via the guild singleton (D1), mirroring the
        // existing Stacks resolution pattern in `start()` below. In
        // production this is always reachable because the apparatus
        // declares `requires: ['clerk']`. Test fixtures that bypass the
        // dependency contract (registering only Stacks for unit-level
        // isolation) will fall through to the static intrinsic set —
        // we trap the `Apparatus "clerk" not installed` error and warn,
        // since failing the boot here would force every unit test to
        // wire a stub Clerk it does not otherwise need.
        events: buildEventsContribution,
      },

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');

        // Prime book handles so `emit()`, `processEvents()`, and
        // downstream commissions can use them without re-resolving
        // Stacks.
        events = stacks.book<EventDoc>('clockworks', 'events');
        dispatches = stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');

        // Rebuild the relay registry from scratch. Arbor wires standalone
        // kits ahead of apparatus supportKits, so honoring the returned
        // order naturally gives user-kit relays priority over
        // stdlib ones contributed by `supportKit.relays`.
        relays.clear();
        for (const entry of ctx.kits(RELAYS_KIT)) {
          registerKitRelays(entry);
        }

        // ── Plugin-layer event set ─────────────────────────────────
        //
        // Walk the `events` kit contributions, evaluate function-form
        // contributions, and assemble the plugin layer of the merged
        // event set. The four fail-loud guards (D4 plugin-vs-plugin
        // collision, D5 function-form throw / non-object return, D6
        // malformed kit value, plus the same per-event shape check
        // operators get from D19) are all wired through
        // `buildPluginEventSet`. Per D3 this runs after `requires:`
        // deps have started — the apparatus's `start()` is itself
        // gated on those deps, so simple ordering inside the function
        // body is enough.
        //
        // `pluginEventSetReady` is the gate on the not-yet-ready
        // throw from `validateSignal`; we flip it to true after the
        // build completes so a thrown error keeps the gate closed and
        // any subsequent call surfaces the unprimed-set message.
        pluginEventSetReady = false;
        buildPluginEventSet(ctx);
        pluginEventSetReady = true;

        // ── Kit-layer standing orders ──────────────────────────────────
        //
        // D11: build the kit layer immediately after the events-kit
        // build and before the schedule-table seed, so the schedule
        // seed loop and the per-call dispatch path both observe the
        // same sealed snapshot. D9: malformed kit contributions throw
        // here with kit attribution, failing apparatus boot loud.
        buildKitStandingOrders(ctx);

        // ── Schedule table ─────────────────────────────────────────────
        //
        // D4, D11: build the in-memory schedule table fresh on every
        // start. Walk the merged `[...kit, ...operator]` standing-order
        // list; for each entry with a `schedule:` key, parse the
        // expression and seed `nextFireTime` per D8 (`@every`: now +
        // duration) / D9 (cron: next boundary after now) — both fall
        // out of the same `computeNextFireTime(parsed, startTime)`
        // call.
        //
        // Validation already happened: kit entries went through the
        // source-aware validator in `buildKitStandingOrders` above, and
        // operator entries are validated per-call from `processEvents`.
        // The `parseSchedule` defensive guard here re-checks the
        // schedule string so any drift between the validator and the
        // schedule table surfaces as a boot-time error attributed to
        // the offending source.
        schedule.length = 0;
        const operatorStandingOrders =
          g.guildConfig().clockworks?.standingOrders ?? [];
        const mergedForSchedule: SourcedStandingOrder[] = [
          ...kitStandingOrders,
          ...operatorStandingOrders.map((order, idx) => ({
            order,
            source: null,
            orderIndex: idx,
          })),
        ];
        const startTime = new Date();
        for (const entry of mergedForSchedule) {
          const value = (entry.order as { schedule?: unknown }).schedule;
          if (typeof value !== 'string' || value.length === 0) continue;
          const parsed = parseSchedule(value);
          if (!parsed.ok) {
            // Fail loud: the validator should have caught this, but
            // surfacing it again here keeps the message attached to
            // the apparatus boot rather than the first scheduler tick.
            // D12: attribute kit vs. operator in the boot-time message.
            const sourceTag =
              entry.source === null
                ? 'in guild.json'
                : `in kit "${entry.source}"`;
            throw new Error(
              `clockworks: standing order #${entry.orderIndex} ${sourceTag} has an invalid schedule (${parsed.error}).`,
            );
          }
          schedule.push({
            orderIndex: entry.orderIndex,
            source: entry.source,
            order: entry.order,
            parsed: parsed.parsed,
            nextFireTime: computeNextFireTime(parsed.parsed, startTime),
          });
        }

        // ── Writ-lifecycle CDC observer ───────────────────────────────
        // Watches `clerk/writs` for both create and update events. The
        // observer fires `writ.<type>.<phase>` on every status
        // transition (including entry into `new` / `cancelled`) using
        // the writ's `phase` verbatim as the suffix. Phase 2
        // (`failOnError: false`) so a slow events book write cannot
        // stall a writ transition; per-emit try/catch already handles
        // failure modes.
        const writsBook: ReadOnlyBook<WritDoc> = stacks.readBook<WritDoc>(
          'clerk',
          'writs',
        );
        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          (event) => handleWritLifecycle({ clockworks: api, writsBook }, event),
          { failOnError: false },
        );
      },

      stop(): void {
        // No internal handles to release — the Clockworks daemon's
        // poll loop is owned by `runForegroundDaemon`, not by the
        // apparatus. Arbor's `StartedGuild.shutdown()` still calls
        // this for symmetry / future-proofing.
      },
    },
  };
}


# Codebase inventory — Scheduled standing orders (cron) MVP-1

## Scope and blast radius

This commission extends the Clockworks apparatus with a time-trigger alternative to event-trigger standing orders. The blast radius is mostly contained inside `packages/plugins/clockworks/`, but it touches:

- **Standing-order shape & validator** — the canonical `{ on, run, with? }` shape grows a new top-level metadata key `schedule:`. The shared validator (used at every sweep AND by future operator linters) gets new rules.
- **Daemon poll loop** — `runForegroundDaemon` gains a scheduler pass that runs alongside (and before) the existing event-processing pass.
- **Reserved framework namespaces** — `schedule.fired` is reserved. The `signal-validator.ts` allowlist of seven prefixes (`anima.`, `commission.`, `tool.`, `migration.`, `guild.`, `standing-order.`, `session.`) becomes eight.
- **Event catalog & architecture docs** — `docs/reference/event-catalog.md`, `docs/architecture/clockworks.md`, `docs/reference/core-api.md`. Doc refresh is largely covered by sibling commission `w-modf69vg`, but this commission must add the `schedule.fired` event to the framework events table and the reserved-namespace list (or coordinate with the doc-refresh commission).
- **Reckoner consumer** — the Reckoner (per `c-mod9a54n`) plans to declare `{ "schedule": "@every <interval>", "run": "reckoner-tick" }`. No code change here, but the shape must be exactly what that consumer expects.
- **Dependency choice** — no cron parser is currently in `pnpm-lock.yaml`. This commission either pulls in a third-party library or hand-rolls a parser. New runtime dep needs a decision.

## Affected packages and files

### `packages/plugins/clockworks/src/`

#### `types.ts` — public type surface
- `StandingOrder` interface (lines 55–66): declares the canonical `{ on, run, with? }` shape. `on` is required string. Must grow to accept `schedule?: string` as a top-level alternative trigger; the canonical-form rule "exactly one of `on` / `schedule`" is encoded in the validator, not in the TS type (TS unions are awkward for this; precedent: dropped sugar forms enforced at runtime).
- `ClockworksConfig` (lines 72–77): `events`, `standingOrders[]`. Unchanged shape — schedules live inside the same array.
- `EventDoc` / `EventDispatchDoc`: persisted row shapes. `EventDispatchDoc.handlerType` is `'relay' | 'anima'`; `targetRole`/`noticeType` already null for plain relay invocations. Reuse as-is for scheduled fires.
- `ClockworksApi.processEvents` (lines 270–282): existing event-sweep entry. Returns `{ processedEvents, dispatches, errors, skipped }`. The scheduler pass will likely need its own entry point with a parallel summary shape (see dispatcher.ts notes below).
- `ProcessEventsOptions` (lines 317–324): `eventId`, `max`, `onDispatch`. The scheduler pass needs equivalent observer plumbing if the daemon is to log per-fire.

#### `clockworks.ts` — apparatus factory
- Lines 150–239: `ClockworksApi` implementation. `emit()` writes events; `processEvents()` re-reads `g.guildConfig().clockworks?.standingOrders ?? []` per call (D15) and forwards to `runDispatchSweep`. Same hot-edit pattern would naturally apply to a scheduler sweep.
- Lines 197–238: `processEvents` → `runDispatchSweep` plumbing, including `signalStandingOrderFailed` lambda that re-emits failures via `api.emit('standing-order.failed', payload, 'framework')`. **The scheduler pass should reuse this same SOF emission path** for relay throws inside scheduled fires — keeps error-handling uniform across event-triggered and time-triggered paths.
- Lines 283–432: `start()`. Primes book handles, builds the relay registry from kits, registers CDC watchers. **Schedule-table construction would naturally land in `start()` too** — read once on apparatus startup, mirroring how relay registry and CDC watchers are bound.
- Lines 297: `relays.clear()` then re-populate — first-writer-wins precedent for handling the registry. The schedule table needs an analogous build/rebuild policy.

#### `dispatcher.ts` — pure dispatch sweep
- The dispatcher is "pure plumbing — no apparatus imports, no `guild()` calls, no `Date.now()` directly. Every dependency is passed in" (lines 26–28). This discipline informs the scheduler-pass shape: a parallel `runScheduleSweep(...)` (or extension to `runDispatchSweep`) should follow the same pattern.
- `DispatchSweepInputs` (lines 74–134) lists every dep injected: events book, dispatches book, relay resolver, standing orders, home, clock, optional eventId/max/observer/SOF callback.
- `dispatchOrder()` (lines 293–428): the per-order invocation logic — lookup relay, build RelayContext, try/catch, write dispatch row, notify observer, emit SOF on failure. **Reusable for scheduled fires** if factored — the scheduler pass must invoke the same per-handler isolation, write the same dispatch row shape, and notify the same observer.
- `writeDispatchRow()` (lines 526–553): centralizes the schema-shape constants (`handlerType: 'relay'`, `targetRole: null`, `noticeType: null`, `d-` id prefix). Scheduled fires should write rows with identical shape.
- `isLoopGuardEvent` / `isStandingOrderFailedTrigger` (lines 229, 499–505): loop-guard inspects `payload.triggeringEvent.name === 'standing-order.failed'`. For scheduled fires, the synthetic event has `name === 'schedule.fired'` so the guard does not trip. Subsequent SOF events triggered BY a scheduled relay throw will have `triggeringEvent.name === 'schedule.fired'` — the guard still does not trip on those (only `standing-order.failed`-triggered events are guarded). Scheduled fires therefore participate in the same one-layer-of-error-handling discipline as event-triggered fires.

#### `daemon.ts` — daemon lifecycle
- `ForegroundDaemonInputs` (lines 360–397): `home`, `intervalMs`, `processEvents`, optional `log` / `shutdown` / `onShutdown`. Tests drive the loop via injected `processEvents` stubs (see `daemon-integration.test.ts`).
- `runForegroundDaemon` (lines 420–522): the poll loop. Today: tick = `await processEvents({ onDispatch })` then abortable `setTimeout(intervalMs)` race.
- **Scheduler pass insertion point**: the brief specifies "scheduler pass runs *before* the event-processing pass in each tick cycle" — the scheduler pass goes inside the `while (!shuttingDown)` loop, before the `await processEvents(...)` call.
- `runForegroundDaemonFromGuild` (lines 592–606): the live-guild convenience wrapper. Currently resolves `processEvents` only. Must also resolve a scheduler entry point (or, if scheduler is folded into `processEvents`, no API change needed).
- `formatDispatchLogLine` (lines 540–552): renders a `DispatchObservation` as a log line. Scheduled fires reuse this naturally — same observation shape.
- `validateInterval` (lines 561–569): `--interval <ms>` validator. Unchanged.

#### `standing-order-validator.ts` — shared validator
- `ALLOWED_STANDING_ORDER_KEYS` (lines 34–38): currently `['on', 'run', 'with']`. **Must grow to include `'schedule'`.**
- `validateSingleOrder` (lines 115–174): walks each entry. Today: dropped-sugar callouts → unknown-key rejection → required `on:` → required `run:` → optional `with:` plain object.
- **New rules required:**
  - At least one of `on` / `schedule` must be present (today: `on` always required).
  - Both `on` AND `schedule` present is an error ("one trigger source per order").
  - `schedule:` value must be a non-empty string AND parse as either a valid 5-field cron expression or `@every <duration>` form.
- `validateStandingOrders` (lines 81–104): aggregates errors per index. Existing error-aggregation contract carries over for the new rules.
- **Test fixture impact**: `standing-order-validator.test.ts` line 218 currently asserts `schedule:` is rejected as an unknown key — that test inverts in this commission. Same file line 272 has another `schedule:` rejection assertion in the aggregation test — must be replaced.

#### `signal-validator.ts` — anima signal validator
- `RESERVED_EVENT_NAMESPACES` (lines 32–40): currently the seven catalogued prefixes. **Must grow to include `'schedule.'`** so `signal('schedule.fired', ...)` is rejected at the anima-tool surface AND by the framework-CLI `nsg signal` command (which calls the same validator).

#### `tools/signal.ts`
- Reads `RESERVED_EVENT_NAMESPACES` indirectly via `validateSignal`. No code change once the constant is updated.

#### Existing tests with schedule references
- `standing-order-validator.test.ts:218–226` — "rejects future-reserved keys until they are wired (e.g. `schedule:`)". This whole test inverts — it must now assert `schedule:` is accepted (with a valid value).
- `standing-order-validator.test.ts:272` — aggregation test uses `{ on: 'd', run: 'q', schedule: 'every 5m' }` as an invalid entry (currently relies on unknown-key rejection AND on the value being malformed). Must be rewritten — the value is invalid (no `@` prefix, missing minute count format), so we want it to still fail validation but with a different error message.
- The README.md (`packages/plugins/clockworks/README.md` line 173) mentions "cron loop compose on top of this primitive" — fine as-is; informational.

### `packages/framework/cli/src/commands/clock.ts`
- Hand-written CLI for `clock list/tick/run/start/stop/status`. **No new subcommands required by this commission** — the daemon's existing `clock start` is the only operator surface needed for scheduled orders. Operators inspect scheduled fires via the same `clock list` (looks at the events book, where `schedule.fired` rows now appear) or `clock status` for daemon state.
- `clockworks/events` book is the durable history per-fire (the brief explicitly rejects a separate scheduled-fire log).

### `packages/framework/cli/src/commands/signal.ts` (and `signal.test.ts`)
- Hand-written `nsg signal` calls `validateSignal` from clockworks. Once `schedule.` is added to `RESERVED_EVENT_NAMESPACES`, `nsg signal schedule.fired ...` rejects automatically. Worth a regression test.

### `docs/architecture/clockworks.md`
- Lines 281–283 (Deferred): "Scheduled standing orders — time-triggered rather than event-triggered. Deferred." Removed by sibling commission `w-modf69vg`. Coordination point — this commission's behavior must match what the doc-refresh commission writes.
- Lines 100–119 (Standing Orders): canonical shape examples. Sibling commission rewrites these.

### `docs/reference/event-catalog.md`
- Lines 64–69: Clockworks framework events table. Currently lists only `standing-order.failed`. **Must add `schedule.fired`** (or this commission defers the doc edit and the sibling doc-refresh commission picks it up).
- Lines 73–83: Reserved namespaces table. **Must add `schedule.`** to the listed namespaces.

### `docs/reference/core-api.md`
- Lines 57–63: `isFrameworkEvent` description names the seven reserved namespaces. Must add `schedule.`.

## Key types and interfaces

### `StandingOrder` (current → updated)
```typescript
// Today (from types.ts)
interface StandingOrder {
  on: string;           // event name trigger
  run: string;          // relay name
  with?: Record<string, unknown>;
}

// After this commission — `on` becomes optional; `schedule` is the alternative
interface StandingOrder {
  on?: string;          // event name trigger (mutually exclusive with `schedule`)
  schedule?: string;    // cron expression or `@every <duration>` (mutually exclusive with `on`)
  run: string;          // relay name (still required)
  with?: Record<string, unknown>;
}
```
Validator enforces XOR-of-(on,schedule). TS type stays loose; runtime is the gate (precedent: `summon:`/`brief:` rejection lives in the validator, not the type).

### `ScheduleEntry` (new internal shape)
```typescript
// In-memory schedule table; not exported, not persisted
interface ScheduleEntry {
  orderIndex: number;            // index into standingOrders[]
  expression: string;            // raw schedule string (cron or @every)
  nextFireTime: number;          // wall-clock ms (Date.now() comparable)
  // For @every: cached duration in ms, advanced by simple addition.
  // For cron: the parser computes nextFireTime from the most recent fire (or startup time).
}
```

### Synthesized `GuildEvent` for scheduled fires
The relay handler still receives a `GuildEvent` per the existing `RelayHandler` contract. For scheduled fires:
- `name` = `'schedule.fired'`
- `payload` = `{ standingOrder, fireTime, orderIndex }` (shape is a decision point — see decisions D2)
- `emitter` = `'framework'`
- `firedAt` = the actual fire ISO timestamp
- `id` = generated via `generateId('e')` if a real events-book row is written (decision D5)

## Adjacent patterns

### Per-tick re-read of guild config (existing precedent)
`processEvents` re-reads `g.guildConfig().clockworks?.standingOrders ?? []` every call (clockworks.ts line 213) so operators can hot-edit `guild.json` without restart. The brief says the schedule table is built "on daemon startup" — implying NO hot-edit support for scheduled orders. This is an inconsistency the spec writer needs to resolve (decision D11).

### SOF (`standing-order.failed`) emission for relay errors
`signalStandingOrderFailed` callback (clockworks.ts lines 231–233) wraps `api.emit('standing-order.failed', ...)`. The dispatcher invokes this on:
- Unresolved relay (line 370)
- Throwing relay (line 422)

Scheduled fires should reuse this exact path so error-handling standing orders apply uniformly. The triggering event in the SOF payload becomes `{ id, name: 'schedule.fired' }`.

### Loop guard (D9)
The dispatcher's loop guard (`isStandingOrderFailedTrigger`) suppresses standing orders fired in response to a `standing-order.failed` event whose own triggering event was `standing-order.failed`. The scheduled-fire path does not need new loop-guard logic — the existing guard checks the payload of the event being dispatched, not the event-name being fired. Scheduled fires only generate `schedule.fired` events, never `standing-order.failed`, so no new cascade risk.

### Pure-dispatcher discipline
`dispatcher.ts` has zero apparatus imports — every dep is parameter-injected so unit tests can run against in-memory backends without booting Stacks. The new scheduler primitive should follow the same shape (pure function in a new module or extension of `dispatcher.ts`). This makes it testable against `MemoryBackend` like the existing dispatcher tests.

### Daemon test injection pattern
`daemon-integration.test.ts` builds a `processEvents` stub that lets tests:
- queue dispatch observations
- queue forced throws
- count calls
- await next-call

The scheduler-pass tests can follow the identical pattern: a stub scheduler entry point that lets tests queue scheduled fires, advance a virtual clock, and assert on the resulting log lines.

### Daemon's ms-resolution polling
`DEFAULT_INTERVAL_MS = 2000` (daemon.ts line 118). The brief says cron expressions are minute-resolution and `@every` supports seconds. With a 2s default tick, `@every 30s` is fine but `@every 1s` would not be reliable — every tick would either miss or double-fire. **This is worth surfacing in a decision/observation** — minimum interval below the daemon tick is undefined behavior.

## Existing context

- Brief explicitly references the deferred bullet in `docs/architecture/clockworks.md` (line 381) — that bullet is removed by sibling commission `w-modf69vg`.
- Standing-order validator (line 30) already lists `schedule` among "future-reserved keys" with a future-tense comment. The author of the validator anticipated this commission landing.
- The Reckoner's MVP design (`c-mod9a54n` conclusion) is the load-bearing consumer: "Interval is Clockworks config" — the Reckoner installs a scheduled standing order pointing at its own tick relay.
- The `clockworks-retry` plugin (`packages/plugins/clockworks-retry/`) exists already as a kit — should be checked for any standing-order shape assumptions, but it most likely just contributes a relay and is unaffected.

## Doc/code discrepancies

- `docs/architecture/clockworks.md` line 106 still describes the standing-order shape as `{ on, run, ...params }` (flat-spread). The shipped code rejects flat-spread (`standing-order-validator.ts` lines 132–146). The sibling commission `w-modf69vg` is the explicit fix — this commission should not duplicate that work, but must coordinate so cron examples in the new Scheduled Standing Orders section also use `with:` for params.
- `docs/architecture/clockworks.md` line 113–114 still shows a `summon:` sugar example as if it were valid. Same sibling-commission fix; same coordination point.
- `docs/reference/event-catalog.md` line 67 only lists `standing-order.failed` in the "Clockworks Events" table. After this commission `schedule.fired` belongs there too (and in the reserved-namespaces list).
- `clockworks/README.md` line 173 mentions "cron loop compose on top of this primitive" as future work — informational only; the README is largely accurate, but a follow-up touch-up could update the wording.

## Cross-cutting concerns

1. **Cron parser sourcing.** No cron library is currently a dep. Choices: pull in `cron-parser` (de-facto standard, MIT, well-tested, ~5KB), pull in `croner` (smaller, also popular), or hand-roll. Decision needed (D6).
2. **Synthesized event persistence.** Whether the scheduled-fire `schedule.fired` event is written into the events book before dispatch (so the dispatch row's `eventId` references a real events row) or whether the scheduler bypasses persistence and writes directly to the dispatches book with a synthesized event id. The events table's FK shape (`event_id REFERENCES events(id)` per `docs/architecture/clockworks.md` line 304) suggests persistence is required. Decision D5.
3. **Schedule table reconciliation.** Build-once-on-startup vs. re-reconcile-per-tick. Brief implies build-once. Inconsistency with event-trigger hot-edit support is the trade-off.
4. **Scheduler pass entry point.** Whether to extend `processEvents()` with a "fire-due-schedules-first" pre-pass, or expose a separate `processSchedules()` API method. The latter is cleaner for testing; the former is fewer moving parts. Decision D3.
5. **Time-source injection.** The dispatcher accepts `now: () => string` for testability. The scheduler needs both a wall-clock-millis source (for `nextFireTime <= now` comparison) and an ISO-string source (for log lines). Decision D14.
6. **Reserved-namespace addition.** `schedule.` joins the seven existing namespaces. This is a single-line change in `signal-validator.ts` plus tests. Documentation cross-update in `docs/reference/event-catalog.md` and `docs/reference/core-api.md`.

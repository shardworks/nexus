# The Clockworks

The Clockworks is the guild's nervous system — the event-driven layer that connects things that happen to things that should happen in response. It turns the guild from an imperative system (things happen when someone calls something) into a reactive one (things happen because other things happened).

The Clockworks is Pillar 5 of the guild architecture. The first four pillars make the guild *capable*. The Clockworks makes it *alive* — able to act on itself without waiting for the patron to push.

---

## Core Concepts

### Events

An event is an immutable fact: *this happened*.

```typescript
{
  name: string;       // e.g. "writ.mandate.completed", "astrolabe.plan.files-over-threshold"
  payload: unknown;   // event-specific data
  emitter: string;    // who signaled it: anima name, engine name, or "framework"
  firedAt: DateTime;
}
```

Events are persisted to the Clockworks' own event queue immediately when signaled. They do not carry intent — they carry record. An event says "this occurred"; it does not say "therefore do this." That causal link lives in standing orders. The event and dispatch books are internal Clockworks operational state — Stacks books contributed by the apparatus's `supportKit`, distinct from the guild's curated Books (Register, Ledger, Daybook). The distinction is curatorial, not architectural: every persistent collection in the guild is a Stacks book; the curated trio is the human-readable surface, while the Clockworks' two books are operational machinery.

#### Framework events

Framework events are signaled automatically from authoritative code paths in the framework and apparatuses (`session.*`, `anima.*`, `commission.session.ended`, the universal writ-lifecycle `writ.<type>.<status>` family, the Clockworks's own `clockworks.standing-order.failed` and `clockworks.timer`). Animas cannot signal them. The full enumeration — every event name, payload shape, emitter site, and "fires when" condition — lives in the [Event Catalog](../reference/event-catalog.md), which is the single source of truth for the framework event surface. Each event listed there is grep-findable in shipped emitter code; this document deliberately does not duplicate the table.

#### Custom guild events

Guilds declare their own events in `guild.json` under the `clockworks` key:

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "Signaled when an anima completes a code review"
      },
      "deploy.approved": {
        "description": "Leadership has approved a deployment"
      }
    }
  }
}
```

Custom events use any name that is not already declared by a plugin's `events` kit contribution. There is no hardcoded reserved-prefix list — names are framework-owned per-event, claimed by a plugin's `events` kit at apparatus `start()`, and tagged with a sticky `pluginDeclared` flag in the merged event set. Writ-lifecycle names (e.g. `writ.mandate.open`, `writ.task.completed`) are part of that plugin-declared set: the Clockworks itself contributes them as a state-walk over Clerk's writ-type registry, so they are framework-emitted and rejected by the merged-set framework-owned check on the unprivileged `signal` channels. See the [Event Catalog → Reserved Namespaces](../reference/event-catalog.md#reserved-namespaces) and [Writ Lifecycle Events](../reference/event-catalog.md#writ-lifecycle-events) for details. Bundles may also declare events they introduce; these are merged into `guild.json` on installation.

Animas signal custom events using the `signal` tool. The tool validates the event name against declared events in `guild.json` before persisting.

#### Book change events (Stacks auto-wiring)

`book.<ownerId>.<bookName>.<verb>` events are owned by the `clockworks-stacks-signals` bridge plugin — see [`docs/architecture/apparatus/clockworks-stacks-signals.md`](apparatus/clockworks-stacks-signals.md) for the full apparatus contract and carve-out rationale.

---

### Standing Orders

A standing order is a registered response to an event. Standing orders are **guild policy** — they live in `guild.json` under the `clockworks` key, not in relay descriptors. The guild decides what fires when; a relay is a capability, not a policy.

#### Canonical form

Every standing order has one canonical form: `{ on, run, with? }`. The `on` key names the event to respond to. The `run` key names the relay to invoke. The optional `with` block is a plain object passed to the relay as `RelayContext.params`. A peer `schedule` key swaps the trigger from event-driven to time-driven (see [Scheduled Standing Orders](#scheduled-standing-orders) below); exactly one of `on:` or `schedule:` must be present.

```typescript
interface StandingOrder {
  on?: string;                       // event-trigger; XOR with schedule
  schedule?: string;                 // time-trigger; XOR with on
  run: string;                       // relay name
  with?: Record<string, unknown>;    // forwarded as RelayContext.params
}
```

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "writ.mandate.completed", "run": "cleanup-worktree" },
      { "on": "code.reviewed",          "run": "notify-patron" },
      {
        "on": "deploy.requested",
        "run": "deploy",
        "with": { "environment": "staging", "dryRun": true }
      }
    ]
  }
}
```

**Why nested `with:`.** The four canonical top-level keys (`on`, `schedule`, `run`, `with`) are reserved for Clockworks metadata; nesting params under `with:` keeps that namespace open for future Clockworks-owned fields without colliding with operator-chosen param names. The shape mirrors GitHub Actions' `with:` block on workflow steps — same separation between the runner's trigger / handler metadata and the handler's own inputs. The standing-order validator enforces the allowlist at guild.json load time and rejects any unknown top-level key.

#### The summon relay

The **summon relay** is the stdlib relay that turns event dispatches into anima sessions. It is wired into the apparatus's `supportKit.relays` so every guild has it available by default, registered under the canonical name `summon-relay`. Operators invoke it like any other relay:

```json
{
  "on": "writ.mandate.open",
  "run": "summon-relay",
  "with": {
    "role": "artificer",
    "prompt": "Read your writ. Title: {{writ.title}}",
    "maxSessions": 5
  }
}
```

Anima dispatch is therefore handled by a regular relay — replaceable, upgradeable, configurable — not baked into the framework.

**`with:` parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | *(required)* | Role to summon. Must be registered with the Loom; the relay throws at dispatch time if not. |
| `prompt` | string | *(required)* | `{{path.with.dots}}` template. Namespaces: `writ.*` (always populated, real or synthetic), `event.*` (id / name / payload / emitter / firedAt), and `params.*` (every `with:` key other than `role`, `prompt`, `maxSessions`). Undefined paths throw. |
| `maxSessions` | number | 10 | Per-writ circuit breaker. The relay tracks `writ.status.clockworks.sessionAttempts` and fails the writ once the count reaches this cap. `0` disables the breaker; negative values throw. |

**Writ binding:** if `event.payload.writId` is a string, the relay fetches the writ via the Clerk and exposes it as `writ.*`. Otherwise it synthesizes an in-memory writ from the event payload — synthetic writs are never persisted, and the circuit breaker is bypassed entirely (synthetic writs have no durable identity to count against).

**Circuit breaker:** the per-writ counter (`writ.status.clockworks.sessionAttempts`) is incremented before each launch via `clerk.setWritStatus(writId, 'clockworks', …)` so a crashed dispatcher cannot bypass the count. When the cap trips, the relay transitions the writ to `'failed'` via `clerk.transition` with a resolution string identifying the relay, and returns cleanly without throwing to the dispatcher — the writ's resolution is the audit trail.

**Soft dependency on the Animator and the Loom:** both apparatuses are declared under Clockworks's `recommends` (not `requires`) and are resolved lazily at handler-call time. A guild that uses Clockworks for non-anima relays can install the apparatus without dragging in the session-launch stack; if a `summon-relay` standing order fires while the dependencies are missing, the relay throws a clear error naming the missing apparatus.

**Session metadata:** the relay calls `animator.summon` with `cwd: guild().home` and metadata `{ trigger: 'summon-relay', role, writId, eventId, eventName }`, then awaits `AnimateHandle.result` so the dispatcher's `event_dispatches` row reflects real session runtime.

#### Relay params

The `with:` block on a standing order is forwarded verbatim to the relay as `RelayContext.params`. The relay handler reads its inputs off `params`:

```typescript
export default relay({
  name: 'deploy',
  handler: async (event, { home, params }) => {
    const environment = (params.environment as string) ?? 'production';
    const dryRun = (params.dryRun as boolean) ?? false;
    // ...
  }
});
```

Params default to `{}` when the order omits `with:`. Existing relays that destructure only `{ home }` from context are unaffected.

---

### Scheduled Standing Orders

A standing order may swap its `on:` trigger for a `schedule:` expression to fire on a wall-clock cadence rather than on an event. The two trigger keys are mutually exclusive — a standing order with both, or with neither, is rejected at guild.json load time. Everything downstream of the trigger (the `run:` relay, the `with:` params block, the dispatch row written per fire, the SOF callback on failure) is shared with the event-driven path.

```json
{ "schedule": "*/5 * * * *", "run": "reckoner-tick" }
```

```json
{ "schedule": "@every 1h", "run": "tech-debt-scan", "with": { "depth": "full" } }
```

**Schedule expressions.** Two syntaxes are accepted:

- **Standard 5-field unix cron** — `m h dom mon dow`. Six- and seven-field forms (with seconds or year) and vendor extensions are rejected. Cron expressions are evaluated in the daemon's local time zone.
- **`@every <N><unit>`** — fixed interval. The unit suffix is one of `s` (seconds), `m` (minutes), or `h` (hours), and the count is a positive integer. Compound durations (e.g. `1m30s`), fractional values, and other unit suffixes are rejected.

Schedule values are parse-checked at guild.json load time alongside the rest of the standing-order validator, so a malformed cron or `@every` value fails the apparatus boot with an error that names the offending order index.

**The `clockworks.timer` event.** Every fire writes a synthesized `clockworks.timer` event row into the `events` book (with `processed: true` so the event-sweep does not re-fire it) plus a matching dispatch row through the same plumbing the event-driven path uses. The Clockworks's own `events` kit declares `clockworks.timer` as framework-owned, so the merged-set check rejects any `signal('clockworks.timer', …)` from animas or the operator CLI — only the daemon's scheduler pass is authorized to emit it.

**Per-tick ordering.** The daemon runs `processSchedules()` first on every tick and `processEvents()` second, so events emitted from a scheduled relay are picked up on the same tick they are produced.

**Missed fires and restart semantics.** A daemon cold start fires each scheduled order at the next boundary after start — there is no missed-fire backfill. When the scheduler is catching up (a stalled tick, a paused process, or many intervals elapsed at once), an in-tick guard limits each order to at most one fire per tick; subsequent overdue fires are picked up one-per-tick on later passes.

**Lifecycle constraint.** The schedule table is built once on apparatus `start()` and held in memory for the life of the daemon. Operators editing `schedule:` entries in `guild.json` must restart the apparatus for the change to take effect — distinct from event-driven (`on:`) orders, which the dispatcher re-reads from the config on every sweep and so support hot-edit.

---

### The Clockworks Runner

A framework engine that processes the event queue. It reads unprocessed events from the Clockworks event queue, resolves which standing orders apply, and executes them in registration order.

#### Phase 1 — manual operation via `nsg clock`

Events are written to the Clockworks event queue immediately when signaled. Processing is explicitly operator-driven — not automatic. This allows the system to be monitored and stepped through until it has earned enough trust to run unattended.

| Command | Behavior |
|---|---|
| `nsg clock list` | Show all pending (unprocessed) events |
| `nsg clock tick [id]` | Process the next pending event, or the specific event with the given id |
| `nsg clock run` | Continuously process all pending events until the queue is empty |

No daemon required. The operator decides when and how much the Clockworks runs.

#### Phase 2 — daemon

A background daemon polls the event queue and processes events automatically. Phase 2 is shipped — see commission c-moe3qifr.

| Command | Behavior |
|---|---|
| `nsg clock start [--interval <ms>] [--foreground|-f]` | Start the daemon as a detached background process (default interval: 2000ms). Refuses (exits nonzero) when a daemon is already running. Cleans up a stale pidfile and continues. `--foreground` runs the inline daemon body in this process and is the re-exec target the detached spawn uses. |
| `nsg clock stop` | Send SIGTERM and clean up the PID file. Escalates to SIGKILL after a 5s grace window. Exits zero with a message when there is nothing to stop (no pidfile, or the pidfile was stale). |
| `nsg clock status [--json]` | Show whether the daemon is running, with PID, uptime, and log file path. `--json` emits the structured payload. |

The daemon spawns as a detached child process by re-execing the same `nsg` binary with `clock start --foreground --guild-root <home>` (plus `--interval <ms>` if supplied). It writes a PID file at `<home>/.nexus/clock.pid` and logs to `<home>/.nexus/clock.log` (append mode). Both stdout and stderr land in the same log file. The detached parent calls `child.unref()` so closing the parent terminal does not take the daemon down.

The startup banner names the pid, polling interval, and log path; the shutdown banner records the signal received. Per-dispatch lines emit on active ticks in the format `<ISO timestamp> <eventId> <eventName> [<handlerName>] <status> <durationMs>ms[: <error>]`. Idle ticks are silent. When `processEvents` itself throws, the loop logs `<ISO timestamp> [error] processEvents threw: <reason>` and continues at the next interval — the daemon stays unattended.

The poll loop sleeps abortably between ticks (`Promise.race(timeout, shutdownDeferred)`) so SIGTERM is acted on immediately. Per-tick `processEvents` runs as a full drain — no `max` cap — and the post-completion sleep schedules the next tick after the previous one returns.

Phase 1 commands (`list`, `tick`, `run`) continue to work alongside the daemon. If the daemon is running, `tick` and `run` emit a one-line coexistence warning to stderr and still execute. The dispatch sweep (read-pending → invoke → patch-processed) is not atomic across processes, so an overlapping manual invocation and the daemon can each see the same unprocessed events and a relay may be invoked more than once for the same event; the contract is upheld by relay-author idempotency rather than by substrate coordination (see the relay-handler `RelayHandler` JSDoc and `docs/guides/building-relays.md` for the worked pattern).

`clockStatus(home)` cleans up stale pidfiles as a side effect: a pidfile pointing at a dead pid surfaces in the return shape as `stalePidfile: true` and is unlinked, so subsequent calls are silent on staleness.

Core API: `clockStart(home, options?)`, `clockStop(home)`, `clockStatus(home)`, plus `runForegroundDaemon(...)` (the inline daemon body, with every dependency injected for tests) and `runForegroundDaemonFromGuild(...)` (the live-guild convenience wrapper the CLI re-exec target calls). The `clock-status` MCP tool exposes daemon status to animas.

The two-daemon coexistence with `nsg start` (the guild daemon) is intentional. Different pidfiles (`daemon.pid` vs `clock.pid`), different log files, different lifecycles. Both processes may dispatch the same event when their sweeps overlap, so relay-author idempotency carries the cross-process contract — relays must be safe to invoke more than once for the same event.

---

## Error Handling

Standing order failures signal a `clockworks.standing-order.failed` event:

```typescript
{
  name: "clockworks.standing-order.failed",
  payload: {
    standingOrder: { on: "writ.mandate.failed", run: "notify-patron" },
    triggeringEvent: { id: 42, name: "writ.mandate.failed", ... },
    error: "relay 'notify-patron' threw: SMTP connect ECONNREFUSED"
  }
}
```

Guilds can respond to this event with their own standing orders — summon an anima, invoke a notification relay, whatever the guild needs. The error handling policy is itself configurable.

**Loop guard**: the dispatcher reads `payload.triggeringEvent.name` on every event and suppresses any standing order whose triggering event was itself a `clockworks.standing-order.failed`. Errors handling errors do not cascade. The check is a single literal comparison against a module-level constant shared with the apparatus's emit lambdas — see `STANDING_ORDER_FAILED_EVENT` in `clockworks/src/event-names.ts`.

---

## The `signal` Tool

A base tool available to all animas. Used to signal custom guild events.

```typescript
tool({
  description: "Signal a custom guild event",
  params: {
    name: z.string().describe("Event name (must be declared in guild.json clockworks.events)"),
    payload: z.record(z.unknown()).optional().describe("Event payload")
  },
  handler: async ({ name, payload }, { home }) => {
    // route through ClockworksApi.validateSignal — merged-set
    // membership check, then framework-owned check (sticky
    // pluginDeclared)
    // persist to Clockworks events table
  }
})
```

Also exposed as `nsg signal <name> [--payload <json>]` for operator use.

Animas cannot signal framework events (`anima.*`, `session.*`, the Clockworks's own `clockworks.standing-order.failed` / `clockworks.timer`, etc.) or any name from the universal writ-lifecycle family (`writ.mandate.open`, `writ.task.completed`, every other `writ.<type>.<status>` declared by the Clockworks's `events` kit). Only operator-declared custom events. This keeps the event record trustworthy — framework events come from authoritative code paths.

---

## guild.json Shape

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "Signaled when an anima completes a code review"
      }
    },
    "standingOrders": [
      { "on": "writ.mandate.completed", "run": "cleanup-worktree" },
      {
        "on": "writ.mandate.open",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "Read your writ. Title: {{writ.title}}",
          "maxSessions": 5
        }
      },
      {
        "on": "code.reviewed",
        "run": "notify-channel",
        "with": { "channel": "#reviews", "level": "info" }
      },
      { "schedule": "@every 30s", "run": "reckoner-tick" }
    ]
  }
}
```

---

## Clockworks Books

The Clockworks apparatus contributes two books to The Stacks via its `supportKit.books` block: `events` (the immutable fact record) and `event_dispatches` (the per-handler execution log). Both are Stacks-owned books in the literal sense — JSON documents addressed by `id`, queried through the `Book` interface, and observable through CDC. There is no per-field SQL surface to bind against; field-level access happens through the `BookQuery` language documented in [stacks.md](apparatus/stacks.md#query-language), and only declared indexes are guaranteed to be efficient.

### `events`

One document per emission. The Clockworks assigns the id, records the emitter and fire time, and flips `processed` to `true` once every matching standing order has been dispatched (or the event has been found to match no order).

```typescript
interface EventDoc extends BookEntry {
  /** Unique event id (`e-<base36_ts>-<hex>`). Sortable by creation time. */
  id: string;
  /** Event name — `{pluginId}.{kebab-suffix}` for framework events; same grammar for operator-defined events. */
  name: string;
  /** Structured payload. Shape is keyed by event name; the Clockworks does not enforce a schema in Phase 1. */
  payload: unknown;
  /** Plugin id of the emitter that produced this event. */
  emitter: string;
  /** ISO timestamp when the event was emitted. */
  firedAt: string;
  /** Whether every matching standing order has been dispatched. The runner flips this to true after dispatch. */
  processed: boolean;
}
```

**Declared indexes:** `name`, `processed`, `firedAt`, and the compound `['processed', 'firedAt']` (used by the dispatcher to drain pending events oldest-first).

### `event_dispatches`

One document per handler invocation triggered by an event. Each standing order that matches an event produces exactly one dispatch document; the document carries its own lifecycle from `pending` through one of the three terminal states.

```typescript
interface EventDispatchDoc extends BookEntry {
  /** Unique dispatch id (`d-<base36_ts>-<hex>`). */
  id: string;
  /** Id of the event that produced this dispatch — references an `EventDoc.id`. */
  eventId: string;
  /** Whether this dispatch runs a relay or summons an anima session. */
  handlerType: 'relay' | 'anima';
  /** Relay name for `handlerType: 'relay'`; resolved role id for `handlerType: 'anima'`. */
  handlerName: string;
  /** Role id the anima session is opened in; always null for `handlerType: 'relay'`. */
  targetRole: string | null;
  /** Emitted pulse kind, if the dispatcher raised a notice (e.g. a summon invitation); null otherwise. */
  noticeType: 'summon' | null;
  /** ISO timestamp when handler execution began, or null while pending. */
  startedAt: string | null;
  /** ISO timestamp when handler execution ended, or null if still pending. */
  endedAt: string | null;
  /** Lifecycle state of this dispatch — see the four-state table below. */
  status: 'pending' | 'success' | 'error' | 'skipped';
  /** Error text when `status === 'error'`; loop-guard reason (prefixed `loop-guard:`) when `status === 'skipped'`; null otherwise. */
  error: string | null;
}
```

**Status lifecycle.** The dispatcher writes one of four states:

| State | When the dispatcher writes it |
|---|---|
| `pending` | Dispatch row created; handler not yet attempted. |
| `success` | Handler ran and returned without throwing. |
| `error` | Handler threw, or the standing order's `run:` name did not resolve to a registered relay. |
| `skipped` | The dispatcher's loop-guard policy elided the invocation (e.g. the triggering event was itself a `clockworks.standing-order.failed`). The relay was not called and no `clockworks.standing-order.failed` event was emitted; this is policy suppression, not a failure, and must not count toward operator error metrics. |

**Declared indexes:** `eventId`, `status`, and the compound `['eventId', 'status']`.

### Source of truth

The interface declarations above mirror `EventDoc` and `EventDispatchDoc` in `packages/plugins/clockworks/src/types.ts` (exported from `@shardworks/clockworks-apparatus`) — that file is the field-level source of truth, and any divergence here is a defect against it. The index sets mirror the `supportKit.books` block in `packages/plugins/clockworks/src/clockworks.ts`. For the Book API, query language, CDC semantics, and backing store, see [The Stacks — API Contract](apparatus/stacks.md).

---

## ClockworksKit

The Clockworks apparatus consumes relay, event, and standing-order contributions from installed plugins. It publishes a `ClockworksKit` interface that kit authors import for type safety:

```typescript
// Published by @shardworks/clockworks-apparatus
interface ClockworksKit {
  relays?:         RelayDefinition[]
  events?:         EventsKitContribution
  standingOrders?: StandingOrder[]
}
```

A plugin contributing relays, events, or default standing orders declares itself as satisfying `ClockworksKit` and names `clockworks` in its `recommends`:

```typescript
import type { ClockworksKit } from "@shardworks/clockworks-apparatus"

export default {
  name: "nexus-signals",
  kit: {
    relays:     [memberJoinedRelay, memberLeftRelay],
    recommends: ["clockworks"],
  } satisfies ClockworksKit,
} satisfies Plugin
```

The Clockworks apparatus registers relays from both standalone kit packages and its own `supportKit` into a unified relay registry. Callers of the Clockworks API see a single relay list regardless of source.

### Kit-contributed standing orders

Apparatuses and standalone kits may ship default standing orders through the `standingOrders` slot. Each kit's contribution is validated with the source-aware standing-order validator at apparatus boot — a malformed entry fails the boot loud with a header that names the contributing kit, e.g. `clockworks: invalid standing order in kit "demo-kit":` plus per-bullet `standing order #N [kit "demo-kit"]: …` lines. A non-array contribution surfaces the same fail-loud guard.

The kit layer is sealed at apparatus `start()` and merged additively (`[...kit, ...operator]`) with the operator-defined `clockworks.standingOrders` slice on every dispatch and schedule pass. There is no id, no override, no disable, and no collision detection — identical entries from two sources simply produce two dispatches. Operator hot-edits to `guild.json` continue to land on the next `processEvents` call without restart; updating a kit-contributed default requires an apparatus restart (matching the existing schedule-table lifecycle).

The synthesized `clockworks.timer` event payload carries a scalar `source` field alongside `orderIndex` (`null` for operator-sourced entries; the contributing pluginId for kit entries). `orderIndex` is per-source — the entry's position within its own source array — so an operator's mental model of "the #N-th order in `guild.json`" stays stable when kit defaults change. The dispatcher's relay-not-registered error message and the scheduler's boot-time schedule-parse error both attribute the contributing kit when applicable.

### Relay Contract

The Clockworks needs a standard invocation contract to call relays generically. Relays export a default using the `relay()` SDK factory shipped from `@shardworks/clockworks-apparatus` — kit authoring factories live with their owning apparatus (mirrors `tool()` in `@shardworks/tools-apparatus`):

```typescript
import { relay } from '@shardworks/clockworks-apparatus';

export default relay({
  handler: async (event: GuildEvent | null, { home, params }) => {
    // event  — the triggering GuildEvent when invoked by a standing order (null for direct invocation)
    // home   — absolute path to the guild root
    // params — the standing order's `with:` block (empty object when absent)
  }
});
```

The Clockworks runner calls `module.default.handler(event, { home, params })`. Params come from `order.with ?? {}` — the standing order's `with:` block, or an empty object when absent. Relays can be named in `run:` standing orders; bespoke framework processes cannot.

---

## Relationship to Existing Concepts

**Relays** — a new artifact type, distinct from tools and existing framework machinery. Relays are purpose-built Clockworks handlers that export a standard `relay()` contract and can be named in `run:` standing orders. Framework processes (manifest, mcp-server, ledger-migrate) are unchanged.

**Tools** — `signal` is a new base tool. All other tools unchanged.

**The Books** — the Clockworks owns its event/dispatch tables as internal operational state, separate from the guild's Books (Register, Ledger, Daybook). Writs live in the Ledger — see the architecture overview.

**Bundles** — may ship default standing orders and custom event declarations, merged into `guild.json` on installation. Same delivery mechanism as other bundle-provided config.

---

## Deferred

- **Natural language trigger syntax** — `'when a mandate becomes available'` instead of `'writ.mandate.open'`. Worth pursuing once real guilds have standing orders in production and vocabulary needs are understood. Requires validation tooling to be safe.
- **Pre-event hooks** — cancellable `before.*` events. Powerful but complex. Start with observation-only (post-facto) events.
- **Phase 2 daemon enhancements** — external event injection (webhooks, file watchers), log rotation, concurrency.

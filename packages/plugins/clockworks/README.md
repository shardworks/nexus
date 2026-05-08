# `@shardworks/clockworks-apparatus`

The Clockworks — Pillar 5 of the guild architecture. The event substrate
and standing-order engine: declares events, accepts emissions, and fans
them out to registered handlers (relays, summons, briefs).

**Status:** Write path, event-triggered dispatcher, the manual
operator CLI, framework-event emission from real lifecycle activity,
the unattended Clockworks daemon, AND the time-driven scheduler are
all live. The Clockworks exposes `ClockworksApi.emit` for trusted
framework callers, a validated `signal` tool for animas (with an
operator-facing `nsg signal` CLI counterpart),
`ClockworksApi.processEvents()` — the bulk-drain dispatcher that
resolves matching standing orders, invokes their relays, persists one
dispatch row per invocation, and flips the event's `processed`
flag — `ClockworksApi.processSchedules()` — the scheduler pass that
fires every time-driven standing order whose `nextFireTime` has
elapsed and synthesizes a `clockworks.timer` event plus a dispatch
row per fire. Startup also registers a CDC observer on `clerk/writs`
that emits one `writ.<type>.<status>` event per writ status
transition (the universal contract — every transition fires,
including initial creation and cancellation). A fresh `start()` adds
no boot-time noise to the events book — the legacy
`guild.initialized` and per-book `migration.applied` emissions were
removed in C2. The operator-facing `nsg clock list/tick/run` CLI
composes on top of `processEvents()`. The daemon polls the events
queue at a configurable interval, runs the scheduler pass before each
event-processing pass, and drains dispatches without an operator at
the keyboard. **Canonical startup is `nsg start`**, which co-hosts
the Clockworks tick loops as a sibling task inside the unified guild
daemon. A dedicated standalone daemon (`nsg clock start`) is also
available for advanced operator use.

Stacks change-data-capture (CDC) → Clockworks `book.*` event
auto-wiring lives in the dedicated
[`@shardworks/clockworks-stacks-signals-apparatus`](../clockworks-stacks-signals/README.md)
bridge plugin; install it alongside Stacks and Clockworks to surface
row mutations as Clockworks events.

See also: [`docs/architecture/clockworks.md`](../../../docs/architecture/clockworks.md).

---

## Installation

```sh
pnpm add @shardworks/clockworks-apparatus
```

Register the apparatus in `guild.json`:

```json
{
  "plugins": [
    "@shardworks/clockworks-apparatus"
  ]
}
```

The apparatus declares `requires: ['stacks', 'clerk']` — the Stacks
provides persistence for the two books, and the Clerk supplies the
writ-type registry the `signal` validator consults. The Animator and
the Loom appear under `recommends` (not `requires`): the stdlib
`summon-relay` resolves both lazily at handler-call time, so a guild
that uses Clockworks for non-anima relays can install the apparatus
without dragging in the session-launch stack.

---

## Configuration

Custom events live under `clockworks.events` in `guild.json`. Each entry
is keyed by the event name with an optional human-readable description:

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": { "description": "An anima finished reviewing a diff." },
      "demo.thing-happened": {}
    }
  }
}
```

Framework-owned names cannot be emitted via `signal`. There is no
hardcoded reserved-prefix list — names are framework-owned per-event,
claimed by a plugin's `events` kit at apparatus `start()`. The
Clockworks itself claims `clockworks.standing-order.failed`,
`clockworks.timer`, and the universal `writ.<type>.<status>` family
(one entry per `(writType, state)` pair currently registered with the
Clerk); the Animator claims `session.*`, `anima.*`, and
`commission.session.ended`; the framework CLI claims `tool.*`. See
[Event Catalog → Reserved Namespaces](../../../docs/reference/event-catalog.md#reserved-namespaces)
for the canonical surface and
[Event Catalog → Renamed/removed in this release](../../../docs/reference/event-catalog.md#renamedremoved-in-this-release)
for the migration table from the legacy `commission.*`,
`guild.initialized`, `migration.applied`, `schedule.fired`, and
`standing-order.failed` vocabulary that landed in C2.

---

## API

### `ClockworksApi.emit(name, payload, emitter): Promise<string>`

Persists one document to the `clockworks/events` book and returns the
generated event id (`e-<base36_ts>-<hex>`). The payload is
JSON-serialized eagerly so non-serializable values (circular references,
`BigInt`, functions, …) surface as a descriptive Clockworks-attributed
error at the API boundary rather than as an opaque failure inside the
Stacks layer. An `undefined` payload is coerced to `null` so the stored
row shape stays predictable.

`emit` is the trusted write path — it does not run the `signal`
validator, so framework callers can record reserved-namespace and
writ-lifecycle events that animas cannot. Use it from inside plugins
that own a namespace; use the `signal` tool for everything else.

### `ClockworksApi.resolveRelay(name): RelayDefinition | undefined`

Looks up a registered relay by name. Returns the `RelayDefinition`
registered under `name` — sourced from either a standalone kit's
`relays` contribution or the apparatus's own `supportKit.relays` slot —
or `undefined` when no relay with that name is registered. The
dispatcher calls this when resolving a standing order's `run:` field.

### `ClockworksApi.processEvents(): Promise<{ processedEvents, dispatches, errors, skipped }>`

Drains every unprocessed event from the `events` book in one pass.
For each event in id-ascending order, the dispatcher resolves every
standing order whose `on:` field matches the event name (in
registration order), invokes the named relay with the event and a
fresh `RelayContext { home, params: order.with ?? {} }`, and writes
exactly one `event_dispatches` row per invocation. After all matching
orders for an event have been attempted, the event is marked
`processed: true`.

Per-handler isolation: a thrown handler does not block sibling
handlers or sibling events. Both success and error outcomes are
recorded as one-phase dispatch rows (no `pending` intermediate state
written by this dispatcher).

The standing-order array is re-read from `guildConfig().clockworks?.standingOrders`
on every call, so operators may hot-edit `guild.json` without
restarting the apparatus. Every entry is validated against the
canonical shape on every sweep — any malformed order causes the entire
sweep to throw with an aggregated error message naming every
offender's index, and no events are processed.

#### Standing-order failure signaling

Whenever a relay throws OR an order's `run:` field names a relay that
is not registered, the dispatcher (after writing the dispatch row)
emits a `clockworks.standing-order.failed` event into the `events`
book with `emitter: 'framework'`. The payload carries the verbatim
standing order, an `{id, name}` projection of the triggering event,
and the same error string written to the dispatch row's `error`
column:

```typescript
{
  name: 'clockworks.standing-order.failed',
  emitter: 'framework',
  payload: {
    standingOrder: { on, run, with? },
    triggeringEvent: { id, name },
    error: '<message>'
  }
}
```

Guilds can wire standing orders against `clockworks.standing-order.failed`
to react to failures (notify the patron, summon a steward, etc.). A
loop guard prevents cascade: when the dispatcher processes an event
whose `payload.triggeringEvent.name` is
`'clockworks.standing-order.failed'` (i.e. a second-generation SOF),
every matching standing order is recorded as a `'skipped'` dispatch
row, the relay is not invoked, and no fresh
`clockworks.standing-order.failed` event is emitted.

Returned counts:

- `processedEvents` — events whose `processed` flag was flipped this sweep.
- `dispatches` — total dispatch rows written across every event.
- `errors` — subset of those rows whose `status` is `'error'`.
- `skipped` — subset whose `status` is `'skipped'` (loop-guard
  suppression). Reported separately from `errors` so policy-driven
  skips do not flip the CLI exit code.

Sequential, single-pass — no scheduling, no parallelism, no retry. The
CLI wrapper, daemon, and cron loop compose on top of this primitive.

**Cross-process delivery.** The read-pending → invoke → patch-processed
sequence is not atomic across processes. When two callers overlap (e.g.
the unattended daemon plus a manual `nsg clock run`, or two manual
runs), both can see the same unprocessed events, so a relay
may be invoked more than once for the same event. Substrate-level row
locking is intentionally deferred; the contract is upheld by
relay-author idempotency — handlers must be safe to invoke more than
once for the same triggering event. See
[Authoring relays](#authoring-relays) and the
[Building Relays guide](../../../docs/guides/building-relays.md#best-practices).

### `ClockworksApi.processSchedules(): Promise<{ fired, errors }>`

Runs one tick of the scheduler pass over the in-memory schedule
table populated at apparatus `start()`. Sister to
`processEvents()` — every detail of the scheduled-fire path
(persisted-row shape, observer hook, SOF emission) mirrors the
event-driven path so observers and operators do not need to
special-case scheduled fires. See the
[Standing orders](#standing-orders) section for the full schedule
contract, supported expressions, and lifecycle rules.

The daemon runs `processSchedules()` first on every tick, then
`processEvents()` — emit-and-pickup latency for events emitted
from a scheduled handler is one tick rather than two.

---

## Standing orders

Standing orders live under `clockworks.standingOrders` in `guild.json`.
Each order has exactly one trigger — either `on:` (event-driven) or
`schedule:` (time-driven) — and exactly one relay to invoke (`run:`),
with an optional `with:` block forwarded to the relay as
`RelayContext.params`:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "demo.thing-happened", "run": "log-event" },
      {
        "on": "code.reviewed",
        "run": "notify-channel",
        "with": { "channel": "#reviews", "level": "info" }
      },
      { "schedule": "@every 30s", "run": "reckoner-tick" },
      { "schedule": "*/5 * * * *", "run": "health-probe" }
    ]
  }
}
```

`on:` and `schedule:` are mutually exclusive — declaring both, or
neither, fails load with a descriptive error. Anything else — extra
top-level keys, a non-object `with:`, the dropped `summon:` /
`brief:` sugar forms — is rejected at load time too.

### Schedule expressions

Two syntaxes are supported:

- **`@every <N><unit>`** — fixed-interval. Units are `s` (seconds),
  `m` (minutes), or `h` (hours); the count must be a positive
  integer. Examples: `@every 30s`, `@every 5m`, `@every 1h`. The
  first fire lands one full duration after apparatus startup; later
  fires advance from the prior fire to preserve cadence.
- **5-field unix cron** — `m h dom mon dow`. Standard ranges, lists,
  and step expressions are accepted (e.g. `*/5 * * * *`,
  `0 9 * * 1-5`, `0,15,30,45 9-17 * * *`). 6/7-field forms (with
  seconds or year) and vendor extensions are rejected. Cron
  expressions are evaluated in the daemon's local time zone; the
  first fire is the next boundary after apparatus startup.

Schedule expressions are parse-checked at guild.json load time, so a
malformed cron or `@every` value fails the apparatus boot with an
error that names the offending order index and the parser's
diagnosis.

### Schedule lifecycle and limitations

The schedule table is built once on `start()` and held in memory —
**operators editing schedule entries in `guild.json` must restart
the apparatus for the change to take effect.** Event-driven orders
(`on:`) continue to support hot-edit through the per-call re-read in
`processEvents()`.

Daemon restarts are cold starts — there is no missed-fire backfill.
A `@every 5m` order that misses 20 minutes of fires across a
restart fires once on the next due tick and resumes cadence from
there.

### `processSchedules()` semantics

Each scheduler pass:

1. Walks the in-memory schedule table in `orderIndex` ascending order.
2. For each entry whose `nextFireTime <= now`, persists a
   `clockworks.timer` event row with `processed: true` (so the
   event-sweep does not re-fire it), invokes the resolved relay with
   a synthesized `GuildEvent`, persists a dispatch row through the
   shared helper, and advances `nextFireTime` from the parser.
3. Returns counts: `{ fired, errors }`.

In-tick guard: at most one fire per order per tick, even if many
intervals have elapsed (e.g. a stalled tick or a paused process).
The scheduler catches up over subsequent ticks, one fire at a time.

Failure isolation matches the dispatcher:

- A thrown relay produces an `error` dispatch row and a
  `clockworks.standing-order.failed` event via the same SOF callback
  the dispatcher uses — subscribers wiring
  `{ on: 'clockworks.standing-order.failed', run: ... }` see
  scheduled-fire failures and event-driven failures uniformly.
- An unresolved `run:` name produces an `error` dispatch row with a
  message naming the offending order index, plus the same SOF event.

### Reckoner-style example

The Reckoner (or any other periodic apparatus) wires its tick
through Clockworks rather than maintaining its own scheduler:

```json
{
  "clockworks": {
    "standingOrders": [
      { "schedule": "@every 30s", "run": "reckoner-tick" }
    ]
  }
}
```

### Kit-contributed defaults

Apparatuses and standalone kits may ship default standing orders by
contributing a `standingOrders` array on their `ClockworksKit`. Each
kit's contribution is validated with the source-aware standing-order
validator at apparatus boot and sealed into a closure-scoped layer for
the life of the apparatus.

```typescript
import type { ClockworksKit } from '@shardworks/clockworks-apparatus';

export default {
  recommends: ['clockworks'],
  standingOrders: [
    { schedule: '@every 30s', run: 'reckoner-tick' },
  ],
} satisfies ClockworksKit;
```

The kit layer is merged additively with the operator-defined
`clockworks.standingOrders` slice on every dispatch and schedule pass:

```
effective list = [...kit, ...operator]
```

There is no id, no override, no disable, and no collision detection
— identical entries from two sources simply produce two dispatches.
Operator hot-edits to `guild.json` continue to land on the next
`processEvents` call without restart; updating a kit-contributed
default requires an apparatus restart (matching the existing
schedule-table lifecycle).

A malformed kit contribution fails the apparatus boot loud with kit
attribution. A non-array contribution surfaces as
`clockworks: standingOrders kit "<pluginId>" contribution must be an
array, …`. A malformed entry surfaces through the source-aware
validator with a header reading `clockworks: invalid standing order in
kit "<pluginId>":` (or the pluralized form) and per-bullet lines that
read `standing order #N [kit "<pluginId>"]: …`. The operator-layer
validator path is untouched — its messages continue to read
`clockworks: invalid standing order in guild.json:` so existing
operator-facing diagnostics are byte-for-byte preserved.

#### `clockworks.timer` payload — `source` and per-source `orderIndex`

Every scheduled fire writes a `clockworks.timer` event carrying:

```typescript
{
  standingOrder: { /* verbatim from the contributing source */ },
  orderIndex: 0,         // position within `source`'s OWN array
  source: 'demo-kit',    // null for operator entries, pluginId for kit entries
  fireTime: '2026-04-25T17:30:00.000Z'
}
```

`orderIndex` is per-source so the operator's mental model of "the
#N-th order in `guild.json`" stays stable when kit defaults change.
The scalar `source` field disambiguates kit-sourced fires from
operator-sourced fires when the same `orderIndex` would otherwise
collide.

The dispatcher's relay-not-registered error message and the
scheduler's boot-time schedule-parse error both attribute the
contributing kit when applicable.

---

## CDC auto-wiring

`book.<ownerId>.<book>.<verb>` events are owned by the
`clockworks-stacks-signals` bridge plugin — see its
[README](../clockworks-stacks-signals/README.md) and
[apparatus contract](../../../docs/architecture/apparatus/clockworks-stacks-signals.md).

---

## Framework events

`start()` registers a CDC observer on `clerk/writs` that fires exactly
one `writ.<type>.<status>` event per writ status transition, using the
writ's `phase` verbatim as the suffix. The contract is universal —
every type, every state, every transition (including initial entry
into the type's initial state and entry into `cancelled`) fires its
own row. Metadata-only patches (title rename, codex inheritance, etc.)
emit nothing because the per-update phase-delta gate suppresses them.

For the builtin `mandate` type the concrete vocabulary is
`writ.mandate.new`, `writ.mandate.open`, `writ.mandate.stuck`,
`writ.mandate.completed`, `writ.mandate.failed`, and
`writ.mandate.cancelled`. Plugin-registered types contribute their
own state list to the universal pattern.

Every payload carries `{ writId, writType, phase, commissionId, title,
parentId? }` — `commissionId` is derived at emit time by walking
`parentId` to the root, so there is no `commissionId` column on
`WritDoc`. All emissions go through the shared `emit()` write path
with `emitter: 'framework'` and are wrapped in best-effort `try/catch`:
a Clockworks failure cannot roll back the originating writ transition.

A fresh `start()` writes nothing to the events book of its own — the
legacy boot-time `guild.initialized` and per-book `migration.applied`
emissions were removed in C2. See [Event Catalog → Renamed/removed in
this release](../../../docs/reference/event-catalog.md#renamedremoved-in-this-release)
for the full migration table from the legacy `commission.*`,
`schedule.fired`, and `standing-order.failed` vocabulary.

## Tools

- `signal` — anima-facing event emission. Validates the proposed event
  name against the three rule layers above and delegates to
  `ClockworksApi.emit` with `emitter` defaulting to `'anima'`.
  `callableBy: ['anima']` — patron callers go through `nsg signal`
  instead.
- `clock-status` — anima-facing read of the Clockworks daemon status.
  Parameterless. Returns `{ running, pid?, logFile?, uptime?,
  stalePidfile? }` — the same payload shape as `nsg clock status
  --json`. `callableBy: ['anima']` — patron callers go through `nsg
  clock status` instead.

---

## Stdlib relays

### `summon-relay`

The bridge between event dispatch and anima sessions. Wired into
`supportKit.relays` so every guild gets it for free. Drive it from a
standing order:

```json
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "writ.mandate.open",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "Read your writ. Title: {{writ.title}}",
          "maxSessions": 5
        }
      }
    ]
  }
}
```

`with:` parameters:

- `role` *(required)* — the role to summon, must already be registered
  with the Loom (declared under `loom.roles` in `guild.json` or
  contributed by a kit).
- `prompt` *(required)* — a `{{path.with.dots}}` mustache template. The
  recognized namespaces are `writ.*` (always populated, real or
  synthetic), `event.*` (id / name / payload / emitter / firedAt), and
  `params.*` (every `with:` key other than `role`, `prompt`,
  `maxSessions`). Any path that resolves to `undefined` throws — silent
  empty-string substitution would hide operator drift.
- `maxSessions` *(optional, default `10`)* — per-writ circuit breaker.
  Once that many sessions have launched against the same writ, the next
  invocation transitions the writ to `'failed'` (with a resolution
  string identifying the relay) and returns cleanly without launching
  another session. Set to `0` to disable; negative values throw.

Writ binding: when `event.payload.writId` is a string, the relay
fetches the writ via the Clerk and exposes it as `writ.*`. Otherwise
it synthesizes an in-memory writ from the event payload — the
synthetic writ is **never persisted**, and the circuit breaker is
bypassed entirely for it (synthetic writs have no durable identity to
count against).

Session metadata recorded on every launched session:

```json
{
  "trigger": "summon-relay",
  "role": "<role>",
  "writId": "<real or syn-* id>",
  "eventId": "<triggering event id>",
  "eventName": "<triggering event name>"
}
```

The handler awaits `AnimateHandle.result` before returning, so the
dispatcher's `event_dispatches` row reflects real session runtime.

---

## CLI

```sh
nsg signal <name> [--payload '<json>']
nsg clock list [--include-processed] [--limit <n>]
nsg clock tick [id]
nsg clock run
nsg clock start [--interval <ms>] [--foreground|-f]
nsg clock stop
nsg clock status [--json]
```

The hand-written `nsg signal` command shares the same validator path as
the `signal` tool — both surfaces resolve the running guild's
Clockworks apparatus and call `ClockworksApi.validateSignal(name)`
before emitting. The CLI hardcodes `'operator'` as the emitter; the
`--payload` flag accepts a JSON string; omit it to record a `null`
payload.

`nsg clock` is the operator surface for the event queue:

- `nsg clock list` — print pending events in id order. With
  `--include-processed`, processed events are included too. `--limit N`
  caps the output; without it, every matching event prints.
- `nsg clock tick [id]` — process a single event. Without an id, the
  next pending event in id order; with an id, the matching event after
  a CLI-side pre-check that it exists and is still pending.
- `nsg clock run` — loop `processEvents()` until the queue drains. No
  sleep, no daemon — finite drain. Mid-sweep arrivals are picked up on
  the next iteration.
- `nsg clock start` — **advanced/standalone path.** Start a dedicated
  Clockworks daemon as a detached background process. `--interval <ms>`
  sets the polling interval (default 2000); `--foreground`/`-f` is the
  inline body the detached spawn re-execs into and is normally not
  invoked directly. Refuses when the unified guild daemon (`nsg start`)
  is already hosting the Clockworks loops. The detached path blocks
  until the pidfile is present and the named pid is alive (~10s
  deadline) so "started" means "verified running".
- `nsg clock stop` — graceful SIGTERM with SIGKILL escalation after a
  5s grace window. Removes the pidfile once the process is confirmed
  dead. When Clockworks is hosted by the unified guild daemon, prints
  an informative message and exits zero — use `nsg stop` instead.
- `nsg clock status` — show whether the daemon is running, with pid,
  host (`standalone` or `guild-daemon`), log file path, and uptime.
  `--json` emits the structured payload. When the pidfile points at a
  dead pid, the command surfaces `stalePidfile: true` and unlinks the
  pidfile as a side effect; the next call is silent.

`tick` and `run` print one summary line per dispatch — `[<handler>]
<status> <durationMs>ms`, with `: <error>` appended on the same line
for failed dispatches — and exit nonzero when at least one dispatch
recorded `status: error`. When the daemon is up, `tick` and `run`
emit a one-line coexistence warning to stderr (the manual invocation
runs concurrently with the daemon, so relays may be invoked more
than once for overlapping events) and execute regardless.

The canonical Clockworks host is the unified guild daemon (`nsg
start`): one pidfile (`daemon.pid`), one log stream, one shutdown
signal. The standalone `nsg clock start` daemon uses a separate
pidfile (`clock.pid`) and log file (`clock.log`); conflict guards
(D3/D4) prevent both from running their tick loops concurrently.

---

## Daemon

The unattended Clockworks daemon is a long-running process that polls
the events book and drains dispatches automatically. Use it once a
guild's standing-order set is trusted enough to run without an
operator at the keyboard.

### Lifecycle

The detached path (`nsg clock start` / `clockStart(home, options?)`)
spawns the same `nsg` binary with `clock start --foreground
--guild-root <home>` plus `--interval <ms>` if supplied, fully
detached from the parent terminal, and pipes both stdout and stderr
to a single append-mode log file. The detached spawn calls
`child.unref()` so closing the parent terminal does not take the
daemon down. Startup blocks until the pidfile is present and the
named pid is alive — failure tails the log to help debugging.

`clockStart` refuses to run when a daemon is already recorded by a
live pidfile and throws with an "already running" message; the
operator-visible `nsg clock start` exits nonzero in that case. A
stale pidfile (the named pid is dead) is cleaned up as a side effect
and a fresh spawn proceeds.

`clockStop` is the dual: it gracefully handles the missing-pidfile
and stale-pidfile cases as exit-zero outcomes (the result carries a
`reason: 'no-pidfile' | 'stale'` plus a human-readable message)
rather than treating them as errors. Only the `'signaled'` branch
actually sends SIGTERM (and escalates to SIGKILL after a short grace
window). The CLI surface, `nsg clock stop`, prints the message and
exits zero in every non-signaling branch — there is nothing to fail
when there is nothing to stop.

The foreground body is the inline daemon loop: writes `clock.pid`
with its own pid, registers SIGTERM/SIGINT handlers, calls
`processEvents` every interval (full drain — no per-tick cap),
catches every throw and writes an `[error] ...` line to the log
before continuing on the next interval, and sleeps abortably between
ticks so SIGTERM is acted on immediately.

On signal, the loop exits, the pidfile is unlinked, and the daemon's
async `onShutdown` runs to completion before the process exits. When
the foreground body is wired through `runForegroundDaemonFromGuild`
with a `StartedGuild` reference, that hook is where Arbor's
`StartedGuild.shutdown()` runs — firing `guild:shutdown` and walking
every started apparatus's optional `stop()` in reverse topological
order — before the eventual `process.exit(0)`.

### Files

- `<home>/.nexus/clock.pid` — the pidfile. Written at daemon start;
  removed on graceful shutdown. A dead pid surfaces as
  `stalePidfile: true` and is unlinked as a side effect of
  `clockStatus`.
- `<home>/.nexus/clock.log` — the append-mode log file. Both stdout
  and stderr land here. Combined into a single file so operators can
  grep one place.

### Log shape

Banners frame the daemon's lifetime. Per-dispatch lines appear on
active ticks; idle ticks are silent.

```
[clockworks] daemon started — pid=12345 intervalMs=2000 log=/.../clock.log
2026-04-25T17:30:00.000Z e-aaa demo.thing-happened [log-event] success 12ms
2026-04-25T17:30:00.001Z e-aaa demo.thing-happened [notify-channel] error 4ms: kaboom
2026-04-25T17:30:05.123Z [error] processEvents threw: <reason>
[clockworks] SIGTERM received — shutting down
[clockworks] daemon stopped
```

### Daemon coexistence

The Clockworks daemon and the manual `nsg clock tick` / `nsg clock
run` commands coexist intentionally. The dispatch sweep
(read-pending → invoke → patch-processed) is not atomic across
processes: when a manual invocation overlaps the daemon, both can
see the same unprocessed events, so a relay may be invoked more than
once for the same event. Substrate-level row locking is intentionally
deferred; the contract is upheld by relay-author idempotency (see
[Authoring relays](#authoring-relays) and the
[Building Relays guide](../../../docs/guides/building-relays.md#best-practices)).
When the daemon is up, manual invocations emit a one-line coexistence
warning to stderr and then execute regardless. The patron and anima
can probe daemon liveness via `nsg clock status` and the
`clock-status` MCP tool respectively.

---

## Books

- `clockworks/events` — one document per emitted event. Indexes:
  `name`, `processed`, `firedAt`, and the composite
  `(processed, firedAt)`.
- `clockworks/event_dispatches` — one document per handler invocation
  triggered by an event. Indexes: `eventId`, `status`, and the
  composite `(eventId, status)`. Written by `processEvents()` — one
  row per matching standing order, with `status: 'success' | 'error'
  | 'skipped'` set after the dispatcher settles. The `'skipped'`
  variant covers loop-guard policy suppression (the relay was not
  invoked because the triggering event was itself a
  `clockworks.standing-order.failed`); skipped rows carry their reason
  in the `error` column with a `loop-guard:` prefix and do not count
  toward the `errors` summary counter.

Both are owned by plugin id `clockworks`.

---

## Authoring relays

A relay is a named event-handler function the Clockworks dispatches
to when a standing order's `run:` field matches. Use the `relay()`
factory to define one and contribute it under a kit's `relays` field:

```typescript
import { relay } from '@shardworks/clockworks-apparatus';

export default {
  relays: [
    relay({
      name: 'log-event',
      description: 'Write the event to stdout.',
      handler: async (event, { home, params }) => {
        console.log(`[${home}] ${event.name}`, event.payload, params);
      },
    }),
  ],
};
```

Relays may be sync or async — the dispatcher always awaits. Failure is
signalled by throwing; return values are ignored. The `relay()` factory
validates `name` and `handler` fail-loud at module load: a missing or
malformed relay throws synchronously rather than silently registering a
broken handler.

### Registry semantics

The registry merges relays from every standalone kit's `relays`
contribution and from the apparatus's own `supportKit.relays`. On
duplicate names, the **first writer wins** and a warning is logged in
the lattice format:

```
[clockworks] Kit "<pluginId>" relays: relay name "<name>" is already
registered by kit "<existing>" — duplicate skipped.
```

Standalone kits are wired ahead of apparatus supportKits, so a user kit
can override a stdlib relay simply by registering one with the same
name. Malformed contributions (a non-array `relays` field, or an
individual entry that fails `isRelayDefinition`) are warn-and-skip —
they cannot crash startup.

The registry is rebuilt from scratch on every `start()` call so a future
daemon-restart cycle stays idempotent.

---

## Exports

- `createClockworks` — apparatus factory.
- `signal` — the anima-facing event emission tool. The
  operator-facing `nsg clock list/tick/run` surface lives in the
  framework CLI as a hand-written command (see
  `packages/framework/cli/src/commands/clock.ts`).
- `clockStatusTool` — the anima-facing `clock-status` tool. Wired
  into `supportKit.tools` alongside `signal`; re-exported so tests
  can drive it directly.
- `clockStart`, `clockStop`, `clockStatus` — the unattended-daemon
  lifecycle helpers. `clockStart(home, options?)` spawns the daemon
  detached and throws if a live daemon is already running.
  `clockStop(home)` sends SIGTERM (with SIGKILL escalation) when a
  daemon is alive and otherwise returns a non-error result with
  `reason: 'no-pidfile' | 'stale'` so callers can surface the message
  and exit zero. `clockStatus(home)` reads the pidfile and reports
  `{ running, pid?, logFile?, uptime?, stalePidfile? }`.
- `runForegroundDaemon`, `runForegroundDaemonFromGuild` — the inline
  foreground daemon body. `runForegroundDaemon` accepts every
  dependency by parameter so tests can drive the loop without
  spawning a child or booting a Stacks-backed apparatus;
  `runForegroundDaemonFromGuild` is the convenience wrapper the
  CLI's `clock start --foreground` re-exec target calls.
- `formatDispatchLogLine`, `validateInterval` — pure helpers used by
  the daemon and re-exported so the CLI can share validation /
  formatting without duplicating it.
- `relay`, `isRelayDefinition` — relay SDK factory and structural type guard.
- `createSummonRelay` — factory for the stdlib `summon-relay`. Already
  wired into `supportKit.relays`; re-exported so unit tests and any
  downstream tooling that needs to drive the relay directly can pull
  it without reaching into the package's internals.
- `validateStandingOrders`, `ALLOWED_STANDING_ORDER_KEYS` — the shared
  standing-order load-time validator and its allowlist of permitted
  top-level keys.
- Types: `ClockworksApi`, `ClockworksKit`, `ClockworksConfig`,
  `EventSpec`, `EventsKitContribution`, `MergedEventEntry`,
  `StandingOrder`, `EventDoc`, `EventDispatchDoc`, `RelayDefinition`,
  `RelayContext`, `GuildEvent`, `ClockStartOptions`,
  `ClockStartResult`, `ClockStopResult`, `ClockStatus`,
  `ForegroundDaemonInputs`.

The signal validator does not ship as a standalone helper or as
hardcoded namespace / suffix constants. `ClockworksApi.validateSignal(name)`
on the running apparatus is the single canonical entry point, and the
authoritative event set is assembled from kit contributions plus
`guild.json` at start time.
- The module augments `GuildConfig` with `clockworks?: ClockworksConfig`.

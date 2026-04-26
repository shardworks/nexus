# `@shardworks/clockworks-apparatus`

The Clockworks — Pillar 5 of the guild architecture. The event substrate
and standing-order engine: declares events, accepts emissions, and fans
them out to registered handlers (relays, summons, briefs).

**Status:** Write path, event-triggered dispatcher, CDC auto-wiring,
the manual operator CLI, framework-event emission from real
lifecycle activity, the unattended Clockworks daemon, AND the
time-driven scheduler are all live. The Clockworks exposes
`ClockworksApi.emit` for trusted framework callers, a validated
`signal` tool for animas (with an operator-facing `nsg signal` CLI
counterpart), `ClockworksApi.processEvents()` — the bulk-drain
dispatcher that resolves matching standing orders, invokes their
relays, persists one dispatch row per invocation, and flips the
event's `processed` flag — `ClockworksApi.processSchedules()` — the
scheduler pass that fires every time-driven standing order whose
`nextFireTime` has elapsed and synthesizes a `schedule.fired` event
plus a dispatch row per fire — and, at startup, registers a Phase-2
CDC watcher on every plugin-declared book (other than
`clockworks/events` itself) that re-emits each row
create/update/delete as a `book.<ownerId>.<book>.<verb>` event with
emitter `'framework'`. Startup also registers a CDC observer on
`clerk/writs` that emits writ-lifecycle
(`{type}.{ready|completed|stuck|failed}`) and root-mandate
`commission.*` events as writs transition, and emits a one-shot
`guild.initialized` the first time a guild comes up. The
operator-facing `nsg clock list/tick/run` CLI composes on top of
`processEvents()`. The daemon (`nsg clock start/stop/status`,
plus the matching `clockStart` / `clockStop` / `clockStatus` core
API and the anima-callable `clock-status` MCP tool) polls the events
queue at a configurable interval, runs the scheduler pass before
each event-processing pass, and drains dispatches without an
operator at the keyboard.

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

Names that match a reserved framework namespace
(`anima.`, `commission.`, `tool.`, `migration.`, `guild.`,
`standing-order.`, `session.`, `schedule.`) or a writ-lifecycle
pattern (`<type>.{ready,completed,stuck,failed}` for any declared
writ type) are owned by the framework and cannot be emitted via
`signal`.

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
emits a `standing-order.failed` event into the `events` book with
`emitter: 'framework'`. The payload carries the verbatim standing
order, an `{id, name}` projection of the triggering event, and the
same error string written to the dispatch row's `error` column:

```typescript
{
  name: 'standing-order.failed',
  emitter: 'framework',
  payload: {
    standingOrder: { on, run, with? },
    triggeringEvent: { id, name },
    error: '<message>'
  }
}
```

Guilds can wire standing orders against `standing-order.failed` to
react to failures (notify the patron, summon a steward, etc.). A
loop guard prevents cascade: when the dispatcher processes an event
whose `payload.triggeringEvent.name` is `'standing-order.failed'`
(i.e. a second-generation SOF), every matching standing order is
recorded as a `'skipped'` dispatch row, the relay is not invoked,
and no fresh `standing-order.failed` event is emitted.

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
   `schedule.fired` event row with `processed: true` (so the
   event-sweep does not re-fire it), invokes the resolved relay with
   a synthesized `GuildEvent`, persists a dispatch row through the
   shared helper, and advances `nextFireTime` from the parser.
3. Returns counts: `{ fired, errors }`.

In-tick guard: at most one fire per order per tick, even if many
intervals have elapsed (e.g. a stalled tick or a paused process).
The scheduler catches up over subsequent ticks, one fire at a time.

Failure isolation matches the dispatcher:

- A thrown relay produces an `error` dispatch row and a
  `standing-order.failed` event via the same SOF callback the
  dispatcher uses — subscribers wiring
  `{ on: 'standing-order.failed', run: ... }` see scheduled-fire
  failures and event-driven failures uniformly.
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

---

## CDC auto-wiring

At `start()`, the Clockworks walks every `books` kit contribution
collected during the Wire phase and registers a Phase-2 (post-commit)
Stacks CDC watcher on each declared book. Every `create` / `update` /
`delete` becomes one row in `clockworks/events`:

- `name`    — `book.<ownerId>.<book>.<created|updated|deleted>`
- `emitter` — the literal string `'framework'`
- `payload` — the Stacks CDC event object verbatim

Standing orders can therefore bind to row mutations directly without
each plugin author having to call `emit()` or `signal()` from every
write site.

The `clockworks/events` book is the only book excluded from
auto-wiring. The carve-out is an *architectural boundary* — auto-wiring
the events book would re-emit every emission as a `book.clockworks.
events.created` event, polluting the framework event stream with
self-feedback that has no consumer. The Stacks substrate now enforces
a Phase-2 cross-transaction re-entry depth bound that would terminate
any runaway chain at 16 hops, so the carve-out is no longer the
load-bearing safety net it once was — but it stays in place to keep
the events book free of self-feedback in the first place. Future
maintainers: do not remove the carve-out on the assumption that the
substrate now covers it. Everything else, including
`clockworks/event_dispatches`, is auto-wired. Books contributed by
plugins installed *after* `start()` are not picked up; the registry
seals at `phase:started`.

Auto-wiring runs as Phase 2 (`failOnError: false`), so an
emit-handler error cannot roll back the triggering row write — Stacks'
existing Phase-2 error path logs the failure and the system keeps
going.

---

## Framework events

`start()` registers a CDC observer on `clerk/writs` that produces:

- `{type}.{ready|completed|stuck|failed}` for every writ on entry into
  the corresponding phase. Transitions into `new` (drafts) and
  `cancelled` are silent — the catalog has no entries for those
  phases. Stuck → open re-entry re-emits `{type}.ready` so dispatchers
  see the writ as available again.
- For root mandates only (`type === 'mandate'` AND no `parentId`):
  `commission.posted` on entry into `open`,
  `commission.state.changed` on every phase change, both
  `commission.sealed` AND `commission.completed` on entry into
  `completed`, and `commission.failed` on entry into `failed`.

Every payload carries a `commissionId` derived at emit time by walking
`parentId` to the root — there is no `commissionId` column on
`WritDoc`. All emissions go through the shared `emit()` write path with
`emitter: 'framework'` and are wrapped in best-effort `try/catch`: a
Clockworks failure cannot roll back the originating writ transition.

`start()` also queries the `events` book for any prior
`guild.initialized` row and emits one if absent. The persisted row is
the first-boot marker — subsequent boots find it and skip.

`start()` also walks every `books` kit contribution and emits one
`migration.applied` event per `(pluginId, book)` pair the first time
each is observed (idempotency keyed off the events book itself, like
`guild.initialized`). The catalog defines this event by name only; the
chosen payload is `{ pluginId, book, indexes }`. First boot fires one
event per declared book; subsequent boots fire only for newly-introduced
books.

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
        "on": "mandate.ready",
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

The hand-written `nsg signal` command shares the same three-layer
validation as the `signal` tool but passes `'operator'` as the emitter
(per commission decision D4). The `--payload` flag accepts a JSON
string; omit it to record a `null` payload.

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
- `nsg clock start` — start the unattended Clockworks daemon as a
  detached background process. `--interval <ms>` sets the polling
  interval (default 2000); `--foreground`/`-f` is the inline body the
  detached spawn re-execs into and is normally not invoked directly.
  The detached path blocks until the pidfile is present and the named
  pid is alive (~10s deadline) so "started" means "verified running".
- `nsg clock stop` — graceful SIGTERM with SIGKILL escalation after a
  5s grace window. Removes the pidfile once the process is confirmed
  dead.
- `nsg clock status` — show whether the daemon is running, with pid,
  log file path, and uptime. `--json` emits the structured payload.
  When the pidfile points at a dead pid, the command surfaces
  `stalePidfile: true` and unlinks the pidfile as a side effect; the
  next call is silent.

`tick` and `run` print one summary line per dispatch — `[<handler>]
<status> <durationMs>ms`, with `: <error>` appended on the same line
for failed dispatches — and exit nonzero when at least one dispatch
recorded `status: error`. When the daemon is up, `tick` and `run`
emit a one-line coexistence warning to stderr (the manual invocation
runs concurrently with the daemon, so relays may be invoked more
than once for overlapping events) and execute regardless.

The two daemons (`nsg start` for the guild daemon and `nsg clock
start` for the Clockworks daemon) are independent: different pidfiles
(`daemon.pid` vs `clock.pid`), different log files, and different
lifecycles.

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
  `standing-order.failed`); skipped rows carry their reason in the
  `error` column with a `loop-guard:` prefix and do not count toward
  the `errors` summary counter.

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
- `validateSignal`, `RESERVED_EVENT_NAMESPACES`,
  `WRIT_LIFECYCLE_SUFFIXES` — the shared signal validator (re-used by
  the framework CLI's hand-written `nsg signal` command).
- `validateStandingOrders`, `ALLOWED_STANDING_ORDER_KEYS` — the shared
  standing-order load-time validator and its allowlist of permitted
  top-level keys.
- Types: `ClockworksApi`, `ClockworksKit`, `ClockworksConfig`,
  `EventDeclaration`, `StandingOrder`, `EventDoc`, `EventDispatchDoc`,
  `RelayDefinition`, `RelayContext`, `GuildEvent`, `ClockStartOptions`,
  `ClockStartResult`, `ClockStopResult`, `ClockStatus`,
  `ForegroundDaemonInputs`.
- The module augments `GuildConfig` with `clockworks?: ClockworksConfig`.

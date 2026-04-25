# `@shardworks/clockworks-apparatus`

The Clockworks — Pillar 5 of the guild architecture. The event substrate
and standing-order engine: declares events, accepts emissions, and fans
them out to registered handlers (relays, summons, briefs).

**Status:** Write path, event-triggered dispatcher, CDC auto-wiring,
and the manual operator CLI are live. The Clockworks exposes
`ClockworksApi.emit` for trusted framework callers, a validated
`signal` tool for animas (with an operator-facing `nsg signal` CLI
counterpart), `ClockworksApi.processEvents()` — the bulk-drain
dispatcher that resolves matching standing orders, invokes their
relays, persists one dispatch row per invocation, and flips the
event's `processed` flag — and, at startup, registers a Phase-2 CDC
watcher on every plugin-declared book (other than `clockworks/events`
itself) that re-emits each row create/update/delete as a
`book.<ownerId>.<book>.<verb>` event with emitter `'framework'`. The
operator-facing `nsg clock list/tick/run` CLI composes on top of
`processEvents()`. The unattended daemon and cron scheduling are
still to come.

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
writ-type registry the `signal` validator consults.

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
`standing-order.`, `session.`) or a writ-lifecycle pattern
(`<type>.{ready,completed,stuck,failed}` for any declared writ type)
are owned by the framework and cannot be emitted via `signal`.

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

### `ClockworksApi.processEvents(): Promise<{ processedEvents, dispatches, errors }>`

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

Returned counts:

- `processedEvents` — events whose `processed` flag was flipped this sweep.
- `dispatches` — total dispatch rows written across every event.
- `errors` — subset of those rows whose `status` is `'error'`.

Sequential, single-pass — no scheduling, no parallelism, no retry. The
CLI wrapper, daemon, and cron loop compose on top of this primitive.

---

## Standing orders

Standing orders live under `clockworks.standingOrders` in `guild.json`.
The canonical shape is:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "demo.thing-happened", "run": "log-event" },
      {
        "on": "code.reviewed",
        "run": "notify-channel",
        "with": { "channel": "#reviews", "level": "info" }
      }
    ]
  }
}
```

Each order names exactly one event (`on:`) and exactly one relay to
invoke (`run:`); an optional `with:` block is forwarded to the relay
handler as `RelayContext.params`. Anything else — extra top-level
keys, a non-object `with:`, the dropped `summon:` / `brief:` sugar
forms — is rejected at load time with a descriptive error.

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
auto-wiring — watching it would observe its own emit() write and
re-emit forever. Everything else, including `clockworks/event_dispatches`,
is auto-wired. Books contributed by plugins installed *after*
`start()` are not picked up; the registry seals at `phase:started`.

Auto-wiring runs as Phase 2 (`failOnError: false`), so an
emit-handler error cannot roll back the triggering row write — Stacks'
existing Phase-2 error path logs the failure and the system keeps
going.

---

## Tools

- `signal` — anima-facing event emission. Validates the proposed event
  name against the three rule layers above and delegates to
  `ClockworksApi.emit` with `emitter` defaulting to `'anima'`.
  `callableBy: ['anima']` — patron callers go through `nsg signal`
  instead.

---

## CLI

```sh
nsg signal <name> [--payload '<json>']
nsg clock list [--include-processed] [--limit <n>]
nsg clock tick [id]
nsg clock run
```

The hand-written `nsg signal` command shares the same three-layer
validation as the `signal` tool but passes `'operator'` as the emitter
(per commission decision D4). The `--payload` flag accepts a JSON
string; omit it to record a `null` payload.

`nsg clock` is the operator surface for the event queue (Phase 1 in
[`docs/architecture/clockworks.md`](../../../docs/architecture/clockworks.md)) —
manual control before the unattended daemon lands:

- `nsg clock list` — print pending events in id order. With
  `--include-processed`, processed events are included too. `--limit N`
  caps the output; without it, every matching event prints.
- `nsg clock tick [id]` — process a single event. Without an id, the
  next pending event in id order; with an id, the matching event after
  a CLI-side pre-check that it exists and is still pending.
- `nsg clock run` — loop `processEvents()` until the queue drains. No
  sleep, no daemon — finite drain. Mid-sweep arrivals are picked up on
  the next iteration. The persistent daemon arrives in a future
  commission.

`tick` and `run` print one summary line per dispatch — `[<handler>]
<status> <durationMs>ms`, with `: <error>` appended on the same line
for failed dispatches — and exit nonzero when at least one dispatch
recorded `status: error`.

---

## Books

- `clockworks/events` — one document per emitted event. Indexes:
  `name`, `processed`, `firedAt`, and the composite
  `(processed, firedAt)`.
- `clockworks/event_dispatches` — one document per handler invocation
  triggered by an event. Indexes: `eventId`, `status`, and the
  composite `(eventId, status)`. Written by `processEvents()` — one
  row per matching standing order, with `status: 'success' | 'error'`
  set after the relay settles.

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
- `relay`, `isRelayDefinition` — relay SDK factory and structural type guard.
- `validateSignal`, `RESERVED_EVENT_NAMESPACES`,
  `WRIT_LIFECYCLE_SUFFIXES` — the shared signal validator (re-used by
  the framework CLI's hand-written `nsg signal` command).
- `validateStandingOrders`, `ALLOWED_STANDING_ORDER_KEYS` — the shared
  standing-order load-time validator and its allowlist of permitted
  top-level keys.
- Types: `ClockworksApi`, `ClockworksKit`, `ClockworksConfig`,
  `EventDeclaration`, `StandingOrder`, `EventDoc`, `EventDispatchDoc`,
  `RelayDefinition`, `RelayContext`, `GuildEvent`.
- The module augments `GuildConfig` with `clockworks?: ClockworksConfig`.

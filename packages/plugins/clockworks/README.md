# `@shardworks/clockworks-apparatus`

The Clockworks — Pillar 5 of the guild architecture. The event substrate
and standing-order engine: declares events, accepts emissions, and fans
them out to registered handlers (relays, summons, briefs).

**Status:** Write path is live. The Clockworks now exposes
`ClockworksApi.emit` for trusted framework callers and a validated
`signal` tool for animas (with an operator-facing `nsg signal` CLI
counterpart). The dispatcher, the runner, CDC auto-wiring, and the
daemon are still to come — events land in the `events` book but nothing
reads them yet.

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

---

## Tools

- `signal` — anima-facing event emission. Validates the proposed event
  name against the three rule layers above and delegates to
  `ClockworksApi.emit` with `emitter` defaulting to `'anima'`.
  `callableBy: ['anima']` — patron callers go through `nsg signal`
  instead.
- `clock-status`, `clock-list` — CLI stubs that return
  `{ ok: false, message }`. Real implementations arrive with the runner
  / dispatcher commissions.

---

## CLI

```sh
nsg signal <name> [--payload '<json>']
```

The hand-written `nsg signal` command shares the same three-layer
validation as the `signal` tool but passes `'operator'` as the emitter
(per commission decision D4). The `--payload` flag accepts a JSON
string; omit it to record a `null` payload.

---

## Books

- `clockworks/events` — one document per emitted event. Indexes:
  `name`, `processed`, `firedAt`, and the composite
  `(processed, firedAt)`.
- `clockworks/event_dispatches` — one document per handler invocation
  triggered by an event. Indexes: `eventId`, `status`, and the
  composite `(eventId, status)`. Reserved for the dispatcher / runner
  commissions; nothing writes to this book yet.

Both are owned by plugin id `clockworks`.

---

## Exports

- `createClockworks` — apparatus factory.
- `clockStatus`, `clockList`, `signal` — the registered tools.
- `validateSignal`, `RESERVED_EVENT_NAMESPACES`,
  `WRIT_LIFECYCLE_SUFFIXES` — the shared signal validator (re-used by
  the framework CLI's hand-written `nsg signal` command).
- Types: `ClockworksApi`, `ClockworksKit`, `ClockworksConfig`,
  `EventDeclaration`, `StandingOrder`, `EventDoc`, `EventDispatchDoc`.
- The module augments `GuildConfig` with `clockworks?: ClockworksConfig`.

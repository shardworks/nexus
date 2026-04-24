# `@shardworks/clockworks-apparatus`

The Clockworks — Pillar 5 of the guild architecture. The event substrate
and standing-order engine: declares events, accepts emissions, and fans
them out to registered handlers (relays, summons, briefs).

**This package is a skeleton.** It claims the plugin id (`clockworks`),
declares the two books (`events`, `event_dispatches`), registers the
`nsg clock` CLI namespace, and publishes the shared type surface —
**but has no runtime behavior yet**. Emission, dispatch, the `signal`
tool, the runner, CDC auto-wiring, and the daemon all arrive in later
commissions.

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

---

## Status

Skeleton only. Expect:

- `start()` resolves the Stacks apparatus and acquires handles on the
  two books, so downstream commissions can read/write them immediately.
- `stop()` is a no-op.
- `ClockworksApi` is an empty interface; downstream tasks extend it
  (task 3 adds `emit()`, etc.).
- `ClockworksKit` is an empty interface; the relay contribution shape
  is owned by task 2.
- The `nsg clock` namespace is claimed by two stub subcommands
  (`nsg clock status`, `nsg clock list`) that print a
  "not yet implemented" message.

---

## Books

- `clockworks/events` — one document per emitted event.
- `clockworks/event_dispatches` — one document per handler invocation
  triggered by an event.

Both are owned by plugin id `clockworks`.

---

## Exports

- `createClockworks` — apparatus factory.
- `clockStatus`, `clockList` — the two CLI stub tools.
- Types: `ClockworksApi`, `ClockworksKit`, `ClockworksConfig`,
  `EventDeclaration`, `StandingOrder`, `EventDoc`, `EventDispatchDoc`.
- The module augments `GuildConfig` with `clockworks?: ClockworksConfig`.

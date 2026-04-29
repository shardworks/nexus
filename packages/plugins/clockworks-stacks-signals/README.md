# `@shardworks/clockworks-stacks-signals-apparatus`

The Clockworks↔Stacks signals bridge — the dedicated home for the
cross-plugin observer-translator that surfaces every Stacks
change-data-capture (CDC) row mutation as a Clockworks
`book.<ownerId>.<book>.<verb>` event.

This bridge owns the auto-wiring that previously lived inside the
Clockworks apparatus. Behaviour, event names, payloads, and emitter
attribution are unchanged when the bridge is installed — Clockworks no
longer reaches into Stacks at startup.

See also:
[`docs/architecture/apparatus/clockworks-stacks-signals.md`](../../../docs/architecture/apparatus/clockworks-stacks-signals.md).

---

## Installation

```sh
pnpm add @shardworks/clockworks-stacks-signals-apparatus
```

Register the apparatus in `guild.json` alongside Stacks and Clockworks:

```json
{
  "plugins": [
    "@shardworks/stacks-apparatus",
    "@shardworks/clockworks-apparatus",
    "@shardworks/clockworks-stacks-signals-apparatus"
  ]
}
```

The bridge declares `requires: ['stacks', 'clockworks']`. There is no
`defaultPlugins` mechanism in the framework `nsg init` flow today; the
patron lists the bridge in `plugins` explicitly the same way they list
any other apparatus.

A guild that installs Stacks + Clockworks without the bridge gets the
`signal` validator and the standing-order engine but no `book.*`
events; standing orders bound to `book.*` names will silently
not-match. Install the bridge to restore the prior auto-wiring
behaviour.

---

## What the bridge does

At apparatus `start()`, the bridge:

1. Walks `ctx.kits('books')` — every plugin-declared book contributed
   during the framework's Wire phase.
2. Skips entries whose `value` is not a non-null object (silent-skip,
   matching Stacks' own `reconcileSchemas()` guard so divergent
   reactions to the same malformed contribution cannot occur).
3. Skips the `clockworks/events` book (the carve-out — see below).
4. Registers a Phase-2 (`failOnError: false`) Stacks CDC watcher on
   each remaining `(pluginId, bookName)` pair. The handler composes
   `book.${event.ownerId}.${event.book}.${verb}` from the delivered
   `ChangeEvent` (where verb maps create/update/delete to created/
   updated/deleted, and the book-level `delete-book` retirement event
   to `book-dropped`) and calls `clockworks.emit(name, event,
   'framework')`.

The bridge also contributes a function-form `events` kit that declares
the same `book.<owner>.<book>.<verb>` names it emits, so the merged
event set is in sync with the watcher's emit surface.

### Event shape

For every observed mutation:

| Field | Value |
|---|---|
| `name`    | `book.<ownerId>.<bookName>.<created\|updated\|deleted\|book-dropped>` |
| `emitter` | the literal string `'framework'` |
| `payload` | the Stacks `ChangeEvent` object verbatim |

The `book-dropped` verb fires once per `StacksApi.dropBook(...)` call,
even when the book held many rows — the substrate emits a single
book-level `delete-book` CDC event rather than per-row deletes
(consistent with the substrate's coalescing model). The payload for
`book-dropped` carries `{ type: 'delete-book', ownerId, book }` only.

### The carve-out

The `clockworks/events` book is the only book excluded from
auto-wiring. The carve-out is an *architectural boundary* —
auto-wiring the events book would pollute the framework event stream
with `book.clockworks.events.created` rows describing the very acts of
emission, which is feedback noise without a consumer. The Stacks
substrate now enforces a Phase-2 cross-transaction re-entry depth
bound (`MAX_PHASE2_REENTRY_DEPTH` in `stacks-core.ts`) that would
terminate any runaway loop, so the carve-out is no longer the
load-bearing safety net it once was — but it stays in place to keep
the events book free of self-feedback in the first place.

Future maintainers: do not remove the carve-out on the assumption that
the substrate now covers it. The two serve different purposes — the
substrate caps depth as a CPU-pin guard; the carve-out keeps the
events book free of self-feedback in the first place. Every other
book — including `clockworks/event_dispatches` — is auto-wired.

---

## Authoring standing orders against `book.*`

Standing orders bind to fully-qualified names; there is no wildcard
syntax in `on:`. Wire one standing order per book the operator cares
about:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "book.clerk.writs.updated", "run": "audit-writ-changes" }
    ]
  }
}
```

The bridge's function-form `events` kit declares each
`book.<owner>.<book>.<verb>` name, so the Clockworks's
`validateSignal` rejects anima `signal()` attempts on the same names
through the framework-owned check.

---

## Exports

- `createClockworksStacksSignals` — apparatus factory. The default
  export of the package is `createClockworksStacksSignals()` so the
  framework's plugin loader can pick it up directly.

The bridge has no `provides` — no consumer needs an API surface; the
bridge is opaque to other plugins.

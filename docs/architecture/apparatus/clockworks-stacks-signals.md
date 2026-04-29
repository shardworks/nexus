# The Clockworks↔Stacks Signals Bridge — API Contract

Status: **Draft**

Package: `@shardworks/clockworks-stacks-signals-apparatus` · Plugin id: `clockworks-stacks-signals`

---

## Purpose

The Clockworks↔Stacks signals bridge is the dedicated home for the cross-plugin observer-translator that surfaces every Stacks change-data-capture (CDC) row mutation as a Clockworks `book.<ownerId>.<book>.<verb>` event. The bridge is opaque to other plugins — it has no `provides` API surface and contributes nothing the patron interacts with directly. Its job is to translate observation events on one substrate (Stacks CDC) into emission events on another (Clockworks events).

The bridge does **not** own the `book.*` event contract — `book.*` events are part of the framework's substrate-observation surface and the emitter remains `'framework'`. The bridge is a relocation of *where* the auto-wiring registration happens, not a re-attribution of *who* the contract belongs to. This relocation gives the Clockworks↔Stacks relationship its own home, lets the bridge declare the `book.*` names as plugin-declared events (closing a spoofing-vector gap on the unprivileged signal surface), and establishes the observer-translator pattern as the template for future substrate observers (HTTP, filesystem, etc.).

---

## Dependencies

```
requires: ['stacks', 'clockworks']
consumes: ['books']
```

- **Stacks** — the bridge registers a Phase-2 (`failOnError: false`) CDC watcher per declared book via `stacks.watch(...)`.
- **Clockworks** — the bridge resolves `ClockworksApi` once in `start()` and routes every observed CDC event through `clockworks.emit(name, event, 'framework')`.

The bridge declares no `recommends`. Echoing Clockworks' `recommends` list (animator, loom) would create startup-warning noise without earning its keep — none of those apparatuses are reached from this bridge.

The bridge consumes the `books` kit contribution type (the same vocabulary Stacks publishes) so the framework's unconsumed-kit warning stays quiet.

---

## Support Kit

```typescript
supportKit: {
  // Function-form `events` kit contribution. Walks ctx.kits('books')
  // with the same silent-skip and carve-out the watcher loop applies
  // and enumerates `book.<owner>.<book>.<verb>` for the three verbs.
  // Mirrors the watcher's carve-out so the declared set equals the
  // emitted set.
  events: (ctx) => Record<string, EventSpec>,
},
```

The bridge contributes no books, no tools, and no relays. The single contribution is the `events` kit declaration that mirrors the watcher's emit surface. Closing the spoofing vector for `book.clockworks.events.*` (which the bridge does not declare and therefore does not mark framework-owned) is captured as a separate follow-up — the carve-out is preserved for parity with the watcher.

---

## How the bridge works

At apparatus `start()`:

```
  bridge.start(ctx)
    ├─ 1. Resolve dependencies once and capture in closure
    │     stacks      = guild().apparatus<StacksApi>('stacks')
    │     clockworks  = guild().apparatus<ClockworksApi>('clockworks')
    │
    ├─ 2. Walk ctx.kits('books')
    │     ├─ Silent-skip when entry.value is not a non-null object
    │     │   (mirrors Stacks' reconcileSchemas() guard so divergent
    │     │   reactions to the same malformed contribution cannot
    │     │   occur)
    │     └─ For each (pluginId, bookName) pair:
    │         ├─ Skip if pluginId === 'clockworks' && bookName === 'events'
    │         │   (the architectural-boundary carve-out — see below)
    │         └─ Register a Phase-2 (failOnError: false) watcher whose
    │            handler composes book.<event.ownerId>.<event.book>.<verb>
    │            from the delivered ChangeEvent and calls
    │            clockworks.emit(name, event, 'framework')
```

For every observed mutation:

| Field | Value |
|---|---|
| `name`    | `book.<ownerId>.<bookName>.<created\|updated\|deleted\|book-dropped>` |
| `emitter` | the literal string `'framework'` |
| `payload` | the Stacks `ChangeEvent` object verbatim |

`<owner>` and `<book>` are sourced from the delivered `ChangeEvent` (`event.ownerId`, `event.book`). At runtime they are equivalent to the captured registration values, but composing from the delivered event is more robust to future Stacks changes and matches the architecture-doc reference sketch.

The verb mapping is exhaustive across the four `ChangeEvent` variants:

| CDC variant | Past-tense verb |
|---|---|
| `create` | `created` |
| `update` | `updated` |
| `delete` | `deleted` |
| `delete-book` | `book-dropped` |

`book-dropped` (rather than bare `dropped`) disambiguates the book-level retirement verb from the row-level `deleted` verb in log lines. The `book-dropped` event fires once per `StacksApi.dropBook(...)` call, regardless of how many rows the dropped book held — the substrate emits a single book-level CDC event rather than per-row deletes, and the bridge translates it 1:1.

---

## Carve-out: `clockworks/events`

The `clockworks/events` book is the only book excluded from auto-wiring. The carve-out is an *architectural boundary* — auto-wiring the events book would pollute the framework event stream with `book.clockworks.events.created` rows describing the very acts of emission, which is feedback noise without a consumer.

The Stacks substrate now enforces a Phase-2 cross-transaction re-entry depth bound (`MAX_PHASE2_REENTRY_DEPTH` in `stacks-core.ts`) that would terminate any runaway loop, so the carve-out is no longer the load-bearing safety net it once was — the substrate is. Future maintainers: do not remove the carve-out on the assumption that the substrate now covers it. The two serve different purposes — the substrate caps depth as a CPU-pin guard; the carve-out keeps the events book free of self-feedback in the first place.

The carve-out predicate is a pair of literal-string comparisons — `entry.pluginId === 'clockworks' && bookName === 'events'`. Importing a constant from `@shardworks/clockworks-apparatus` would entangle the plugins for no behavioural gain.

The carve-out applies uniformly to every verb, including `book-dropped` — the events book never self-emits regardless of operation, so the declared and emitted sets stay in sync across the row-level and book-level verbs.

The events-kit function form mirrors the same carve-out so the declared set equals the emitted set — the bridge does not declare names it does not emit.

Every other book — including `clockworks/event_dispatches` — is auto-wired.

---

## Phase-2 isolation

The handler runs after the triggering transaction commits (`failOnError: false`). Emit-handler errors are logged via Stacks' Phase-2 error path (`[stacks] Phase 2 handler error (...)`) and do not roll back the primary write — observation is layered on top of the substrate, not gating it.

The bridge deliberately does **not** wrap the `clockworks.emit(...)` call in try/catch: Stacks' Phase-2 error path already logs the failure. Wrapping would either duplicate or mask that diagnostic.

The bridge deliberately does **not** normalize the `ChangeEvent` payload. There is no second consumer to earn a normalized projection; passthrough preserves all available context.

---

## Registration timing

Registration MUST happen here in `start()`, because the Stacks CDC registry seals at the framework's `phase:started` signal — no later registration is possible. The bridge's `requires: ['stacks', 'clockworks']` ensures both dependencies have started before the bridge's own `start()` runs; the framework's start-order gate guarantees the `ctx.kits('books')` snapshot is fully assembled by then.

Books contributed by plugins installed *after* `phase:started` are not picked up. This matches the prior behaviour when the auto-wiring lived inside Clockworks.

---

## Installation

There is no `defaultPlugins` mechanism in the framework `nsg init` flow today; the bridge does not auto-attach to fresh guilds. The patron lists the bridge in `guild.json` `plugins` explicitly the same way they list any other apparatus:

```json
{
  "plugins": [
    "@shardworks/stacks-apparatus",
    "@shardworks/clockworks-apparatus",
    "@shardworks/clockworks-stacks-signals-apparatus"
  ]
}
```

A guild that installs Stacks + Clockworks without the bridge gets the `signal` validator and the standing-order engine but no `book.*` events; standing orders bound to `book.*` names will silently not-match. Install the bridge to restore the prior auto-wiring behaviour.

---

## Future: observer-translator pattern

The bridge is the first concrete instance of an observer-translator pattern that should generalize to other substrates. Future bridges (HTTP, filesystem, external message queues, etc.) follow the same shape: a thin apparatus that `requires` both the substrate (the source of observations) and Clockworks (the emit target), with a `start()` that walks the substrate's registration surface and routes observations through `clockworks.emit(..., 'framework')` with no try/catch and no payload normalization. The bridge has no `provides` and is opaque to other plugins; substrate-specific behaviour stays in the substrate, and observer-translator behaviour stays in the bridge.

A second observation captured but deferred: closing the spoofing vector on `book.clockworks.events.*` requires either (a) adding a deny-list contribution shape to the Clockworks events kit so a plugin can claim a name as framework-owned without also emitting it, or (b) declaring the carved-out names in the events kit and accepting that a `validateSignal('book.clockworks.events.created')` rejection message will reference an event the bridge does not actually emit. Both options have rough edges; the choice is deferred until a real-world spoofing report makes it concrete.

# Event Catalog

The Clockworks event system — every framework event, custom event rules, CDC events, and standing-order wiring. This document is the canonical reference for the framework event surface; payload shapes shown here match the shipped emitter code.

---

## Framework Events

Framework events are emitted by core modules and the Clockworks runner. They use [reserved namespaces](#reserved-namespaces) (`anima.`, `commission.`, `tool.`, `migration.`, `guild.`, `standing-order.`, `session.`, `schedule.`) and **cannot** be signalled by animas via the `signal` tool. Writ lifecycle events (`{type}.ready`, etc.) are also framework-only but live outside the reserved-namespace list — see [Writ Lifecycle Events](#writ-lifecycle-events) for how validation handles that.

Payload shapes use inline records `{ field, optional? }` where `?` marks an optional field.

### Commission Events

Emitted by the writ-lifecycle observer in `clockworks/src/writ-lifecycle-observer.ts` for **root mandates only** — a writ with `type === 'mandate'` and no `parentId`. The shared payload base is `{ commissionId, writId, phase, title }`.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `commission.posted` | `{ commissionId, writId, phase, title }` | `framework` | A root mandate enters `open` phase — direct creation in `open`, `new → open` via `writ-publish`, or `stuck → open` re-entry |
| `commission.state.changed` | `{ commissionId, writId, phase, title, previousPhase? }` | `framework` | Any phase change on a root mandate. `previousPhase` is present on update events; on the initial create event there is no prior phase to record |
| `commission.sealed` | `{ commissionId, writId, phase, title }` | `framework` | A root mandate enters `completed` phase. **Fires alongside `commission.completed`** — both names are emitted from the same transition; pick one to subscribe to |
| `commission.completed` | `{ commissionId, writId, phase, title }` | `framework` | A root mandate enters `completed` phase. **Fires alongside `commission.sealed`** — both names are emitted from the same transition; pick one to subscribe to |
| `commission.failed` | `{ commissionId, writId, phase, title, resolution? }` | `framework` | A root mandate enters `failed` phase. `resolution` is present when the writ records a resolution string |
| `commission.session.ended` | `{ sessionId, anima?, trigger?, exitCode?, durationMs?, costUsd?, error?, commissionId }` | `framework` | A session whose `metadata.writId` chains to a root mandate completes. Co-emitted alongside `session.ended` only when the chain resolves |

**`commission.posted`** is the primary entry point for the commission pipeline. The framework also emits a `mandate.ready` writ-lifecycle event for the same writ — standing orders typically wire **`mandate.ready`** to summon an anima rather than `commission.posted`, since the lifecycle event carries the writ id directly.

**`commission.session.ended`** fires after `session.ended` and only when the underlying session was triggered by a writ that chains up to a root mandate. Sessions without `metadata.writId`, or whose chain doesn't reach a root mandate, emit `session.ended` only.

### Session Events

Emitted by the shared session-emission helpers in `animator/src/session-emission.ts`. Every terminal session site (in-process attached dispatch, detached `handleSessionRecord`, the detached `session-running` tool, orphan recovery in `startup.ts`) routes through these helpers so the payloads come from a single source of truth.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `session.started` | `{ sessionId, anima?, trigger? }` | `framework` | A session begins — pending → running transition. `anima` is present when the session's `metadata.role` is set; `trigger` is present when `metadata.trigger` is set |
| `session.ended` | `{ sessionId, anima?, trigger?, exitCode?, durationMs?, costUsd?, error? }` | `framework` | A session terminates (success or failure). Optional fields are populated from the `SessionResult` / `SessionDoc`; missing fields are omitted entirely (no `null` placeholders) |
| `session.record-failed` | `{ sessionId, phase, error }` | `framework` | A session-record write itself failed. `phase` is one of `'insert'` (initial running-row write), `'write-record'` (transcript JSON), or `'update-row'` (terminal SessionDoc overwrite) |

**`session.ended` is guaranteed.** The session funnel wraps the provider call in try/finally — it fires even if the provider threw. The `error` field is present when the session terminated with an error; `exitCode`, `durationMs`, and `costUsd` are populated from the provider's report and may be omitted if the provider doesn't supply them.

**`session.record-failed`** is a diagnostic event. Subscribers wiring to it should not assume anything about the underlying session's state — the failure was in the bookkeeping, not the session itself.

### Anima Events

Emitted by `animator/src/session-emission.ts` alongside the session events. Anima events fire only when the session's `metadata.role` is populated — sessions with no anima role (e.g. a detached `animate()` call with no metadata) produce session events without anima co-emissions.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `anima.manifested` | `{ sessionId, anima, trigger? }` | `framework` | An anima is launched for a session — co-emitted with `session.started` when the session metadata carries a `role` |
| `anima.session.ended` | `{ sessionId, anima, trigger?, exitCode?, durationMs?, costUsd?, error? }` | `framework` | An anima session terminates — co-emitted with `session.ended` when the session metadata carries a `role` |

Only the two anima events listed above fire today. The Roster apparatus is the natural home for additional anima lifecycle events (e.g. an aspirant → active state machine); when it ships, this section will be extended.

### Writ Lifecycle Events

Emitted by the writ-lifecycle observer in `clockworks/src/writ-lifecycle-observer.ts` for every writ regardless of position in the hierarchy. The event namespace is the writ's **type** — a `mandate` writ emits `mandate.ready`, a guild-defined `task` type emits `task.ready`, etc. Transitions into `new` (drafts) and `cancelled` are silent.

| Event Pattern | Payload | Emitter | When |
|---------------|---------|---------|------|
| `{type}.ready` | `{ writId, writType, phase, commissionId, title, parentId? }` | `framework` | Writ enters `open` phase — available for dispatch. Stuck → open re-entry re-emits |
| `{type}.completed` | `{ writId, writType, phase, commissionId, title, parentId? }` | `framework` | Writ enters `completed` phase |
| `{type}.stuck` | `{ writId, writType, phase, commissionId, title, parentId? }` | `framework` | Writ enters `stuck` phase (engine failure, needs attention) |
| `{type}.failed` | `{ writId, writType, phase, commissionId, title, parentId? }` | `framework` | Writ enters `failed` phase |

**`commissionId`** is derived at emit time by walking `parentId` to the root — no `commissionId` column lives on `WritDoc`. For root writs (no parent), `commissionId === writId`.

**`{type}.ready` is the primary dispatch signal.** Standing orders wire these to summon animas. When a commission is posted, the framework creates a `mandate` writ and emits `mandate.ready`.

**Completion rollup:** when all children of a writ complete, the parent transitions from `pending` to `open` (re-emitting `{type}.ready`) or auto-completes (if no standing order exists). This cascades upward through the tree.

**Failure cascade:** when a writ fails, all its incomplete children are cancelled. Cancelled writs do not emit a lifecycle event.

#### Event namespace and validation

Writ lifecycle events are **framework-emitted** but use **guild-defined type names** as their namespace. A guild with a `task` writ type gets `task.ready` events — these aren't in the reserved framework namespaces, and they aren't declared in `clockworks.events` either. This is intentional:

- The framework emits them freely (it calls `ClockworksApi.emit()` directly, bypassing `validateSignal`).
- An anima calling `signal('task.ready')` is **rejected** by `validateSignal` — the writ-lifecycle pattern check catches `<type>.{ready,completed,stuck,failed}` for every type returned by `ClerkApi.listWritTypes()`.

This asymmetry is a feature: the framework controls writ lifecycle events; animas cannot forge them.

### Clockworks Events

Emitted by the dispatcher (`clockworks/src/dispatcher.ts`) and the scheduler (`clockworks/src/scheduler.ts`).

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `standing-order.failed` | `{ standingOrder, triggeringEvent: { id, name }, error }` | `framework` | A standing order execution fails — the relay throws, or the named relay is not registered. The `error` string is the same one written to the dispatch row's `error` column |
| `schedule.fired` | `{ standingOrder, orderIndex, fireTime }` | `framework` | The Clockworks scheduler fires a time-driven standing order. Emitted once per fire by the daemon's scheduler pass; the row is written with `processed: true` so the event-sweep does not re-fire it |

**Loop guard:** if a `standing-order.failed` event was itself triggered by another `standing-order.failed`, the dispatcher skips processing to prevent infinite cascades.

**Scheduled-fire bookkeeping:** the scheduler writes each `schedule.fired` row with `processed: true` so the dispatcher's event-sweep does not pick it up. The row is the durable record of the fire; the matching `event_dispatches` row records the relay invocation.

### Tool Events

Emitted by `cli/src/commands/plugin-bootstrap-emit.ts` after a successful `nsg plugin install` or `nsg plugin remove`. Both emissions are best-effort: the `guild.json` change is authoritative regardless of whether the event lands.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `tool.installed` | `{ pluginId, packageName }` | `framework` | A plugin (which contributes implements, engines, curricula, or temperaments) is installed via `nsg plugin install` |
| `tool.removed` | `{ pluginId, packageName? }` | `framework` | A plugin is removed via `nsg plugin remove`. `packageName` is present when the package name was resolvable; on a stale entry without a package the field is omitted |

The events use the `tool.` namespace because plugins are the framework's tool-delivery mechanism — implements, engines, curricula, and temperaments all flow through the plugin contract.

### Migration Events

Emitted by `clockworks/src/clockworks.ts` (`emitMigrationsApplied`) at apparatus `start()`. Idempotency is keyed off the events book itself — each `(pluginId, book)` pair fires exactly once, ever. First boot fires one event per declared book; subsequent boots fire only for newly-introduced books.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `migration.applied` | `{ pluginId, book, indexes }` | `framework` | A `(pluginId, book)` schema is observed for the first time. `indexes` is the declared index list from the book's schema contribution (an array of strings or string arrays) |

The catalog defines this event by name; the chosen payload identifies the schema that came into existence plus its disambiguating index list. Because Stacks' `reconcileSchemas` runs `CREATE … IF NOT EXISTS` silently, we use the events book itself as the ledger of "what we've already announced" rather than asking Stacks for a delta.

### Guild Events

Emitted by `clockworks/src/clockworks.ts` at apparatus `start()`. Idempotency is keyed off the events book — the persisted row is itself the marker.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `guild.initialized` | `null` | `framework` | First Clockworks boot for this guild. `start()` queries the events book for any prior `guild.initialized` row and emits one if absent; subsequent boots find the row and skip |

The payload is `null` — the event is a marker, not a record.

### Reserved Namespaces

The following namespaces are reserved for framework events. Animas calling the `signal` tool with names in these namespaces are rejected by `validateSignal`. The canonical list lives in `clockworks/src/signal-validator.ts` (`RESERVED_EVENT_NAMESPACES`):

```
anima.
commission.
tool.
migration.
guild.
standing-order.
session.
schedule.
```

**Note:** Writ lifecycle events (e.g. `mandate.ready`, `task.completed`) use guild-defined type names as namespaces, which are *not* in this list. They are still framework-only — `validateSignal` rejects them via a separate writ-lifecycle pattern check that runs against `ClerkApi.listWritTypes()`. See [Writ Lifecycle Events](#writ-lifecycle-events).

**`book.` is intentionally absent.** The CDC auto-wiring emits `book.<ownerId>.<bookName>.<verb>` events from framework code (see [CDC Events](#cdc-events) below), but the prefix is **not** reserved — the validator does not block animas from signalling spoofed `book.*` names. This is an as-is gap in the validator; closing it is a separate code-only follow-up. Operators relying on `book.*` events should treat the namespace as authoritative-by-convention rather than authoritative-by-validator.

---

## CDC Events

The Clockworks apparatus auto-wires Stacks change-data-capture (CDC) handlers across every declared book at startup. Each `create` / `update` / `delete` becomes one row in `clockworks/events`:

| Event Pattern | Payload | Emitter | When |
|---------------|---------|---------|------|
| `book.<ownerId>.<bookName>.created` | `ChangeEvent<T>` (Stacks event passed through verbatim) | `framework` | A new entry is committed to the named book |
| `book.<ownerId>.<bookName>.updated` | `ChangeEvent<T>` (Stacks event passed through verbatim) | `framework` | An existing entry is patched in the named book |
| `book.<ownerId>.<bookName>.deleted` | `ChangeEvent<T>` (Stacks event passed through verbatim) | `framework` | An entry is removed from the named book |

The `<ownerId>` parameter is the contributing plugin's id (e.g. `clerk`, `astrolabe`, `clockworks`); `<bookName>` is the book name within that plugin (e.g. `writs`, `events`, `event_dispatches`). Concrete examples: `book.clerk.writs.updated`, `book.clockworks.event_dispatches.created`, `book.astrolabe.plans.deleted`. The set of valid `(ownerId, bookName)` pairs is unbounded — it grows whenever a plugin contributes a new book.

**How subscribers wire concrete names.** Standing orders bind to a fully-qualified name; there is no wildcard syntax in `on:`. Wire one standing order per book the operator cares about:

```json
{ "on": "book.clerk.writs.updated", "run": "audit-writ-changes" }
```

**What triggers the family.** At apparatus `start()`, the Clockworks walks every `books` kit contribution and registers a Phase-2 (post-commit) Stacks watcher on each. The handler composes the event name from the delivered CDC event (`book.${event.ownerId}.${event.book}.${verb}` where verb is `created` / `updated` / `deleted`) and forwards the verbatim `ChangeEvent` as the payload.

**What's excluded from auto-wiring.** The `clockworks/events` book itself is not watched — observing it would re-emit forever. Everything else, including `clockworks/event_dispatches`, is auto-wired. Books contributed by plugins installed *after* `start()` are not picked up; the registry seals at `phase:started`.

**Phase-2 isolation.** Auto-wiring runs as `failOnError: false`, so an emit handler error cannot roll back the triggering write — Stacks' Phase-2 error path logs the failure and the system keeps going.

**Reserved-namespace gap.** The `book.` prefix is **not** in `RESERVED_EVENT_NAMESPACES` — animas calling `signal('book.clerk.writs.updated', ...)` are rejected only by Layer 3 (the event must be declared in `guild.json`), not by the namespace check. In theory an operator who declared `book.clerk.writs.updated` under `clockworks.events` would let animas signal a spoofed change event. Closing this gap is a separate follow-up; the documentation reflects the as-is state.

---

## Custom Events

Custom events are declared in `guild.json` under `clockworks.events` and can be signalled by animas (via the `signal` MCP tool) or by engines / relays / plugin code (via `ClockworksApi.emit`).

### Declaring Custom Events

Add events to `guild.json` under `clockworks.events`:

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "A code review has been completed"
      },
      "deploy.requested": {
        "description": "A deployment was requested"
      }
    }
  }
}
```

- `description` — human-readable purpose (optional but recommended)

Plugins may also declare events in their `guild.json` contribution, which the framework merges into the live config on installation. The astrolabe plugin's `astrolabe.plan.files-over-threshold` event is declared this way — see the example below.

### Validation Rules

`validateSignal` enforces three layers, in order:

1. The event name **must not** start with a [reserved framework namespace prefix](#reserved-namespaces).
2. The event name **must not** match the writ-lifecycle pattern `<type>.{ready,completed,stuck,failed}` for any declared writ type.
3. The event name **must** be declared in `guild.json` under `clockworks.events`.

Framework events bypass `validateSignal` — they call `ClockworksApi.emit` directly with `emitter: 'framework'`.

### Signalling Custom Events

From an anima (via the `signal` tool):

```
signal code.reviewed { "prUrl": "https://...", "approved": true }
```

From an engine, relay, or plugin start hook:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

const clockworks = guild().apparatus<ClockworksApi>('clockworks');
await clockworks.emit('code.reviewed', { prUrl: '...', approved: true }, 'my-engine');
```

### Plugin-Declared Custom Events (Example)

The astrolabe plugin declares `astrolabe.plan.files-over-threshold` in its `guild.json` contribution and emits it from the `astrolabe.plan-finalize` engine when the predicted-files count from a plan's `<task-manifest>` strictly exceeds the configured threshold (default 15):

```json
{
  "clockworks": {
    "events": {
      "astrolabe.plan.files-over-threshold": {
        "description": "A plan's predicted-files count exceeds the configured threshold",
        "schema": { "planId": "string", "count": "number", "threshold": "number" }
      }
    }
  }
}
```

The emitter calls `ClockworksApi.emit('astrolabe.plan.files-over-threshold', { planId, count, threshold }, 'framework')` after the patch transitioning the plan to `completed` has already landed; the emission is best-effort and a Clockworks failure logs an `[astrolabe]` warning without failing the engine.

This is a **measurement signal, not a gate** — the framework records the signal; subscribers (sanctum-side instrumentation, future auto-decompose) decide what to do with it. The event is not declared in any framework-shipped `guild.json` beyond astrolabe's own contribution; wiring a standing order to react to it is the responsibility of whichever guild operationalizes the signal.

---

## Standing Order Wiring

Standing orders connect events to relays. They are declared in `guild.json` under `clockworks.standingOrders`. Every standing order has the canonical shape `{ on | schedule, run, with? }` — exactly one of `on:` or `schedule:` must be present, and `run:` names a relay registered with the Clockworks. The standing-order validator rejects any unknown top-level key at guild.json load time.

```typescript
interface StandingOrder {
  on?: string;                       // event-trigger; XOR with schedule
  schedule?: string;                 // time-trigger; XOR with on
  run: string;                       // relay name
  with?: Record<string, unknown>;    // forwarded as RelayContext.params
}
```

### Event-Driven Orders (`on:`)

```json
{ "on": "session.ended", "run": "completion-rollup" }
```

The dispatcher imports the relay by name from the registered relay set, calls its handler with the triggering `GuildEvent` and a `RelayContext`, and writes a dispatch row.

### Time-Driven Orders (`schedule:`)

```json
{ "schedule": "@every 30s", "run": "reckoner-tick" }
```

The scheduler synthesises a `schedule.fired` event row per fire (with `processed: true`) and dispatches the named relay through the same plumbing the event-driven path uses. Two schedule syntaxes are accepted: standard 5-field unix cron (`m h dom mon dow`) and `@every <N><s|m|h>`. See [The Clockworks → Scheduled Standing Orders](../architecture/clockworks.md#scheduled-standing-orders) for the full grammar and missed-fire semantics.

### Forwarding Params (`with:`)

The optional `with:` block is forwarded verbatim to the relay as `RelayContext.params`:

```json
{
  "on": "deploy.requested",
  "run": "deploy",
  "with": { "environment": "staging", "dryRun": true }
}
```

The relay handler reads its inputs off `params`:

```typescript
export default relay({
  handler: async (event, { home, params }) => {
    const environment = (params.environment as string) ?? 'production';
    const dryRun = (params.dryRun as boolean) ?? false;
    // ...
  }
});
```

Params default to `{}` when the order omits `with:`.

### Summoning Animas — the `summon-relay`

The stdlib `summon-relay` (shipped with the Clockworks apparatus's `supportKit.relays`) is the bridge between event dispatches and anima sessions. Wire it from a standing order like any other relay:

```json
{
  "on": "mandate.ready",
  "run": "summon-relay",
  "with": {
    "role": "artificer",
    "prompt": "Read your writ. Title: {{writ.title}}",
    "maxSessions": 5
  }
}
```

`with:` parameters:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | *(required)* | Role to summon. Must be registered with the Loom; the relay throws at dispatch time if not |
| `prompt` | string | *(required)* | `{{path.with.dots}}` template. Namespaces: `writ.*` (always populated, real or synthetic), `event.*` (id / name / payload / emitter / firedAt), and `params.*` (every `with:` key other than `role`, `prompt`, `maxSessions`). Undefined paths throw |
| `maxSessions` | number | `10` | Per-writ circuit breaker. The relay tracks `writ.status.clockworks.sessionAttempts` and fails the writ once the count reaches this cap. `0` disables the breaker; negative values throw |

See [The Clockworks → The summon relay](../architecture/clockworks.md#the-summon-relay) for the full contract (writ binding, circuit-breaker behaviour, session metadata).

### Dispatch Lifecycle

When the dispatcher processes an event:

1. Find all standing orders where `on:` matches the event name (string equality only).
2. For each matching order, in registration order:
   a. Resolve the relay named in `run:`. An unresolved relay writes an `error` dispatch row and emits `standing-order.failed`.
   b. Invoke the relay's handler with `(guildEvent, { home, params })` inside a per-handler try/catch.
   c. Write a dispatch row with `started_at`, `ended_at`, `status`, and `error`.
   d. If the handler threw, emit `standing-order.failed` with the same error string.
3. Mark the event as processed.

A throw from one relay never blocks sibling relays or sibling events.

### No-Provider Behaviour for `summon-relay`

The Animator and the Loom are declared under Clockworks's `recommends`, not `requires`. If a `summon-relay` standing order fires while either dependency is missing, the relay throws a clear error naming the missing apparatus — the dispatcher writes an `error` dispatch row and emits `standing-order.failed`. Guilds that use Clockworks for non-anima relays can install the apparatus without dragging in the session-launch stack.

---

## Cookbook

Common patterns for wiring events to actions. All examples use the canonical `{ on | schedule, run, with? }` shape and the stdlib `summon-relay`.

### Standard Commission Pipeline

The default commission flow: patron posts → mandate dispatched → session runs → cleanup on completion.

```json
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "mandate.ready",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "You have been assigned a commission.\n\n{{writ.title}}\n\n{{writ.body}}"
        }
      },
      { "on": "commission.completed", "run": "cleanup-worktree" }
    ]
  }
}
```

When a commission is posted, the framework creates a `mandate` writ and emits `mandate.ready`. The standing order summons an artificer through `summon-relay`. When the artificer finishes, the mandate completes (or enters `pending` if child writs exist), `commission.completed` fires (alongside `commission.sealed`), and the cleanup relay runs. (Subscribe to one of `commission.completed` or `commission.sealed`, not both — they fire from the same transition; see the [Commission Events](#commission-events) cross-note.)

### Multi-Level Writ Decomposition

A sage decomposes a mandate into child `task` writs, each dispatched independently:

```json
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "mandate.ready",
        "run": "summon-relay",
        "with": {
          "role": "sage",
          "prompt": "Plan this commission.\n\n{{writ.title}}\n\n{{writ.body}}"
        }
      },
      {
        "on": "task.ready",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "{{writ.title}}\n\n{{writ.body}}"
        }
      },
      { "on": "commission.completed", "run": "cleanup-worktree" }
    ]
  }
}
```

The sage receives the mandate, creates `task` child writs, and finishes its session. The mandate enters `pending`. Each `task.ready` event summons an artificer. When all tasks complete, the mandate auto-transitions to `completed` → fires `commission.completed` → triggers cleanup.

### Custom Writ Types

Guilds declare custom writ types in `guild.json` to match their workflow vocabulary:

```json
{
  "writTypes": {
    "task":    { "description": "A concrete unit of work" },
    "feature": { "description": "A user-facing capability" },
    "bug":     { "description": "A defect to fix" }
  }
}
```

Each type gets its own lifecycle events (`task.ready`, `feature.completed`, `bug.failed`) and can be wired to different standing orders. Multiple standing orders can match the same event — they execute in registration order.

### Periodic Engine Tick

A reckoner (or any other periodic apparatus) wires its tick through a scheduled standing order rather than maintaining its own scheduler:

```json
{
  "clockworks": {
    "standingOrders": [
      { "schedule": "@every 30s", "run": "reckoner-tick" }
    ]
  }
}
```

Each fire writes a `schedule.fired` event row (with `processed: true`) and a matching dispatch row, so the operator can audit the cadence by querying the events book.

### Reacting to a Custom Event

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "A code review completed",
        "schema": { "prUrl": "string", "approved": "boolean" }
      }
    },
    "standingOrders": [
      {
        "on": "code.reviewed",
        "run": "notify-channel",
        "with": { "channel": "#reviews", "level": "info" }
      }
    ]
  }
}
```

The custom event must be declared under `clockworks.events` before any anima can `signal` it. The standing order forwards `with:` verbatim to the `notify-channel` relay as `RelayContext.params`.

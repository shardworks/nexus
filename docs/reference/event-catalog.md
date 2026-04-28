# Event Catalog

The Clockworks event system — every framework event, custom event rules, CDC events, and standing-order wiring. This document is the canonical reference for the framework event surface; payload shapes shown here match the shipped emitter code.

---

## Framework Events

Framework events are emitted by core modules and the Clockworks runner. They are claimed by their owning plugins via the `events` kit contribution (`supportKit.events` on apparatuses, top-level `events` on standalone kits) and merged into the Clockworks's authoritative event set at apparatus `start()`. Once a plugin has claimed a name, it is **framework-owned** — `signal` surfaces (the anima `signal` tool, the operator `nsg signal` CLI) reject emit attempts on that name even when an operator's `guild.json` entry now provides the active spec. See [Reserved Namespaces](#reserved-namespaces) and [Validation Rules](#validation-rules) for the detail.

Payload shapes use inline records `{ field, optional? }` where `?` marks an optional field.

### Session Events

Emitted by the shared session-emission helpers in `animator/src/session-emission.ts`, declared via the Animator's `supportKit.events` kit contribution. Every terminal session site (in-process attached dispatch, detached `handleSessionRecord`, the detached `session-running` tool, orphan recovery in `startup.ts`) routes through these helpers so the payloads come from a single source of truth.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `animator.session.started` | `{ sessionId, anima?, trigger? }` | `framework` | A session begins — pending → running transition. `anima` is present when the session's `metadata.role` is set; `trigger` is present when `metadata.trigger` is set |
| `animator.session.ended` | `{ sessionId, anima?, trigger?, exitCode?, durationMs?, costUsd?, error? }` | `framework` | A session terminates (success or failure). Optional fields are populated from the `SessionResult` / `SessionDoc`; missing fields are omitted entirely (no `null` placeholders) |
| `animator.session.record-failed` | `{ sessionId, phase, error }` | `framework` | A session-record write itself failed. `phase` is one of `'insert'` (initial running-row write), `'write-record'` (transcript JSON), or `'update-row'` (terminal SessionDoc overwrite) |

**`animator.session.ended` is guaranteed.** The session funnel wraps the provider call in try/finally — it fires even if the provider threw. The `error` field is present when the session terminated with an error; `exitCode`, `durationMs`, and `costUsd` are populated from the provider's report and may be omitted if the provider doesn't supply them.

**`animator.session.record-failed`** is a diagnostic event. Subscribers wiring to it should not assume anything about the underlying session's state — the failure was in the bookkeeping, not the session itself.

### Anima Events

**Deferred — pending the future Roster apparatus.** No `anima.*` events fire today. Animas have no aspirant → active state machine to observe yet, so emitting from here would invent semantics. When the Roster lands, it becomes the natural home for anima lifecycle events (e.g. `anima.manifested`, `anima.session.ended`, plus an instantiation / state-change pair) and will declare them through its own `supportKit.events` kit contribution. Until then, callers wanting "an anima ran a session" subscribe to `animator.session.started` / `animator.session.ended` and read the `anima` field on the payload (populated when the session's `metadata.role` is set).

### Writ Lifecycle Events

Emitted by the writ-lifecycle observer in `clockworks/src/writ-lifecycle-observer.ts` for every writ regardless of position in the hierarchy. The contract is **universal across writ types and statuses**: every status transition fires exactly one `writ.<type>.<status>` event whose suffix is the writ's `phase` verbatim. The status set is open-ended — it grows whenever a plugin registers a writ type with new states; the catalog no longer hardcodes a fixed `{ ready | completed | stuck | failed }` suffix list.

| Event Pattern | Payload | Emitter | When |
|---------------|---------|---------|------|
| `writ.<type>.<status>` | `{ writId, writType, phase, commissionId, title, parentId? }` | `framework` | A writ of `<type>` transitions into `<status>`. Fires on every status change including initial entry into the type's initial state and into terminal states such as `cancelled` |

For the builtin `mandate` type the concrete vocabulary is `writ.mandate.new`, `writ.mandate.open`, `writ.mandate.stuck`, `writ.mandate.completed`, `writ.mandate.failed`, and `writ.mandate.cancelled`. Plugin-registered types contribute their own state list — for example, a guild that registers a `task` type with states `[draft, queued, running, done, cancelled]` gets `writ.task.draft`, `writ.task.queued`, …, `writ.task.cancelled`.

**`commissionId`** is derived at emit time by walking `parentId` to the root — no `commissionId` column lives on `WritDoc`. For root writs (no parent), `commissionId === writId`. The field name is preserved verbatim from the prior contract so subscribers that already key on it continue to work; renaming it to a more precise name is a deferred follow-up.

**`writ.<type>.<active-state>` is the primary dispatch signal.** Standing orders typically bind to the type's active phase — `writ.mandate.open` for the default mandate flow, `writ.task.queued` for a guild's custom task type — to summon animas at the moment the writ is available for work.

**Metadata-only updates fire nothing.** The observer gates emission on a real phase delta: a title rename, codex inheritance change, or any other metadata-only patch produces no event row.

**Completion rollup:** when all children of a writ complete, the parent transitions to its active phase (re-emitting `writ.<type>.<active>`) or auto-completes per the type's `childrenBehavior` config. This cascades upward through the tree.

**Failure cascade:** when a writ fails, all its incomplete children are cancelled — and per the universal contract, each cancellation now fires its own `writ.<type>.cancelled` row.

#### Event namespace and validation

Writ lifecycle events are **framework-emitted** but use **guild-defined type names and state names** as their namespace. The Clockworks declares the full Cartesian product (every registered type × every declared state) at apparatus `start()` via its `events` kit contribution; once that declaration lands, the names are framework-owned in the merged event set:

- The framework emits them freely. `ClockworksApi.emit()` bypasses `validateSignal` entirely (advisory-only enforcement on the unprivileged emit channels).
- An anima calling `signal('writ.mandate.open')` (or any other declared writ-lifecycle name) is **rejected** by `validateSignal` because the merged set marks the name as plugin-declared (sticky `pluginDeclared`).

This asymmetry is a feature: the framework controls writ lifecycle events; animas cannot forge them.

### Clockworks Events

Emitted by the dispatcher (`clockworks/src/dispatcher.ts`) and the scheduler (`clockworks/src/scheduler.ts`).

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `clockworks.standing-order.failed` | `{ standingOrder, triggeringEvent: { id, name }, error }` | `framework` | A standing order execution fails — the relay throws, or the named relay is not registered. The `error` string is the same one written to the dispatch row's `error` column |
| `clockworks.timer` | `{ standingOrder, orderIndex, fireTime }` | `framework` | The Clockworks scheduler fires a time-driven standing order. Emitted once per fire by the daemon's scheduler pass; the row is written with `processed: true` so the event-sweep does not re-fire it |

**Loop guard:** if a `clockworks.standing-order.failed` event was itself triggered by another `clockworks.standing-order.failed`, the dispatcher skips processing to prevent infinite cascades.

**Scheduled-fire bookkeeping:** the scheduler writes each `clockworks.timer` row with `processed: true` so the dispatcher's event-sweep does not pick it up. The row is the durable record of the fire; the matching `event_dispatches` row records the relay invocation.

### Tool Events

Emitted by `cli/src/commands/plugin-bootstrap-emit.ts` after a successful `nsg plugin install` or `nsg plugin remove`. Both emissions are best-effort: the `guild.json` change is authoritative regardless of whether the event lands.

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `tool.installed` | `{ pluginId, packageName }` | `framework` | A plugin (which contributes implements, engines, curricula, or temperaments) is installed via `nsg plugin install` |
| `tool.removed` | `{ pluginId, packageName? }` | `framework` | A plugin is removed via `nsg plugin remove`. `packageName` is present when the package name was resolvable; on a stale entry without a package the field is omitted |

The events use the `tool.` namespace because plugins are the framework's tool-delivery mechanism — implements, engines, curricula, and temperaments all flow through the plugin contract.

### Renamed/removed in this release

The C2 commission migrated Clockworks's event vocabulary onto the kit-contribution mechanism, and the C4 commission migrated the Animator's session events the same way. Operators with `guild.json` standing orders bound to the legacy names below should update their bindings — bindings to deleted names silently stop firing, and bindings to renamed names will not match the new persisted event-row `name` field.

| Before | After | Notes |
|--------|-------|-------|
| `standing-order.failed` | `clockworks.standing-order.failed` | Renamed; payload shape unchanged |
| `schedule.fired` | `clockworks.timer` | Renamed; payload shape unchanged. The row is still written with `processed: true` |
| `session.started` | `animator.session.started` | Renamed; payload shape unchanged |
| `session.ended` | `animator.session.ended` | Renamed; payload shape unchanged |
| `session.record-failed` | `animator.session.record-failed` | Renamed; payload shape unchanged |
| `commission.posted` | *(deleted)* | Use `writ.mandate.open` instead — fires every time a root mandate enters the active phase |
| `commission.state.changed` | *(deleted)* | Use the matching `writ.mandate.<status>` row for the target phase |
| `commission.sealed` | *(deleted)* | Use `writ.mandate.completed` |
| `commission.completed` | *(deleted)* | Use `writ.mandate.completed` |
| `commission.failed` | *(deleted)* | Use `writ.mandate.failed`. The lifecycle payload does not include `resolution`; subscribers that need it read the writ from the Clerk |
| `commission.session.ended` | *(deleted)* | Use `animator.session.ended`. The renamed payload no longer carries `commissionId`; subscribers needing it walk the writ chain via the Clerk |
| `anima.manifested` | *(deleted)* | Subsumed by `animator.session.started` for v0; read the `anima` field on the payload (populated when the session's `metadata.role` is set). Anima identity events return when the Roster apparatus lands |
| `anima.session.ended` | *(deleted)* | Subsumed by `animator.session.ended` for v0; read the `anima` field on the payload. Anima identity events return when the Roster apparatus lands |
| `guild.initialized` | *(deleted)* | No replacement. A fresh Clockworks `start()` now writes zero rows of its own to the events book |
| `migration.applied` | *(deleted)* | No replacement. Stacks reconciles `CREATE … IF NOT EXISTS` silently; subscribers needing migration visibility consult Stacks directly |

Renaming `commissionId` on writ-lifecycle event payloads to a more precise name (e.g. `rootWritId`) is a deferred follow-up; the field name is preserved verbatim so existing subscribers continue to work.

### Reserved Namespaces

There is no hardcoded reserved-namespace list. Names are framework-owned per-event, claimed by a plugin's `events` kit contribution at apparatus `start()`. The merged event set tags each entry with a `pluginDeclared` flag that stays sticky-true once any plugin has claimed the name; `signal` surfaces (the anima `signal` tool, the operator `nsg signal` CLI) reject any emit on a `pluginDeclared` name even when an operator's `guild.json` entry now provides the active spec.

By convention, framework plugins claim per-namespace prefixes via their `events` kit contributions — the Clockworks claims its own `clockworks.*` intrinsic events (`clockworks.standing-order.failed`, `clockworks.timer`) plus the universal `writ.<type>.<status>` family (one entry per `(writType, state)` pair currently registered with the Clerk); the Animator claims `animator.session.*` (`animator.session.started`, `animator.session.ended`, `animator.session.record-failed`); the framework CLI claims `tool.*` plugin-bootstrap events. The exact catalog of plugin-claimed names lives in each plugin's `supportKit.events` slot — there is no second copy to drift against.

**Writ lifecycle events** (e.g. `writ.mandate.open`, `writ.task.queued`) are declared by the Clockworks's own `events` kit contribution as a state-walk over Clerk's writ-type registry. They are still framework-only — `validateSignal` rejects them via the merged-set framework-owned check.

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

Custom events are declared in `guild.json` under `clockworks.events` and can be signalled by animas (via the `signal` MCP tool) or by engines / relays / plugin code (via `ClockworksApi.emit`). Plugins also claim events through their `events` kit contribution; the Clockworks merges both layers into one authoritative event set at apparatus `start()`.

### Declaring Custom Events

Operator-defined events live in `guild.json` under `clockworks.events`:

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

- `description` — human-readable purpose (optional but recommended).
- `schema` — reserved slot for structural payload validation; accepted but not interpreted at runtime today.

Plugins claim events through the `events` kit (see [Plugin-Declared Custom Events](#plugin-declared-custom-events) below). The plugin layer is built once at apparatus `start()`; the `guild.json` layer is re-read on every call to `validateSignal` so operators can hot-edit `clockworks.events` and see the change without restarting the apparatus. The kit layer cannot be hot-edited — adding a new plugin contribution requires a restart.

### Validation Rules

`ClockworksApi.validateSignal(name)` runs two checks against the merged event set:

1. **Merged-set membership.** The event name must be present in the merged set. Otherwise: `signal: "<name>" is not a declared event …`.
2. **Framework-owned check.** Events claimed by any plugin's `events` kit are framework-owned (`pluginDeclared` is sticky-true). Even if the operator's `guild.json` later overrides the spec, the name remains framework-owned and `signal` surfaces are rejected. Otherwise: `signal: "<name>" is a framework-owned event …`.

Both the anima `signal` tool and the operator `nsg signal` CLI route through `ClockworksApi.validateSignal`; the apparatus closure is the single canonical validator path.

`ClockworksApi.emit()` deliberately does **not** call `validateSignal` — framework emit sites are unchecked by design, so plugin code that owns its own emit sites does not trip the validator on its own claimed events. Enforcement is advisory-only at the unprivileged `signal` channels.

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

### Plugin-Declared Custom Events

Plugins claim event names through the `events` kit contribution. On apparatuses, this lives in `supportKit.events`; on standalone kits, as a top-level `events` field. The contribution is either a flat record (event-name → `EventSpec`) or a pure function of the `StartupContext` returning the same record.

```typescript
// In an apparatus's `supportKit.events`:
export default {
  apparatus: {
    // ...
    supportKit: {
      events: {
        'astrolabe.plan.files-over-threshold': {
          description: "A plan's predicted-files count exceeds the configured threshold",
          schema: { planId: 'string', count: 'number', threshold: 'number' },
        },
      },
    },
  },
};
```

The function form lets a plugin compute its event set from runtime data. The Clockworks itself uses this pattern to declare the writ-lifecycle vocabulary — it walks every `(writType, state)` pair currently registered with the Clerk and produces one `writ.<type>.<status>` entry per pair, so the suffix list is open-ended (it grows as plugins register types with new states):

```typescript
// In an apparatus that produces a writ-type-derived event set:
events: (ctx) => {
  const events: Record<string, EventSpec> = {};
  const clerk = guild().apparatus<ClerkApi>('clerk');
  for (const writType of clerk.listWritTypes()) {
    // Walk the type's full state list — every state, including initial
    // and terminal — so the universal `writ.<type>.<status>` contract
    // covers every transition the lifecycle observer can fire.
    for (const state of writType.states) {
      events[`writ.${writType.name}.${state.name}`] = {
        description: `A writ of type "${writType.name}" entered the "${state.name}" phase.`,
      };
    }
  }
  return events;
},
```

Plugins that need a similar runtime-derived event set follow the same shape: read whatever runtime registry your contribution depends on (via the guild singleton), iterate, and return a flat `Record<string, EventSpec>`. Throws inside the function fail apparatus boot loud — no silent fallback.

Names claimed by a plugin's `events` kit are framework-owned. The emitter calls `ClockworksApi.emit(name, payload, '<plugin-id>')` directly — `emit()` bypasses `validateSignal`, so the plugin's own emit sites are not blocked by the framework-owned check.

**Operator override.** An operator may shadow a plugin's event spec by declaring the same name under `clockworks.events` in `guild.json`. The active spec is the operator entry (full-replacement on collision); the `pluginDeclared` flag stays sticky-true so animas and the operator CLI cannot emit the name through the `signal` surfaces.

**Worked example.** The astrolabe plugin claims `astrolabe.plan.files-over-threshold` through its `events` kit and emits it from the `astrolabe.plan-finalize` engine when the predicted-files count from a plan's `<task-manifest>` strictly exceeds the configured threshold (default 15):

```typescript
clockworks.emit(
  'astrolabe.plan.files-over-threshold',
  { planId, count, threshold },
  'astrolabe',
);
```

The emission lands after the patch transitioning the plan to `completed`; the call is best-effort and a Clockworks failure logs an `[astrolabe]` warning without failing the engine.

This is a **measurement signal, not a gate** — the framework records the signal; subscribers (sanctum-side instrumentation, future auto-decompose) decide what to do with it. Wiring a standing order to react to it is the responsibility of whichever guild operationalizes the signal.

#### Fail-loud boot guards

Several shape errors fail apparatus boot loud rather than silently degrading:

- **Plugin-vs-plugin collision** — two plugins claiming the same event name throw at `start()`, naming both contributors.
- **Function-form contribution that throws or returns a non-object** — the throw propagates from `start()`; non-object returns produce a `clockworks: events kit "<plugin>" function-form contribution returned <type>, expected an object.` error.
- **Malformed kit value** — neither a record nor a function; the apparatus throws naming the kit's pluginId and `typeof`.
- **Malformed `guild.json clockworks.events.<key>` value** — non-object entries throw on the first `validateSignal` call (the operator-side layer is read per-call, so this surfaces lazily but with a `clockworks: guild.json clockworks.events.<key>: expected object, got <typeof>` message that names the offending key).

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
{ "on": "animator.session.ended", "run": "completion-rollup" }
```

The dispatcher imports the relay by name from the registered relay set, calls its handler with the triggering `GuildEvent` and a `RelayContext`, and writes a dispatch row.

### Time-Driven Orders (`schedule:`)

```json
{ "schedule": "@every 30s", "run": "reckoner-tick" }
```

The scheduler synthesises a `clockworks.timer` event row per fire (with `processed: true`) and dispatches the named relay through the same plumbing the event-driven path uses. Two schedule syntaxes are accepted: standard 5-field unix cron (`m h dom mon dow`) and `@every <N><s|m|h>`. See [The Clockworks → Scheduled Standing Orders](../architecture/clockworks.md#scheduled-standing-orders) for the full grammar and missed-fire semantics.

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
  "on": "writ.mandate.open",
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
   a. Resolve the relay named in `run:`. An unresolved relay writes an `error` dispatch row and emits `clockworks.standing-order.failed`.
   b. Invoke the relay's handler with `(guildEvent, { home, params })` inside a per-handler try/catch.
   c. Write a dispatch row with `started_at`, `ended_at`, `status`, and `error`.
   d. If the handler threw, emit `clockworks.standing-order.failed` with the same error string.
3. Mark the event as processed.

A throw from one relay never blocks sibling relays or sibling events.

### No-Provider Behaviour for `summon-relay`

The Animator and the Loom are declared under Clockworks's `recommends`, not `requires`. If a `summon-relay` standing order fires while either dependency is missing, the relay throws a clear error naming the missing apparatus — the dispatcher writes an `error` dispatch row and emits `clockworks.standing-order.failed`. Guilds that use Clockworks for non-anima relays can install the apparatus without dragging in the session-launch stack.

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
        "on": "writ.mandate.open",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "You have been assigned a commission.\n\n{{writ.title}}\n\n{{writ.body}}"
        }
      },
      { "on": "writ.mandate.completed", "run": "cleanup-worktree" }
    ]
  }
}
```

When a commission is posted, the framework creates a `mandate` writ and the writ-lifecycle observer fires `writ.mandate.new` followed by `writ.mandate.open` once the writ is published. The standing order summons an artificer through `summon-relay`. When the artificer finishes, the mandate completes (or enters its active phase if child writs exist), `writ.mandate.completed` fires, and the cleanup relay runs.

### Multi-Level Writ Decomposition

A sage decomposes a mandate into child `task` writs, each dispatched independently:

```json
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "writ.mandate.open",
        "run": "summon-relay",
        "with": {
          "role": "sage",
          "prompt": "Plan this commission.\n\n{{writ.title}}\n\n{{writ.body}}"
        }
      },
      {
        "on": "writ.task.open",
        "run": "summon-relay",
        "with": {
          "role": "artificer",
          "prompt": "{{writ.title}}\n\n{{writ.body}}"
        }
      },
      { "on": "writ.mandate.completed", "run": "cleanup-worktree" }
    ]
  }
}
```

The sage receives the mandate, creates `task` child writs, and finishes its session. The mandate enters its active phase. Each `writ.task.open` event summons an artificer. When all tasks complete, the mandate auto-transitions to `completed` → fires `writ.mandate.completed` → triggers cleanup.

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

Each type gets its own writ-lifecycle events (`writ.task.<status>`, `writ.feature.<status>`, `writ.bug.<status>`) declared via the Clockworks's `events` kit walk over Clerk's writ-type registry; standing orders bind to the specific `(type, state)` pair the guild cares about. Multiple standing orders can match the same event — they execute in registration order.

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

Each fire writes a `clockworks.timer` event row (with `processed: true`) and a matching dispatch row, so the operator can audit the cadence by querying the events book.

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

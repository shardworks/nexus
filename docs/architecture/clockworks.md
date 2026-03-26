# The Clockworks

The Clockworks is the guild's nervous system — the event-driven layer that connects things that happen to things that should happen in response. It turns the guild from an imperative system (things happen when someone calls something) into a reactive one (things happen because other things happened).

The Clockworks is Pillar 5 of the guild architecture. The first four pillars make the guild *capable*. The Clockworks makes it *alive* — able to act on itself without waiting for the patron to push.

---

## Core Concepts

### Events

An event is an immutable fact: *this happened*.

```typescript
{
  name: string;       // e.g. "commission.sealed", "tool.installed"
  payload: unknown;   // event-specific data
  emitter: string;    // who signaled it: anima name, engine name, or "framework"
  firedAt: DateTime;
}
```

Events are persisted to the Clockworks' own event queue immediately when signaled. They do not carry intent — they carry record. An event says "this occurred"; it does not say "therefore do this." That causal link lives in standing orders. The event and dispatch tables are internal Clockworks operational state — not part of the guild's Books (Register, Ledger, Daybook).

#### Framework events

Signaled automatically by `nexus-core` operations. Always available; no guild configuration needed.

| Event | Signaled when |
|---|---|
| `anima.instantiated` | A new anima is created |
| `anima.state.changed` | An anima transitions state (aspirant → active, active → retired) |
| `anima.manifested` | An anima is launched for a session |
| `anima.session.ended` | A session completes |
| `commission.posted` | A new commission is posted by the patron |
| `commission.state.changed` | A commission transitions state |
| `commission.sealed` | A commission completes successfully |
| `commission.failed` | A commission fails |
| `{type}.ready` | A writ transitions to `ready` — available for dispatch (e.g. `mandate.ready`, `task.ready`) |
| `{type}.completed` | A writ is fulfilled (e.g. `mandate.completed`, `task.completed`) |
| `{type}.failed` | A writ fails (e.g. `mandate.failed`, `task.failed`) |
| `tool.installed` | A tool (implement, engine, curriculum, or temperament) is installed |
| `tool.removed` | A tool is removed |
| `migration.applied` | A database migration is applied |
| `guild.initialized` | The guild is first initialized |
| `standing-order.failed` | A standing order failed during execution (see Error Handling) |

Framework events are signaled from authoritative code paths in `nexus-core`. Animas cannot signal them.

#### Custom guild events

Guilds declare their own events in `guild.json` under the `clockworks` key:

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "Signaled when an anima completes a code review",
        "schema": { "pr": "number", "issues_found": "number" }
      },
      "deploy.approved": {
        "description": "Leadership has approved a deployment"
      }
    }
  }
}
```

Custom events use any name not in a reserved framework namespace (`anima.*`, `commission.*`, `tool.*`, `migration.*`, `guild.*`, `standing-order.*`, `session.*`). Writ lifecycle events (e.g. `mandate.ready`, `task.completed`) use guild-defined type names as namespaces — they are framework-emitted but not in the reserved list. See the [Event Catalog](../reference/event-catalog.md#writ-lifecycle-events) for how validation handles this. Bundles may also declare events they introduce; these are merged into `guild.json` on installation.

Animas signal custom events using the `signal` tool. The tool validates the event name against declared events in `guild.json` before persisting.

---

### Standing Orders

A standing order is a registered response to an event. Standing orders are **guild policy** — they live in `guild.json` under the `clockworks` key, not in engine descriptors. The guild decides what fires when; an engine is a capability, not a policy.

#### Canonical form

Every standing order has one canonical form: `{ on, run, ...params }`. The `on` key names the event to respond to. The `run` key names the engine to invoke. Any additional keys are **params** passed to the engine via `EngineContext.params`.

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "commission.sealed",  "run": "cleanup-worktree" },
      { "on": "mandate.ready",      "summon": "artificer", "prompt": "..." },
      { "on": "code.reviewed",      "run": "notify-patron" },
      { "on": "deploy.requested",   "run": "deploy", "environment": "staging", "dryRun": true }
    ]
  }
}
```

#### The `summon` verb (syntactic sugar)

The `summon` key is shorthand for invoking the **summon-engine** — the stdlib engine that handles anima session dispatch. The Clockworks desugars `summon` orders at dispatch time:

```json
// What the operator writes:
{ "on": "mandate.ready", "summon": "artificer", "prompt": "...", "maxSessions": 5 }

// What the Clockworks dispatches:
{ "on": "mandate.ready", "run": "summon-engine", "role": "artificer", "prompt": "...", "maxSessions": 5 }
```

The `summon` value becomes the `role` param. All other keys pass through as engine params. This means anima dispatch is handled by a regular engine — replaceable, upgradeable, configurable — not baked into the framework.

The **summon-engine** resolves the role to an active anima, binds or synthesizes a writ, manifests the anima, hydrates the prompt template, launches a session, and handles post-session writ lifecycle. See [Dispatch Integration](writs.md#dispatch-integration) for the full sequence.

**Summon-engine params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | *(required)* | Role to summon (set automatically from `summon` value) |
| `prompt` | string | — | Prompt template with `{{writ.title}}`, `{{writ.description}}`, etc. |
| `maxSessions` | number | 10 | Circuit breaker: max session attempts per writ before auto-fail |

**Circuit breaker:** By default, the summon-engine will fail a writ after 10 session attempts. This prevents infinite re-dispatch loops when a writ keeps getting interrupted without making progress. Override per standing order with `"maxSessions": 20` or disable with `"maxSessions": 0`.

**Role resolution:** If no active anima fills the named role, the engine throws and the Clockworks signals `standing-order.failed`.

#### Engine params

Any key on a standing order that isn't `on` or `run` (or `summon`/`brief` for sugar forms) is extracted as a param and passed to the engine:

```typescript
export default engine({
  name: 'deploy',
  handler: async (event, { home, params }) => {
    const environment = (params.environment as string) ?? 'production';
    const dryRun = (params.dryRun as boolean) ?? false;
    // ...
  }
});
```

Params default to `{}` when no extra keys are present. Existing engines that destructure only `{ home }` from context are unaffected.

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

A background daemon that polls the event queue and processes events automatically.

| Command | Behavior |
|---|---|
| `nsg clock start [--interval <ms>]` | Start the daemon as a detached background process (default interval: 2000ms) |
| `nsg clock stop` | Send SIGTERM and clean up the PID file |
| `nsg clock status` | Show whether the daemon is running, with PID, uptime, and log file path |

The daemon spawns as a detached child process. It writes a PID file at `<home>/.nexus/clock.pid` and logs to `<home>/.nexus/clock.log` (append mode). Only event-processing cycles are logged; idle polls are silent.

The daemon registers the session provider at startup, enabling the summon-engine to dispatch anima sessions autonomously.

Phase 1 commands (`list`, `tick`, `run`) continue to work alongside the daemon. If the daemon is running, `tick` and `run` print a warning but still execute — SQLite handles concurrent access safely.

Core API: `clockStart(home, options?)`, `clockStop(home)`, `clockStatus(home)`. The `clock-status` MCP tool exposes daemon status to animas.

---

## Error Handling

Standing order failures signal a `standing-order.failed` event:

```typescript
{
  name: "standing-order.failed",
  payload: {
    standingOrder: { on: "commission.failed", summon: "steward" },
    triggeringEvent: { id: 42, name: "commission.failed", ... },
    error: "No active anima fills role 'steward'"
  }
}
```

Guilds can respond to this event with their own standing orders — summon an anima, run a notification engine, whatever the guild needs. The error handling policy is itself configurable.

**Loop guard**: `standing-order.failed` events are tagged. The Clockworks runner will not fire standing orders in response to a `standing-order.failed` event that was itself triggered by a `standing-order.failed` event. Errors handling errors do not cascade.

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
    // validate name against guild.json clockworks.events
    // reject framework-reserved namespaces
    // persist to Clockworks events table
  }
})
```

Also exposed as `nsg signal <name> [--payload <json>]` for operator use.

Animas cannot signal framework events (`anima.*`, `commission.*`, `tool.*`, `session.*`, etc.) or writ lifecycle events (`mandate.ready`, `task.completed`, etc.). Only guild-declared custom events. This keeps the event record trustworthy — framework events come from authoritative code paths.

---

## guild.json Shape

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "Signaled when an anima completes a code review",
        "schema": { "pr": "number", "issues_found": "number" }
      }
    },
    "standingOrders": [
      { "on": "commission.sealed",     "run": "cleanup-worktree" },
      { "on": "commission.failed",     "run": "notify-patron" },
      { "on": "commission.failed",     "summon": "steward" },
      { "on": "code.reviewed",         "run": "post-review-summary" },
      { "on": "standing-order.failed", "summon": "steward" }
    ]
  }
}
```

---

## Clockworks Schema

```sql
-- Event log: immutable fact record
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  payload    TEXT,                    -- JSON
  emitter    TEXT NOT NULL,           -- anima name, engine name, or 'framework'
  fired_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed  INTEGER NOT NULL DEFAULT 0   -- 0=pending, 1=processed
);

-- Execution log: what ran in response to each event
CREATE TABLE event_dispatches (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  handler_type TEXT NOT NULL,          -- 'engine' or 'anima'
  handler_name TEXT NOT NULL,          -- engine name or resolved anima name
  target_role  TEXT,                   -- role name (anima orders only; handler_name is the resolved anima)
  notice_type  TEXT,                   -- 'summon' | null (historical; present on summon-engine dispatches)
  started_at   DATETIME,
  ended_at     DATETIME,
  status       TEXT,                   -- 'success' | 'error'
  error        TEXT
);
```

---

## Engine Contract

Today, engines are plain TypeScript modules with bespoke exported functions — no SDK wrapper, no standard invocation contract. Each static engine has its own specific signature (`manifest(home, animaName)`, `applyMigrations(home, provenance?)`, etc.) and is called directly by the CLI or other framework code that knows the API. The `nexus-engine.json` descriptor is used only at install time; nothing reads it at runtime.

This works for static engines but is incompatible with the Clockworks — a generic runner cannot call an engine if every engine has a different signature.

### Two kinds of engines

The Clockworks introduces a meaningful distinction that wasn't needed before:

**Static engines** — bespoke APIs, called by specific framework code. The manifest engine, mcp-server, and ledger-migrate fall here. They have no standard invocation contract and are not directly triggerable by standing orders. Nothing about them changes.

**Clockwork engines** — purpose-built to respond to Clockworks events. These export a default using a new `engine()` SDK factory, giving the Clockworks runner a standard contract to call.

### The `engine()` factory

A new SDK export from `nexus-core`, parallel to `tool()`:

```typescript
import { engine } from '@shardworks/nexus-core';

export default engine({
  handler: async (event: GuildEvent | null, { home, params }) => {
    // event  — the triggering GuildEvent when invoked by a standing order (null for direct invocation)
    // home   — absolute path to the guild root
    // params — extra keys from the standing order (empty object when none)
  }
});
```

The Clockworks runner calls `module.default.handler(event, { home, params })`. This is the only contract the runner needs to know. Params are extracted from the standing order at dispatch time — any key that isn't `on` or `run` becomes a param.

Clockwork engines can be named in `run:` standing orders. Static engines cannot — attempting to do so is a configuration error caught at validation time.

### `nexus-engine.json` is unchanged

No new fields needed. The descriptor's `entry` field already points to the module. Whether that module exports an `engine()` default is discovered at load time, not in the descriptor. The distinction between static and clockwork engines is in the module shape, not the configuration.

---

## Relationship to Existing Concepts

**Engines** — gain a new activation path (event-driven, via standing orders) alongside existing explicit invocation. Split into two kinds: static engines (unchanged, bespoke APIs) and clockwork engines (use the new `engine()` factory). No changes to `nexus-engine.json`.

**Tools** — `signal` is a new base tool. All other tools unchanged.

**The Books** — the Clockworks owns its event/dispatch tables as internal operational state, separate from the guild's Books (Register, Ledger, Daybook). Writs live in the Ledger — see the architecture overview.

**The Manifest Engine** — invoked by the summon-engine when dispatching anima sessions. Receives event context rather than a patron-posted commission brief.

**Bundles** — may ship default standing orders and custom event declarations, merged into `guild.json` on installation. Same delivery mechanism as other bundle-provided config.

---

## Deferred

- **Natural language trigger syntax** — `'when a commission is posted'` instead of `'commission.posted'`. Worth pursuing once real guilds have standing orders in production and vocabulary needs are understood. Requires validation tooling to be safe.
- **Pre-event hooks** — cancellable `before.*` events. Powerful but complex. Start with observation-only (post-facto) events.
- **Payload schema enforcement** — schema field in custom event declarations is documented but not validated. Enforcement deferred.
- **Phase 2 daemon enhancements** — external event injection (webhooks, file watchers), log rotation, concurrency.
- **Scheduled standing orders** — time-triggered rather than event-triggered. Deferred.

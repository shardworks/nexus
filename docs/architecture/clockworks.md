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

#### Book change events (Stacks auto-wiring)

The Clockworks apparatus registers CDC handlers across all declared books at startup via The Stacks' `watch()` API (see [stacks.md](apparatus/stacks.md#6-change-data-capture-cdc)). This emits `book.<ownerId>.<bookName>.created`, `book.<ownerId>.<bookName>.updated`, and `book.<ownerId>.<bookName>.deleted` events into the Clockworks event stream automatically — no per-book configuration needed.

```typescript
// In clockworks apparatus start()
const stacks = ctx.apparatus<StacksApi>('stacks')
for (const plugin of ctx.plugins) {
  const bookNames = Object.keys(plugin.books ?? {})
  for (const bookName of bookNames) {
    stacks.watch(plugin.id, bookName, async (event) => {
      await clockworksApi.emit(`book.${event.ownerId}.${event.book}.${event.type}`, event)
    }, { failOnError: false })  // clockworks failure must not block writes
  }
}
```

This means any book mutation from any plugin is observable via standing orders without the originating plugin needing to signal events explicitly. Standing orders can respond to book change events just like framework or custom events:

```json
{ "on": "book.nexus-ledger.writs.updated", "run": "audit-writ-changes" }
```

---

### Standing Orders

A standing order is a registered response to an event. Standing orders are **guild policy** — they live in `guild.json` under the `clockworks` key, not in relay descriptors. The guild decides what fires when; a relay is a capability, not a policy.

#### Canonical form

Every standing order has one canonical form: `{ on, run, ...params }`. The `on` key names the event to respond to. The `run` key names the relay to invoke. Any additional keys are **params** passed to the relay via `RelayContext.params`.

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

#### The summon relay

The **summon relay** is the stdlib relay that turns event dispatches into anima sessions. It is wired into the apparatus's `supportKit.relays` so every guild has it available by default, registered under the canonical name `summon-relay`. Operators invoke it like any other relay:

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

Anima dispatch is therefore handled by a regular relay — replaceable, upgradeable, configurable — not baked into the framework. The standing-order validator's canonical `{ on, run, with? }` shape applies; there is no `summon:` or `brief:` sugar form.

**`with:` parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | string | *(required)* | Role to summon. Must be registered with the Loom; the relay throws at dispatch time if not. |
| `prompt` | string | *(required)* | `{{path.with.dots}}` template. Namespaces: `writ.*` (always populated, real or synthetic), `event.*` (id / name / payload / emitter / firedAt), and `params.*` (every `with:` key other than `role`, `prompt`, `maxSessions`). Undefined paths throw. |
| `maxSessions` | number | 10 | Per-writ circuit breaker. The relay tracks `writ.status.clockworks.sessionAttempts` and fails the writ once the count reaches this cap. `0` disables the breaker; negative values throw. |

**Writ binding:** if `event.payload.writId` is a string, the relay fetches the writ via the Clerk and exposes it as `writ.*`. Otherwise it synthesizes an in-memory writ from the event payload — synthetic writs are never persisted, and the circuit breaker is bypassed entirely (synthetic writs have no durable identity to count against).

**Circuit breaker:** the per-writ counter (`writ.status.clockworks.sessionAttempts`) is incremented before each launch via `clerk.setWritStatus(writId, 'clockworks', …)` so a crashed dispatcher cannot bypass the count. When the cap trips, the relay transitions the writ to `'failed'` via `clerk.transition` with a resolution string identifying the relay, and returns cleanly without throwing to the dispatcher — the writ's resolution is the audit trail.

**Soft dependency on the Animator and the Loom:** both apparatuses are declared under Clockworks's `recommends` (not `requires`) and are resolved lazily at handler-call time. A guild that uses Clockworks for non-anima relays can install the apparatus without dragging in the session-launch stack; if a `summon-relay` standing order fires while the dependencies are missing, the relay throws a clear error naming the missing apparatus.

**Session metadata:** the relay calls `animator.summon` with `cwd: guild().home` and metadata `{ trigger: 'summon-relay', role, writId, eventId, eventName }`, then awaits `AnimateHandle.result` so the dispatcher's `event_dispatches` row reflects real session runtime.

#### Relay params

Any key on a standing order that isn't `on` or `run` (or `summon`/`brief` for sugar forms) is extracted as a param and passed to the relay:

```typescript
export default relay({
  name: 'deploy',
  handler: async (event, { home, params }) => {
    const environment = (params.environment as string) ?? 'production';
    const dryRun = (params.dryRun as boolean) ?? false;
    // ...
  }
});
```

Params default to `{}` when no extra keys are present. Existing relays that destructure only `{ home }` from context are unaffected.

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

A background daemon polls the event queue and processes events automatically. Phase 2 is shipped — see commission c-moe3qifr.

| Command | Behavior |
|---|---|
| `nsg clock start [--interval <ms>] [--foreground|-f]` | Start the daemon as a detached background process (default interval: 2000ms). Refuses (exits nonzero) when a daemon is already running. Cleans up a stale pidfile and continues. `--foreground` runs the inline daemon body in this process and is the re-exec target the detached spawn uses. |
| `nsg clock stop` | Send SIGTERM and clean up the PID file. Escalates to SIGKILL after a 5s grace window. Exits zero with a message when there is nothing to stop (no pidfile, or the pidfile was stale). |
| `nsg clock status [--json]` | Show whether the daemon is running, with PID, uptime, and log file path. `--json` emits the structured payload. |

The daemon spawns as a detached child process by re-execing the same `nsg` binary with `clock start --foreground --guild-root <home>` (plus `--interval <ms>` if supplied). It writes a PID file at `<home>/.nexus/clock.pid` and logs to `<home>/.nexus/clock.log` (append mode). Both stdout and stderr land in the same log file. The detached parent calls `child.unref()` so closing the parent terminal does not take the daemon down.

The startup banner names the pid, polling interval, and log path; the shutdown banner records the signal received. Per-dispatch lines emit on active ticks in the format `<ISO timestamp> <eventId> <eventName> [<handlerName>] <status> <durationMs>ms[: <error>]`. Idle ticks are silent. When `processEvents` itself throws, the loop logs `<ISO timestamp> [error] processEvents threw: <reason>` and continues at the next interval — the daemon stays unattended.

The poll loop sleeps abortably between ticks (`Promise.race(timeout, shutdownDeferred)`) so SIGTERM is acted on immediately. Per-tick `processEvents` runs as a full drain — no `max` cap — and the post-completion sleep schedules the next tick after the previous one returns.

Phase 1 commands (`list`, `tick`, `run`) continue to work alongside the daemon. If the daemon is running, `tick` and `run` emit a one-line coexistence warning to stderr and still execute — SQLite handles concurrent access safely.

`clockStatus(home)` cleans up stale pidfiles as a side effect: a pidfile pointing at a dead pid surfaces in the return shape as `stalePidfile: true` and is unlinked, so subsequent calls are silent on staleness.

Core API: `clockStart(home, options?)`, `clockStop(home)`, `clockStatus(home)`, plus `runForegroundDaemon(...)` (the inline daemon body, with every dependency injected for tests) and `runForegroundDaemonFromGuild(...)` (the live-guild convenience wrapper the CLI re-exec target calls). The `clock-status` MCP tool exposes daemon status to animas.

The two-daemon coexistence with `nsg start` (the guild daemon) is intentional. Different pidfiles (`daemon.pid` vs `clock.pid`), different log files, different lifecycles. SQLite handles concurrent access from both.

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

Guilds can respond to this event with their own standing orders — summon an anima, invoke a notification relay, whatever the guild needs. The error handling policy is itself configurable.

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
  handler_type TEXT NOT NULL,          -- 'relay' or 'anima' (relays are stored as 'engine' in older schemas)
  handler_name TEXT NOT NULL,          -- relay name or resolved anima name
  target_role  TEXT,                   -- role name (anima orders only; handler_name is the resolved anima)
  notice_type  TEXT,                   -- 'summon' | null (historical; present on summon relay dispatches)
  started_at   DATETIME,
  ended_at     DATETIME,
  status       TEXT,                   -- 'success' | 'error'
  error        TEXT
);
```

---

## ClockworksKit

The Clockworks apparatus consumes relay contributions from installed plugins. It publishes a `ClockworksKit` interface that kit authors import for type safety:

```typescript
// Published by nexus-clockworks
interface ClockworksKit {
  relays?: RelayDefinition[]
}
```

A plugin contributing relays declares itself as satisfying `ClockworksKit` and names `nexus-clockworks` in its `recommends`:

```typescript
import type { ClockworksKit } from "nexus-clockworks"

export default {
  name: "nexus-signals",
  kit: {
    relays:     [memberJoinedRelay, memberLeftRelay],
    recommends: ["nexus-clockworks"],
  } satisfies ClockworksKit,
} satisfies Plugin
```

The Clockworks apparatus registers relays from both standalone kit packages and its own `supportKit` into a unified relay registry. Callers of the Clockworks API see a single relay list regardless of source.

### Relay Contract

The Clockworks needs a standard invocation contract to call relays generically. Relays export a default using the `relay()` SDK factory shipped from `@shardworks/clockworks-apparatus` — kit authoring factories live with their owning apparatus (mirrors `tool()` in `@shardworks/tools-apparatus`):

```typescript
import { relay } from '@shardworks/clockworks-apparatus';

export default relay({
  handler: async (event: GuildEvent | null, { home, params }) => {
    // event  — the triggering GuildEvent when invoked by a standing order (null for direct invocation)
    // home   — absolute path to the guild root
    // params — extra keys from the standing order (empty object when none)
  }
});
```

The Clockworks runner calls `module.default.handler(event, { home, params })`. Params are extracted from the standing order at dispatch time — any key that isn't `on` or `run` becomes a param. Relays can be named in `run:` standing orders; bespoke framework processes cannot.

---

## Relationship to Existing Concepts

**Relays** — a new artifact type, distinct from tools and existing framework machinery. Relays are purpose-built Clockworks handlers that export a standard `relay()` contract and can be named in `run:` standing orders. Framework processes (manifest, mcp-server, ledger-migrate) are unchanged.

**Tools** — `signal` is a new base tool. All other tools unchanged.

**The Books** — the Clockworks owns its event/dispatch tables as internal operational state, separate from the guild's Books (Register, Ledger, Daybook). Writs live in the Ledger — see the architecture overview.

**Bundles** — may ship default standing orders and custom event declarations, merged into `guild.json` on installation. Same delivery mechanism as other bundle-provided config.

---

## Deferred

- **Natural language trigger syntax** — `'when a commission is posted'` instead of `'commission.posted'`. Worth pursuing once real guilds have standing orders in production and vocabulary needs are understood. Requires validation tooling to be safe.
- **Pre-event hooks** — cancellable `before.*` events. Powerful but complex. Start with observation-only (post-facto) events.
- **Payload schema enforcement** — schema field in custom event declarations is documented but not validated. Enforcement deferred.
- **Phase 2 daemon enhancements** — external event injection (webhooks, file watchers), log rotation, concurrency.
- **Scheduled standing orders** — time-triggered rather than event-triggered. Deferred.

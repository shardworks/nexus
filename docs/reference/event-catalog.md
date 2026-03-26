# Event Catalog

The Clockworks event system — every framework event, custom event rules, and standing order wiring.

---

## Framework Events

Framework events are signaled by core modules and the Clockworks runner. They use reserved namespaces (`commission.`, `session.`, `standing-order.`) and **cannot** be signaled by animas or operators.

### Commission Events

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `commission.posted` | `{ commissionId, workshop }` | `framework` | A new commission is posted via `commission()` |
| `commission.session.ended` | `{ commissionId, workshop?, exitCode }` | `framework` | A session launched for a commission completes (success or failure) |
| `commission.completed` | `{ commissionId }` | `framework` | `completeCommissionIfReady()` transitions status to `completed` |

**`commission.posted`** is the primary entry point for the commission pipeline. The framework creates a `mandate` writ and signals `mandate.ready` — standing orders typically wire that to summon an anima (e.g. `{ on: "mandate.ready", summon: "artificer" }`).

**`commission.session.ended`** fires when any session associated with a commission finishes. Useful for post-session automation (merge worktrees, check completion, notify).

**`commission.completed`** fires when the commission's mandate writ is fulfilled. This is a terminal event — no further work expected.

### Session Events

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `session.started` | `{ sessionId, anima, trigger, workshop, workspaceKind }` | `framework` | A session begins (after Daybook row is inserted) |
| `session.ended` | `{ sessionId, anima, trigger, workshop, exitCode, durationMs, costUsd, error }` | `framework` | A session completes (even if the provider threw) |
| `session.record-failed` | `{ sessionId?, error, phase, anima? }` | `framework` | Failed to write session record to Daybook or disk |

**`session.ended`** fires **guaranteed** — the session funnel wraps the provider call in try/finally. The `error` field is non-null if the provider threw. The `costUsd` field may be null if the provider doesn't report cost.

**`session.record-failed`** is a diagnostic event. The `phase` field indicates where the failure occurred: `"insert"` (initial row), `"write-record"` (JSON to disk), or `"update-row"` (final metrics).

### Writ Lifecycle Events

Writ lifecycle events use the writ's **type** as the event namespace. For example, a writ of type `mandate` emits `mandate.ready`, `mandate.completed`, etc. A guild-defined type like `task` emits `task.ready`, `task.completed`, etc.

| Event Pattern | Payload | Emitter | When |
|---------------|---------|---------|------|
| `{type}.ready` | `{ writId, parentId?, commissionId? }` | `framework` | Writ transitions to `ready` — available for dispatch |
| `{type}.completed` | `{ writId, parentId?, commissionId? }` | `framework` | Writ transitions to `completed` |
| `{type}.failed` | `{ writId, parentId?, commissionId? }` | `framework` | Writ transitions to `failed` |

**`{type}.ready`** is the primary dispatch signal. Standing orders wire these to summon animas (e.g. `{ on: "mandate.ready", summon: "artificer" }`). When a commission is posted, the framework creates a `mandate` writ and signals `mandate.ready`.

**Completion rollup:** When all children of a writ complete, the parent transitions from `pending` to `ready` (if a standing order exists for `{type}.ready`) or auto-completes (if not). This cascades upward through the tree — child completion can ripple up to fulfill the root mandate and complete the commission.

**Failure cascade:** When a writ fails, all its incomplete children are cancelled.

#### Event namespace and validation

Writ lifecycle events are **framework-emitted** but use **guild-defined type names** as their namespace. A guild with a `task` writ type gets `task.ready` events — these aren't in the reserved framework namespaces, and they aren't declared in `clockworks.events` either. This is intentional:

- The framework emits them freely (it calls `signalEvent()` directly, bypassing validation).
- An anima calling `signal('task.ready')` will be **rejected** by `validateCustomEvent()` — the event isn't declared in `clockworks.events`, and animas can't spoof writ state transitions.

This asymmetry is a feature: the framework controls writ lifecycle events; animas cannot forge them.

### Clockworks Events

| Event | Payload | Emitter | When |
|-------|---------|---------|------|
| `standing-order.failed` | `{ standingOrder, triggeringEvent: { id, name }, error }` | `framework` | A standing order execution fails (engine throws or anima session fails) |

**Loop guard:** If a `standing-order.failed` event was itself triggered by another `standing-order.failed` event, the Clockworks runner skips processing to prevent infinite cascades.

### Reserved Namespaces

The following namespaces are reserved for framework events. Animas cannot signal events in these namespaces via the `signal` tool — `validateCustomEvent()` will throw.

```
anima.
commission.
tool.
migration.
guild.
standing-order.
session.
```

**Note:** Writ lifecycle events (e.g. `mandate.ready`, `task.completed`) use guild-defined type names as namespaces, which are *not* in this reserved list. They are still framework-only — see [Writ Lifecycle Events](#writ-lifecycle-events) for how validation handles this.

---

## Custom Events

Custom events are declared in `guild.json` and can be signaled by animas (via the `signal` MCP tool) or by engines.

### Declaring Custom Events

Add events to `guild.json` under `clockworks.events`:

```json
{
  "clockworks": {
    "events": {
      "code.reviewed": {
        "description": "A code review has been completed",
        "schema": { "prUrl": "string", "approved": "boolean" }
      },
      "deploy.requested": {
        "description": "A deployment was requested"
      }
    }
  }
}
```

- `description` — human-readable purpose (optional but recommended)
- `schema` — payload schema hint (informational only, not enforced at runtime)

### Validation Rules

1. The event name must **not** start with a reserved namespace prefix
2. The event name **must** be declared in `guild.json` `clockworks.events`
3. Both rules are enforced by `validateCustomEvent()`, which is called by the `signal` MCP tool

### Signaling Custom Events

From an anima (via the `signal` tool):
```
signal code.reviewed { "prUrl": "https://...", "approved": true }
```

From an engine:
```typescript
import { signalEvent } from '@shardworks/nexus-core';
signalEvent(home, 'code.reviewed', { prUrl: '...', approved: true }, 'my-engine');
```

Framework events bypass `validateCustomEvent()` — they call `signalEvent()` directly.

---

## Standing Order Wiring

Standing orders connect events to actions. They are declared in `guild.json` under `clockworks.standingOrders`.

### Order Types

#### `run` — Execute an engine

```json
{ "on": "session.ended", "run": "completion-rollup" }
```

The Clockworks runner imports the engine by name from `guild.json.engines`, calls its handler with the triggering event, and records a dispatch.

#### `summon` — Launch an anima session

```json
{ "on": "commission.posted", "summon": "artificer" }
```

Resolves the role to an active anima, manifests it, and launches a full session through the session funnel. For commission events, also writes commission assignments and updates commission status to `"in_progress"`.

The `prompt` for the session comes from the commission content (for commission events) or the event payload's `brief` field.

#### `brief` — Launch an anima session (lightweight)

```json
{ "on": "code.reviewed", "brief": "steward" }
```

Same as `summon` but semantically lighter — no commission lifecycle updates.

### Dispatch Lifecycle

When the Clockworks runner processes an event:

1. Find all standing orders where `on` matches the event name
2. For each matching order:
   a. Execute the action (`run` engine, or `summon`/`brief` anima)
   b. Record a dispatch in `event_dispatches` (started_at, ended_at, status, error)
   c. If the action failed, signal `standing-order.failed`
3. Mark the event as processed

### Role Resolution

For `summon` and `brief` orders, the role name is resolved to a specific anima:
- Query the roster for active animas holding the role
- If multiple animas share the role, the one with the lowest ID is selected
- If no active anima holds the role, the dispatch fails with an error

### No-Provider Behavior

If no session provider is registered (e.g. during testing or CLI-only operation), `summon` and `brief` orders are recorded as **skipped** — the intent is logged but no session is launched.

---

## Cookbook

Common patterns for wiring events to actions.

### Standard Commission Pipeline

The default commission flow: patron posts → workshop prepared → mandate dispatched → session runs → workshop merged.

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "commission.posted", "run": "workshop-prepare" },
      { "on": "mandate.ready", "summon": "artificer", "prompt": "You have been assigned a commission.\n\n{{writ.title}}\n\n{{writ.description}}" },
      { "on": "mandate.completed", "run": "workshop-merge" }
    ]
  }
}
```

When a commission is posted, the framework creates a `mandate` writ and signals `mandate.ready`. The standing order summons an artificer. When the artificer calls `complete-session`, the mandate completes (or enters `pending` if child writs exist), and `mandate.completed` triggers the merge engine.

### Multi-Level Writ Decomposition

An artificer can decompose a mandate into child writs, each dispatched independently:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "commission.posted", "run": "workshop-prepare" },
      { "on": "mandate.ready", "summon": "sage", "prompt": "Plan this commission.\n\n{{writ.title}}\n\n{{writ.description}}" },
      { "on": "task.ready", "summon": "artificer", "prompt": "{{writ.title}}\n\n{{writ.description}}" },
      { "on": "mandate.completed", "run": "workshop-merge" }
    ]
  }
}
```

The sage receives the mandate, creates `task` child writs, and calls `complete-session`. The mandate enters `pending`. Each `task.ready` event summons an artificer. When all tasks complete, the mandate auto-transitions to `ready` → completes → triggers the merge.

### Custom Writ Types

Guilds declare custom writ types in `guild.json` to match their workflow vocabulary:

```json
{
  "writTypes": {
    "task": { "description": "A concrete unit of work" },
    "feature": { "description": "A user-facing capability" },
    "bug": { "description": "A defect to fix" }
  }
}
```

Each type gets its own lifecycle events (`task.ready`, `feature.completed`, `bug.failed`) and can be wired to different standing orders.

Multiple standing orders can match the same event — they execute in declaration order.

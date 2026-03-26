# Writs

Writs are the guild's system for tracking labor — typed, tree-structured work items that record outstanding obligations. A writ says "this needs to get done" and persists until it's fulfilled, failed, or withdrawn.

This document covers the architecture of the writ system: design principles, lifecycle mechanics, dispatch integration, prompt templates, and the commission bridge. For the schema, see the [Schema Reference](../reference/schema.md#writs). For writ lifecycle events, see the [Event Catalog](../reference/event-catalog.md#writ-lifecycle-events).

---

## Design Principles

**Events are transient, writs are durable.** Events signal that something happened. Writs record that something needs to happen. If an event is dropped or a session crashes, the writ persists as "not done yet" — recoverable, queryable, restartable. Events drive reactions; writs hold intent.

**Writs are the only planning/tracking primitive.** There is no separate concept for atomic progress records. What might have been a "step" or "stroke" is a child writ of a lightweight type. One data model, one completion mechanism, all the way down.

**Every summon gets a writ.** The clockworks creates or binds a writ for every anima session. For writ lifecycle events, the writ already exists. For any other event, the framework automatically synthesizes a `summon` writ. The result is uniform session resumption, progress tracking, and audit across all dispatches.

**The framework provides lifecycle mechanics, not work vocabulary.** The framework knows about writs, statuses, parent/child relationships, events, and sessions. It does not know what a "feature," "task," or "step" is. Those are guild-defined types that drive event naming and standing order routing.

**Summons are generic.** The clockworks summons animas based on standing orders. It does not have special logic for commissions or any specific type of work. Context is provided through prompt templates on standing orders, hydrated from event payloads and writ fields.

---

## Writ Structure

A writ has:
- A **type** — guild-defined vocabulary (e.g. `feature`, `task`, `step`, `review`), plus two framework-reserved built-in types
- An optional **parent** — another writ, forming a flexible tree
- A **status** with lifecycle events emitted on transitions
- A **title** and **description** — the specification of what needs to happen
- An optional **session_id** — the currently bound session (cleared on completion/interruption)

The tree is flexible. A commission might produce one writ (simple bug fix) or a deep tree (feature → tasks → steps). Operational events produce standalone writs with no parent. The framework treats both the same.

### Built-in Types

The framework reserves two types that do not need to be declared in `guild.json`:

- **`mandate`** — the root writ created automatically when a commission arrives. The commission record points to its mandate writ (`commissions.writ_id`). This bridges the commission system (patron-facing) and the writ system (guild-internal). Completing a mandate completes its commission.
- **`summon`** — auto-synthesized for non-writ event sessions. When the clockworks dispatches an anima for an event that doesn't carry a `writId`, it creates a summon writ to bind to the session. This gives every session a trackable work item — durability, resumption, and audit for free.

### Guild-Defined Types

Guilds declare their own writ types in `guild.json` under `writTypes`:

```json
{
  "writTypes": {
    "feature": { "description": "A significant deliverable requiring decomposition" },
    "task": { "description": "A single assignable unit of work" },
    "step": { "description": "An atomic unit of progress within a task" }
  }
}
```

Type validation: `createWrit()` rejects unknown types. At guild init/upgrade, the framework can warn about standing orders referencing undeclared types (e.g. a `task.ready` order with no `task` type declared).

Progress visibility is uniform across all types. "Task is 3/5 steps done" is the same query as "feature is 2/4 tasks done" — count complete children vs. total children, at any level.

---

## Status Lifecycle

```
ready → active → completed
              → failed
              → pending → ready  (cycle)
       → cancelled
```

### States

| Status | Meaning | Event fired |
|--------|---------|-------------|
| **ready** | Available for dispatch. Writs are born here. | `<type>.ready` |
| **active** | A session is working on it. | — |
| **pending** | Session completed its pass, but incomplete children remain. Waiting. | — |
| **completed** | Done. All obligations fulfilled. | `<type>.completed` |
| **failed** | Explicitly failed by an anima. Terminal. | `<type>.failed` |
| **cancelled** | Abandoned. Terminal. | — |

### Transitions

| From | To | Trigger |
|------|----|---------|
| ready | active | Session binds to writ |
| active | completed | `complete-session` called; no children or all children complete |
| active | pending | `complete-session` called; incomplete children exist |
| active | ready | Session interrupted (no `complete-session`; writ not failed) |
| active | failed | Anima calls `fail-writ` (terminal) |
| pending | ready | All children complete (rollup) |
| pending | cancelled | Explicit cancellation |
| pending | failed | Explicit (operational intervention) |
| ready | cancelled | Explicit cancellation |

`<type>.ready` fires on every transition TO `ready` — both at creation and on `pending → ready`. The same standing order handles initial dispatch and re-dispatch. The progress appendix tells the anima which case it's in.

---

## Completion Model

### complete-session

**`complete-session`** is the universal "I'm done" signal. When an anima calls it:

1. Session is marked complete.
2. Framework checks the bound writ's children:
   - No children, or all children complete → writ transitions to **completed** → fires `<type>.completed` → triggers completion rollup on parent.
   - Incomplete children exist → writ transitions to **pending**. No event fired. Writ waits for children.

### Session interruption

If a session ends WITHOUT `complete-session` (context limit, crash, timeout), the framework treats it as interrupted:

1. If the writ is already failed → do nothing (failure already handled).
2. Otherwise → writ transitions back to **ready** → fires `<type>.ready` → re-dispatch via standing orders.

The re-summoned anima receives the progress appendix showing current child state, so it can pick up where the previous session left off.

### fail-writ

**`fail-writ`** is the explicit failure signal. It is terminal for both the writ and the session:

1. Writ transitions to **failed** → fires `<type>.failed`.
2. Session ends implicitly.
3. Incomplete children are **cancelled** (cascading to their children).
4. Completed children remain completed (historical record).
5. Active children (sessions in progress) are allowed to finish; their writs are cancelled when the session reports back.

### Completion rollup

When a writ transitions to **completed**, the framework checks its parent:

1. **Parent is `pending` and all siblings are complete** → parent transitions to **ready** → fires `<type>.ready` → standing order re-dispatches for final integration pass.
2. **Parent is `pending` and siblings remain incomplete** → no action. Wait.
3. **No standing order matches `<type>.ready` for the parent's type** (container writ) → parent auto-completes → rollup continues up the tree.

The container auto-complete rule: a writ auto-completes on rollup **only if no standing order matches `<type>.ready` for its type**. If a standing order exists, the writ must go through the session path (`ready → active → completed`). This prevents skipping the integration pass.

When a `mandate` writ completes (whether via session or auto-complete), the framework marks the corresponding commission record as complete.

### The pending → ready cycle

A writ can cycle through `pending → ready → active → pending` multiple times. Each cycle represents one "pass" by an anima:

1. **First pass:** Anima is summoned, creates child writs, calls `complete-session` → **pending**.
2. **Children complete:** Rollup transitions writ to **ready** → re-dispatch.
3. **Second pass:** Anima sees all children complete in progress appendix. Does final integration. Calls `complete-session` → **completed**. Or creates more children → **pending** again.

---

## Dispatch Integration

When the clockworks matches a summon standing order, the summon-engine handles the dispatch:

### 1. Bind or synthesize a writ

**If the event payload contains `writId`:** Bind the session to the existing writ. Mark it `active`.

The `writId` field is a conventional name. Guild-created events can include it intentionally to bind sessions to existing writs.

**If the event payload does NOT contain `writId`:** Synthesize a writ automatically:
- **type:** `"summon"`
- **title:** `"Summon <role>: <event-name>"`
- **description:** serialized event payload
- **parent_id:** null

### 2. Hydrate the prompt template

Resolve the prompt template from the standing order, substituting from two scopes:

- `{{field}}` — direct substitution from the event payload
- `{{writ.field}}` — from the bound writ (title, description, type, status, parentId)
- `{{writ.parent.field}}` — from the parent writ (one level up)

Missing values resolve to empty string. No deeper traversal — if a standing order needs ancestor context beyond the parent, bake it into the writ's description at creation time.

### 3. Inject session protocol

The summon-engine injects the writ session protocol into the system prompt appendix, telling the anima it must call `complete-session` or `fail-writ` before its session ends. Without this, animas wouldn't know they're bound to a writ.

### 4. Manifest and launch

Resolve the role to an anima. Manifest it. Launch the session through the session funnel with the hydrated prompt. The session record includes the writ reference (`sessions.writ_id`).

### 5. On session end

- `complete-session` called → complete or pend the writ (based on children) → rollup if completed
- `fail-writ` called → fail the writ → cancel children → end session
- Neither called → session interrupted → writ back to `ready` → re-dispatch

---

## Prompt Templates

Standing orders have a `prompt` field — a template string hydrated at dispatch time.

```json
{
  "on": "task.ready",
  "summon": "artificer",
  "prompt": "You have been assigned a task.\n\n## Task\n**{{writ.title}}**\n\n{{writ.description}}\n\n## Context\nPart of: {{writ.parent.title}}"
}
```

### Template scopes

| Syntax | Source | Example |
|--------|--------|---------|
| `{{field}}` | Event payload | `{{budgetRemaining}}` |
| `{{writ.field}}` | Bound writ | `{{writ.title}}`, `{{writ.description}}` |
| `{{writ.parent.field}}` | Parent writ (one level) | `{{writ.parent.title}}` |

### Progress appendix

When re-summoning (writ returns to `ready` from `pending` or interruption), the framework appends a progress appendix to the original prompt:

```
[Original prompt from standing order]

---
## Prior Progress
This is a continuation of prior work. Current state of sub-items:

- ✓ Add retry queue data structure (completed)
- ✓ Implement exponential backoff (completed)
- → Write retry loop (active)
- ○ Add max-retries-exceeded test (ready)
- ○ Wire up to webhook dispatcher (ready)
```

The appendix lists **direct children only**. If children have their own children, those are summarized (e.g. "3 tasks (2 completed, 1 active)") rather than expanded.

---

## Commission → Mandate Bridge

When a commission is posted, the framework automatically:

1. Fires `commission.posted` (commission system event — no writ exists yet).
2. Creates a root writ of type `"mandate"` with the commission content as description.
3. Links the commission record to the mandate writ (`commissions.writ_id`).
4. The mandate writ is created in `ready` status → fires `mandate.ready`.

This bridges the two systems cleanly:
- `commission.posted` — commission system event. Wire to pre-writ setup (workshop-prepare, git operations).
- `mandate.ready` — writ lifecycle event. Wire to dispatching work.
- `mandate.completed` — writ lifecycle event. Framework automatically marks the commission record as complete.

---

## Examples

### Simple Guild (No Sage)

```json
[
  { "on": "commission.posted", "run": "workshop-prepare" },
  { "on": "mandate.ready", "summon": "artificer",
    "prompt": "You have been assigned a commission.\n\n{{writ.title}}\n\n{{writ.description}}" },
  { "on": "mandate.completed", "run": "workshop-merge" }
]
```

Flow: Commission posted → workshop prepared → mandate writ created → artificer summoned → artificer works, calls `complete-session` → mandate completed → commission marked done → workshop merged.

If the artificer creates child writs: `complete-session` → mandate pending → children complete → mandate ready → artificer re-summoned for final pass → `complete-session` → mandate completed.

### Guild With Planning (Sage + Artificer)

Writ types: `feature`, `task`, `step`, `triage`

```json
[
  { "on": "commission.posted", "run": "workshop-prepare" },
  { "on": "mandate.ready", "summon": "sage",
    "prompt": "A new commission needs triage.\n\n{{writ.description}}\n\nAssess scope. Decompose into features and tasks." },
  { "on": "feature.ready", "summon": "sage",
    "prompt": "This feature needs planning.\n\n## Feature\n{{writ.title}}\n{{writ.description}}\n\nBreak this into concrete tasks." },
  { "on": "task.ready", "summon": "artificer",
    "prompt": "You have been assigned a task.\n\n## Task\n{{writ.title}}\n\n{{writ.description}}\n\n## Context\nPart of: {{writ.parent.title}}" },
  { "on": "task.failed", "summon": "steward",
    "prompt": "A task has failed.\n\n{{writ.title}}\n{{writ.description}}\n\nAssess the failure and recommend next steps." },
  { "on": "mandate.completed", "run": "workshop-merge" }
]
```

Completion cascade: steps → tasks → features → mandate → commission marked done.

### Operational Standing Orders

```json
[
  { "on": "commission.failed", "run": "create-failure-review" },
  { "on": "review.ready", "summon": "steward",
    "prompt": "A commission has failed and needs review.\n\n{{writ.description}}\n\nAssess the failure and recommend: retry, modify, or abandon." },
  { "on": "token.budget.low", "summon": "foreman",
    "prompt": "Token budget alert: {{budgetRemaining}} of {{budgetTotal}} remaining.\n\nReview active sessions and halt non-critical work if needed." }
]
```

Every operational summon produces a `"summon"` writ automatically — durable record, resumption on interruption, audit trail, all for free.

---

## Circuit Breaker

The summon-engine includes a built-in circuit breaker to prevent infinite re-dispatch loops. When a writ keeps cycling (interrupted → ready → summoned → interrupted → ...) without converging, the circuit breaker fails it after a configurable number of session attempts.

**Default:** 10 sessions per writ. Override per standing order:

```json
{ "on": "mandate.ready", "summon": "artificer", "prompt": "...", "maxSessions": 5 }
```

Set `"maxSessions": 0` to disable the circuit breaker for a specific standing order (not recommended).

When the circuit breaker fires, the writ transitions to **failed** and emits `<type>.failed`. Downstream standing orders (e.g. alerting the steward) handle the failure like any other.

---

## Open Questions

1. **Other relationship types.** Backlog: blocks/blocked-by, related-to. Not for v1.

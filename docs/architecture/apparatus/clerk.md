# The Clerk — API Contract

Status: **Draft**

Package: `@shardworks/clerk-apparatus` · Plugin id: `clerk`

> **⚠️ MVP scope.** The first implementation covers flat mandate writs with patron-triggered dispatch. No writ hierarchy, no Clockworks integration. Future sections describe where this apparatus is headed once the Clockworks and rigging system exist.

---

## Purpose

The Clerk is the guild's obligation authority. It receives commissions from the patron, issues writs that formally record what is owed, manages the lifecycle of those writs through to completion or failure, and maintains the Ledger — the guild's book of work.

The Clerk owns the boundary between "what is asked for" and "how it gets done." A commission arrives; the Clerk creates a mandate writ. When work completes, the Clerk records the outcome. Connecting writs to sessions is the job of the dispatch layer — currently [The Dispatch](dispatch.md), eventually the full rigging system (Spider, Executor, Fabricator). The Clerk tracks the obligation, not the execution.

The Clerk does **not** execute work. It does not launch sessions, manage rigs, or orchestrate engines. It tracks obligations: what has been commissioned, what state each obligation is in, and whether the guild has fulfilled its commitments. When the Clockworks and rigging system exist, the Clerk will integrate with them via lifecycle events and signals.

---

## Dependencies

```
requires: ['stacks']
```

- **The Stacks** (required) — persists writs in the `writs` book. All writ state lives here.

---

## Kit Interface

The Clerk does not consume kit contributions. No `consumes` declaration.

Kits that need to create or manage writs do so through the Clerk's tools or programmatic API, not through kit contribution fields. Writ creation is an operational act (with validation and lifecycle rules), not a declarative registration.

---

## Support Kit

```typescript
supportKit: {
  books: {
    writs: {
      indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
    },
  },
  tools: [
    commissionPost,
    writShow,
    writList,
    writAccept,
    writComplete,
    writFail,
    writCancel,
  ],
},
```

### `commission-post` tool

Post a new commission. Creates a mandate writ in `ready` status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | yes | Short description of the work |
| `body` | `string` | yes | Full spec — what to do, acceptance criteria, context |
| `codex` | `string` | no | Target codex name |
| `type` | `string` | no | Writ type (default: `"mandate"`) |

Returns the created `WritDoc`.

Permission: `clerk:write`

### `writ-show` tool

Read a writ by id. Returns the full `WritDoc` including status history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |

Permission: `clerk:read`

### `writ-list` tool

List writs with optional filters. Returns writs ordered by `createdAt` descending.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `WritStatus` | no | Filter by status |
| `type` | `string` | no | Filter by writ type |
| `limit` | `number` | no | Max results (default: 20) |

Permission: `clerk:read`

### `writ-accept` tool

Claim a writ. Transitions `ready → active`. Sets `acceptedAt`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |

Permission: `clerk:write`

### `writ-complete` tool

Mark a writ as successfully completed. Transitions `active → completed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | yes | What was done — summary of the work delivered |

Permission: `clerk:write`

### `writ-fail` tool

Mark a writ as failed. Transitions `active → failed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | yes | Why the work failed |

Permission: `clerk:write`

### `writ-cancel` tool

Cancel a writ. Transitions `ready|active → cancelled`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | no | Why the writ was cancelled |

Permission: `clerk:write`

---

## `ClerkApi` Interface (`provides`)

```typescript
interface ClerkApi {
  // ── Commission Intake ─────────────────────────────────────────

  /**
   * Post a commission — create a mandate writ in ready status.
   *
   * This is the primary entry point for patron-originated work.
   * Creates a WritDoc and persists it to the writs book.
   */
  post(request: PostCommissionRequest): Promise<WritDoc>

  // ── Writ Queries ──────────────────────────────────────────────

  /** Read a single writ by id. Throws if not found. */
  show(id: string): Promise<WritDoc>

  /** List writs with optional filters. */
  list(filters?: WritFilters): Promise<WritDoc[]>

  /** Count writs matching filters. */
  count(filters?: WritFilters): Promise<number>

  // ── Writ Lifecycle ────────────────────────────────────────────

  /**
   * Transition a writ to a new status.
   *
   * Enforces the status machine — invalid transitions throw.
   * Updates the writ document and sets timestamp fields.
   *
   * Valid transitions:
   *   ready → active
   *   active → completed
   *   active → failed
   *   ready|active → cancelled
   *
   * The `fields` parameter allows setting additional fields
   * atomically with the transition (e.g. `resolution`).
   */
  transition(id: string, to: WritStatus, fields?: Partial<WritDoc>): Promise<WritDoc>
}
```

### Supporting Types

```typescript
interface WritDoc {
  /** Unique writ id (prefixed, sortable: `w-{base36_timestamp}{hex_random}`). */
  id: string
  /** Writ type — guild vocabulary. e.g. "mandate", "task", "bug". */
  type: string
  /** Current status. */
  status: WritStatus
  /** Short description. */
  title: string
  /** Full spec — what to do, acceptance criteria, context. */
  body: string
  /** Target codex name, if applicable. */
  codex?: string

  // ── Timestamps ──────────────────────────────────────────────

  /** When the writ was created. */
  createdAt: string
  /** When the writ was last modified. */
  updatedAt: string
  /** When status moved to active (accepted). */
  acceptedAt?: string
  /** When terminal status was reached. */
  resolvedAt?: string

  // ── Resolution ───────────────────────────────────────────────

  /** Summary of how the writ resolved. Set on any terminal transition.
   *  What was done (completed), why it failed (failed), or why it
   *  was cancelled (cancelled). The `status` field distinguishes which. */
  resolution?: string
}

type WritStatus =
  | "ready"       // Posted, awaiting acceptance or dispatch
  | "active"      // Claimed by an anima, work in progress
  | "completed"   // Work done successfully
  | "failed"      // Work failed
  | "cancelled"   // Cancelled by patron or system

interface PostCommissionRequest {
  title: string
  body: string
  codex?: string
  type?: string       // default: "mandate"
}

interface WritFilters {
  status?: WritStatus
  type?: string
  limit?: number
  offset?: number
}
```

---

## Configuration

All Clerk configuration lives under the `clerk` key in `guild.json`. The Clerk uses [module augmentation](../plugins.md#typed-config-via-module-augmentation-recommended) to extend `GuildConfig`, so config is accessed via `guild().guildConfig().clerk` with full type safety — no manual cast needed.

```json
{
  "clerk": {
    "writTypes": [
      { "name": "mandate" },
      { "name": "task", "description": "A concrete unit of implementation work" },
      { "name": "bug", "description": "A defect to investigate and fix" }
    ],
    "defaultType": "mandate"
  }
}
```

```typescript
interface ClerkConfig {
  writTypes?: WritTypeEntry[]
  defaultType?: string
}

interface WritTypeEntry {
  name: string
  description?: string
}

// Module augmentation — typed access via guild().guildConfig().clerk
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    clerk?: ClerkConfig
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `writTypes` | `WritTypeEntry[]` | `[]` | Additional writ type declarations. Each entry has a `name` and optional `description`. The built-in type `"mandate"` is always valid regardless of this list. |
| `defaultType` | `string` | `"mandate"` | Default type when `commission-post` is called without a type. |

Both fields are optional. A guild with no `clerk` config (or an empty one) gets only the built-in `mandate` type with `defaultType: "mandate"` — enough to post commissions with no configuration.

Writ types are the guild's vocabulary — not a framework-imposed hierarchy. A guild that does only implementation work might use only `mandate`. A guild with planning animas might add `task`, `step`, `bug`, `spike`. The Clerk validates that posted writs use a declared type but assigns no behavioral semantics to the type name — that meaning lives in role instructions and (when available) standing orders and engine designs.

---

## Status Machine

The writ status machine governs all transitions. The Clerk enforces this — invalid transitions throw.

```
            ┌──────────────┐
            │    ready     │──────────┐
            └──────┬───────┘          │
                   │                  │
              accept               cancel
                   │                  │
                   ▼                  │
            ┌──────────────┐          │
            │    active    │──────┐   │
            └──┬───────┬───┘      │   │
               │       │          │   │
          complete    fail     cancel  │
               │       │          │   │
               ▼       ▼          │   │
        ┌───────────┐ ┌────────┐  │   │
        │ completed │ │ failed │  │   │
        └───────────┘ └────────┘  │   │
                                  │   │
              ┌───────────┐       │   │
              │ cancelled │◀──────┘   │
              │           │◀──────────┘
              └───────────┘
```

Terminal statuses: `completed`, `failed`, `cancelled`. No transitions out of terminal states.

### [Future] The `pending` status

When writ hierarchy is implemented, a parent writ transitions to `pending` when it has active children and is not directly actionable itself. `pending` is not a terminal state — when all children complete, the parent can transition to `completed`. If any child fails, the parent can transition to `failed`.

```
ready → pending    (when children are created via decompose())
pending → completed  (when all children complete — may be automatic)
pending → failed     (when a child fails — patron decides)
pending → cancelled
```

---

## Commission Intake Pipeline

Commission intake is a single synchronous step:

```
├─ 1. Patron calls commission-post (or ClerkApi.post())
├─ 2. Clerk validates input, generates ULID, creates WritDoc
├─ 3. Clerk writes WritDoc to writs book (status: ready)
└─ 4. Returns WritDoc to caller
```

One commission = one mandate writ. No planning, no decomposition. Dispatch is handled by [The Dispatch](dispatch.md) — a separate apparatus that reads ready writs and runs them through the guild's session machinery.

---

## Future: Clockworks Integration

When the Clockworks apparatus exists, the Clerk gains event emission and reactive dispatch.

### Dependency Change

```
requires:   ['stacks']
recommends: ['clockworks']
```

The Clockworks becomes a recommended (not required) dependency. The Clerk checks for the Clockworks at emit time — not at startup — so it functions standalone. When the Clockworks is absent, event emission is silently skipped.

### Lifecycle Events

The Clerk emits events into the Clockworks event stream at each status transition. Event names use the writ's `type` as the namespace, matching the framework event catalog.

| Transition | Event | Payload |
|-----------|-------|---------|
| Commission posted | `commission.posted` | `{ writId, title, type, codex }` |
| Writ signaled ready | `{type}.ready` | `{ writId, title, type, codex }` |
| `ready → active` | `{type}.active` | `{ writId }` |
| `active → completed` | `{type}.completed` | `{ writId, resolution }` |
| `active → failed` | `{type}.failed` | `{ writId, resolution }` |
| `* → cancelled` | `{type}.cancelled` | `{ writId, resolution }` |

These events are what standing orders bind to. The canonical dispatch pattern:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "mandate.ready", "summon": "artificer", "prompt": "Read your writ with writ-show and fulfill the commission. Writ id: {{writ.id}}" }
    ]
  }
}
```

### `signal()` Method

A new method on `ClerkApi`:

```typescript
/**
 * Signal that a writ is ready for dispatch.
 *
 * Emits `{type}.ready` into the Clockworks event stream.
 * In the full design, called after intake processing (Sage
 * decomposition, validation) completes. This is the signal
 * the Spider (or summon relay) listens for to begin execution.
 */
signal(id: string): Promise<void>
```

### Dispatch Integration

The Clerk integrates with the dispatch layer at two points:

**Outbound: Ready Signal.** When a writ is signaled ready, the Clockworks event stream carries it to standing orders. The summon relay (or the Spider, for rig-based execution) picks it up and begins work. The Clerk does not know or care which dispatch path handles the writ — it signals readiness; the guild's configuration determines the response.

**Inbound: Completion Signal.** When work completes (session ends, rig strikes), the completing apparatus calls `clerk.transition(id, 'completed', { outcome })`. For rig-based execution, the Spider calls this when it strikes a completed rig. For direct-summon execution, the anima calls `writ-complete` (which wraps `clerk.transition()`). Both paths converge on the same Clerk API.

### Intake with Planning

When Sage animas and the Clockworks are available, the intake pipeline gains a planning step:

```
├─ 1. Patron calls commission-post
├─ 2. Clerk creates mandate writ (status: ready)
├─ 3. Clerk emits commission.posted
├─ 4. Standing order on commission.posted summons a Sage
├─ 5. Sage reads the mandate, decomposes into child writs via decompose()
├─ 6. Clerk creates child writs (status: ready), sets parent to pending
├─ 7. Clerk emits {childType}.ready for each child
├─ 8. Standing orders on {childType}.ready dispatch workers
├─ 9. As children complete, Clerk rolls up status to parent
└─ 10. When all children complete, parent mandate → completed
```

The patron's experience doesn't change — they still call `commission-post`. The planning step is internal to the guild.

---

## Future: Writ Hierarchy

Writs form a tree. A mandate writ may be decomposed into child writs (tasks, steps, etc.) by a planning anima. The hierarchy enables:

- **Decomposition** — a broad commission broken into concrete tasks
- **Completion rollup** — parent completes when all children complete
- **Failure propagation** — parent awareness of child failures
- **Scope tracking** — the patron sees one mandate; the guild sees the tree

### Hierarchy Rules

- A writ may have zero or one parent.
- A writ may have zero or many children.
- Depth is not limited (but deep hierarchies are a design smell).
- Children inherit the parent's `codex` unless explicitly overridden.
- The parent's `childCount` is denormalized and maintained by the Clerk.

### Completion Rollup

When a child writ reaches a terminal status, the Clerk checks siblings:
- All children `completed` → parent auto-transitions to `completed`
- Any child `failed` → the Clerk emits `{parentType}.child-failed` but does NOT auto-fail the parent. The patron (or a standing order) decides whether to fail, retry, or cancel.
- Child `cancelled` → no automatic parent transition.

### `decompose()` Method

```typescript
/**
 * Create child writs under a parent.
 *
 * Used by planning animas (Sages) to decompose a mandate into
 * concrete tasks. Children inherit the parent's codex unless
 * overridden. The parent transitions to `pending` when it has
 * active children and is not directly actionable.
 */
decompose(parentId: string, children: CreateWritRequest[]): Promise<WritDoc[]>
```

---

## Open Questions

- **Should `commission-post` be a permissionless tool?** It represents patron authority — commissions come from outside the guild. But Coco (running inside a session) needs to call it. Current thinking: gate it with `clerk:write` and grant that to the steward role.

- **Writ type validation — strict or advisory?** The Clerk validates against `clerk.writTypes` in config. But this means adding a new type requires a config change. Alternative: accept any string, use the config list only for documentation/tooling hints. Current thinking: strict validation — the guild should know its own vocabulary.

---

## Implementation Notes

- Standalone apparatus package at `packages/plugins/clerk/`. Requires only the Stacks.
- `WritDoc.type` uses a guild-defined vocabulary, not a framework enum. The Clerk validates against `clerk.writTypes` in the apparatus config section but the framework imposes no meaning on the type name.
- Writ ids use the format `w-{base36_timestamp}{hex_random}` — sortable by creation time, unique without coordination. Not a formal ULID, but provides the same useful properties (temporal ordering, no coordination).
- The `transition()` method is the single choke point for all status changes. All tools and future integrations go through it. This is where validation, timestamp setting, and (future) event emission and hierarchy rollup happen.
- When the Clockworks is eventually added as a recommended dependency, resolve it at emit time via `guild().apparatus()`, not at startup — so the Clerk functions with or without it.

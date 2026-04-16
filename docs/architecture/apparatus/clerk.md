# The Clerk — API Contract

Status: **Draft**

Package: `@shardworks/clerk-apparatus` · Plugin id: `clerk`

---

## Purpose

The Clerk is the guild's obligation authority. It receives commissions from the patron, issues writs that formally record what is owed, manages the lifecycle of those writs through to completion or failure, and maintains the Ledger — the guild's book of work.

The Clerk owns the boundary between "what is asked for" and "how it gets done." A commission arrives; the Clerk creates a mandate writ. When work completes, the Clerk records the outcome. Connecting writs to sessions is the job of the rigging system — the Spider assembles rigs, and engines execute the work. The Clerk tracks the obligation, not the execution.

The Clerk does **not** execute work. It does not launch sessions, manage rigs, or orchestrate engines. It tracks obligations: what has been commissioned, what state each obligation is in, and whether the guild has fulfilled its commitments. When the Clockworks and rigging system exist, the Clerk will integrate with them via lifecycle events and signals.

Writs can be organized into parent/child hierarchies for decomposing complex work. A parent writ stays in `open` status while its children are being processed. Failure cascades upward (child failure fails the parent) and cancellation cascades downward (parent termination cancels non-terminal children).

---

## Dependencies

```
requires: ['stacks']
recommends: ['oculus']
```

- **The Stacks** (required) — persists writs in the `writs` book and links in the `links` book. All writ state lives here.
- **Oculus** (recommended) — provides observability dashboard.

---

## Kit Interface

The Clerk consumes `writTypes` kit contributions. Kits may declare writ types that are merged into the guild's type vocabulary at startup.

```typescript
consumes: ['writTypes']
```

---

## Support Kit

```typescript
supportKit: {
  books: {
    writs: {
      indexes: [
        'status', 'type', 'createdAt', 'parentId',
        ['status', 'type'], ['status', 'createdAt'], ['parentId', 'status'],
      ],
    },
    links: {
      indexes: ['sourceId', 'targetId', 'type', ['sourceId', 'type'], ['targetId', 'type']],
    },
  },
  tools: [
    commissionPost,
    writShow,
    writList,
    writComplete,
    writFail,
    writCancel,
    writPublish,
    writLink,
    writUnlink,
    writTypesTool,
  ],
},
```

### `commission-post` tool

Post a new commission. Creates a writ in `open` status by default, or in `new` (draft) status when `draft: true` is passed. Supports creating child writs via `parentId`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | yes | Short description of the work |
| `body` | `string` | yes | Full spec — what to do, acceptance criteria, context |
| `codex` | `string` | no | Target codex name (inherited from parent if omitted) |
| `type` | `string` | no | Writ type (default: `"mandate"`) |
| `draft` | `boolean` | no | When `true`, create in `new` status — held out of the queue until published (default: `false`, creates in `open`) |
| `parentId` | `string` | no | Create as child of this parent writ. Parent must be in `new` or `open` status. |

Returns the created `WritDoc`.

Permission: `clerk:write`

### `writ-show` tool

Read a writ by id. Returns the full `WritDoc` including status history, parent context, and children summary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |

Returns: `WritDoc` enriched with `links`, `parent` (`{ id, title, status }` or `null`), and `children` (`{ summary: Record<WritStatus, number>, items: Array<{ id, title, status }> }`).

Permission: `clerk:read`

### `writ-list` tool

List writs with optional filters. Returns writs ordered by `createdAt` descending.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `WritStatus` | no | Filter by status (all six values supported) |
| `type` | `string \| string[]` | no | Filter by writ type (repeatable — pass multiple to match any) |
| `parentId` | `string` | no | Filter to children of this parent writ |
| `limit` | `number` | no | Max results (default: 20) |

Permission: `clerk:read`

### `writ-complete` tool

Mark a writ as successfully completed. Transitions `open → completed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | yes | What was done — summary of the work delivered |

Permission: `clerk:write`

### `writ-fail` tool

Mark a writ as failed. Transitions `open → failed`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | yes | Why the work failed |

Permission: `clerk:write`

### `writ-cancel` tool

Cancel a writ. Transitions `new|open|stuck → cancelled`. If the writ has non-terminal children, they are automatically cancelled.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |
| `resolution` | `string` | no | Why the writ was cancelled |

Permission: `clerk:write`

### `writ-publish` tool

Publish a draft writ. Transitions `new → open`, placing it in the execution queue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |

Returns the updated `WritDoc`.

Permission: `clerk:write`

---

## `ClerkApi` Interface (`provides`)

```typescript
interface ClerkApi {
  // ── Commission Intake ─────────────────────────────────────────

  /**
   * Post a commission — create a writ in open status (or new if draft: true).
   *
   * This is the primary entry point for patron-originated work.
   * Creates a WritDoc and persists it to the writs book.
   * Draft writs (new status) are invisible to the Spider until published.
   *
   * When parentId is provided:
   * - The parent must be in new or open status.
   * - The child inherits the parent's codex if none is specified.
   * - The entire operation is atomic (single transaction).
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
   *   new   → open       (publish — enter the queue)
   *   new   → cancelled
   *   open  → completed
   *   open  → failed
   *   open  → cancelled
   *   open  → stuck      (engine failure cascade)
   *   stuck → open       (recovery/retry resumes execution)
   *   stuck → failed     (obligation abandoned)
   *   stuck → cancelled  (obligation withdrawn)
   *
   * The `fields` parameter allows setting additional fields
   * atomically with the transition (e.g. `resolution`).
   * Managed fields (id, status, timestamps, parentId) are stripped.
   *
   * CDC cascade behavior:
   * - Child failed → parent: failure propagates up
   * - Parent terminal → children: non-terminal children are cancelled
   */
  transition(id: string, to: WritStatus, fields?: Partial<WritDoc>): Promise<WritDoc>

  // ── Links ─────────────────────────────────────────────────────

  /** Create a typed directional link from one writ to another. Idempotent. */
  link(sourceId: string, targetId: string, type: string): Promise<WritLinkDoc>

  /** Query all links for a writ — both outbound and inbound. */
  links(writId: string): Promise<WritLinks>

  /** Remove a link. Idempotent. */
  unlink(sourceId: string, targetId: string, type: string): Promise<void>
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
  /** Parent writ id. Absent on root writs. Immutable after creation. */
  parentId?: string

  // ── Timestamps ──────────────────────────────────────────────

  /** When the writ was created. */
  createdAt: string
  /** When the writ was last modified. */
  updatedAt: string
  /** When terminal status was reached. */
  resolvedAt?: string

  // ── Resolution ───────────────────────────────────────────────

  /** Summary of how the writ resolved. Set on any terminal transition.
   *  What was done (completed), why it failed (failed), or why it
   *  was cancelled (cancelled). The `status` field distinguishes which. */
  resolution?: string
}

type WritStatus =
  | "new"         // Draft — held out of the queue, not yet published
  | "open"        // In the queue, available for dispatch
  | "stuck"       // Engine failure — needs attention, non-terminal
  | "completed"   // Work done successfully
  | "failed"      // Work failed
  | "cancelled"   // Cancelled by patron or system

interface PostCommissionRequest {
  title: string
  body: string
  codex?: string          // inherited from parent if omitted
  type?: string           // default: "mandate"
  draft?: boolean         // When true, create in 'new' status (default: false → 'open')
  parentId?: string       // Create as child of this writ
}

interface WritFilters {
  status?: WritStatus | WritStatus[]
  type?: string | string[]
  parentId?: string       // Filter to children of this parent writ
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
            │     new      │──────────────────┐
            └──────┬───────┘                  │
                   │                          │
               publish                     cancel
                   │                          │
                   ▼                          │
            ┌──────────────┐                  │
            │     open     │──────────┐       │
            └──┬───┬───┬───┘          │       │
               │   │   │              │       │
          complete │  fail          cancel    │
               │   │   │              │       │
               ▼   │   ▼              │       │
        ┌────────┐ │ ┌────────┐      │       │
        │completed│ │ │ failed │◀──┐  │       │
        └────────┘ │ └────────┘   │  │       │
                   │  stuck       │  │       │
                   ▼              │  │       │
            ┌──────────────┐  fail │  │       │
            │    stuck     │──────┘  │       │
            │ (non-terminal)│───cancel┤       │
            └──────┬───────┘         │       │
                   │ open            │       │
                   └──► (back to open)       │
                                     │       │
            ┌───────────┐            │       │
            │ cancelled │◀───────────┴───────┘
            │           │ (from new, open, or stuck)
            └───────────┘
```

Terminal statuses: `completed`, `failed`, `cancelled`. No transitions out of terminal states.

Non-terminal statuses: `new`, `open`, `stuck`. The `stuck` status represents an obligation whose rig hit an engine failure. It preserves the obligation for future retry. `stuck → open` is the recovery path; `stuck → failed` or `stuck → cancelled` abandon the obligation.

The `new` status is a pre-queue holding state. A writ in `new` status:
- Is **not** visible to the Spider's spawn phase (which queries exclusively for `open` writs)
- Can be reviewed, linked to other writs, and edited before entering the queue
- Must be explicitly published (`new → open`) via the `writ-publish` tool before it will be picked up
- Can be cancelled directly from `new` without ever entering the queue

---

## Parent/Child Hierarchies

Writs form a tree. A writ may be decomposed into child writs (tasks, steps, etc.) by creating children with `parentId`. The hierarchy enables:

- **Decomposition** — a broad commission broken into concrete tasks
- **Failure propagation** — child failure cascades upward, failing the parent
- **Cancellation cascade** — parent termination cancels all non-terminal children
- **Scope tracking** — the patron sees one mandate; the guild sees the tree

### Hierarchy Rules

- A writ may have zero or one parent (`parentId` is optional, immutable after creation).
- A writ may have zero or many children.
- Depth is not limited (but deep hierarchies are a design smell).
- Children inherit the parent's `codex` unless explicitly overridden.
- Parents must be in `new`, `open`, or `stuck` status to accept new children.

### CDC Cascade Behavior

The Clerk registers a Phase 1 CDC watcher on the `clerk/writs` book. When a writ's status changes:

**Upward cascade (child → parent):** When a child reaches a terminal status:
- If the child **failed** and the parent is in `open` or `stuck` status: the parent transitions to `failed` with resolution `'Child "<childId>" failed: <childResolution>'`. The parent's failure triggers downward cascade, cancelling remaining siblings.

**Downward cascade (parent → children):** When a writ reaches a terminal status, behavior depends on which terminal status the parent reached:
- If the parent reached **`failed`** or **`cancelled`**: all non-terminal children are cancelled with resolution `'Automatically cancelled due to parent termination'` (exported from `clerk.ts` as `CASCADE_PARENT_TERMINATION_RESOLUTION`).
- If the parent reached **`completed`**: non-terminal children are **not** cancelled. Their existence at this point indicates an upstream bookkeeping gap (typically a child-writ transition that lost a race against the parent's terminal write); the cascade logs a warning naming the parent and each non-terminal child rather than masking the discrepancy with a cancellation.

### Cascade Depth

A failure at leaf level cascades as: child fails (depth 1) → parent fails (depth 2) → siblings cancelled (depth 3 each) → each sibling's upward check returns early (depth 4). Well within the Stacks CDC cascade depth limit for reasonable hierarchies.

---

## Commission Intake Pipeline

Commission intake is a single synchronous step:

```
├─ 1. Patron calls commission-post (or ClerkApi.post())
├─ 2. Clerk validates input, generates ULID, creates WritDoc
├─ 3a. draft: false (default) → Clerk writes WritDoc with status: open
│       └─ Spider will pick up on next crawl tick
├─ 3b. draft: true → Clerk writes WritDoc with status: new
│       └─ Held out of queue; patron calls writ-publish to enter queue
└─ 3c. parentId provided → Clerk validates parent, creates child atomically
        └─ Parent stays in its current status (new or open)
```

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
| Writ signaled open | `{type}.open` | `{ writId, title, type, codex }` |
| `open → completed` | `{type}.completed` | `{ writId, resolution }` |
| `open → failed` | `{type}.failed` | `{ writId, resolution }` |
| `* → cancelled` | `{type}.cancelled` | `{ writId, resolution }` |

These events are what standing orders bind to. The canonical dispatch pattern:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "mandate.open", "summon": "artificer", "prompt": "Read your writ with writ-show and fulfill the commission. Writ id: {{writ.id}}" }
    ]
  }
}
```

### `signal()` Method

A new method on `ClerkApi`:

```typescript
/**
 * Signal that a writ is open for dispatch.
 *
 * Emits `{type}.open` into the Clockworks event stream.
 * In the full design, called after intake processing (Sage
 * decomposition, validation) completes. This is the signal
 * the Spider (or summon relay) listens for to begin execution.
 */
signal(id: string): Promise<void>
```

### Execution Integration

The Clerk integrates with the execution layer at two points:

**Outbound: Open Signal.** When a writ is signaled open, the Clockworks event stream carries it to standing orders. The Spider picks it up and spawns a rig to begin work. The Clerk does not know or care how the writ is executed — it signals readiness; the guild's configuration determines the response.

**Inbound: Completion Signal.** When work completes, the completing apparatus calls `clerk.transition(id, 'completed', { outcome })`. The Spider calls this when it strikes a completed rig. For direct-summon execution (standing orders), the anima calls `writ-complete` (which wraps `clerk.transition()`). Both paths converge on the same Clerk API.

### Intake with Planning

When Sage animas and the Clockworks are available, the intake pipeline gains a planning step:

```
├─ 1. Patron calls commission-post
├─ 2. Clerk creates mandate writ (status: open)
├─ 3. Clerk emits commission.posted
├─ 4. Standing order on commission.posted summons a Sage
├─ 5. Sage reads the mandate, creates child writs via post(parentId)
├─ 6. Parent stays in open, children created in open status
├─ 7. Clerk emits {childType}.open for each child
├─ 8. Standing orders on {childType}.open dispatch workers
├─ 9. As children complete, parent remains in open
└─ 10. Parent is completed explicitly when all work is done
```

The patron's experience doesn't change — they still call `commission-post`. The planning step is internal to the guild.

---

## Open Questions

- **Should `commission-post` be a permissionless tool?** It represents patron authority — commissions come from outside the guild. But Coco (running inside a session) needs to call it. Current thinking: gate it with `clerk:write` and grant that to the steward role.

- **Writ type validation — strict or advisory?** The Clerk validates against `clerk.writTypes` in config. But this means adding a new type requires a config change. Alternative: accept any string, use the config list only for documentation/tooling hints. Current thinking: strict validation — the guild should know its own vocabulary.

---

## Implementation Notes

- Standalone apparatus package at `packages/plugins/clerk/`. Requires only the Stacks.
- `WritDoc.type` uses a guild-defined vocabulary, not a framework enum. The Clerk validates against `clerk.writTypes` in the apparatus config section but the framework imposes no meaning on the type name.
- Writ ids use the format `w-{base36_timestamp}{hex_random}` — sortable by creation time, unique without coordination. Not a formal ULID, but provides the same useful properties (temporal ordering, no coordination).
- The `transition()` method is the single choke point for all status changes. All tools and future integrations go through it. This is where validation, timestamp setting, event emission, and hierarchy cascade happen.
- When the Clockworks is eventually added as a recommended dependency, resolve it at emit time via `guild().apparatus()`, not at startup — so the Clerk functions with or without it.
- Parent/child cascade uses a Phase 1 CDC watcher (`failOnError: true`) so cascade operations are transactional — if a cascade step fails, the triggering transition rolls back.
- `parentId` is immutable: stripped from managed fields in `transition()`, preventing mutation through the API.

# The Ratchet — API Contract

Status: **Draft**

Package: `@shardworks/ratchet-apparatus` · Plugin id: `ratchet`

> **⚠️ MVP scope.** MVP covers the click data model, Stacks books, status lifecycle, immutability enforcement, cross-substrate links, and CLI commands. Oculus visualization and the `commission` sugar command are deferred to follow-up commissions.

---

## Purpose

The Ratchet is the guild's decision-tracking authority. It manages **clicks** — atomic, immutable decision-nodes organized in a tree. Each click captures one question or inquiry; when resolved, it records the conclusion. The tree structure expresses decomposition and relationships between questions. Together, the click tree forms a structured record of the reasoning and decisions that guide the guild's work.

The Ratchet owns the inquiry domain. Clicks are always questions or inquiries, never tasks. Tasks are mandates managed by the Clerk. A click's conclusion may imply work, which becomes a commission (mandate) linked back to the originating click via a cross-substrate link. The Ratchet and Clerk are peer apparatus sharing the Stacks storage layer but managing fundamentally different lifecycles: the Clerk tracks obligations; the Ratchet tracks reasoning.

The Ratchet does **not** manage obligations, dispatch work, or orchestrate execution. It does not interact with Spider or the rigging system. It is a passive record-keeper for the decision graph.

### Design rationale

The Ratchet provides a purpose-built substrate for inquiry. A pilgrimage assessment (see References) found that storing inquiry records as writs in the Clerk's books created structural friction: the status model, Oculus views, CLI vocabulary, and body format were all optimized for obligations, and inquiry records were fighting the substrate at every surface. The click model addresses this by providing a dedicated substrate for inquiry with its own lifecycle, invariants, and tooling.

Key design principles:
- **Immutable on create.** A click's goal (the question being asked) is frozen at creation. If the framing is wrong, drop the click and create a new one. This eliminates body-editing complexity and ensures the decision record is append-only.
- **The tree is the product.** Value lives in the structure (hierarchy, relationships, decomposition), not in prose. Click bodies are minimal: a goal sentence and an optional conclusion paragraph. Long-form exploration lives in session transcripts, joinable via session ID.
- **Children are the todo list.** Open sub-questions become child clicks, not prose sections within a parent. The tree *is* the decomposition.
- **Four statuses, not six.** `live | parked | concluded | dropped` — designed for inquiry, not obligation.

---

## Dependencies

```
requires: ['stacks']
recommends: ['oculus']
```

- **The Stacks** (required) — persists clicks in the `clicks` book and links in the `click_links` book. All click state lives here.
- **Oculus** (recommended) — provides observability dashboard for the click tree.

---

## Kit Interface

None for MVP. The Ratchet does not consume kit contributions. Click types are not extensible — there is only one record type (click). This may evolve if other apparatus need to contribute link types or status extensions.

---

## Support Kit

```typescript
supportKit: {
  books: {
    clicks: {
      indexes: [
        'status', 'parentId', 'createdAt', 'resolvedAt',
        ['status', 'parentId'], ['status', 'createdAt'],
      ],
    },
    click_links: {
      indexes: [
        'sourceId', 'targetId', 'linkType',
        ['sourceId', 'linkType'], ['targetId', 'linkType'],
      ],
    },
  },
  tools: [
    clickCreate,
    clickShow,
    clickList,
    clickTree,
    clickExtract,
    clickPark,
    clickResume,
    clickConclude,
    clickDrop,
    clickLink,
    clickReparent,
  ],
},
```

---

## Data Model

### Click record

| Field | Type | Mutable | Description |
|-------|------|---------|-------------|
| `id` | `string` | no | Generated unique identifier |
| `parentId` | `string \| null` | yes (via reparent) | Parent click ID. Null = root node. |
| `goal` | `string` | **no** | The question or inquiry. Immutable after creation. |
| `status` | `ClickStatus` | yes (via transitions) | Current lifecycle state. |
| `conclusion` | `string \| null` | **write-once** | Decision rationale (concluded) or drop reason (dropped). Required for terminal states. Null while live/parked. Cannot be modified once set. |
| `createdSessionId` | `string` | no | Claude session ID at creation. Join key to archived transcript. |
| `resolvedSessionId` | `string \| null` | write-once | Session ID at conclusion/drop. Null while live/parked. |
| `createdAt` | `timestamp` | no | Creation time. |
| `resolvedAt` | `timestamp \| null` | write-once | Resolution time. Null while live/parked. |

### Click status

```typescript
type ClickStatus = 'live' | 'parked' | 'concluded' | 'dropped'
```

- **`live`** — actively being explored. The question is open and under consideration.
- **`parked`** — deliberately dormant. The question is valid but not being worked on now. Pick up later.
- **`concluded`** — a decision was reached. The `conclusion` field holds the verdict. Terminal.
- **`dropped`** — the question was abandoned without a decision (moot, reframed, duplicate, not worth pursuing). The `conclusion` field holds the reason. Terminal.

### Status transitions

```
live → parked       (park)
parked → live       (resume)
live → concluded    (conclude — conclusion required)
live → dropped      (drop — conclusion required)
parked → concluded  (conclude — conclusion required)
parked → dropped    (drop — conclusion required)
```

No transitions from terminal states. Concluded and dropped clicks are immutable.

### Click link record

| Field | Type | Description |
|-------|------|-------------|
| `sourceId` | `string` | The click this link originates from. |
| `targetId` | `string` | Target ID — may be a click ID or a writ ID (cross-substrate). |
| `linkType` | `ClickLinkType` | Relationship type. |
| `createdAt` | `timestamp` | When the link was created. |

### Link types

```typescript
type ClickLinkType = 'related' | 'commissioned' | 'supersedes' | 'depends-on'
```

- **`related`** — lateral cross-reference between clicks or between a click and a writ.
- **`commissioned`** — this click's conclusion produced a commission (mandate writ). Target is a writ ID.
- **`supersedes`** — this click replaces the target click (reframing, refinement).
- **`depends-on`** — this click cannot be concluded until the target is resolved.

---

## `RatchetApi` Interface (`provides`)

```typescript
interface RatchetApi {
  /** Create a new click. Goal is immutable after this call. */
  create(params: {
    goal: string
    parentId?: string
    sessionId: string
  }): Promise<Click>

  /** Get a click by ID. Supports short-ID prefix matching. */
  get(id: string): Promise<Click | null>

  /** List clicks with optional filters. */
  list(params?: {
    status?: ClickStatus | ClickStatus[]
    parentId?: string
    rootId?: string    // all descendants of this click
    limit?: number
    offset?: number
  }): Promise<Click[]>

  /** Park a live click (live → parked). */
  park(id: string): Promise<Click>

  /** Resume a parked click (parked → live). */
  resume(id: string): Promise<Click>

  /** Conclude a click with a decision (live|parked → concluded). */
  conclude(id: string, params: {
    conclusion: string
    sessionId: string
  }): Promise<Click>

  /** Drop a click without a decision (live|parked → dropped). */
  drop(id: string, params: {
    conclusion: string    // reason for dropping — required
    sessionId: string
  }): Promise<Click>

  /** Move a click to a new parent (or to root). */
  reparent(id: string, params: {
    parentId: string | null   // null = make root
  }): Promise<Click>

  /** Add a typed link between a click and another click or writ. */
  link(params: {
    sourceId: string
    targetId: string
    linkType: ClickLinkType
  }): Promise<ClickLink>

  /** Remove a link. */
  unlink(params: {
    sourceId: string
    targetId: string
    linkType: ClickLinkType
  }): Promise<void>

  /** Render a subtree as a structured document. */
  extract(rootId: string, params?: {
    full?: boolean        // include conclusions (default: goals only)
    format?: 'md' | 'json'
  }): Promise<string>

  /** Resolve a short ID prefix to a full ID. Throws on ambiguity. */
  resolveId(prefix: string): Promise<string>
}
```

### Supporting types

```typescript
interface Click {
  id: string
  parentId: string | null
  goal: string
  status: ClickStatus
  conclusion: string | null
  createdSessionId: string
  resolvedSessionId: string | null
  createdAt: string    // ISO timestamp
  resolvedAt: string | null
}

interface ClickLink {
  sourceId: string
  targetId: string
  linkType: ClickLinkType
  createdAt: string
}
```

---

## CLI Commands

All commands are registered under the `click` noun. Short ID prefix matching is supported on all `--id` parameters — the Ratchet resolves prefixes via `resolveId()` and errors on ambiguity.

### `click-create`

Create a new click.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `goal` | `string` | yes | The question or inquiry (immutable after creation) |
| `parent-id` | `string` | no | Parent click ID. Omit for root node. |

### `click-show`

Show a single click with its links and children summary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID (short prefix OK) |

### `click-list`

List clicks with filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `string` | no | Filter by status (repeatable) |
| `root-id` | `string` | no | Only descendants of this click |
| `limit` | `number` | no | Max results (default 20) |

### `click-tree`

Render the click tree with status indicators.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `root-id` | `string` | no | Subtree root. Omit for full forest. |
| `status` | `string` | no | Filter by status (repeatable) |
| `depth` | `number` | no | Max nesting depth |

### `click-extract`

Render a subtree as a structured markdown or JSON document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Subtree root |
| `full` | `boolean` | no | Include conclusions (default: goals only) |
| `format` | `string` | no | `md` (default) or `json` |

### `click-park`

Park a live click (live → parked).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID |

### `click-resume`

Resume a parked click (parked → live).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID |

### `click-conclude`

Conclude a click with a decision.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID |
| `conclusion` | `string` | yes | Decision rationale |

### `click-drop`

Drop a click without a decision.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID |
| `conclusion` | `string` | yes | Reason for dropping |

### `click-link`

Add a typed link.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source-id` | `string` | yes | Source click ID |
| `target-id` | `string` | yes | Target click or writ ID |
| `link-type` | `string` | yes | `related`, `commissioned`, `supersedes`, `depends-on` |

### `click-reparent`

Move a click to a new parent or to root.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Click ID to move |
| `parent-id` | `string` | no | New parent ID. Omit to make root (orphan). |

When `parent-id` is omitted, the click becomes a root node (parentId set to null).

---

## Immutability Enforcement

The Ratchet enforces two immutability constraints at the API level:

1. **Goal is frozen after creation.** Any attempt to modify `goal` after the initial `create()` call is rejected. If the question was framed wrong, the correct action is to drop the click and create a new one.

2. **Conclusion is write-once.** The `conclusion` field starts as null. It is set exactly once, by `conclude()` or `drop()`. Any subsequent attempt to modify it is rejected. Terminal clicks (concluded, dropped) are fully immutable — no field changes are allowed.

These constraints are enforced in the Ratchet plugin, not in Stacks. Stacks provides generic CRUD; the Ratchet adds the domain invariants.

---

## Tree Semantics

Parent/child in the click tree has one meaning: **decomposition**. A child click is a sub-question of the parent. Resolving the parent typically requires resolving (or deliberately dropping) the children.

Unlike the Clerk's writ tree, there is no status cascading. A parent click can be concluded even if some children are still live (the parent's conclusion might be "we answered the main question; remaining sub-questions are moot" — the children get dropped individually). This reflects the reality that inquiry trees are messier than obligation trees.

Circular parentage is rejected at the API level.

---

## Cross-Substrate Links

Click links can reference both click IDs and writ IDs in their `targetId` field. The Ratchet does not validate that the target exists in the other substrate — it stores the reference as-is. This is a deliberate design choice: cross-substrate referential integrity would couple the Ratchet to the Clerk, which violates their peer relationship.

The `commissioned` link type is the primary cross-substrate pattern: a click is concluded, a mandate writ is created from its conclusion, and a `commissioned` link connects them.

---

## Open Questions

- **ID format.** Should click IDs follow the same `w-{random}-{hash}` pattern as writs, or use a different prefix (e.g., `c-{random}-{hash}`) to make them visually distinguishable? A distinct prefix makes cross-substrate links unambiguous (you can tell whether a target is a click or a writ from the ID alone).

- **`extract` depth control.** Should `extract` support a `--depth` parameter like `tree`, or always render the full subtree? Full subtree is simpler; depth control is useful for large trees.

- **Stacks book registration generalization.** Clerk is currently the primary consumer of Stacks book registration. The Ratchet is the second plugin to own books. Verify that the registration API generalizes cleanly — if it was designed with Clerk-specific assumptions, those may need to be relaxed.

---

## Future: Commission Sugar

A `click-commission` CLI command that combines conclude + commission-post + link in one call:

```
nsg click-commission --id <click-id> \
  --conclusion "..." \
  --brief "..." | --brief-file <path>
```

This creates a mandate writ via the Clerk's commission-post, concludes the click, and creates a `commissioned` link. Deferred from MVP because it requires coordination between Ratchet and Clerk APIs.

When `--conclusion` is omitted, a default conclusion is generated: `"Commissioned as <writ-id>."` This covers the common case where the conclusion is simply "yes, do this" and the brief contains all the detail.

---

## Future: Oculus Click View

A purpose-built click visualization in Oculus — a tree or graph view, not a table. Requirements from the patron interview:

- Expandable tree with full nesting depth
- Status indicators per node (live/parked/concluded/dropped)
- Goal visible at each node without drilling in
- Conclusion visible on hover/click/detail pane
- Cross-substrate links visible
- Copyable click IDs
- Filter by status, subtree root

Stretch goals: graph visualization (nodes + edges), drag-and-drop reparenting, notecard-style spatial grouping.

---

## Implementation Notes

- **Reference implementation:** follow the Clerk plugin (`packages/plugins/clerk/`) as the architectural pattern. The Ratchet is structurally similar but simpler (no rig integration, no status cascading, fewer status values).
- **Package location:** `packages/plugins/ratchet/` in the framework monorepo.
- **Short ID resolution:** implement a `resolveId(prefix)` helper that queries the clicks book with a prefix match. Error if zero or multiple matches. This pattern may be worth extracting to Stacks as a shared utility if the Clerk adopts it too.
- **CDC:** all mutations flow through Stacks, so CDC events are emitted automatically. The Laboratory can observe click lifecycle events (created, status changed, concluded, dropped, reparented, linked) using the same CDC machinery it uses for writs.

---

## References

- Pilgrimage assessment: `docs/archive/design-sessions/click-model-assessment.md` (writ `w-mo0gias9`)
- Clerk apparatus (peer, architectural reference): `docs/architecture/apparatus/clerk.md`
- Stacks apparatus (storage layer): `docs/architecture/apparatus/stacks.md`
- Guild vocabulary: `docs/future/guild-vocabulary.md` (Ratchet to be added)
- Interview and friction catalog: session `0f6580e9-2f6f-48a9-9669-14d11161734e`

# The Clerk — API Contract

Status: **Draft**

Package: `@shardworks/clerk-apparatus` · Plugin id: `clerk`

---

## Purpose

The Clerk is the guild's obligation authority. It receives commissions from the patron, issues writs that formally record what is owed, manages the lifecycle of those writs through to completion or failure, and maintains the Ledger — the guild's book of work.

The Clerk owns the boundary between "what is asked for" and "how it gets done." A commission arrives; the Clerk creates a mandate writ. When work completes, the Clerk records the outcome. Connecting writs to sessions is the job of the rigging system — the Spider assembles rigs, and engines execute the work. The Clerk tracks the obligation, not the execution.

The Clerk does **not** execute work. It does not launch sessions, manage rigs, or orchestrate engines. It tracks obligations: what has been commissioned, what state each obligation is in, and whether the guild has fulfilled its commitments. When the Clockworks and rigging system exist, the Clerk will integrate with them via lifecycle events and signals.

Writs can be organized into parent/child hierarchies for decomposing complex work. A parent writ stays in `open` phase while its children are being processed. Failure cascades upward (child failure fails the parent) and cancellation cascades downward when a parent reaches `failed` or `cancelled` (its non-terminal children are auto-cancelled). When a parent reaches `completed`, any still-open children are left as-is and a warning is logged — see [CDC Cascade Behavior](#cdc-cascade-behavior).

Writ documents follow a Kubernetes-style spec/status split: **`phase`** is the Clerk-owned lifecycle state (the phase machine below), and **`status`** is a plugin-owned observation slot — a `Record<string, unknown>` keyed by plugin id where apparatuses like Spider record side-channel observations (last rig, stuck cause, progress ratchets). See [Spec/Status Convention](#specstatus-convention).

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

The Clerk consumes `writTypes` and `linkKinds` kit contributions. Kits may declare writ types that are merged into the guild's type vocabulary at startup, and link kinds that seed the kit-contributed link-kind registry.

```typescript
consumes: ['writTypes', 'linkKinds']
```

### `writTypes` contributions

Kits contribute writ types via the `writTypes` field on `ClerkKit` (or on an apparatus's `supportKit`). Each entry is a complete `WritTypeConfig` — see [Writ-Types Substrate](#writ-types-substrate) for the shape, per-field rules, and the mandate canonical example. Source precedence (built-in > guild config > kit) and the kit-vs-kit collision hard-fail are described there. A fresh-domain plugin-author walkthrough lives in [Adding writ types](../../guides/adding-writ-types.md).

### `linkKinds` registry

Kits contribute link-kind descriptors via the `linkKinds` field on `ClerkKit` (or on an apparatus's `supportKit`). Each entry takes the shape `{ id, description }`. The `id` must have the form `{pluginId}.{kebab-suffix}` (dot-separated, kebab-case suffix), where the prefix matches the contributing plugin's id. Malformed entries, mismatched prefixes, non-kebab suffixes, and duplicate ids all hard-fail at startup — a malformed or colliding kind that silently disappeared would be worse than a boot failure, because downstream consumers key on it.

The registry projection is exposed through `ClerkApi.listKinds()`, which returns `LinkKindDoc[]` — each entry pairs the fully-qualified id with the resolved `ownerPlugin` and the supplied `description`. Downstream consumers (tools, Oculus pages, other apparatuses) read the registry through that API; there is no direct access to the internal map.

Link rows attach a kind via the optional `kind` field on `WritLinkDoc`. The `kind` is the load-bearing identifier (stable, plugin-owned, validated against the registry). The `label` field is the casual, human-facing string (open, syntactically normalized, not validated against any registry). Every link row has a `label`; `kind` is `null` when no kind is attached. `link()` rejects unknown `kind` ids at call time with `Unknown link kind "<id>". Registered link kinds: ...`.

---

## Support Kit

```typescript
supportKit: {
  books: {
    writs: {
      indexes: [
        'phase', 'type', 'createdAt', 'parentId',
        ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase'],
      ],
    },
    links: {
      indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
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
    writLinkKinds,
    writLinkKindsShow,
    writTypesTool,
  ],
},
```

### `commission-post` tool

Post a new commission. Creates a writ in `open` phase by default, or in `new` (draft) phase when `draft: true` is passed. Supports creating child writs via `parentId`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | yes | Short description of the work |
| `body` | `string` | yes | Full spec — what to do, acceptance criteria, context |
| `codex` | `string` | no | Target codex name (inherited from parent if omitted) |
| `type` | `string` | no | Writ type (default: `"mandate"`) |
| `draft` | `boolean` | no | When `true`, create in `new` phase — held out of the queue until published (default: `false`, creates in `open`) |
| `parentId` | `string` | no | Create as child of this parent writ. Parent must be in `new` or `open` phase. |

Returns the created `WritDoc`.

Permission: `clerk:write`

### `writ-show` tool

Read a writ by id. Returns the full `WritDoc` including the current phase, parent context, and a children payload: `summary` tallies phases across the entire descendant subtree beneath the writ (grandchildren and deeper included; the writ itself is excluded), while `items` lists only direct children.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | yes | Writ id |

Returns: `WritDoc` enriched with `links`, `parent` (`{ id, title, phase }` or `null`), and `children` (`{ summary: Record<WritPhase, number>, items: Array<{ id, title, phase }> }`). `summary` counts every descendant grouped by phase (the whole subtree, not just depth 1); `items` stays direct-children-only.

Permission: `clerk:read`

### `writ-list` tool

List writs with optional filters. Returns writs ordered by `createdAt` descending.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `phase` | `WritPhase` | no | Filter by phase (all six values supported) |
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
   * Post a commission — create a writ in open phase (or new if draft: true).
   *
   * This is the primary entry point for patron-originated work.
   * Creates a WritDoc and persists it to the writs book.
   * Draft writs (new phase) are invisible to the Spider until published.
   *
   * When parentId is provided:
   * - The parent must be in new or open phase.
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
   * Transition a writ to a new phase.
   *
   * Enforces the phase machine — invalid transitions throw.
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
   * Managed fields (id, phase, timestamps, parentId, status) are
   * stripped. The observation slot `status` is plugin-owned and
   * must be written via setWritStatus() — transition() silently
   * strips any caller-supplied status field.
   *
   * CDC cascade behavior:
   * - Child failed → parent: failure propagates up
   * - Parent failed/cancelled → children: non-terminal children are cancelled
   * - Parent completed → children: non-terminal children are left as-is
   *   and a warning is logged (their existence indicates an upstream
   *   bookkeeping gap that should be investigated)
   */
  transition(id: string, to: WritPhase, fields?: Partial<WritDoc>): Promise<WritDoc>

  /**
   * Write (or overwrite) a plugin-owned sub-slot inside the writ's
   * observation `status` map. Each plugin uses its own pluginId key;
   * disjoint sub-slots do not clobber each other (read-modify-write
   * runs inside a Stacks transaction). Terminal transitions do not
   * clear the slot — observations persist for post-mortem analysis.
   */
  setWritStatus(writId: string, pluginId: string, value: unknown): Promise<WritDoc>

  // ── Links ─────────────────────────────────────────────────────

  /**
   * Create a labeled directional link from one writ to another.
   * Idempotent. When `kind` is supplied it must appear in the
   * kit-contributed link-kind registry; unknown ids throw.
   */
  link(sourceId: string, targetId: string, label: string, kind?: string): Promise<WritLinkDoc>

  /** Query all links for a writ — both outbound and inbound. */
  links(writId: string): Promise<WritLinks>

  /** Remove a link. Idempotent. */
  unlink(sourceId: string, targetId: string, label: string): Promise<void>

  /** List every kit-contributed link kind in the registry. */
  listKinds(): Promise<LinkKindDoc[]>
}
```

### Supporting Types

```typescript
interface WritDoc {
  /** Unique writ id (prefixed, sortable: `w-{base36_timestamp}-{hex_random}`). */
  id: string
  /** Writ type — guild vocabulary. e.g. "mandate", "task", "bug". */
  type: string
  /** Clerk-owned lifecycle state — the phase machine. */
  phase: WritPhase
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
  /** When terminal phase was reached. */
  resolvedAt?: string

  // ── Resolution ───────────────────────────────────────────────

  /** Summary of how the writ resolved. Set on any terminal transition.
   *  What was done (completed), why it failed (failed), or why it
   *  was cancelled (cancelled). The `phase` field distinguishes which. */
  resolution?: string

  // ── Observation slot ─────────────────────────────────────────

  /** Plugin-owned observation slot, keyed by plugin id. Side-channel
   *  observations (last rig, stuck cause, progress ratchets, etc.)
   *  written via setWritStatus(). Not part of the phase machine. */
  status?: Record<string, unknown>
}

type WritPhase =
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
  draft?: boolean         // When true, create in 'new' phase (default: false → 'open')
  parentId?: string       // Create as child of this writ
}

interface WritFilters {
  phase?: WritPhase | WritPhase[]
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
      {
        "name": "task",
        "states": [
          { "name": "new",       "classification": "initial",  "allowedTransitions": ["open", "cancelled"] },
          { "name": "open",      "classification": "active",   "allowedTransitions": ["completed", "failed", "cancelled"] },
          { "name": "completed", "classification": "terminal", "attrs": ["success"],   "allowedTransitions": [] },
          { "name": "failed",    "classification": "terminal", "attrs": ["failure"],   "allowedTransitions": [] },
          { "name": "cancelled", "classification": "terminal", "attrs": ["cancelled"], "allowedTransitions": [] }
        ],
        "childrenBehavior": {
          "allSuccess": { "transition": "completed", "copyResolution": true },
          "anyFailure": { "transition": "failed",    "copyResolution": true }
        }
      }
    ],
    "defaultType": "mandate"
  }
}
```

```typescript
interface ClerkConfig {
  writTypes?: WritTypeConfig[]
  defaultType?: string
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
| `writTypes` | `WritTypeConfig[]` | `[]` | Guild-declared writ types. Each entry is a complete `WritTypeConfig` — see [Writ-Types Substrate](#writ-types-substrate). The built-in type `mandate` is always valid regardless of this list. |
| `defaultType` | `string` | `"mandate"` | Default type when `commission-post` is called without a type. |

Both fields are optional. A guild with no `clerk` config (or an empty one) gets only the built-in `mandate` type with `defaultType: "mandate"` — enough to post commissions with no configuration.

> **Runtime wiring pending (requires T2/T3).** The `WritTypeConfig` shape and its validator are the authoritative description of a writ type. The runtime that promotes `ClerkConfig.writTypes` from the legacy `{ name, description }` entries into full `WritTypeConfig` lifecycle enforcement lands in the T2/T3 refactor. Until then, the Clerk treats `writTypes` entries as a vocabulary list: the `name` field gates posts, and the rest of each entry is preserved in config but not yet consulted by the phase machine. New code that declares types should use the `WritTypeConfig` shape today so no migration is needed once the runtime catches up.

---

## Writ-Types Substrate

Writ types are first-class lifecycle descriptors, not a vocabulary list. Each declared type carries its own state machine: named states, per-state classifications, semantic attribute tags, an outbound-transition graph, and optional aggregate children triggers. The built-in `mandate` type is one instance of this shape; `mandate`'s six-phase lifecycle (`new`, `open`, `stuck`, `completed`, `failed`, `cancelled`) is the canonical worked example below. For the conceptual framing of per-type lifecycles in guild vocabulary, see [The Guild Metaphor → Writ](../../guild-metaphor.md#writ). For a plugin-author walkthrough of declaring a new type end-to-end, see [Adding writ types](../../guides/adding-writ-types.md).

The substrate composes with the rest of the Clerk:

- **Phase machine** — the validated transition graph declared by each type's `allowedTransitions` is the phase machine the Clerk enforces for that type. A writ of type `T` may only transition between states declared by `T`'s config.
- **Parent/child cascade** — the CDC cascade on the `clerk/writs` book (see [Parent/Child Hierarchies](#parentchild-hierarchies)) routes terminal-child outcomes back through the parent's declared `childrenBehavior` triggers, mapping "all children succeeded" / "any child failed" events onto the parent's declared target state.
- **Spider dispatch** — the Spider's `rigTemplateMappings` (see [Spider → Configuration → Plugin-default template and mapping](spider.md#plugin-default-template-and-mapping)) keys off the writ's `type` string. Declaring a new writ type here does not dispatch it automatically; a matching entry must exist (or be contributed by a kit) in `spider.rigTemplateMappings`.

### Classification vs. attrs

A state's **classification** answers "where does this state sit on the lifecycle?" — `initial` (entry point, exactly one per type), `active` (mid-flight, freely entered and left), or `terminal` (absorbing; no outbound transitions). Classification is structural and drives validator invariants (initial-count, terminal-has-no-outbound, non-initial-has-inbound).

A state's **attrs** answer "what does this terminal outcome *mean*?" — `success`, `failure`, `cancelled`, `stuck`, or any custom string. Attrs are semantic tags downstream consumers key on. The canonical example: `childrenBehavior.allSuccess` fires when every child is terminal *and* every child's state carries the `success` attr. Classification partitions the state; attrs label it.

```typescript
// Example — a terminal state can be *classified* terminal and *tagged* with
// a meaning downstream triggers key on. Two separate fields.
{
  name: 'completed',
  classification: 'terminal',   // where it sits on the lifecycle
  attrs: ['success'],           // what the outcome means
  allowedTransitions: [],
}
```

A state may carry zero, one, or many attrs. An `active` state may still carry attrs if downstream consumers want to tag it — the validator places no attrs-only restriction.

### Source precedence

Writ types come from three sources, in precedence order:

1. **Built-in.** The framework's sole built-in type is `mandate`. It is always valid and cannot be shadowed out of existence. Its name is exported as `BUILTIN_WRIT_TYPE`.
2. **Guild config.** Entries declared in `clerk.writTypes` in `guild.json`. Guild config wins over any kit contribution claiming the same name — the guild operator's declared vocabulary is authoritative.
3. **Kit.** Entries contributed through a plugin's `ClerkKit.writTypes` (see [Kit Interface](#kit-interface)). Scanned at startup via the Wire-phase kit snapshot.

Resolution rules:

- **Built-in vs. kit.** A kit that re-declares the built-in `mandate` type is silently skipped — the built-in is already valid, the contribution is redundant but harmless.
- **Config vs. kit.** A kit whose type name matches a `clerk.writTypes` entry is silently skipped. Operators override kit contributions by declaring the same name in config.
- **Kit vs. kit.** Two kits contributing a type with the same name is a hard startup failure. The Clerk throws, naming both kits and the conflicting type; the error instructs the operator to remove one contribution or override via `clerk.writTypes`. A colliding type that silently resolved one way or the other would be worse than a boot failure — downstream consumers key on the lifecycle declared by the winner, and kit load order is not a stable resolution signal. This same fail-loud rule applies framework-wide at every kit-vs-kit merge site (Clerk `writTypes`, Spider `rigTemplateMappings` and `blockTypes`, Fabricator engine designs).

`ClerkApi.listWritTypes()` surfaces the merged registry with each entry's `source` field set to `"builtin"`, `"guild"`, or the contributing plugin id.

### Schema reference

The structural shape is exported from `@shardworks/clerk-apparatus`:

```typescript
import {
  validateWritTypeConfig,
  type WritTypeConfig,
  type WritTypeStateDefinition,
  type WritTypeStateClassification,
  type WritTypeStateAttr,
  type KnownWritTypeStateAttr,
  type WritTypeChildrenBehavior,
  type WritTypeChildrenBehaviorAction,
} from '@shardworks/clerk-apparatus';
```

Every kit contribution and every guild-config entry is a `WritTypeConfig`. The validator `validateWritTypeConfig(config)` throws a plain `Error` on the first structural violation and returns `void` on success. Error messages take the shape `[clerk] writTypeConfig.<path>: <problem>; received <value>` — the `<path>` names the offending field (e.g. `states[2].classification`, `childrenBehavior.anyFailure.transition`).

> **Runtime wiring pending (requires T2/T3).** The per-type `allowedTransitions` graph driving `transition()` enforcement, the `childrenBehavior` triggers firing on child-terminal events, and kit contributions running through `validateWritTypeConfig()` at registration time are the target behaviour. Today's Clerk enforces a single hard-coded `mandate`-shaped transition table (`ALLOWED_FROM` in `clerk.ts`) and a hard-coded upward-failure cascade. The field-level semantics below are the contract the T2/T3 runtime is written against; the validator rules are already shipped and enforced at the structural level.

#### `WritTypeConfig`

The top-level shape describing one writ type.

```typescript
interface WritTypeConfig {
  name: string;
  states: WritTypeStateDefinition[];
  childrenBehavior?: WritTypeChildrenBehavior;
}
```

- **`name`** — the writ type name. Must be a non-empty string; no format rules beyond non-emptiness are imposed by the validator. Uniqueness across the merged registry is enforced by the source-precedence rules above, not by `validateWritTypeConfig`.
- **`states`** — the lifecycle states for this type. Must be a non-empty array. Validator rules: exactly one state classified `initial`; every non-initial state must have at least one inbound transition from some other state; terminal states must declare no outbound transitions.
- **`childrenBehavior`** — optional aggregate-children triggers. When absent, the type declares no children-driven lifting.

Valid (mandate-shaped minimum):

```typescript
{
  name: 'task',
  states: [
    { name: 'new',       classification: 'initial',  allowedTransitions: ['completed'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
  ],
}
```

Invalid — empty `name` triggers `[clerk] writTypeConfig.name: must be a non-empty string; received ""`:

```typescript
{ name: '', states: [/* … */] }
```

#### `WritTypeStateDefinition`

One state's complete description.

```typescript
interface WritTypeStateDefinition {
  name: string;
  classification: WritTypeStateClassification;
  attrs?: WritTypeStateAttr[];
  allowedTransitions: string[];
}
```

- **`name`** — non-empty string, unique within the config. Duplicate names fail with `states[<i>].name: duplicate state name`.
- **`classification`** — one of `'initial' | 'active' | 'terminal'`. Any other value fails with `states[<i>].classification: must be one of initial, active, terminal`.
- **`attrs`** — optional array of semantic tags. When provided, every entry must be a non-empty string. Empty-string entries fail with `states[<i>].attrs[<a>]: must be a non-empty string`.
- **`allowedTransitions`** — outbound edge list. Every entry must be a non-empty string referencing a state that exists in the same config; unknown targets fail with `states[<i>].allowedTransitions[<t>]: references unknown state "<target>"`. Terminal states must declare an empty array; a terminal state with any outbound edge fails with `states[<i>].allowedTransitions: terminal state "<name>" must not declare any outbound transitions`.

Valid:

```typescript
{ name: 'open', classification: 'active', allowedTransitions: ['completed', 'cancelled'] }
```

Invalid — terminal state with an outbound edge:

```typescript
{ name: 'completed', classification: 'terminal', allowedTransitions: ['open'] }
// → states[<i>].allowedTransitions: terminal state "completed" must not declare any outbound transitions
```

#### `WritTypeStateClassification`

```typescript
type WritTypeStateClassification = 'initial' | 'active' | 'terminal';
```

A closed three-value union describing a state's structural role:

- **`initial`** — the entry state. Exactly one state per config must carry this classification; zero and multiple are both rejected (`states: must contain exactly one state with classification "initial" …`).
- **`active`** — a mid-flight state. Writs may enter and leave `active` states freely via declared transitions. Every non-initial state (active or terminal) must have at least one inbound edge from some other state.
- **`terminal`** — an absorbing state. Must declare zero outbound transitions.

Valid: a three-state cycle-free config `initial → active → terminal` is well-formed.

Invalid — two initial states: `states: must contain exactly one state with classification "initial" (found 2: new, draft)`.

#### `WritTypeStateAttr` / `KnownWritTypeStateAttr`

```typescript
type KnownWritTypeStateAttr =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'stuck';

type WritTypeStateAttr = KnownWritTypeStateAttr | (string & {});
```

A state's attribute vocabulary. Known values surface in editor autocomplete; the open `string` branch is an escape hatch so plugin-contributed types can declare new attrs without a coordinated release.

Downstream meaning of each known attr:

| Attr | Meaning |
|------|---------|
| `success` | This terminal state represents a successful outcome. `childrenBehavior.allSuccess` fires only when every terminal child carries this attr. |
| `failure` | This terminal state represents a failure outcome. `childrenBehavior.anyFailure` fires when any terminal child carries this attr. |
| `cancelled` | This terminal state represents withdrawal — the obligation was neither fulfilled nor failed. Purely descriptive today; consumed by observability surfaces rather than triggers. |
| `stuck` | This state represents an obligation whose rig hit an engine failure and is awaiting attention. Typically attached to a non-terminal `active` state, not a terminal one. |

**When to add a known attr vs. a custom tag.** Reach for a known attr when the downstream consumer that reads it is already in the framework — `allSuccess` reads `success`, the Spider's observability surface reads `stuck`, etc. Reach for a custom string when your kit is the only consumer and the tag names something domain-specific (e.g. `'approved'`, `'blocked-on-legal'`). Under-tagging is the more common failure mode than over-tagging: a terminal state missing the `success` attr will silently prevent `childrenBehavior.allSuccess` from firing.

Valid: `attrs: ['success']`. Valid (forward-compatible custom tag): `attrs: ['approved']`.

Invalid — empty-string attr entry: `states[<i>].attrs[<a>]: must be a non-empty string; received ""`.

#### `WritTypeChildrenBehavior`

```typescript
interface WritTypeChildrenBehavior {
  allSuccess?: WritTypeChildrenBehaviorAction;
  anyFailure?: WritTypeChildrenBehaviorAction;
}
```

Aggregate-children triggers. Both fields are optional; a config with no `childrenBehavior` declares no children-driven lifting. When present, `childrenBehavior` must be an object — strings, numbers, and primitives fail with `childrenBehavior: must be an object when provided`.

- **`allSuccess`** — fires when every child writ has reached a terminal state *and* every such state carries the `success` attr.
- **`anyFailure`** — fires when any child writ has reached a terminal state that carries the `failure` attr.

Valid (both triggers declared, both targeting a `completed`/`failed` pair):

```typescript
{
  allSuccess: { transition: 'completed', copyResolution: true },
  anyFailure: { transition: 'failed',    copyResolution: true },
}
```

Valid (single trigger only):

```typescript
{ allSuccess: { transition: 'completed' } }
```

Invalid — non-object `childrenBehavior`: `childrenBehavior: must be an object when provided; received "oops"`.

> **Runtime wiring pending (requires T2/T3).** The semantics below describe the target cascade; today's Clerk wires only the hard-coded mandate-flavored behaviour (upward failure only, resolution `'Child "<id>" failed: <resolution>'`).
>
> - **Trigger firing** — `allSuccess` fires when the last non-terminal child becomes terminal *and* every terminal child carries the `success` attr. `anyFailure` fires when any child reaches a terminal state carrying the `failure` attr.
> - **Idempotency** — the parent transition driven by a trigger runs at most once per parent. Repeated fires of the same trigger are observed but not re-applied; the parent has already moved to the target state.
> - **Short-circuit** — when both triggers match against the same child-terminal event, `anyFailure` wins. Only the first trigger to match fires on a given CDC event; the other is skipped for this event and not re-evaluated on later child terminals because the parent has already left its source state.
> - **`copyResolution`** — when `true`, the consumer copies the triggering child's `resolution` string onto the parent as part of the transition. When `false` or omitted, the parent's resolution is left to the transition call itself (or stays unset).

#### `WritTypeChildrenBehaviorAction`

```typescript
interface WritTypeChildrenBehaviorAction {
  transition: string;
  copyResolution?: boolean;
}
```

- **`transition`** — target state name the parent writ transitions to when the trigger fires. Must be a non-empty string referencing a state that exists in the enclosing `WritTypeConfig.states`. Also subject to a reachability check: the target must be reachable from every non-terminal state via `allowedTransitions`, so the trigger can actually move the parent no matter which non-terminal state the parent is currently in. Unreachable targets fail with `childrenBehavior.<trigger>.transition: state "<target>" is not reachable from non-terminal state "<origin>" via allowedTransitions`.
- **`copyResolution`** — optional boolean. Non-boolean values fail with `childrenBehavior.<trigger>.copyResolution: must be a boolean when provided`.

Empty action objects are rejected — `{}` fails with `childrenBehavior.<trigger>: must not be an empty object`. Actions without a `transition` field (e.g. `{ copyResolution: true }`) fail with `childrenBehavior.<trigger>.transition: must be a non-empty string`.

Valid: `{ transition: 'completed', copyResolution: true }`.

Invalid — target that exists but is not reachable from some non-terminal state:

```typescript
// With an extra `isolated` active state whose only outbound edge is to `cancelled`,
// `completed` is unreachable from `isolated`.
{ allSuccess: { transition: 'completed' } }
// → childrenBehavior.allSuccess.transition: state "completed" is not reachable
//   from non-terminal state "isolated" via allowedTransitions
```

#### `validateWritTypeConfig(config: WritTypeConfig): void`

The pure structural validator. Throws a plain `Error` on the first structural violation; returns `void` on success. The validator is the one true source for every structural rule referenced above — consumers should run every `WritTypeConfig` through it at registration time rather than duplicating checks.

Top-down ordering of checks (stops at the first failure):

1. `name` is a non-empty string.
2. `states` is a non-empty array.
3. Each state has a non-empty `name`, with no duplicates.
4. Each state's `classification` is one of the three known values.
5. Every `allowedTransitions` entry is a string referencing a state that exists in the same config.
6. Exactly one state is classified `initial`.
7. Every non-initial state has at least one inbound transition from some other state.
8. No terminal state declares any outbound transitions.
9. Every declared `childrenBehavior` trigger carries an action object with a non-empty `transition` string referencing a state that exists.
10. Each `childrenBehavior` transition target is reachable from every non-terminal state of the config via `allowedTransitions`.

### Canonical example: mandate

The built-in `mandate` type's full `WritTypeConfig`. This is the fixture every other example is calibrated against — it mirrors the Clerk's currently-enforced mandate phase machine (`ALLOWED_FROM` in `clerk.ts`) and is the happy-path fixture in `writ-type-config.test.ts`.

```typescript
const mandateConfig: WritTypeConfig = {
  name: 'mandate',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    {
      name: 'open',
      classification: 'active',
      allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'],
    },
    {
      name: 'stuck',
      classification: 'active',
      allowedTransitions: ['open', 'failed', 'cancelled'],
    },
    {
      name: 'completed',
      classification: 'terminal',
      attrs: ['success'],
      allowedTransitions: [],
    },
    {
      name: 'failed',
      classification: 'terminal',
      attrs: ['failure'],
      allowedTransitions: [],
    },
    {
      name: 'cancelled',
      classification: 'terminal',
      attrs: ['cancelled'],
      allowedTransitions: [],
    },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'completed', copyResolution: true },
    anyFailure: { transition: 'failed', copyResolution: true },
  },
};
```

Traits worth reading off the fixture:

- **One `initial`, three `terminal`, two `active` states.** The classification partition is explicit.
- **`stuck` is `active`, not terminal.** Non-terminal means the obligation survives — `stuck → open` is a declared recovery edge.
- **Every `childrenBehavior` target is reachable from every non-terminal state.** `completed` is reachable from `new` (via `open`), from `open` (directly), and from `stuck` (via `open`). Similarly `failed`. The reachability invariant is what lets the trigger fire regardless of where the parent sits when a child terminates.
- **Only terminal states carry `attrs`.** Nothing forbids active-state attrs; `mandate` simply has no domain-specific tag for its active states.

### Cross-reference: Spider dispatch

Declaring a new writ type through `clerk.writTypes` (or a kit) makes the type valid for `commission-post` but does not dispatch it. Dispatch is opt-in per type and is owned by the Spider's `rigTemplateMappings`. A writ whose type has no mapping sits in `open` indefinitely until a mapping is added (or the writ is cancelled / completed manually). The recommended reading order for plugin authors declaring a new type is: declare the type here → register (or declare) a mapping in [Spider → `rigTemplateMappings`](spider.md#plugin-default-template-and-mapping) → only then does posting a writ of that type spawn a rig. See also the [plugin-author walkthrough](../../guides/adding-writ-types.md) for an end-to-end kit example.

---

## Phase Machine (mandate)

The mandate type's phase machine — the canonical worked example of the substrate above, and the set of transitions the Clerk currently hard-enforces via `ALLOWED_FROM`. Other writ types declare their own; this diagram is mandate-specific.

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

Terminal states (for mandate): `completed`, `failed`, `cancelled`. No transitions out of terminal states.

Non-terminal states (for mandate): `new`, `open`, `stuck`. The `stuck` state represents an obligation whose rig hit an engine failure. It preserves the obligation for future retry. `stuck → open` is the recovery path; `stuck → failed` or `stuck → cancelled` abandon the obligation.

The `new` state is a pre-queue holding state. A mandate in `new` phase:
- Is **not** visible to the Spider's spawn phase (which queries exclusively for `open` writs)
- Can be reviewed, linked to other writs, and edited before entering the queue
- Must be explicitly published (`new → open`) via the `writ-publish` tool before it will be picked up
- Can be cancelled directly from `new` without ever entering the queue

Types that declare their own lifecycle may adopt the same `new → open → terminal` skeleton or diverge (a pure-planning type might drop `stuck`; a long-running type might add additional active states). The Clerk enforces whatever transitions the type's `WritTypeConfig` declares once T2/T3 wiring lands; until then, non-mandate types share the mandate transition table.

---

## Spec/Status Convention

Writ documents follow a Kubernetes-style spec/status split:

- **Spec fields** are the declared intent of the writ — `title`, `body`, `type`, `codex`, `parentId`, and the Clerk-owned lifecycle field `phase`. These describe *what should happen* and *where the writ currently sits on the phase machine*. `transition()` is the only writer for `phase`.
- **Status slot** (`status` on `WritDoc`) is a free-form `Record<string, unknown>` keyed by plugin id. Each plugin owns one sub-slot and records side-channel observations there: last rig, stuck cause, progress ratchets, planner version, etc. `setWritStatus()` is the only writer for the slot.

### Rules

- **Plugin ownership is a soft convention.** Each plugin writes only under its own pluginId key. No runtime guard stops a plugin from reading another plugin's sub-slot — the convention is *write only your own key*, and the `setWritStatus()` API makes the right thing easy.
- **One sanctioned slot-write path.** The observation slot is writable only via `setWritStatus()`, which performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers. `transition()` silently drops `status` from its body alongside the other managed fields. The generic `put()` / `patch()` paths on the `clerk/writs` book are not supported slot-write mechanisms — every route other than `setWritStatus()` would wholesale-replace the slot and clobber sibling sub-slots.
- **Disjoint sub-slots are concurrency-safe.** `setWritStatus()` runs its read-modify-write inside a Stacks transaction. Concurrent writes from different plugins to different sub-slots do not clobber each other.
- **Within a single plugin's sub-slot, writes are last-writer-wins.** `setWritStatus()` replaces the plugin's sub-slot value wholesale — per-key atomicity inside a sub-slot is deferred until real contention appears.
- **Slot writes emit CDC events.** Changes to the `status` slot propagate through the same `update` events on the `clerk/writs` book as any other field change; downstream watchers can react.
- **Terminal transitions do not clear the slot.** Observations persist on the writ after `completed`/`failed`/`cancelled` for post-mortem inspection.

### Worked example: `status.spider.stuckCause`

When Spider's engine fails for a writ, it transitions the writ to `stuck` (a phase change) *and* records the diagnostic cause in its sub-slot (an observation):

```typescript
// In Spider's engine-failure handler:
await clerk.transition(writ.id, 'stuck', { resolution: 'Engine "implement-loop" failed' });
await clerk.setWritStatus(writ.id, 'spider', {
  stuckCause: 'engine-failed',
  lastRig: rig.id,
  failedEngine: 'implement-loop',
});

// A triage tool later inspects the slot:
const writ = await clerk.show(writId);
const spiderStatus = (writ.status ?? {})['spider'] as
  | { stuckCause?: string; lastRig?: string; failedEngine?: string }
  | undefined;

if (spiderStatus?.stuckCause === 'engine-failed') {
  console.log(`Stuck in rig ${spiderStatus.lastRig} at engine ${spiderStatus.failedEngine}`);
}
```

The phase (`stuck`) is the authoritative lifecycle state — queries, cascades, and the phase machine all reason from it. The observation (`status.spider.stuckCause`) is diagnostic context that survives alongside the phase without becoming part of the state machine itself.

### Guild-wide extensibility

The spec/status split is guild-wide in intent, not a writs-only pattern. Other runtime objects — **rigs**, **engines**, **sessions**, **input requests**, **clicks**, and future apparatuses' primary objects — will adopt the same split on a per-consumer basis: the owning apparatus keeps the lifecycle field (renaming its current `status` to `phase` when the time comes), and a new plugin-keyed `status: Record<string, unknown>` slot appears when the first observation-slot consumer materializes. Until that trigger arrives, those objects keep their existing `status` field unchanged — the convention rolls out one object at a time, not in a big-bang migration. Apparatus authors adding a new primary object whose state may gain observations should reach for the spec/status shape from day one to avoid the rename later.

---

## Parent/Child Hierarchies

Writs form a tree. A writ may be decomposed into child writs (tasks, steps, etc.) by creating children with `parentId`. The hierarchy enables:

- **Decomposition** — a broad commission broken into concrete tasks
- **Failure propagation** — child failure can be lifted onto the parent via the parent type's `childrenBehavior.anyFailure` trigger
- **Cancellation cascade** — when a parent terminates in a state carrying the `failure` or `cancelled` attr, its non-terminal children are auto-cancelled (a successful terminal leaves them in place and warns instead)
- **Scope tracking** — the patron sees one writ; the guild sees the tree

### Hierarchy Rules

- A writ may have zero or one parent (`parentId` is optional, immutable after creation).
- A writ may have zero or many children.
- Depth is not limited (but deep hierarchies are a design smell).
- Children inherit the parent's `codex` unless explicitly overridden.
- Parents must be in a non-terminal state to accept new children (for mandate: `new`, `open`, or `stuck`).

### CDC Cascade Behavior

The Clerk registers a Phase 1 CDC watcher on the `clerk/writs` book. When a writ's phase changes:

**Upward cascade (child → parent).** Child-terminal events are routed through the parent type's [`childrenBehavior`](#writtypechildrenbehavior) triggers.

> **Runtime wiring pending (requires T2/T3).** The cascade currently hard-codes mandate-flavored upward failure: when a child terminates in `failed` and the parent is in `open` or `stuck`, the parent transitions to `failed` with resolution `'Child "<childId>" failed: <childResolution>'`. The target behaviour: the CDC handler reads the parent type's `childrenBehavior`; `anyFailure` fires when the terminating child's state carries the `failure` attr, and `allSuccess` fires when every child is terminal and every such state carries the `success` attr. The parent transitions to the action's declared `transition` target state; if `copyResolution: true`, the child's resolution is copied onto the parent transition. Triggers are idempotent per parent (at most one cascade fire per parent), and `anyFailure` short-circuits against `allSuccess` when both would match the same event.

**Downward cascade (parent → children).** When a parent reaches a terminal state, behavior depends on which attrs that state carries:
- If the parent's terminal state carries the `failure` or `cancelled` attr (for mandate: `failed` or `cancelled`): all non-terminal children are cancelled with resolution `'Automatically cancelled due to parent termination'` (exported from `clerk.ts` as `CASCADE_PARENT_TERMINATION_RESOLUTION`).
- If the parent's terminal state carries the `success` attr (for mandate: `completed`): non-terminal children are **not** cancelled. Their existence at this point indicates an upstream bookkeeping gap (typically a child-writ transition that lost a race against the parent's terminal write); the cascade logs a warning naming the parent and each non-terminal child rather than masking the discrepancy with a cancellation.

> **Runtime wiring pending (requires T2/T3).** The downward cascade currently keys on the raw mandate phase names (`completed` vs. `failed`/`cancelled`). The target behaviour reads the parent's terminal-state attrs from the type config, so a type that declares its own terminal names (`shipped`, `killed`, …) participates in the same cascade without the Clerk growing a type-aware switch.

### Cascade Depth

A failure at leaf level cascades as: child fails (depth 1) → parent fails (depth 2) → siblings cancelled (depth 3 each) → each sibling's upward check returns early (depth 4). Well within the Stacks CDC cascade depth limit for reasonable hierarchies.

---

## Commission Intake Pipeline

Commission intake is a single synchronous step:

```
├─ 1. Patron calls commission-post (or ClerkApi.post())
├─ 2. Clerk validates input, generates ULID, creates WritDoc
├─ 3a. draft: false (default) → Clerk writes WritDoc with phase: open
│       └─ Spider will pick up on next crawl tick
├─ 3b. draft: true → Clerk writes WritDoc with phase: new
│       └─ Held out of queue; patron calls writ-publish to enter queue
└─ 3c. parentId provided → Clerk validates parent, creates child atomically
        └─ Parent stays in its current phase (new or open)
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

The Clerk emits events into the Clockworks event stream at each phase transition. Event names use the writ's `type` as the namespace, matching the framework event catalog.

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
├─ 2. Clerk creates mandate writ (phase: open)
├─ 3. Clerk emits commission.posted
├─ 4. Standing order on commission.posted summons a Sage
├─ 5. Sage reads the mandate, creates child writs via post(parentId)
├─ 6. Parent stays in open, children created in open phase
├─ 7. Clerk emits {childType}.open for each child
├─ 8. Standing orders on {childType}.open dispatch workers
├─ 9. As children complete, parent remains in open
└─ 10. Parent is completed explicitly when all work is done
```

The patron's experience doesn't change — they still call `commission-post`. The planning step is internal to the guild.

---

## Open Questions

- **Should `commission-post` be a permissionless tool?** It represents patron authority — commissions come from outside the guild. But Coco (running inside a session) needs to call it. Current thinking: gate it with `clerk:write` and grant that to the steward role.

---

## Implementation Notes

- Standalone apparatus package at `packages/plugins/clerk/`. Requires only the Stacks.
- `WritDoc.type` uses a guild-defined vocabulary, not a framework enum. The Clerk validates against `clerk.writTypes` in the apparatus config section but the framework imposes no meaning on the type name.
- Writ ids use the format `w-{base36_timestamp}-{hex_random}`, produced by `generateId('w', 6)` — sortable by creation time, unique without coordination. Not a formal ULID, but provides the same useful properties (temporal ordering, no coordination).
- The `transition()` method is the single choke point for all phase changes. All tools and future integrations go through it. This is where validation, timestamp setting, event emission, and hierarchy cascade happen. The observation slot `status` is a managed field stripped from the body alongside `id`, `phase`, timestamps, and `parentId`; the one sanctioned slot-write path is `setWritStatus()`, which performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers.
- When the Clockworks is eventually added as a recommended dependency, resolve it at emit time via `guild().apparatus()`, not at startup — so the Clerk functions with or without it.
- Parent/child cascade uses a Phase 1 CDC watcher (`failOnError: true`) so cascade operations are transactional — if a cascade step fails, the triggering transition rolls back.
- `parentId` is immutable: stripped from managed fields in `transition()`, preventing mutation through the API.

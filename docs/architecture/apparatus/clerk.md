# The Clerk — API Contract

Status: **Draft**

Package: `@shardworks/clerk-apparatus` · Plugin id: `clerk`

---

## Purpose

The Clerk is the guild's obligation authority. It receives commissions from the patron, issues writs that formally record what is owed, manages the lifecycle of those writs through to completion or failure, and maintains the Ledger — the guild's book of work.

The Clerk owns the boundary between "what is asked for" and "how it gets done." A commission arrives; the Clerk creates a mandate writ. When work completes, the Clerk records the outcome. Connecting writs to sessions is the job of the rigging system — the Spider assembles rigs, and engines execute the work. The Clerk tracks the obligation, not the execution.

The Clerk does **not** execute work. It does not launch sessions, manage rigs, or orchestrate engines. It tracks obligations: what has been commissioned, what state each obligation is in, and whether the guild has fulfilled its commitments. When the Clockworks and rigging system exist, the Clerk will integrate with them via lifecycle events and signals.

Writs can be organized into parent/child hierarchies for decomposing complex work. The Clerk's children-behavior engine consumes each type's `WritTypeConfig.childrenBehavior` block to drive both cascade directions automatically: terminal children can lift the parent (upward `allSuccess` / `anyFailure`), and a parent reaching a `failure`- or `cancelled`-attr terminal can cancel every non-terminal descendant (downward `parentTerminal`). Cascade is opt-in per type — a type whose config omits `childrenBehavior` evolves independently from its parent and children. Mandate opts into all three triggers; see [Children-behavior cascade](#children-behavior-cascade).

Writ documents follow a Kubernetes-style spec/status split: **`phase`** is the Clerk-owned lifecycle state (the phase machine below), **`status`** is a plugin-owned observation slot — a `Record<string, unknown>` keyed by plugin id where apparatuses like Spider record side-channel observations (last rig, stuck cause, progress ratchets) — and **`ext`** is a sibling plugin-owned metadata slot of the same shape, reserved for metadata-shape data (provenance, cross-references, classifier tags) attached at registration time rather than the post-hoc observation `status` records. See [Spec/Status Convention](#specstatus-convention).

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

The Clerk consumes `linkKinds` kit contributions — link kinds seed the kit-contributed link-kind registry at startup. Writ types are **not** a kit contribution; every plugin contributes its writ types by calling `ClerkApi.registerWritType` from its own apparatus's `start()` (see [Writ-Type Registry](#writ-type-registry) below).

```typescript
consumes: ['linkKinds']
```

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
   * Managed fields (id, phase, timestamps, parentId, status, ext)
   * are stripped. The observation slot `status` is plugin-owned and
   * must be written via setWritStatus(); the metadata slot `ext` is
   * plugin-owned and must be written via setWritExt(). transition()
   * silently strips any caller-supplied status or ext field.
   *
   * Cascade across the parent/child boundary is not driven by
   * `transition()` itself; it is dispatched by the per-type
   * children-behavior engine. See [Children-behavior cascade](#children-behavior-cascade).
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

  /**
   * Write (or overwrite) a plugin-owned sub-slot inside the writ's
   * metadata `ext` map. Sibling to setWritStatus: same plugin-keyed
   * shape, same transactional read-modify-write semantics, same CDC
   * event emission, same terminal-survival rule. The semantic
   * distinction is that `ext` carries metadata-shape data (petition
   * ids, cross-references, classifier tags) attached at registration
   * time, while `status` records post-hoc observations. Throws on
   * empty writId / empty pluginId / missing writ.
   */
  setWritExt(writId: string, pluginId: string, value: unknown): Promise<WritDoc>

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

  // ── Metadata slot ────────────────────────────────────────────

  /** Plugin-owned metadata slot, keyed by plugin id. Sibling to
   *  status, but reserved for metadata-shape data (petition ids,
   *  cross-references, classifier tags) attached at registration
   *  time. Written via setWritExt(). Optional and absent by default;
   *  survives terminal phase transitions. Not part of the phase
   *  machine. */
  ext?: Record<string, unknown>
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
    "defaultType": "mandate"
  }
}
```

```typescript
interface ClerkConfig {
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
| `defaultType` | `string` | `"mandate"` | Default writ type for `commission-post` when called without an explicit type. Validated against the Clerk's writ-type registry on the framework's `phase:started` event — an unregistered name fails startup with `[clerk] guild config: defaultType "<name>" is not a registered writ type`. |

Guild-config `writTypes` is **gone**. Writ types are contributed exclusively via `ClerkApi.registerWritType(config)` from a plugin's own `start()`. See [Writ-Type Registry](#writ-type-registry).

Writ types are the guild's vocabulary — not a framework-imposed hierarchy. A guild that does only implementation work might use only `mandate`. A guild with planning animas might register `piece`, `observation-set` via the astrolabe apparatus. The Clerk validates that posted writs use a registered type but assigns no behavioral semantics to the type name — that meaning lives in role instructions and (when available) standing orders and engine designs.

---

## Writ-Types Substrate

Writ types are first-class lifecycle descriptors, not a vocabulary list. Each declared type carries its own state machine: named states, per-state classifications, semantic attribute tags, an outbound-transition graph, and optional aggregate children triggers. The built-in `mandate` type is one instance of this shape; `mandate`'s six-phase lifecycle (`new`, `open`, `stuck`, `completed`, `failed`, `cancelled`) is the canonical worked example below. For the conceptual framing of per-type lifecycles in guild vocabulary, see [The Guild Metaphor → Writ](../../guild-metaphor.md#writ). For a plugin-author walkthrough of declaring a new type end-to-end, see [Adding writ types](../../guides/adding-writ-types.md).

The substrate composes with the rest of the Clerk:

- **Phase machine** — the validated transition graph declared by each type's `allowedTransitions` is the phase machine the Clerk enforces for that type. A writ of type `T` may only transition between states declared by `T`'s config.
- **Parent/child cascade** — declared on `WritTypeConfig.childrenBehavior` and consumed by the children-behavior engine (see [Parent/Child Hierarchies](#parentchild-hierarchies)). The engine routes terminal-child outcomes back through the parent's declared upward triggers (`allSuccess` / `anyFailure`) and routes parent-terminal events down through every non-terminal descendant via the optional downward `parentTerminal` trigger.
- **Spider dispatch** — the Spider's `rigTemplateMappings` (see [Spider → Configuration → Plugin-default template and mapping](spider.md#plugin-default-template-and-mapping)) keys off the writ's `type` string. Registering a new writ type here does not dispatch it automatically; a matching entry must exist (or be contributed by a kit) in `spider.rigTemplateMappings`.

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

Every `ClerkApi.registerWritType(config)` call passes a `WritTypeConfig`. The validator `validateWritTypeConfig(config)` throws a plain `Error` on the first structural violation and returns `void` on success. Error messages take the shape `[clerk] writTypeConfig.<path>: <problem>; received <value>` — the `<path>` names the offending field (e.g. `states[2].classification`, `childrenBehavior.anyFailure.transition`).

**Runtime wiring.** The per-type `allowedTransitions` graph drives `transition()` enforcement, registration runs every config through `validateWritTypeConfig()` before admitting it to the registry, and the children-behavior cascade engine fires `childrenBehavior` triggers on child-terminal events as a Phase 1 watcher on the writs book. The field-level semantics below describe the contract the engine implements.

#### `WritTypeConfig`

The top-level shape describing one writ type.

```typescript
interface WritTypeConfig {
  name: string;
  states: WritTypeStateDefinition[];
  childrenBehavior?: WritTypeChildrenBehavior;
}
```

- **`name`** — the writ type name. Must be a non-empty string; no format rules beyond non-emptiness are imposed by the validator. Uniqueness across the runtime registry is enforced at registration time — a duplicate `registerWritType` call throws — not by `validateWritTypeConfig`.
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
| `failure` | This terminal state represents a failure outcome. `childrenBehavior.anyFailure` fires when any terminal child carries this attr; `childrenBehavior.parentTerminal` fires when a writ of the cascading type itself transitions into a terminal state carrying this attr. |
| `cancelled` | This terminal state represents withdrawal — the obligation was neither fulfilled nor failed. Read by `childrenBehavior.parentTerminal` (alongside `failure`) to drive the downward cascade when a writ terminates without success. |
| `stuck` | This state represents an obligation whose rig hit an engine failure and is awaiting attention. Typically attached to a non-terminal `active` state, not a terminal one. |

**When to add a known attr vs. a custom tag.** Reach for a known attr when the downstream consumer that reads it is already in the framework — `allSuccess` reads `success`, the Spider's observability surface reads `stuck`, etc. Reach for a custom string when your kit is the only consumer and the tag names something domain-specific (e.g. `'approved'`, `'blocked-on-legal'`). Under-tagging is the more common failure mode than over-tagging: a terminal state missing the `success` attr will silently prevent `childrenBehavior.allSuccess` from firing.

Valid: `attrs: ['success']`. Valid (forward-compatible custom tag): `attrs: ['approved']`.

Invalid — empty-string attr entry: `states[<i>].attrs[<a>]: must be a non-empty string; received ""`.

#### `WritTypeChildrenBehavior`

```typescript
interface WritTypeChildrenBehavior {
  allSuccess?: WritTypeChildrenBehaviorAction;
  anyFailure?: WritTypeChildrenBehaviorAction;
  parentTerminal?: WritTypeChildrenBehaviorAction;
}
```

Aggregate-children + downward-cascade triggers. All fields are optional; a config with no `childrenBehavior` declares no children-driven cascade. When present, `childrenBehavior` must be an object — strings, numbers, and primitives fail with `childrenBehavior: must be an object when provided`.

- **`allSuccess`** (upward) — fires when every child writ has reached a terminal state *and* every such state carries the `success` attr.
- **`anyFailure`** (upward) — fires when any child writ has reached a terminal state that carries the `failure` attr.
- **`parentTerminal`** (downward) — fires when a writ of *this* type transitions into a `failure`- or `cancelled`-attr terminal state. Drives every non-terminal descendant through `ClerkApi.transition` with the configured target. Does not fire on `success`-attr terminals.

Valid (all three triggers declared — mandate's full configuration):

```typescript
{
  allSuccess: { transition: 'completed', copyResolution: true },
  anyFailure: { transition: 'failed',    copyResolution: true },
  parentTerminal: {
    transition: 'cancelled',
    resolution: 'Automatically cancelled due to parent termination',
  },
}
```

Valid (single trigger only):

```typescript
{ allSuccess: { transition: 'completed' } }
```

Invalid — non-object `childrenBehavior`: `childrenBehavior: must be an object when provided; received "oops"`.

**Runtime semantics — children-behavior cascade engine.** The children-behavior engine is a Phase 1 watcher on the `clerk/writs` book registered from the Clerk's `start()`. Cascade writes join the triggering transaction; a handler throw rolls the whole commit back. The engine is generic in writ type — any registered type whose config declares a `childrenBehavior` block opts in. Both cascade directions live in the same `handle` function.

Common firing-rule prefix (both directions):

- **Update events only** — the engine fires only on `update` events whose new phase differs from the previous and is classified `terminal`. Create events never satisfy the rule (the validator forbids initial states from being terminal).

Upward branch (`allSuccess` / `anyFailure`):

- **Firing rule** — the triggering writ has a parent, the parent writ exists, the parent's type is registered, the parent type declares a `childrenBehavior` block, and the parent itself is non-terminal. (Already-terminal parent → silent idempotent short-circuit.)
- **Trigger firing** — `allSuccess` fires when every sibling under the same parent is terminal and every one carries the `success` attr (siblings are enumerated directly from the writs book, bypassing the default `list` row cap). `anyFailure` fires when the triggering child's terminal state carries the `failure` attr.
- **Trigger evaluation order** — `anyFailure` is evaluated first. If it fires, `allSuccess` is skipped on this event. This is the precedence rule: a failing child wins over a simultaneously-completing one.
- **Idempotency** — when the parent itself is already terminal, the engine short-circuits before evaluating triggers. Repeated child-terminal events on the same already-terminal parent are silent no-ops.
- **`copyResolution`** — when `true`, the engine copies the triggering child's `resolution` string verbatim onto the parent through the same `transition` call. When `false` or omitted, the parent's resolution is left untouched.
- **`status['clerk'].triggeringChildId` write** — on every upward fire, before the parent's `transition()` call, the engine records the immediate triggering child's id on the parent's Clerk-owned status sub-slot via `setWritStatus(parent, 'clerk', { triggeringChildId })`. The ordering is load-bearing for downstream observers: the Reckoner reads the post-commit snapshot of the terminal-transition CDC event, so the slot must be in place before the transition fires. See [Worked example: `status.clerk.triggeringChildId`](#worked-example-statusclerktriggeringchildid).
- **Grandparent lift** — natural CDC re-fire. When the engine transitions the parent, that transition is itself a writ-update event; the watcher re-enters and evaluates the grandparent's `childrenBehavior`.

Downward branch (`parentTerminal`):

- **Firing rule** — the triggering writ's new terminal state carries either the `failure` or `cancelled` attr (not `success` — that case is the tripwire branch's domain), the writ's *own* type is registered, and that type declares a `parentTerminal` action. The branch enumerates the writ's children directly from the writs book (bypassing the default `list` row cap) and skips already-terminal children using the type's classification.
- **Action firing** — for each non-terminal child, the engine calls `api.transition` with the action's configured target and `resolution` string (or the parent's own resolution when `copyResolution: true`).
- **Idempotency** — already-terminal children are skipped during enumeration. A re-fire of the cascade with no non-terminal children is a silent no-op.
- **Grandchild cancel** — natural CDC re-fire. When the engine transitions a child into its terminal state, that transition is itself a writ-update event; the watcher re-enters and the downward branch fires on the child's own `parentTerminal` action (if the child's type declares one). For mandate trees this is how grandchildren get cancelled when grandparents terminate.
- **Heterogeneous children** — every potential child type must declare the configured target state reachable from each non-terminal state via `allowedTransitions`. The validator does *not* enforce this cross-type contract; misconfigured children surface at runtime as fail-loud throws from `api.transition` that roll the cascade back.

Tripwire branch (success-attr terminal with non-terminal descendant — enforced invariant):

- **Firing rule** — the triggering writ's new terminal state carries the `success` attr, the writ's *own* type is registered, and that type declares a `childrenBehavior` block (the tripwire is implicit in opting into cascade — there is no separate config field). The branch walks the descendant subtree directly through the writs book (bypassing the default `list` row cap) and recurses through terminal nodes too — a bypass further down the tree could leave a non-terminal grandchild beneath an already-terminal child.
- **Throw and rollback** — when any non-terminal descendant is found, the engine throws inside the firing transaction. Phase 1 atomicity rolls the entry's transition back, so the bookkeeping gap is unrepresentable in the writs book rather than a log-only signal. The throw message names the offending writ id, the `success`-attr terminal state, and the non-terminal descendants.
- **Why a hard error** — the cascade engine's own `allSuccess` path enumerates every direct sibling and requires terminal-success, so the cascade itself can never produce a `success`-attr terminal with non-terminal descendants. Any path that does produce it is a direct `ClerkApi.transition` caller bypassing the cascade (the `writ-complete` tool, plugin code, tests). Surfacing the gap as a hard error catches caller bugs early; leaving it silent would let orphaned-children states accumulate without any audit signal.
- **Idempotency** — a re-fire (e.g. a metadata-only update to the now-terminal entry) short-circuits at the engine's no-phase-change rule before reaching the tripwire. A genuine re-fire of a terminal-transition event with all descendants now terminal is a silent no-op (the walk finds no non-terminal descendants).
- **Types that decline `childrenBehavior`** — silent no-op. Declining `childrenBehavior` is the type's announcement that it does not couple parent and child outcomes, and the tripwire respects that.

Stacks' 16-deep cascade cap bounds combined depth across all three branches.

Fail-loud surface (all three branches):

- **Dangling `parentId`** (upward) — throws and rolls back the triggering transition.
- **Unregistered parent or own type** — throws and rolls back.
- **Misconfigured child target** (downward) — `api.transition` throws when a child cannot reach the configured `parentTerminal.transition` target from its current state, rolling back.
- **Bypass leaves non-terminal descendants** (tripwire) — throws and rolls the parent's `success`-attr terminal transition back when any non-terminal descendant remains.

#### `WritTypeChildrenBehaviorAction`

```typescript
interface WritTypeChildrenBehaviorAction {
  transition: string;
  copyResolution?: boolean;
  resolution?: string;
}
```

- **`transition`** — target state name the writ-being-acted-on transitions to when the trigger fires. Must be a non-empty string. For upward triggers, the target must reference a state declared in the enclosing `WritTypeConfig.states` and is subject to a reachability check: the target must be reachable from every non-terminal state via `allowedTransitions`, so the trigger can actually move the parent no matter which non-terminal state it sits in. The downward `parentTerminal` trigger's target lives in *child* type configs and is therefore exempt from same-config existence and reachability validation — runtime fail-loud at the `api.transition` call site enforces the per-child-type contract.
- **`copyResolution`** — optional boolean. When `true`, copy the triggering writ's `resolution` string onto the target as part of the transition. Non-boolean values fail with `childrenBehavior.<trigger>.copyResolution: must be a boolean when provided`. Mutually exclusive with `resolution`.
- **`resolution`** — optional non-empty string. Written verbatim onto every transitioned writ as the static cascade resolution. Used by the downward `parentTerminal` trigger to stamp every cancelled child with the same canonical reason. Empty/non-string values fail with `childrenBehavior.<trigger>.resolution: must be a non-empty string when provided`. Mutually exclusive with `copyResolution: true`.

Empty action objects are rejected — `{}` fails with `childrenBehavior.<trigger>: must not be an empty object`. Actions without a `transition` field (e.g. `{ copyResolution: true }`) fail with `childrenBehavior.<trigger>.transition: must be a non-empty string`. Actions with both `copyResolution: true` and `resolution` set fail with `childrenBehavior.<trigger>: copyResolution and resolution are mutually exclusive — pick one`.

Valid: `{ transition: 'completed', copyResolution: true }`.

Valid: `{ transition: 'cancelled', resolution: 'Automatically cancelled due to parent termination' }`.

Invalid — upward target that exists but is not reachable from some non-terminal state:

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
9. Every declared `childrenBehavior` trigger carries an action object with a non-empty `transition` string. Upward triggers' targets must reference a state that exists in this same config; the downward `parentTerminal` trigger's target lives in child type configs and is therefore exempt from same-config existence checking.
10. Each upward `childrenBehavior` transition target is reachable from every non-terminal state of the config via `allowedTransitions`. The downward `parentTerminal` trigger is exempt — its target lives in child type configs.
11. Each action's optional `resolution` field is a non-empty string, and `copyResolution: true` and `resolution` are mutually exclusive on the same action.

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
    parentTerminal: {
      transition: 'cancelled',
      resolution: 'Automatically cancelled due to parent termination',
    },
  },
};
```

Traits worth reading off the fixture:

- **One `initial`, three `terminal`, two `active` states.** The classification partition is explicit.
- **`stuck` is `active`, not terminal.** Non-terminal means the obligation survives — `stuck → open` is a declared recovery edge.
- **Every upward `childrenBehavior` target is reachable from every non-terminal state.** `completed` is reachable from `new` (via `open`), from `open` (directly), and from `stuck` (via `open`). Similarly `failed`. The reachability invariant is what lets the trigger fire regardless of where the parent sits when a child terminates.
- **The downward `parentTerminal` trigger is exempt from same-config reachability.** `cancelled` happens to be reachable from every non-terminal mandate state — `new`, `open`, and `stuck` all declare `cancelled` outbound — but the validator does not enforce that for the downward trigger because its target lives in child type configs. Plugin authors registering a child type beneath mandate must declare `cancelled` reachable from each non-terminal state of the child type per the heterogeneous-child convention; runtime fail-loud at `api.transition` rolls the cascade back if the contract is violated.
- **`parentTerminal` uses a static resolution string.** Mandate stamps every cascade-cancelled descendant with `Automatically cancelled due to parent termination`. The string is per-type vocabulary and lives inline in mandate's config — there is no exported framework constant.
- **Only terminal states carry `attrs`.** Nothing forbids active-state attrs; `mandate` simply has no domain-specific tag for its active states.

### Cross-reference: Spider dispatch

Registering a new writ type via `ClerkApi.registerWritType` makes the type valid for `commission-post` but does not dispatch it. Dispatch is opt-in per type and is owned by the Spider's `rigTemplateMappings`. A writ whose type has no mapping sits in `open` indefinitely until a mapping is added (or the writ is cancelled / completed manually). The recommended reading order for plugin authors registering a new type is: register the type here → register (or declare) a mapping in [Spider → `rigTemplateMappings`](spider.md#plugin-default-template-and-mapping) → only then does posting a writ of that type spawn a rig. See also the [plugin-author walkthrough](../../guides/adding-writ-types.md) for an end-to-end example.

---

## Writ-Type Registry

The Clerk maintains a runtime registry of writ types keyed by name. Each entry is a fully-validated `WritTypeConfig` that declares the type's states (with classifications `'initial' | 'active' | 'terminal'`, an optional semantic `attrs` vocabulary, and per-state `allowedTransitions`), plus optional `childrenBehavior` triggers that lift terminal-child outcomes back onto the parent (upward `allSuccess` / `anyFailure`) and cascade parent-terminal events down through non-terminal descendants (downward `parentTerminal`).

`ClerkApi.registerWritType(config)` is the single-surface entry point. Plugins call it from their own apparatus's `start()`. Validator errors propagate verbatim; registration-specific failures (duplicate name, late call after the seal) throw with a `[clerk] registerWritType:` prefix. The Clerk itself registers `mandate` through this same path during its own `start()`.

The registry seals on the framework's global `phase:started` signal — the moment every apparatus's `start()` has finished. Registration calls after the seal throw a clear error; `post()` of an unregistered type also fails fast at the registry lookup.

A writ's current state is classified by consulting its type's registered config. The predicates `isInitial(writ)`, `isActive(writ)`, `isTerminal(writ)` return a boolean keyed on the type's classification vocabulary; `getWritTypeConfig(name)` returns the full config for abstract callers. All of these throw the fail-loud diagnostic when a writ carries a state not declared in its type config or an unregistered type — these are data-integrity or registration-ordering bugs and should surface loudly.

---

## Mandate's lifecycle (an example registered type)

Mandate is the one writ type the Clerk plugin registers for itself. The six-state lifecycle below — the canonical worked example of the substrate above — is just one example of a `WritTypeConfig`; other plugin-registered types declare their own state machines via `ClerkApi.registerWritType` (see [Writ-Type Registry](#writ-type-registry)). The Clerk enforces every transition against the writ's own type config — invalid transitions throw.

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

Types that declare their own lifecycle may adopt the same `new → open → terminal` skeleton or diverge (a pure-planning type might drop `stuck`; a long-running type might add additional active states). The Clerk enforces whatever transitions the type's `WritTypeConfig` declares; per-type lifecycles are no longer constrained to the mandate transition table.

---

## Spec/Status Convention

Writ documents follow a Kubernetes-style spec/status split:

- **Spec fields** are the declared intent of the writ — `title`, `body`, `type`, `codex`, `parentId`, and the Clerk-owned lifecycle field `phase`. These describe *what should happen* and *where the writ currently sits on the phase machine*. `transition()` is the only writer for `phase`.
- **Status slot** (`status` on `WritDoc`) is a free-form `Record<string, unknown>` keyed by plugin id. Each plugin owns one sub-slot and records side-channel observations there: last rig, stuck cause, progress ratchets, planner version, etc. `setWritStatus()` is the only writer for the slot.
- **Ext slot** (`ext` on `WritDoc`) is the structural sibling of `status` — same plugin-keyed `Record<string, unknown>` shape, same transactional write contract, same terminal-survival rule — but reserved for metadata-shape data (petition ids, cross-references, classifier tags, configuration extensions) attached at registration time rather than the post-hoc observation `status` records. `setWritExt()` is the only writer. See [ext (metadata) vs status (observation)](#ext-metadata-vs-status-observation) below.

### Rules

The rules below apply uniformly to both the observation slot (`status` / `setWritStatus()`) and the metadata slot (`ext` / `setWritExt()`) — wherever a rule names one slot and writer, the same rule holds for the sibling.

- **Plugin ownership is a soft convention.** Each plugin writes only under its own pluginId key. No runtime guard stops a plugin from reading another plugin's sub-slot — the convention is *write only your own key*, and the `setWritStatus()` / `setWritExt()` APIs make the right thing easy.
- **One sanctioned slot-write path per slot.** The observation slot is writable only via `setWritStatus()`, and the metadata slot only via `setWritExt()`; each performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers. `transition()` silently drops both `status` and `ext` from its body alongside the other managed fields. The generic `put()` / `patch()` paths on the `clerk/writs` book are not supported slot-write mechanisms — every route other than the dedicated writer would wholesale-replace the slot and clobber sibling sub-slots.
- **Disjoint sub-slots are concurrency-safe.** `setWritStatus()` and `setWritExt()` each run their read-modify-write inside a Stacks transaction. Concurrent writes from different plugins to different sub-slots do not clobber each other.
- **Within a single plugin's sub-slot, writes are last-writer-wins.** The dedicated writer replaces the plugin's sub-slot value wholesale — per-key atomicity inside a sub-slot is deferred until real contention appears.
- **Slot writes emit CDC events.** Changes to either slot propagate through the same `update` events on the `clerk/writs` book as any other field change; downstream watchers can react.
- **Terminal transitions do not clear the slots.** Observations and metadata persist on the writ after `completed`/`failed`/`cancelled` for post-mortem inspection and ongoing cross-reference reads.

### `ext` (metadata) vs `status` (observation)

Both slots are plugin-keyed `Record<string, unknown>` maps with identical mechanics. The semantic distinction is the *kind* of data each is meant to hold:

- **`status` is for post-hoc observation** — what a plugin has *observed* about a writ after the fact. Examples: a stuck cause recorded by Spider's engine-failure handler, a triggering child id recorded by the Clerk's children-behavior cascade, a gate result recorded by an evaluator. The defining feature is that the observation is the plugin's reaction to something the writ has been through.
- **`ext` is for attached metadata** — what a plugin needs the writ to *carry* as an attribute of its identity. Examples: a petition id linking a writ back to its originating registration, a foreign-system reference, a classifier tag baked in at creation. The defining feature is that the metadata is part of *what the writ is*, not a record of what has happened to it.

Picking the wrong slot layers metadata under an observation contract or vice versa, so plugin authors should choose consciously. When in doubt: ask whether the data is set as the writ comes into being (or is registered with another system) — that points to `ext` — versus updated reactively as the writ evolves — that points to `status`.

#### Worked example: `ext['reckoner'].petitionId`

The Reckoner registers a petition for a writ at the moment the writ is created on its behalf, and attaches the petition id under `ext['reckoner']` so downstream consumers can chase the cross-reference back to the petition record without a separate index. The shape is established at attach time and stable for the writ's lifetime — a textbook metadata-shape consumer rather than an observation. See [Reckoner: petitioner registration → §13](../petitioner-registration.md) for the full contract; the slot itself is opaque to the Clerk and validated only by the Reckoner.

### Worked example: `status.clerk.triggeringChildId`

The Clerk's children-behavior cascade engine writes its own observation
sub-slot. When a parent writ is lifted into a terminal state by the
cascade — i.e. one of its children's terminal transitions fired the
parent's `WritTypeConfig.childrenBehavior` trigger — the engine records
the *immediate* triggering child's id under `status['clerk']` before the
parent's `transition()` call:

```typescript
interface ClerkWritStatus {
  /**
   * Id of the immediate child whose terminal transition fired the
   * children-behavior cascade onto this writ. Absent on writs that
   * reached terminal through a direct (non-cascaded) transition.
   *
   * For multi-level cascades (root → mid → leaf), each parent in the
   * chain carries its own immediate triggering child id; consumers walk
   * the chain by reading each successive writ's
   * `status['clerk'].triggeringChildId`.
   */
  triggeringChildId?: string;
}
```

**Ownership.** The Clerk plugin (specifically the children-behavior
cascade engine in `children-behavior-engine.ts`) is the sole writer.
Downstream consumers — today, the Reckoner — read the slot through the
standard plugin convention:

```typescript
const clerkStatus = writ.status?.clerk as
  | { triggeringChildId?: string }
  | undefined;
```

Like every other plugin's sub-slot, consumers re-declare the narrow shape
locally rather than importing a Clerk-side type so that the consumer
package's import graph stays one-way.

**Write contract.** The engine calls `setWritStatus(parent, 'clerk', …)`
**before** the parent's `transition()` fires. The ordering is load-
bearing: the Reckoner is a Phase 2 CDC observer keyed on the terminal-
transition's `updatedAt` and reads `event.entry` (the post-commit
snapshot) at emit time. If the slot were written *after* the transition,
the pulse would fire against a snapshot that pre-dates the slot's
existence and the leaf-cause surface would degrade silently. This dual-
write sequence (`setWritStatus` then `transition`) is preserved instead
of carve-outs to `transition()`'s safe-fields strip — `status` continues
to be writable only through `setWritStatus()`.

**Chase-chain semantics on the consumer side.** The Reckoner walks the
chain at emit time: starting from the pulse's writ, it reads
`status['clerk'].triggeringChildId`, fetches that child via the Clerk,
reads its slot, and so on until a writ has no triggeringChildId. The
terminating writ is the leaf cause. Cascade depth is bounded by the
Stacks `MAX_CASCADE_DEPTH = 16` invariant, so the worst-case walk is
short and uncached.

**Forward-only.** The slot is forward-only: there is no migration or
backfill for writs that already terminal'd before the slot existed.
Pre-existing terminal writs do not re-emit pulses, so the absence of a
slot on a historical writ is harmless.

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
- **Scope tracking** — the patron sees one writ; the guild sees the tree

### Hierarchy Rules

- A writ may have zero or one parent (`parentId` is optional, immutable after creation).
- A writ may have zero or many children.
- Depth is not limited (but deep hierarchies are a design smell).
- Children inherit the parent's `codex` unless explicitly overridden.
- Parents accept children in any non-terminal state; a parent in a terminal state (as classified by its type config) rejects new children with a clear error.

### Children-behavior cascade

The children-behavior engine — a Phase 1 watcher on the `clerk/writs` book registered from `start()` — drives **three** cascade-engine branches from the same `handle` function:

- **Upward** (terminal child → parent lift). When a writ transitions to a terminal state, the engine evaluates the *parent's* `WritTypeConfig.childrenBehavior` block. If `allSuccess` or `anyFailure` fires, the parent is driven through `ClerkApi.transition` with the configured target.
- **Downward** (terminal parent → non-terminal-children cancellation). When a writ transitions to a `failure`- or `cancelled`-attr terminal, the engine evaluates the *writ's own* type's `parentTerminal` action. If declared, every non-terminal descendant is driven through `ClerkApi.transition` with the configured target. Recursion to grandchildren happens via natural CDC re-fire on each child's own transition, not by an in-handler walk.
- **Tripwire** (success-attr terminal with non-terminal descendant — enforced invariant). When a writ whose type opts into `childrenBehavior` reaches a `success`-attr terminal state and any non-terminal descendant remains, the engine throws and Phase 1 atomicity rolls the offending parent transition back, so the bookkeeping gap is unrepresentable in the writs book rather than a log-only signal. The cascade engine's own `allSuccess` path enumerates every direct sibling and requires terminal-success, so the engine can never produce this state — any path that does is a direct `ClerkApi.transition` caller bypassing the cascade (the `writ-complete` tool, plugin code, tests). The branch walks the descendant subtree directly through the writs book (bypassing the default `list` row cap) and recurses through terminal nodes too — a bypass further down the tree can leave a non-terminal grandchild beneath an already-terminal child. The throw message names the offending writ id, the `success`-attr state, and the non-terminal descendants.

Cascade is opt-in per type. A type whose config omits `childrenBehavior` is a silent no-op across all three branches, and parent/child lifecycles evolve independently. Mandate opts into all three triggers (both upward + downward) and is therefore covered by the tripwire too; piece and observation-set declare none.

The trigger vocabulary on `WritTypeConfig.childrenBehavior`:

- `allSuccess` (upward) — fires when every sibling under the same parent has reached a terminal state and every one carries the `success` attr.
- `anyFailure` (upward) — fires when the triggering child's terminal state carries the `failure` attr.
- `parentTerminal` (downward) — fires when a writ of *this* type transitions into a `failure`- or `cancelled`-attr terminal. Drives every non-terminal descendant to the configured target. The `success`-attr case is the tripwire branch's domain — declaring `childrenBehavior` is itself the opt-in to the tripwire's enforced invariant, so a `success`-attr terminal with non-terminal descendants throws and rolls back rather than silently leaving descendants alone.

Upward trigger evaluation order: `anyFailure` is evaluated first; if it fires, `allSuccess` is skipped on this event. This is the precedence rule a failing child wins over a simultaneously-completing one. Cascade ordering when both directions could fire on the same chain (e.g. an upward `anyFailure` lifts a parent into `failed`, which then needs to push down into the parent's other open siblings) is handled by natural CDC re-fire: the parent's own update event re-enters the handler and the downward branch fires on the parent's now-terminal transition.

Each trigger carries a `transition` target and one of two mutually-exclusive resolution carriers: `copyResolution: true` copies the triggering writ's `resolution` string onto the target verbatim, while `resolution: '...'` writes a static string onto every transitioned writ. Declaring both on the same action is a validator error.

The watcher fires inside the transaction that triggered it (Phase 1 atomicity): cascade writes join the same commit, and a handler throw rolls everything back — including the misconfigured-child case where a child's type cannot accept the configured `parentTerminal.transition` target. Grandparent lift and grandchild cancel both fall out naturally — the parent's (or child's) own update event re-enters the watcher. Stacks' 16-deep cascade cap bounds depth.

**Heterogeneous-child convention.** Because the downward `parentTerminal` trigger drives non-terminal *children* through their own state machines, every child type that may sit beneath a parent declaring `parentTerminal` must declare the configured target state reachable from each non-terminal state via `allowedTransitions`. The validator does *not* enforce this cross-type contract — it cannot, because the trigger's downstream target lives in child types — so a misconfigured child surfaces at runtime as a fail-loud throw from `api.transition` that rolls the cascade back. Plugins registering child types beneath mandate (or any other downward-cascading parent) must declare the corresponding `cancelled`-equivalent state reachable accordingly.

Mandate's `childrenBehavior` declares all three triggers — the upward pair with `copyResolution: true`, and the downward `parentTerminal` with the canonical static resolution string:

```typescript
childrenBehavior: {
  allSuccess: { transition: 'completed', copyResolution: true },
  anyFailure: { transition: 'failed',    copyResolution: true },
  parentTerminal: {
    transition: 'cancelled',
    resolution: 'Automatically cancelled due to parent termination',
  },
}
```

---

## Commission Intake Pipeline

Commission intake is a single synchronous step:

```
├─ 1. Patron calls commission-post (or ClerkApi.post())
├─ 2. Clerk validates input, generates ULID, creates WritDoc
├─ 3a. ClerkApi.post() always lands the writ in its type's declared initial state
│       └─ For mandate that is `new`; for other registered types, whatever
│          state their `WritTypeConfig` declares as the initial classification
├─ 3b. commission-post auto-publishes mandate writs when draft !== true
│       └─ The tool calls transition(writ.id, 'open') after the post
│       └─ The auto-advance is mandate-specific; other registered types
│          stay in their declared initial state
└─ 3c. parentId provided → Clerk validates parent is non-terminal, creates child atomically
        └─ Parent stays in its current phase (any non-terminal state)
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

The Clockworks's writ-lifecycle observer fires one `writ.<type>.<status>` event per writ status transition by reading the Clerk's writs CDC stream — there is no Clerk-owned emit path. The Clerk's job is to drive the transitions cleanly; the observer's job is to fan them onto the events book. Names use the writ's `type` and the target `phase` verbatim.

| Transition | Event |
|-----------|-------|
| Initial creation (entry into the type's initial state) | `writ.<type>.<initial-state>` (e.g. `writ.mandate.new`) |
| Entry into the type's active state | `writ.<type>.<active-state>` (e.g. `writ.mandate.open`) |
| `<active> → completed` | `writ.<type>.completed` |
| `<active> → failed` | `writ.<type>.failed` |
| `<active> → stuck` | `writ.<type>.stuck` |
| `* → cancelled` | `writ.<type>.cancelled` |

Payload is `{ writId, writType, phase, commissionId, title, parentId? }` for every row — `commissionId` is derived by walking `parentId` to the root. See [Event Catalog → Writ Lifecycle Events](../../reference/event-catalog.md#writ-lifecycle-events) for the full contract.

These events are what standing orders bind to. The canonical dispatch pattern:

```json
{
  "clockworks": {
    "standingOrders": [
      { "on": "writ.mandate.open", "run": "summon-relay", "with": { "role": "artificer", "prompt": "Read your writ with writ-show and fulfill the commission. Writ id: {{writ.id}}" } }
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
├─ 3. Clockworks's writ-lifecycle observer fires writ.mandate.open
├─ 4. Standing order on writ.mandate.open summons a Sage
├─ 5. Sage reads the mandate, creates child writs via post(parentId)
├─ 6. Parent stays in open, children created in their initial phase
├─ 7. Clockworks fires writ.<childType>.<initial-state> for each child
├─ 8. Standing orders on writ.<childType>.<active> dispatch workers
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
- `WritDoc.type` uses a guild-defined vocabulary, not a framework enum. The Clerk validates that the type is registered in its runtime writ-type registry (see [Writ-Type Registry](#writ-type-registry)) but the framework imposes no meaning on the type name.
- Writ ids use the format `w-{base36_timestamp}-{hex_random}`, produced by `generateId('w', 6)` — sortable by creation time, unique without coordination. Not a formal ULID, but provides the same useful properties (temporal ordering, no coordination).
- `WritDoc.phase` is structurally typed as `string` so any plugin-registered writ type's state name round-trips through the book. `WritPhase` remains exported as the mandate-specific six-state union for callers that knowingly downcast.
- The `transition()` method is the single choke point for all phase changes. All tools go through it. This is where validation, timestamp setting, and managed-field stripping happen. The observation slot `status` is a managed field stripped from the body alongside `id`, `createdAt`, `updatedAt`, `resolvedAt`, and `parentId`; the one sanctioned slot-write path is `setWritStatus()`, which performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers. Attempts to smuggle `phase` through `fields` are rejected with `[clerk] transition: cannot override phase via fields argument`.
- When the Clockworks is eventually added as a recommended dependency, resolve it at emit time via `guild().apparatus()`, not at startup — so the Clerk functions with or without it.
- `parentId` is immutable: stripped from managed fields in `transition()`, preventing mutation through the API.

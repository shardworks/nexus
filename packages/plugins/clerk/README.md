# `@shardworks/clerk-apparatus`

The Clerk manages the lifecycle of **writs** — lightweight work orders whose state machine is declared per writ type via a `WritTypeConfig`. The Clerk's own built-in `mandate` type flows through a six-state lifecycle (below); other plugin-registered types declare their own states and transitions. Writs can be organized into parent/child hierarchies for decomposing complex work.

Writ documents follow a Kubernetes-style spec/status split: **`phase`** is the Clerk-owned lifecycle state (the phase machine below), and **`status`** is a plugin-owned observation slot keyed by plugin id — a place for apparatuses like Spider to record side-channel observations (last rig, stuck cause, progress ratchets) without mutating the phase. See [Spec/Status Convention](#specstatus-convention) below.

The Clerk sits downstream of The Stacks: `stacks ← clerk`.

---

## Installation

Add to your package's dependencies:

```json
{
  "@shardworks/clerk-apparatus": "workspace:*"
}
```

The Clerk requires The Stacks to be installed in the guild.

---

## API

The Clerk exposes a `ClerkApi` via its `provides` interface, retrieved at runtime:

```typescript
import type { ClerkApi } from '@shardworks/clerk-apparatus';

const clerk = guild().apparatus<ClerkApi>('clerk');
```

### `post(request): Promise<WritDoc>`

Post a new commission, creating a writ in its registered type's declared `initial` state. For mandate that's `new` (a draft).

> **API vs. tool — auto-publish UX lives in the tool layer.** `clerk.post()` always lands the writ in the type's `initial` state and never advances it on its own — the API surface is intentionally minimal and predictable. The two tool wrappers reach `open` for you:
>
> - **`commission-post`** transitions newly-posted **mandate** writs to `open` automatically unless `draft: true` is passed. Other types (anything plugin-registered) are left in their `initial` state — advancing them without a type-specific tool would be silent coupling, so the auto-advance is confined to mandate.
> - **`piece-add`** unconditionally transitions the new piece to `open` (the tool has no `draft` parameter).
>
> Direct `clerk.post()` callers — including most plugin code — keep the `initial`-state landing semantics; if you want the writ to be dispatchable, follow up with `clerk.transition(id, 'open')`.

```typescript
const writ = await clerk.post({
  title: 'Refactor the session layer',
  body: 'Move all session logic into a dedicated module',
  type: 'mandate',      // optional, defaults to guild defaultType or "mandate"
  codex: 'artificer',  // optional target codex
  parentId: parent.id, // optional parent writ for hierarchical decomposition
});
```

| Parameter | Type | Description |
|---|---|---|
| `title` | `string` | Short human-readable title |
| `body` | `string` | Detail text (required) |
| `type` | `string` | Writ type — must be a registered type (optional) |
| `codex` | `string` | Target codex name (optional, inherited from parent if omitted) |
| `parentId` | `string` | Parent writ id for hierarchical decomposition (optional) |

When `parentId` is provided:
- The parent must exist and not be in a terminal state (as classified by its type config).
- The child inherits the parent's `codex` if no explicit codex is provided.
- The entire operation is atomic.

Throws if the writ type is not registered — register types with [`registerWritType`](#registerwrittypeconfig-void) from your plugin's `start()`.

### `show(id): Promise<WritDoc>`

Show a writ by id. Throws if not found.

### `list(filters?): Promise<WritDoc[]>`

List writs with optional filters, ordered by `createdAt` descending (newest first).

```typescript
const openWrits = await clerk.list({ phase: 'open', limit: 10 });
const children = await clerk.list({ parentId: parent.id });
```

| Filter | Type | Description |
|---|---|---|
| `phase` | `WritPhase \| WritPhase[]` | Filter by phase (single or array — multiple values OR together) |
| `type` | `string` | Filter by writ type |
| `parentId` | `string` | Filter to children of this parent writ |
| `limit` | `number` | Maximum results (default: 20) |
| `offset` | `number` | Number of results to skip |

### `tree(params?): Promise<WritTree[]>`

Walk the writ hierarchy and return a forest (an array of `{ writ, children }` nodes). When `rootId` is provided the walk is scoped to that single subtree and the array has at most one entry.

```typescript
// Forest of all roots, all phases, fully expanded.
const forest = await clerk.tree();

// Subtree rooted at a specific writ, capped at depth 8.
const sub = await clerk.tree({ rootId: root.id, depth: 8 });

// First page of roots, fully expanded, filtered by phase.
const page = await clerk.tree({ phase: ['open', 'stuck'], rootLimit: 100, rootOffset: 0 });
```

| Parameter | Type | Description |
|---|---|---|
| `rootId` | `string` | Restrict to the subtree rooted at this writ id (optional) |
| `phase` | `WritPhase \| WritPhase[]` | Filter by phase with **prune semantics** — a non-matching node is dropped together with its entire subtree |
| `type` | `string \| string[]` | Filter by writ type with prune semantics |
| `depth` | `number` | Maximum recursion depth (0 = roots only). Node at the cap is included; its children are not. |
| `rootLimit` | `number` | Maximum number of roots in forest mode (ignored with `rootId`) |
| `rootOffset` | `number` | Skip this many roots in forest mode (ignored with `rootId`) |

Children are walked in `createdAt asc` order under each parent so the visual order is stable across filters and sorts. Each node is fully-populated `WritDoc` plus a recursively-typed `children` array.

### `count(filters?): Promise<number>`

Count writs matching optional filters. Accepts the same filters as `list()` (except `limit` and `offset`).

```typescript
const total = await clerk.count({ phase: 'open' });
```

### `listWritTypes(): WritTypeInfo[]`

List all registered writ types. Returns an entry for each type registered via [`registerWritType`](#registerwrittypeconfig-void), including the Clerk's own `mandate`.

```typescript
const types = clerk.listWritTypes();
// [
//   { name: 'mandate', description: null, source: 'builtin', isDefault: true },
//   { name: 'piece',   description: null, source: 'plugin',  isDefault: false },
// ]
```

Each entry includes:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | The writ type name |
| `description` | `string \| null` | Reserved; always `null` today — `WritTypeConfig` does not currently model a description field |
| `source` | `"builtin" \| "plugin"` | `"builtin"` for mandate (registered by the Clerk plugin itself); `"plugin"` for every other registered type |
| `isDefault` | `boolean` | Whether this is the guild's default writ type |

Use [`getWritTypeConfig(name)`](#getwrittypeconfigname-writtypeconfig--undefined) when you need the full `WritTypeConfig` (states, transitions, etc.).

### `registerWritType(config): void`

Register a writ type's state machine with the Clerk. The config is validated via `validateWritTypeConfig` (validator errors propagate verbatim); registration-specific failures — duplicate names, or calls after the startup window has closed — throw with a `[clerk] registerWritType:` prefix.

```typescript
// From a plugin's own start():
const clerk = guild().apparatus<ClerkApi>('clerk');
clerk.registerWritType({
  name: 'audit',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['completed', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
});
```

`registerWritType` is the only path for a plugin to contribute a writ type. The registry is sealed at the framework's global `phase:started` signal — call it from your apparatus's `start()`. There is no guild-config writTypes field and no kit-contribution channel.

### `getWritTypeConfig(name): WritTypeConfig | undefined`

Return the registered `WritTypeConfig` for a writ type, or `undefined` when the name is not registered. Use this accessor when composing higher-level predicates or inspecting a type abstractly (e.g. to render a state-machine diagram).

### `isInitial(writ): boolean` / `isActive(writ): boolean` / `isTerminal(writ): boolean`

Classify a writ's current state by consulting its type's registered `WritTypeConfig`. Each predicate throws the fail-loud diagnostic when the writ's type is not registered, or when its stored state is not declared in that type's config.

```typescript
const writ = await clerk.show(id);
if (clerk.isTerminal(writ)) { /* ... */ }
```

The three predicates partition registered states cleanly — every state in a validated `WritTypeConfig` carries exactly one classification.

### `link(sourceId, targetId, label, kind?): Promise<WritLinkDoc>`

Create a directional link between two writs.

```typescript
// Casual label — attach any open-string relationship label.
await clerk.link(src.id, tgt.id, 'fixes');

// Load-bearing — attach a registered link-kind id.
await clerk.link(src.id, tgt.id, 'refines', 'astrolabe.refines');
```

Link rows carry two complementary identifiers:

- **`label`** — a casual, human-facing label. Open string. Normalized at write time via a syntactic pipeline (lowercase → trim → camelCase split → snake_case/kebab-case split → whitespace collapse). Variant spellings of the same label (`depends-on`, `dependsOn`, `depends_on`) collapse to a single composite id; distinct labels (`requires` vs `depends on`) remain distinct. Normalization is **not** synonymy.
- **`kind`** — a stable, plugin-owned id from the kit-contributed link-kind registry. The load-bearing identifier for downstream consumers. `null` when no kind is attached. Unknown ids are rejected.

Upsert semantics: calling `link()` again for the same `(sourceId, targetId, label)` returns the existing row. When a `kind` is supplied on the repeat call, it replaces the existing kind; when omitted, the existing kind is preserved.

### `unlink(sourceId, targetId, label): Promise<void>`

Remove a link. The `label` argument is normalized before deletion, so any spelling variant of the canonical form removes the same link. Idempotent — no error if the link does not exist.

### `links(writId): Promise<WritLinks>`

Return every link for a writ in both directions: `outbound` (this writ is the source) and `inbound` (this writ is the target).

### `listKinds(): Promise<LinkKindDoc[]>`

List every kit-contributed link kind in the registry. Each record includes the fully-qualified kind id, the contributing plugin, and a human-readable description.

```typescript
const kinds = await clerk.listKinds();
// [
//   { id: 'astrolabe.refines', ownerPlugin: 'astrolabe', description: 'Source refines target' },
// ]
```

Kit authors register kinds under the `linkKinds` key of their `ClerkKit` (or an apparatus's `supportKit`). Each entry is `{ id, description }`; the id must be prefixed with the contributing plugin id (`{pluginId}.{kebab-suffix}`, dot-separated). Malformed entries, duplicate ids, and plugin-prefix mismatches hard-fail at startup.

### `edit(request): Promise<WritDoc>`

Edit a writ, updating one or more fields. Only the provided fields are updated.

```typescript
const edited = await clerk.edit({
  id: writ.id,
  title: 'Updated title',
  body: 'Updated body text',
  type: 'errand',           // must be a valid declared type
  codex: 'new-codex',       // pass empty string to clear
});
```

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Writ id (required) |
| `title` | `string` | New title (optional) |
| `body` | `string` | New body text (optional) |
| `type` | `string` | New writ type — must be declared or built-in (optional) |
| `codex` | `string` | New target codex name; empty string clears it (optional) |

At least one field besides `id` must be provided. Title and body can be edited in any phase. Type and codex can only be changed while the writ is in `new` (draft) phase.

### `transition(id, to, fields?): Promise<WritDoc>`

Transition a writ to a new phase, optionally setting additional fields atomically.

```typescript
// Complete with resolution
await clerk.transition(id, 'completed', { resolution: 'Shipped to production' });

// Fail with resolution
await clerk.transition(id, 'failed', { resolution: 'Build pipeline broke' });

// Cancel (resolution optional)
await clerk.transition(id, 'cancelled', { resolution: 'No longer needed' });
```

Throws if the transition is not legal for the writ's current phase. The rejection message carries the writ id, current state, attempted target, and the list of legal transitions declared by the writ's type config (or `none (terminal state)` when the current state is terminal).

`transition()` strips the phase machine's managed fields from the body — `id`, `createdAt`, `updatedAt`, `resolvedAt`, and `parentId` — and rejects attempts to override `phase` through the `fields` argument with `[clerk] transition: cannot override phase via fields argument`. The observation slot `status` is writable only via `setWritStatus()` (the one sanctioned slot-write path), which performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers. See [Spec/Status Convention](#specstatus-convention).

The children-behavior engine — a Phase 1 watcher on the writs book — drives **three** cascade-engine branches. When any writ transitions to a terminal state, the engine evaluates the relevant `WritTypeConfig.childrenBehavior` block(s) and applies the configured actions via `transition`:

- **Upward** (terminal child → parent lift) reads the *parent's* `childrenBehavior`. `anyFailure` is evaluated first; if it fires, `allSuccess` is skipped. When the firing trigger declares `copyResolution: true`, the triggering child's `resolution` string is copied verbatim onto the parent. On every upward fire the engine *also* publishes the immediate triggering child's id under the parent's Clerk-owned status sub-slot (`status['clerk'].triggeringChildId`) **before** the transition records — see [Worked example: `status.clerk.triggeringChildId`](#worked-example-statusclerktriggeringchildid) — so downstream observers (the Reckoner today) can chase the cascade chain back to the leaf cause without parsing the parent's resolution string.
- **Downward** (terminal parent → non-terminal-children cancellation) reads the *triggering writ's own* `childrenBehavior.parentTerminal`. The downward branch fires only on `failure`- or `cancelled`-attr terminals; the `success` attr is handled by the tripwire branch instead. For each non-terminal child, the engine calls `transition` with the action's configured target and resolution. Already-terminal children are skipped (idempotent on re-fire); a child whose type cannot accept the configured target throws and rolls back the cascade.
- **Tripwire** (success-attr terminal with non-terminal descendant — enforced invariant). When a writ whose type opts into `childrenBehavior` reaches a `success`-attr terminal state and any non-terminal descendant remains, the engine throws inside the firing transaction and Phase 1 atomicity rolls the offending parent transition back. The cascade engine itself can never produce this state — `allSuccess` enumerates every direct sibling and requires terminal-success — so any path that does is a direct `clerk.transition()` caller bypassing the cascade. Surfacing the gap as a hard error (rather than a log-only warn) makes it unrepresentable in the writs book and catches caller bugs at commit time. The branch walks the descendant subtree directly through the writs book (recursing through terminal nodes too — a bypass further down the tree could leave a non-terminal grandchild beneath an already-terminal child) and the throw message names the offending writ id, the success-attr state, and the non-terminal descendants.

Types whose configs omit `childrenBehavior` are silent no-ops across all three branches — they have announced they do not couple parent and child outcomes. Mandate opts into all three upward/downward triggers (`allSuccess`, `anyFailure`, `parentTerminal`) and is therefore covered by the tripwire too; piece and observation-set declare none. Cascade writes join the triggering transaction (Phase 1 atomicity); grandparent lift and grandchild cancel both fall out naturally as the next update event re-enters the watcher.

### `setWritStatus(writId, pluginId, value): Promise<WritDoc>`

Write (or overwrite) a plugin-owned sub-slot inside the writ's observation `status` map. The `status` field on `WritDoc` is a `Record<string, unknown>` keyed by plugin id — each plugin reads and writes under its own key.

```typescript
// Spider records stuck cause
await clerk.setWritStatus(writ.id, 'spider', { stuckCause: 'engine-failed', lastRig: 'rig-01' });

// Astrolabe records a progress ratchet in the same writ — does not clobber spider's slot.
await clerk.setWritStatus(writ.id, 'astrolabe', { planVersion: 3 });
```

The write runs in a Stacks transaction (read-modify-write), so concurrent writes from different plugins to different sub-slots are disjoint and safe. The slot is not cleared on terminal transitions — observations persist for post-mortem analysis. See [Spec/Status Convention](#specstatus-convention) for conventions and a worked example.

Throws if `writId` or `pluginId` is missing, or if the writ does not exist.

---

## Mandate's lifecycle (an example registered type)

Mandate is the one writ type the Clerk plugin registers for itself. Its lifecycle — six states, the transitions below — is just one example of a `WritTypeConfig`; other plugin-registered types declare their own state machines.

```
new ──► open ──┬──► completed
  │       │    │
  │       │    ├──► stuck ──┬──► failed
  │       │    │     │      │
  │       │    │     └──────┤
  │       │    │     ▲      │
  │       │    │     │      ├──► cancelled
  │       │    ├─────┘      │
  │       │    │            │
  │       │    ├──► failed  │
  │       │    │            │
  └───────┴────┴──► cancelled
```

- `completed`, `failed`, and `cancelled` are **terminal** (classification: `terminal`) — no transitions out.
- `stuck` is **non-terminal** (classification: `active`) — a "needs attention" phase for writs whose rig hit an engine failure. Recovery transitions back to `open`; giving up transitions to `failed` or `cancelled`.

### Mandate's allowed transitions

| To | From |
|---|---|
| `open` | `new`, `stuck` |
| `stuck` | `open` |
| `completed` | `open` |
| `failed` | `open`, `stuck` |
| `cancelled` | `new`, `open`, `stuck` |

The same table is carried as `allowedTransitions` on each state in mandate's `WritTypeConfig`. Other types (`piece`, `observation-set`, your own) live alongside mandate in the Clerk's runtime registry — their allowed transitions come from their own configs, not this table.

---

## Parent/Child Hierarchies

Writs can be organized into parent/child relationships for decomposing complex work:

- **Creating children:** Pass `parentId` to `post()`. The parent stays in its current phase. Parents accept children in any non-terminal state; a parent in a terminal state (as classified by its type config) rejects new children with a clear error.
- **Children-behavior cascade:** the children-behavior engine drives three branches. Upward (terminal child → parent lift) evaluates the parent's `childrenBehavior` (`anyFailure` before `allSuccess`; a failing child wins precedence; `copyResolution: true` copies the triggering child's resolution onto the parent verbatim). Downward (terminal parent → non-terminal-children cancellation) evaluates the triggering writ's own type's `parentTerminal` action when the writ reaches a `failure`- or `cancelled`-attr terminal — every non-terminal descendant is driven to the configured target with the configured resolution string. Tripwire (enforced invariant) throws and rolls back when a cascade-opt-in writ would reach a `success`-attr terminal with any non-terminal descendant: the cascade itself can never produce this state, so any path that does is upstream-broken (a direct `transition()` caller bypassing the cascade), and Phase 1 atomicity makes the gap unrepresentable in the writs book. Cascade is opt-in per type: a type with no `childrenBehavior` block is a silent no-op across all three branches. Mandate opts into all three triggers; piece and observation-set declare none. Cascade fires inside the transaction that triggered it (Phase 1); grandparent lift and grandchild cancel both fall out naturally as the next update event re-enters the watcher.
- **Codex inheritance:** Children inherit the parent's codex if none is specified.
- **Immutability:** `parentId` cannot be changed after creation.

---

## Spec/Status Convention

Clerk follows a Kubernetes-style spec/status split:

- **Spec fields** are the declared intent of the writ — `title`, `body`, `type`, `codex`, `parentId`, and the Clerk-owned lifecycle field `phase`. These describe *what should happen* and *where the writ currently sits on the phase machine*.
- **Status slot** (the `status` field on `WritDoc`) is a `Record<string, unknown>` — a free-form observation map keyed by plugin id. Each plugin owns one sub-slot and uses it to record side-channel observations about the writ: last rig used, stuck cause, progress ratchets, planner version, etc.

The slot is a soft convention rather than a hard enforcement boundary:

- No runtime guard stops a plugin from reading another plugin's sub-slot — the convention is *write only your own key*, and the `setWritStatus()` API makes the right thing easy.
- **One sanctioned slot-write path.** The observation slot is writable only via `setWritStatus(writId, pluginId, value)`, which performs a transactional read-modify-write on the sub-slot keyed by `pluginId` so sibling sub-slots are preserved under concurrent writers. `transition()` silently strips `status` from its body alongside the other managed fields (`id`, `phase`, `createdAt`, `updatedAt`, `resolvedAt`, `parentId`). The generic `put()` / `patch()` paths on the `clerk/writs` book are not supported slot-write mechanisms — every route other than `setWritStatus()` would wholesale-replace the slot and clobber sibling sub-slots.
- Concurrent writes from different plugins to different sub-slots are disjoint and safe: `setWritStatus()` runs its read-modify-write inside a Stacks transaction.
- Within a single plugin's sub-slot, concurrent writes are last-writer-wins at the sub-slot level — `setWritStatus()` replaces the plugin's sub-slot value wholesale. Per-key atomicity inside a sub-slot is deferred until real contention appears.
- Slot writes emit CDC events like any other field change. Downstream observers (page renderers, audits, further observation pipelines) can watch the writs book for `update` events and react to the new `status` contents.
- Terminal transitions do **not** clear the slot. Observations persist on the writ for post-mortem inspection.

### Worked example: `status.clerk.triggeringChildId`

The Clerk's children-behavior cascade engine writes a sub-slot of its
own. When a parent writ is lifted into a terminal state by the cascade
(one of its children's terminal transitions fired the parent's
`WritTypeConfig.childrenBehavior` trigger), the engine records the
immediate triggering child's id under `status['clerk']` *before* the
parent's `transition()` call:

```typescript
interface ClerkWritStatus {
  /**
   * Id of the immediate child whose terminal transition fired the
   * children-behavior cascade onto this writ. Absent on writs that
   * reached terminal through a direct (non-cascaded) transition.
   */
  triggeringChildId?: string;
}
```

The slot is owned by the Clerk; downstream observers (today, the
Reckoner) read it through the standard plugin convention:

```typescript
const clerkStatus = writ.status?.clerk as
  | { triggeringChildId?: string }
  | undefined;
```

**Why the ordering matters.** Phase 2 CDC observers read `event.entry`
(the post-commit snapshot) at emit time, keyed on the terminal-
transition's `updatedAt`. Writing the slot *after* the transition would
deliver the pulse against a snapshot that pre-dates the slot's
existence and degrade the leaf-cause surface. The dual-write sequence
(`setWritStatus(parent, 'clerk', …)` then `transition(parent, …)`) is
preserved instead of relaxing `transition()`'s safe-fields strip —
`status` continues to be writable only through `setWritStatus()`.

**Chase-chain on the consumer side.** Multi-level cascades (root → mid
→ leaf) leave each parent in the chain carrying its own immediate
triggering child id; consumers walk the chain by reading each successive
writ's own `status['clerk'].triggeringChildId`. Cascade depth is bounded
by Stacks' `MAX_CASCADE_DEPTH = 16` invariant.

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

// Later, a human or tool reads the slot to triage:
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

The spec/status split is guild-wide in intent, not a writs-only pattern. Other runtime objects — **rigs**, **engines**, **sessions**, **input requests**, **clicks**, and future apparatuses' primary objects — will adopt the same split on a per-consumer basis: the owning apparatus keeps the lifecycle field (renaming its current `status` to `phase` when the time comes), and a new plugin-keyed `status: Record<string, unknown>` slot appears when the first observation-slot consumer materializes. Until that trigger arrives, those objects keep their existing `status` field unchanged — the convention rolls out one object at a time, not in a big-bang migration. When you author a new apparatus whose primary object may gain observations, reach for the spec/status shape from day one to avoid the rename later.

---

## Configuration

Configure The Clerk under the `"clerk"` key in your guild config:

```json
{
  "clerk": {
    "defaultType": "mandate"
  }
}
```

Only `defaultType` is honored. It must name a writ type registered with the Clerk (via `registerWritType` from a plugin's `start()`); an unregistered default fails the guild's startup with a clear `[clerk] guild config:` error.

There is no guild-config `writTypes` field. Plugins contribute writ types via `ClerkApi.registerWritType(config)` from their own apparatus's `start()`. The Clerk itself registers `mandate` the same way.

---

## Support Kit

The Clerk contributes books, tools, and pages to the guild:

### Books

| Book | Indexes | Contents |
|---|---|---|
| `writs` | `phase`, `type`, `createdAt`, `parentId`, `[phase, type]`, `[phase, createdAt]`, `[parentId, phase]` | Writ documents |
| `links` | `sourceId`, `targetId`, `label`, `[sourceId, label]`, `[targetId, label]` | Writ relationship links |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `commission-post` | `clerk:write` | Post a new commission (create a writ, optionally as child). Auto-publishes mandate writs to `open` unless `draft: true` is passed; other types stay in their `initial` state. |
| `piece-add` | `clerk:write` | Add a child `piece` writ to a mandate from a structured task description; the piece is auto-published to `open` and joins the implement-loop queue. |
| `writ-show` | `clerk:read` | Show full detail for a writ (includes parent/children context) |
| `writ-list` | `clerk:read` | List writs with optional filters (phase, type, parentId) |
| `writ-tree` | `clerk:read` | Render the writ hierarchy as a depth-aware tree (forest or single subtree); supports `phase` / `type` filters with prune semantics and a `depth` cap. Output is a box-drawing ASCII tree by default (`--format text`) or the structured `WritTree[]` forest (`--format json`). |
| `writ-edit` | `clerk:write` | Edit a writ (title/body any phase; type/codex draft only) |
| `writ-complete` | `clerk:write` | Complete a writ (open → completed) |
| `writ-fail` | `clerk:write` | Fail a writ (open/stuck → failed) |
| `writ-cancel` | `clerk:write` | Cancel a writ (new/open/stuck → cancelled) |
| `writ-publish` | `clerk:write` | Publish a draft writ (new → open) |
| `writ-link` | `clerk:write` | Create a labeled link between writs (`--kind <id>` to attach a registered link kind) |
| `writ-unlink` | `clerk:write` | Remove a labeled link between writs |
| `writ-link-kinds` | `clerk:read` | List registered link kinds (`--json` for raw array) |
| `writ-link-kinds-show` | `clerk:read` | Show a single link kind by id |
| `writ-types` | `clerk:read` | List available writ types |

---

## Key Types

```typescript
// Mandate-specific state union (kept for callers that knowingly downcast).
// The structural type of WritDoc.phase is `string` so any plugin-registered
// writ type's state name round-trips through the book.
type WritPhase = 'new' | 'open' | 'stuck' | 'completed' | 'failed' | 'cancelled';

interface WritDoc {
  id: string;           // ULID-like, prefixed "w-"
  type: string;         // a registered writ type
  phase: string;        // Clerk-owned lifecycle state (any registered type's state name)
  title: string;
  body: string;
  codex?: string;       // target codex name
  parentId?: string;    // parent writ id (absent on root writs, immutable)
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp, updated on every mutation
  resolvedAt?: string;  // ISO timestamp, set on any terminal transition
  resolution?: string;  // summary of how the writ resolved
  status?: Record<string, unknown>; // plugin-owned observation slot (keyed by plugin id)
}

interface PostCommissionRequest {
  title: string;
  body: string;         // required
  type?: string;        // defaults to guild defaultType or "mandate"
  codex?: string;       // inherited from parent if omitted
  parentId?: string;    // create as child of this writ
}

interface EditWritRequest {
  id: string;           // writ to edit
  title?: string;       // new title
  body?: string;        // new body text
  type?: string;        // new type (must be valid)
  codex?: string;       // new codex (empty string to clear)
}

interface WritFilters {
  phase?: WritPhase | WritPhase[];
  type?: string;
  parentId?: string;    // filter to children of this parent
  limit?: number;
  offset?: number;
}

// Returned by tree(): a writ plus a recursively-typed children array.
interface WritTree {
  writ: WritDoc;
  children: WritTree[];
}

interface WritTreeParams {
  rootId?: string;                  // restrict to a single subtree
  phase?: WritPhase | WritPhase[];  // prune-semantics filter
  type?: string | string[];         // prune-semantics filter
  depth?: number;                   // 0 = roots only; node at cap included
  rootLimit?: number;               // forest mode: page across roots
  rootOffset?: number;              // forest mode: skip this many roots
}

interface WritTypeInfo {
  name: string;                       // writ type name
  description: string | null;         // reserved; always null today
  source: 'builtin' | 'plugin';       // "builtin" for mandate; "plugin" otherwise
  isDefault: boolean;                 // whether this is the default type
}

interface WritLinkDoc {
  id: string;                // `{sourceId}:{targetId}:{normalized label}`
  sourceId: string;
  targetId: string;
  label: string;             // casual label, syntactically normalized
  kind: string | null;       // load-bearing link-kind id (null when unattached)
  createdAt: string;         // ISO timestamp
}

interface WritLinks {
  outbound: WritLinkDoc[];   // this writ → other writs
  inbound: WritLinkDoc[];    // other writs → this writ
}

// Kit-input shape for linkKinds contributions on ClerkKit.
interface KindEntry {
  id: string;                // `{pluginId}.{kebab-suffix}`
  description: string;
}

// Registry-projection shape returned by listKinds().
interface LinkKindDoc {
  id: string;
  ownerPlugin: string;
  description: string;
}
```

See `src/types.ts` for the complete type definitions.

---

## Exports

The package exports all public types and the `createClerk()` factory:

```typescript
import clerkPlugin, {
  createClerk,
  CLERK_PLUGIN_ID,
  type ClerkApi,
  type ClerkWritStatus,
  type WritTypeInfo,
} from '@shardworks/clerk-apparatus';
```

`CLERK_PLUGIN_ID` is the constant (`'clerk'`) used as the `status` sub-slot key for the Clerk's own observations (see [Worked example: `status.clerk.triggeringChildId`](#worked-example-statusclerktriggeringchildid)). `ClerkWritStatus` is the writer-side shape of that slot.

The default export is a pre-built plugin instance, ready for guild installation.

### Writ-type configuration

The package also exports the structural shape that describes a writ type's state machine and lifecycle behavior, plus a pure structural validator. These primitives are the foundation for plugin-registered writ types; they do not yet participate in the runtime lifecycle.

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

A `WritTypeConfig` names the type, enumerates its lifecycle states (each with a `classification` of `'initial' | 'active' | 'terminal'`, an optional `attrs` vocabulary, and per-state `allowedTransitions`), and optionally declares `childrenBehavior` triggers (`allSuccess`, `anyFailure`) that lift terminal-child outcomes back onto the parent.

`validateWritTypeConfig(config)` throws a plain `Error` on the first structural violation it encounters and returns `void` on success. Error messages take the shape `[clerk] writTypeConfig.<path>: <problem>; received <value>` with the path naming the offending field (e.g. `states[2].classification`, `childrenBehavior.anyFailure.transition`). The validator enforces:

- non-empty `name`
- non-empty `states` array with unique non-empty state names
- every `classification` drawn from the known vocabulary
- every `allowedTransitions` entry references an existing state
- exactly one state classified `initial`
- every non-initial state has at least one inbound transition
- terminal states declare no outbound transitions
- every declared `childrenBehavior` trigger carries an action with a `transition` field that references an existing state
- every `childrenBehavior` transition target is reachable from every non-terminal state via `allowedTransitions`

# `@shardworks/clerk-apparatus`

The Clerk manages the lifecycle of **writs** — lightweight work orders that flow through a fixed phase machine. Writs are created as commissions and ultimately completed, failed, or cancelled. Writs may also enter a `stuck` phase when their rig encounters an engine failure — a non-terminal "needs attention" phase that preserves the obligation for future retry. Writs can be organized into parent/child hierarchies for decomposing complex work.

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

Post a new commission, creating a writ in `open` phase.

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
| `type` | `string` | Writ type — must be declared or built-in (optional) |
| `codex` | `string` | Target codex name (optional, inherited from parent if omitted) |
| `parentId` | `string` | Parent writ id for hierarchical decomposition (optional) |

When `parentId` is provided:
- The parent must exist and be in `new`, `open`, or `stuck` phase.
- The child inherits the parent's `codex` if no explicit codex is provided.
- The entire operation is atomic.

Throws if the writ type is not declared in the guild config and is not a built-in type (`mandate`, `summon`).

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

### `count(filters?): Promise<number>`

Count writs matching optional filters. Accepts the same filters as `list()` (except `limit` and `offset`).

```typescript
const total = await clerk.count({ phase: 'open' });
```

### `listWritTypes(): WritTypeInfo[]`

List all registered writ types with full metadata — descriptions, source tracking, and default flag.

```typescript
const types = clerk.listWritTypes();
// [
//   { name: 'mandate', description: null, source: 'builtin', isDefault: true },
//   { name: 'task', description: 'A task', source: 'guild', isDefault: false },
//   { name: 'quality-audit', description: 'Code quality audit', source: 'my-kit', isDefault: false },
// ]
```

Each entry includes:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | The writ type name |
| `description` | `string \| null` | Human-readable description, or `null` if none was provided |
| `source` | `string` | Origin: `"builtin"`, `"guild"`, or the contributing plugin's id |
| `isDefault` | `boolean` | Whether this is the guild's default writ type |

Source precedence: guild config entries fully shadow kit contributions with the same name (including description).

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

Throws if the transition is not legal for the writ's current phase.

`transition()` does **not** write the observation slot. Any `status` field passed in `fields` is silently stripped — plugins must use `setWritStatus()` instead.

**Cascade behavior:** When a writ with children transitions to `failed` or `cancelled`, all non-terminal children are automatically cancelled with resolution `'Automatically cancelled due to parent termination'` (exported as `CASCADE_PARENT_TERMINATION_RESOLUTION`). When a parent transitions to `completed`, non-terminal children are **not** cancelled — instead a warning is logged (their existence indicates an upstream bookkeeping gap). When a child fails and its parent is `open` or `stuck`, the parent is failed and remaining siblings are cancelled.

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

## Phase Machine

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

- `completed`, `failed`, and `cancelled` are **terminal** — no transitions out.
- `stuck` is **non-terminal** — a "needs attention" phase for writs whose rig hit an engine failure. Recovery (future retry) transitions back to `open`; giving up transitions to `failed` or `cancelled`.

### Allowed transitions

| To | From |
|---|---|
| `open` | `new`, `stuck` |
| `stuck` | `open` |
| `completed` | `open` |
| `failed` | `open`, `stuck` |
| `cancelled` | `new`, `open`, `stuck` |

---

## Parent/Child Hierarchies

Writs can be organized into parent/child relationships for decomposing complex work:

- **Creating children:** Pass `parentId` to `post()`. The parent stays in its current phase. Parents in `new`, `open`, or `stuck` phase accept children.
- **Failure cascade:** When a child fails and the parent is `open` or `stuck`, the parent is failed and remaining non-terminal siblings are cancelled.
- **Cancellation cascade:** When a parent reaches `failed` or `cancelled`, all non-terminal children are cancelled. When a parent reaches `completed` with non-terminal children still present, the Clerk logs a warning and leaves the children alone — this signals an upstream bookkeeping gap rather than normal flow.
- **Codex inheritance:** Children inherit the parent's codex if none is specified.
- **Immutability:** `parentId` cannot be changed after creation.

---

## Spec/Status Convention

Clerk follows a Kubernetes-style spec/status split:

- **Spec fields** are the declared intent of the writ — `title`, `body`, `type`, `codex`, `parentId`, and the Clerk-owned lifecycle field `phase`. These describe *what should happen* and *where the writ currently sits on the phase machine*.
- **Status slot** (the `status` field on `WritDoc`) is a `Record<string, unknown>` — a free-form observation map keyed by plugin id. Each plugin owns one sub-slot and uses it to record side-channel observations about the writ: last rig used, stuck cause, progress ratchets, planner version, etc.

The slot is a soft convention rather than a hard enforcement boundary:

- No runtime guard stops a plugin from reading another plugin's sub-slot — the convention is *write only your own key*, and the `setWritStatus()` API makes the right thing easy.
- `transition()` silently strips any `status` field passed by callers. The observation slot is plugin-owned and must be written via `setWritStatus()`, not smuggled through the phase machine.
- Concurrent writes from different plugins to different sub-slots are disjoint and safe: `setWritStatus()` runs its read-modify-write inside a Stacks transaction.
- Terminal transitions do **not** clear the slot. Observations persist on the writ for post-mortem inspection.

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

Writ types are declared at the top level of the guild config:

```json
{
  "writTypes": {
    "epic": { "description": "A significant multi-step task" },
    "errand": { "description": "A small one-off task" }
  }
}
```

The built-in types `mandate` and `summon` are always available without declaration.

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
| `commission-post` | `clerk:write` | Post a new commission (create a writ, optionally as child) |
| `writ-show` | `clerk:read` | Show full detail for a writ (includes parent/children context) |
| `writ-list` | `clerk:read` | List writs with optional filters (phase, type, parentId) |
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
type WritPhase = 'new' | 'open' | 'stuck' | 'completed' | 'failed' | 'cancelled';

interface WritDoc {
  id: string;           // ULID-like, prefixed "w-"
  type: string;         // declared or built-in type
  phase: WritPhase;     // Clerk-owned lifecycle state
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

interface WritTypeInfo {
  name: string;              // writ type name
  description: string | null; // human-readable description
  source: string;            // "builtin", "guild", or plugin id
  isDefault: boolean;        // whether this is the default type
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
import clerkPlugin, { createClerk, type ClerkApi, type WritTypeInfo } from '@shardworks/clerk-apparatus';
```

The default export is a pre-built plugin instance, ready for guild installation.

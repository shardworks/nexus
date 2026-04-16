# `@shardworks/clerk-apparatus`

The Clerk manages the lifecycle of **writs** — lightweight work orders that flow through a fixed status machine. Writs are created as commissions and ultimately completed, failed, or cancelled. Writs may also enter a `stuck` state when their rig encounters an engine failure — a non-terminal "needs attention" status that preserves the obligation for future retry. Writs can be organized into parent/child hierarchies for decomposing complex work.

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

Post a new commission, creating a writ in `open` status.

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
- The parent must exist and be in `new`, `open`, or `stuck` status.
- The child inherits the parent's `codex` if no explicit codex is provided.
- The entire operation is atomic.

Throws if the writ type is not declared in the guild config and is not a built-in type (`mandate`, `summon`).

### `show(id): Promise<WritDoc>`

Show a writ by id. Throws if not found.

### `list(filters?): Promise<WritDoc[]>`

List writs with optional filters, ordered by `createdAt` descending (newest first).

```typescript
const openWrits = await clerk.list({ status: 'open', limit: 10 });
const children = await clerk.list({ parentId: parent.id });
```

| Filter | Type | Description |
|---|---|---|
| `status` | `WritStatus \| WritStatus[]` | Filter by status (single or array — multiple values OR together) |
| `type` | `string` | Filter by writ type |
| `parentId` | `string` | Filter to children of this parent writ |
| `limit` | `number` | Maximum results (default: 20) |
| `offset` | `number` | Number of results to skip |

### `count(filters?): Promise<number>`

Count writs matching optional filters. Accepts the same filters as `list()` (except `limit` and `offset`).

```typescript
const total = await clerk.count({ status: 'open' });
```

### `listWritTypes(): WritTypeInfo[]`

List all registered writ types with full metadata — descriptions, source tracking, and default status.

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

At least one field besides `id` must be provided. Title and body can be edited in any status. Type and codex can only be changed while the writ is in `new` (draft) status.

### `transition(id, to, fields?): Promise<WritDoc>`

Transition a writ to a new status, optionally setting additional fields atomically.

```typescript
// Complete with resolution
await clerk.transition(id, 'completed', { resolution: 'Shipped to production' });

// Fail with resolution
await clerk.transition(id, 'failed', { resolution: 'Build pipeline broke' });

// Cancel (resolution optional)
await clerk.transition(id, 'cancelled', { resolution: 'No longer needed' });
```

Throws if the transition is not legal for the writ's current status.

**Cascade behavior:** When a writ with children transitions to a terminal status, all non-terminal children are automatically cancelled. When a child fails and its parent is `open` or `stuck`, the parent is failed and remaining siblings are cancelled.

---

## Status Machine

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
- `stuck` is **non-terminal** — a "needs attention" state for writs whose rig hit an engine failure. Recovery (future retry) transitions back to `open`; giving up transitions to `failed` or `cancelled`.

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

- **Creating children:** Pass `parentId` to `post()`. The parent stays in its current status. Parents in `new`, `open`, or `stuck` status accept children.
- **Failure cascade:** When a child fails and the parent is `open` or `stuck`, the parent is failed and remaining non-terminal siblings are cancelled.
- **Cancellation cascade:** When a parent reaches terminal status, all non-terminal children are cancelled.
- **Codex inheritance:** Children inherit the parent's codex if none is specified.
- **Immutability:** `parentId` cannot be changed after creation.

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
| `writs` | `status`, `type`, `createdAt`, `parentId`, `[status, type]`, `[status, createdAt]`, `[parentId, status]` | Writ documents |
| `links` | `sourceId`, `targetId`, `type`, `[sourceId, type]`, `[targetId, type]` | Writ relationship links |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `commission-post` | `clerk:write` | Post a new commission (create a writ, optionally as child) |
| `writ-show` | `clerk:read` | Show full detail for a writ (includes parent/children context) |
| `writ-list` | `clerk:read` | List writs with optional filters (status, type, parentId) |
| `writ-edit` | `clerk:write` | Edit a writ (title/body any status; type/codex draft only) |
| `writ-complete` | `clerk:write` | Complete a writ (open → completed) |
| `writ-fail` | `clerk:write` | Fail a writ (open/stuck → failed) |
| `writ-cancel` | `clerk:write` | Cancel a writ (new/open/stuck → cancelled) |
| `writ-publish` | `clerk:write` | Publish a draft writ (new → open) |
| `writ-link` | `clerk:write` | Create a typed link between writs |
| `writ-unlink` | `clerk:write` | Remove a typed link between writs |
| `writ-types` | `clerk:read` | List available writ types |

---

## Key Types

```typescript
type WritStatus = 'new' | 'open' | 'stuck' | 'completed' | 'failed' | 'cancelled';

interface WritDoc {
  id: string;           // ULID-like, prefixed "w-"
  type: string;         // declared or built-in type
  status: WritStatus;
  title: string;
  body: string;
  codex?: string;       // target codex name
  parentId?: string;    // parent writ id (absent on root writs, immutable)
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp, updated on every mutation
  resolvedAt?: string;  // ISO timestamp, set on any terminal transition
  resolution?: string;  // summary of how the writ resolved
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
  status?: WritStatus | WritStatus[];
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
```

See `src/types.ts` for the complete type definitions.

---

## Exports

The package exports all public types and the `createClerk()` factory:

```typescript
import clerkPlugin, { createClerk, type ClerkApi, type WritTypeInfo } from '@shardworks/clerk-apparatus';
```

The default export is a pre-built plugin instance, ready for guild installation.

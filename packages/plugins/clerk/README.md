# `@shardworks/clerk-apparatus`

The Clerk manages the lifecycle of **writs** — lightweight work orders that flow through a fixed status machine. Writs are created as commissions and ultimately completed, failed, or cancelled.

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

Post a new commission, creating a writ in `ready` status.

```typescript
const writ = await clerk.post({
  title: 'Refactor the session layer',
  body: 'Move all session logic into a dedicated module',
  type: 'mandate',      // optional, defaults to guild defaultType or "mandate"
  codex: 'artificer',  // optional target codex
});
```

| Parameter | Type | Description |
|---|---|---|
| `title` | `string` | Short human-readable title |
| `body` | `string` | Detail text (required) |
| `type` | `string` | Writ type — must be declared or built-in (optional) |
| `codex` | `string` | Target codex name (optional) |

Throws if the writ type is not declared in the guild config and is not a built-in type (`mandate`, `summon`).

### `show(id): Promise<WritDoc>`

Show a writ by id. Throws if not found.

### `list(filters?): Promise<WritDoc[]>`

List writs with optional filters, ordered by `createdAt` descending (newest first).

```typescript
const activeWrits = await clerk.list({ status: 'active', limit: 10 });
```

| Filter | Type | Description |
|---|---|---|
| `status` | `WritStatus` | Filter by status |
| `type` | `string` | Filter by writ type |
| `limit` | `number` | Maximum results (default: 20) |
| `offset` | `number` | Number of results to skip |

### `count(filters?): Promise<number>`

Count writs matching optional filters. Accepts the same filters as `list()` (except `limit` and `offset`).

```typescript
const total = await clerk.count({ status: 'ready' });
```

### `transition(id, to, fields?): Promise<WritDoc>`

Transition a writ to a new status, optionally setting additional fields atomically.

```typescript
// Accept
await clerk.transition(id, 'active');

// Complete with resolution
await clerk.transition(id, 'completed', { resolution: 'Shipped to production' });

// Fail with resolution
await clerk.transition(id, 'failed', { resolution: 'Build pipeline broke' });

// Cancel (resolution optional)
await clerk.transition(id, 'cancelled', { resolution: 'No longer needed' });
```

Throws if the transition is not legal for the writ's current status.

---

## Status Machine

```
ready ──────► active ──────► completed
  │              │
  │              └──────────► failed
  │
  └──────────────────────────► cancelled
         (from ready or active)
```

`completed`, `failed`, and `cancelled` are **terminal** — no transitions out.

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
    "quest": { "description": "A significant multi-step task" },
    "errand": { "description": "A small one-off task" }
  }
}
```

The built-in types `mandate` and `summon` are always available without declaration.

---

## Support Kit

The Clerk contributes one book and seven tools to the guild:

### Books

| Book | Indexes | Contents |
|---|---|---|
| `writs` | `status`, `type`, `createdAt`, `[status, type]`, `[status, createdAt]` | Writ documents |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `commission-post` | `clerk:write` | Post a new commission (create a writ) |
| `writ-show` | `clerk:read` | Show full detail for a writ |
| `writ-list` | `clerk:read` | List writs with optional filters |
| `writ-accept` | `clerk:write` | Accept a writ (ready → active) |
| `writ-complete` | `clerk:write` | Complete a writ (active → completed) |
| `writ-fail` | `clerk:write` | Fail a writ (active → failed) |
| `writ-cancel` | `clerk:write` | Cancel a writ (ready\|active → cancelled) |

---

## Key Types

```typescript
type WritStatus = 'ready' | 'active' | 'completed' | 'failed' | 'cancelled';

interface WritDoc {
  id: string;           // ULID-like, prefixed "writ-"
  type: string;         // declared or built-in type
  status: WritStatus;
  title: string;
  body: string;
  codex?: string;       // target codex name
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp, updated on every mutation
  acceptedAt?: string;  // ISO timestamp, set when transitioning to active
  resolvedAt?: string;  // ISO timestamp, set on any terminal transition
  resolution?: string;  // summary of how the writ resolved
}

interface PostCommissionRequest {
  title: string;
  body: string;         // required
  type?: string;        // defaults to guild defaultType or "mandate"
  codex?: string;
}
```

See `src/types.ts` for the complete type definitions.

---

## Exports

The package exports all public types and the `createClerk()` factory:

```typescript
import clerkPlugin, { createClerk, type ClerkApi } from '@shardworks/clerk-apparatus';
```

The default export is a pre-built plugin instance, ready for guild installation.

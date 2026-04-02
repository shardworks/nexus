# `@shardworks/clerk-apparatus`

The Clerk manages the lifecycle of **writs** — lightweight work orders that flow through a fixed status machine. Writs are created as commissions, accepted by an assignee, and ultimately completed, failed, or cancelled.

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

### `postCommission(request): Promise<WritDoc>`

Post a new commission, creating a writ in `ready` status.

```typescript
const writ = await clerk.postCommission({
  title: 'Refactor the session layer',
  body: 'Move all session logic into a dedicated module',
  type: 'mandate',       // optional, defaults to guild defaultType or "mandate"
  assignee: 'artificer', // optional
});
```

| Parameter | Type | Description |
|---|---|---|
| `title` | `string` | Short human-readable title |
| `body` | `string` | Optional detail text |
| `type` | `string` | Writ type — must be declared or built-in (optional) |
| `assignee` | `string` | Assignee name or id (optional) |

Throws if the writ type is not declared in the guild config and is not a built-in type (`mandate`, `summon`).

### `show(writId): Promise<WritDoc | null>`

Show a writ by id. Returns `null` if not found.

### `list(filters?): Promise<WritDoc[]>`

List writs with optional filters, ordered by `postedAt` descending (newest first).

```typescript
const activeWrits = await clerk.list({ status: 'active', limit: 10 });
```

| Filter | Type | Description |
|---|---|---|
| `status` | `WritStatus` | Filter by status |
| `type` | `string` | Filter by writ type |
| `assignee` | `string` | Filter by assignee |
| `limit` | `number` | Maximum results (default: 20) |

### `accept(writId): Promise<WritDoc>`

Accept a writ — transitions `ready → active`.

### `complete(writId): Promise<WritDoc>`

Complete a writ — transitions `active → completed`.

### `fail(writId, reason?): Promise<WritDoc>`

Fail a writ — transitions `active → failed`. Optionally records a reason.

### `cancel(writId): Promise<WritDoc>`

Cancel a writ — transitions `ready|active → cancelled`.

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
| `writs` | `status`, `type`, `assignee`, `postedAt` | Writ documents |

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
  title: string;
  body: string | null;
  status: WritStatus;
  assignee: string | null;
  postedAt: string;     // ISO timestamp
  acceptedAt: string | null;
  closedAt: string | null;
  failReason: string | null;
}

interface PostCommissionRequest {
  title: string;
  body?: string;
  type?: string;        // defaults to guild defaultType or "mandate"
  assignee?: string;
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

# `@shardworks/ratchet-apparatus`

The Ratchet manages the lifecycle of **clicks** — hierarchical task trackers that flow through a simple status machine: `live`, `parked`, `concluded`, or `dropped`. Clicks support typed links (including cross-substrate references), short-ID resolution, and tree extraction. Unlike the Clerk, Ratchet has no cascading behavior and no writ types — it is a minimal, independent click lifecycle manager.

The Ratchet sits downstream of The Stacks: `stacks <- ratchet`.

---

## Installation

Add to your package's dependencies:

```json
{
  "@shardworks/ratchet-apparatus": "workspace:*"
}
```

The Ratchet requires The Stacks to be installed in the guild.

---

## API

The Ratchet exposes a `RatchetApi` via its `provides` interface, retrieved at runtime:

```typescript
import type { RatchetApi } from '@shardworks/ratchet-apparatus';

const ratchet = guild().apparatus<RatchetApi>('ratchet');
```

### `create(params): Promise<ClickDoc>`

Create a new click in `live` status.

```typescript
const click = await ratchet.create({
  goal: 'Ship v2 release',
  parentId: parent.id,       // optional
  createdSessionId: 'sess-1', // optional
});
```

| Parameter | Type | Description |
|---|---|---|
| `goal` | `string` | Short description of the task (immutable after creation) |
| `parentId` | `string?` | Parent click ID for hierarchical nesting |
| `createdSessionId` | `string?` | Session that created this click |

### `get(id): Promise<ClickDoc>`

Fetch a click by its full ID. Throws if not found.

```typescript
const click = await ratchet.get('c-mo0z82ay-3ed22201ec13');
```

### `list(filters?): Promise<ClickDoc[]>`

List clicks with optional filters, ordered by `createdAt` descending.

```typescript
const live = await ratchet.list({ status: 'live', limit: 10 });
const children = await ratchet.list({ parentId: parent.id });
const mixed = await ratchet.list({ status: ['live', 'parked'] });
const descendants = await ratchet.list({ rootId: parent.id }); // recursive
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | `ClickStatus \| ClickStatus[]` | — | Filter by status |
| `parentId` | `string` | — | Filter to direct children |
| `rootId` | `string` | — | Filter to all descendants (recursive) |
| `limit` | `number` | `20` | Max results |
| `offset` | `number` | — | Skip N results |

### `park(id): Promise<ClickDoc>`

Transition a click from `live` to `parked`.

### `resume(id): Promise<ClickDoc>`

Transition a click from `parked` to `live`.

### `conclude(id, params): Promise<ClickDoc>`

Transition a click from `live` or `parked` to `concluded`. Sets `conclusion`, `resolvedAt`, and optionally `resolvedSessionId`.

```typescript
await ratchet.conclude(click.id, {
  conclusion: 'Shipped successfully',
  resolvedSessionId: 'sess-2',
});
```

### `drop(id, params): Promise<ClickDoc>`

Transition a click from `live` or `parked` to `dropped`. Same parameters as `conclude()`.

### `reparent(id, params): Promise<ClickDoc>`

Move a click to a new parent or to root. Circular parentage is detected and rejected. Allowed for clicks in any status.

```typescript
await ratchet.reparent(click.id, { parentId: newParent.id });
await ratchet.reparent(click.id, { parentId: null }); // move to root
```

### `link(params): Promise<ClickLinkDoc>`

Create a typed, directional link between entities. Same-substrate links validate both endpoints exist. Cross-substrate targets are stored without validation. Idempotent.

```typescript
await ratchet.link({
  sourceId: click.id,
  targetId: otherClick.id,
  linkType: 'related',
});
```

Valid link types: `'related'`, `'commissioned'`, `'supersedes'`, `'depends-on'`.

### `unlink(params): Promise<void>`

Remove a link. Throws if the link does not exist.

### `links(clickId): Promise<ClickLinks>`

Query outbound and inbound links for a click.

### `resolveId(prefix): Promise<string>`

Resolve a short ID prefix to a full click ID. Throws on zero or ambiguous matches.

```typescript
const fullId = await ratchet.resolveId('c-mo0z');
```

### `extract(rootId, params): Promise<string | ClickTree>`

Extract a click tree in markdown or JSON format. By default, only goals are shown (conclusions omitted). Pass `full: true` to include conclusions.

```typescript
const md = await ratchet.extract(root.id, { format: 'md' });           // goals only
const full = await ratchet.extract(root.id, { format: 'md', full: true }); // with conclusions
const tree = await ratchet.extract(root.id, { format: 'json' });       // JSON, goals only
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `format` | `'md' \| 'json'` | — | Output format |
| `full` | `boolean` | `false` | Include conclusions (default: goals only) |

### `tree(params?): Promise<ClickTree[]>`

Return the click hierarchy as a forest of trees. Returns all root clicks by default, or a specific subtree when `rootId` is given. Supports status filtering (prune semantics) and depth limiting.

```typescript
const forest = await ratchet.tree();                           // all roots
const subtree = await ratchet.tree({ rootId: root.id });       // specific subtree
const live = await ratchet.tree({ status: 'live' });           // only live clicks
const shallow = await ratchet.tree({ depth: 2 });              // limit depth
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `rootId` | `string` | — | Show subtree from this click |
| `status` | `ClickStatus \| ClickStatus[]` | — | Filter by status (prune semantics) |
| `depth` | `number` | — | Maximum tree depth |

---

## Status Machine

```
live ──> parked ──> concluded
  │         │          
  │         └────> dropped
  │
  ├──> concluded
  └──> dropped
```

Only these transitions are valid:
- `live -> parked`, `parked -> live`
- `live -> concluded`, `live -> dropped`
- `parked -> concluded`, `parked -> dropped`

Terminal statuses (`concluded`, `dropped`) allow no further transitions.

---

## Support Kit

### Books

| Book | Description |
|---|---|
| `clicks` | Click documents with indexes on status, createdAt, parentId |
| `click_links` | Link documents with indexes on sourceId, targetId, linkType |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `click-create` | write | Create a new click |
| `click-show` | read | Show click with links, parent, and children context |
| `click-list` | read | List clicks with filters |
| `click-park` | write | Park a live click |
| `click-resume` | write | Resume a parked click |
| `click-conclude` | write | Conclude a click |
| `click-drop` | write | Drop a click |
| `click-reparent` | write | Move a click to a new parent |
| `click-link` | write | Create a typed link |
| `click-unlink` | write | Remove a link |
| `click-extract` | read | Extract a click tree (always includes conclusions for concluded/dropped clicks) |
| `click-tree` | read | Display click hierarchy as a visual tree with short IDs and status indicators |

All tools that accept an `id` parameter resolve short ID prefixes automatically via `resolveId()`. Tools with a single required ID parameter also accept the ID as a positional argument (e.g., `nsg click show <id>`).

---

## Types

All types are exported from the package root:

```typescript
import type {
  ClickDoc,
  ClickLinkDoc,
  ClickLinks,
  ClickStatus,
  LinkType,
  ClickFilters,
  ClickTree,
  RatchetApi,
  CreateClickRequest,
  ConcludeClickRequest,
  DropClickRequest,
  ReparentClickRequest,
  LinkClickRequest,
  UnlinkClickRequest,
  ExtractClickRequest,
  TreeParams,
} from '@shardworks/ratchet-apparatus';
```

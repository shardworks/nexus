# `@shardworks/nexus-core`

The public SDK for Nexus Mk 2.1. Rig authors import from this package to define tools, declare books, and read guild configuration.

This package is a dependency of every rig. It does not depend on arbor or the CLI — the dependency graph runs one way: rigs → core.

---

## `tool()` — Tool SDK

Define a Nexus tool. This is the primary authoring entry point for rig packages.

```typescript
import { tool } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'greet',
  description: 'Greet an anima by name',
  params: {
    name: z.string().describe('Anima name'),
  },
  handler: async ({ name }, ctx) => {
    return `Hello, ${name}! Guild root: ${ctx.home}`;
  },
});
```

A rig package exports a `Rig` object, a single tool, or an array of tools as its default export. Arbor discovers them automatically at install time.

### `ToolDefinition`

The return type of `tool()`. MCP, CLI, and engines all consume this shape.

### `ToolCaller`

`'cli' | 'mcp'` — controls which surfaces a tool appears on. Set via `callableFrom`:

```typescript
tool({
  name: 'rig-install',
  callableFrom: ['cli'],   // CLI only — not exposed to animas via MCP
  ...
});
```

Defaults to all callers if omitted.

### Resolution helpers

```typescript
// Find one tool from a module's default export
resolveToolFromExport(moduleDefault, toolName?)

// Find all tools from a module's default export
resolveAllToolsFromExport(moduleDefault)

// Type guard
isToolDefinition(obj)
```

---

## `Rig` — Rig Export Type

The author-facing export type for a rig package. Rig packages export this as their default export. Arbor reads it at load time to discover the rig's contributions.

```typescript
import { type Rig, tool } from '@shardworks/nexus-core';

const myTool = tool({ ... });

export default {
  tools: [myTool],
  books: {
    writs: { indexes: ['status', 'createdAt', 'parent.id'] },
  },
} satisfies Rig;
```

| Field | Type | Description |
|---|---|---|
| `tools?` | `ToolDefinition[]` | Tools this rig contributes to the guild |
| `books?` | `Record<string, BookOptions>` | Named document collections — arbor creates SQLite tables and indexes at startup |

Backward-compatible: rigs may still export a bare `ToolDefinition` or `ToolDefinition[]` directly.

### `BookOptions`

Schema declaration for a single book:

```typescript
interface BookOptions {
  indexes?: string[];  // field names to index (plain or dot-notation)
}
```

### `isRig(obj)`

Type guard distinguishing a `Rig` export from a bare tool or array.

---

## `RigContext` — Handler Context

Injected into every tool and engine handler. Scoped to the rig that owns the handler.

```typescript
interface RigContext {
  home: string;

  book<T extends { id: string }>(name: string): Book<T>;
  rigBook<T extends { id: string }>(rigId: string, name: string): ReadOnlyBook<T>;
}
```

| Member | Returns | Description |
|---|---|---|
| `home` | `string` | Absolute path to the guild root |
| `book(name)` | `Book<T>` | Read-write handle to one of this rig's declared books |
| `rigBook(rigId, name)` | `ReadOnlyBook<T>` | Read-only handle to another rig's book |

`ToolContext` is a deprecated alias for `RigContext`, re-exported from legacy for backward compatibility.

---

## `Book<T>` — Document Store

The NoSQL document store primitive for rig authors. `T` must extend `{ id: string }` — rig authors own ID generation.

| Method | Description |
|---|---|
| `put(content)` | Upsert a document (creates or replaces entirely by `content.id`) |
| `get(id)` | Retrieve by id, or `null` |
| `delete(id)` | Remove by id (silent no-op if absent) |
| `find(query)` | Query with `where`, `orderBy`, `order`, `limit`, `offset` |
| `list(options?)` | List all documents, optionally paginated and sorted |
| `count(where?)` | Count documents matching an optional filter |

### `BookQuery`

```typescript
type BookQuery = {
  where?: Record<string, unknown>;  // field equality filters, ANDed
  orderBy?: string;                 // plain name or dot-notation
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;                  // requires limit
}
```

### `ReadOnlyBook<T>`

Returned by `rigBook()` for cross-rig access. Same as `Book<T>` minus `put` and `delete`.

---

## `guild-config` — Guild Configuration

Read and write `guild.json`, the guild's central configuration file.

```typescript
import { readGuildConfigV2, writeGuildConfigV2 } from '@shardworks/nexus-core';

const config = readGuildConfigV2(home);
config.baseTools.push('my-tool');
writeGuildConfigV2(home, config);
```

### `GuildConfigV2`

The shape of `guild.json` for V2 guilds:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Guild name |
| `nexus` | `string` | Framework version at last init/upgrade |
| `rigs` | `string[]` | Installed rig keys (derived from npm package names) |
| `baseTools` | `string[]` | Tools available to all animas |
| `roles` | `Record<string, RoleDefinition>` | Guild roles with seats, tools, instructions |
| `workshops` | `Record<string, WorkshopEntry>` | Registered workshops |
| `settings?` | `GuildSettings` | Operational flags including default `model` |
| `clockworks?` | `ClockworksConfig` | Standing orders and custom events |
| `writTypes?` | `Record<string, WritTypeDeclaration>` | Custom writ type declarations |

### Other exports

```typescript
guildConfigPath(home)              // path to guild.json
createInitialGuildConfigV2(...)    // default config for nsg init
```

---

## `nexus-home` — Path Resolution

Resolve standard paths within a guild's `.nexus/` directory.

```typescript
import { findGuildRoot, nexusDir } from '@shardworks/nexus-core';

const home = findGuildRoot();          // walks up from cwd to find guild.json
const dir  = nexusDir(home);           // .nexus/
```

### All path helpers

| Function | Returns |
|---|---|
| `findGuildRoot(startDir?)` | Guild root (walks up from cwd, throws if not found) |
| `nexusDir(home)` | `.nexus/` |
| `worktreesPath(home)` | `.nexus/worktrees/` |
| `workshopsPath(home)` | `.nexus/workshops/` |
| `workshopBarePath(home, name)` | `.nexus/workshops/<name>.git` |
| `clockPidPath(home)` | `.nexus/clock.pid` |
| `clockLogPath(home)` | `.nexus/clock.log` |

---

## `rig-descriptor` — Rig Descriptor Types

Types for `rig.json`, the optional descriptor a rig package can include at its root to declare dependencies on other rigs.

```typescript
import type { RigDescriptor } from '@shardworks/nexus-core';
```

### `RigDescriptor`

```typescript
interface RigDescriptor {
  description?: string;
  dependencies?: RigDependency[];
}

interface RigDependency {
  rig: string;   // rig key, e.g. 'nexus-stdlib'
}
```

Arbor reads `rig.json` at install time. If declared dependencies aren't installed, `nsg rig install` fails with a clear error.

A rig with no dependencies needs no `rig.json` at all.

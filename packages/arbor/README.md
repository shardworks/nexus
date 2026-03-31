# `@shardworks/nexus-arbor`

The guild runtime host for Nexus Mk 2.1. The arbor loads installed rigs, assembles the tool surface, and injects guild context into the CLI and MCP server.

## Package roles

```
@shardworks/nexus-core   — public SDK, types, tool() factory
@shardworks/nexus-arbor  — guild host, createArbor(), Arbor object
@shardworks/nexus (cli)  — nsg binary, maps Tool[] → Commander commands
rigs                     — import from nexus-core only
```

Rig authors import from `@shardworks/nexus-core`. The arbor is an internal concern of the CLI and session provider — not something rigs depend on directly.

## Runtime API

```typescript
import { createArbor } from '@shardworks/nexus-arbor';

const arbor = createArbor('/path/to/guild');
```

### `Arbor`

| Method | Returns | Description |
|---|---|---|
| `arbor.home` | `string` | Absolute path to the guild root |
| `arbor.getGuildConfig()` | `GuildConfigV2` | Parsed `guild.json`, read at construction time |
| `arbor.getRigConfig(name)` | `Record<string, unknown>` | Rig-specific config section from `guild.json`. Accepts key (`'nexus-stdlib'`) or full package name |
| `arbor.listRigs()` | `Promise<LoadedRig[]>` | All installed rigs, including the arbor's own built-ins. Lazy-loaded and cached |
| `arbor.findRig(name)` | `Promise<LoadedRig \| null>` | Find a rig by key or full package name |
| `arbor.listTools(options?)` | `Promise<Tool[]>` | All tools, optionally filtered by `channel` and/or `roles` |
| `arbor.findTool(name)` | `Promise<Tool \| null>` | Find a tool by name, across all rigs |
| `arbor.getDatabase()` | `BooksDatabase` | Lazily-opened SQLite connection to `.nexus/nexus.db`. Cached for process lifetime |
| `arbor.createRigContext(rigId)` | `RigContext` | Scoped context with `book(name)` (read-write) and `rigBook(otherRigId, name)` (read-only) handles |

### `LoadedRig`

An installed rig package as seen by the arbor — its identity, module instance, and resolved tool list:

```typescript
interface LoadedRig {
  packageName: string;  // full npm name, e.g. '@shardworks/nexus-stdlib'
  id: string;           // guild-facing id, e.g. 'nexus-stdlib'
  version: string;
  instance: Rig;        // the package's default export, normalized to Rig shape
  tools: Tool[];        // tools with rigId provenance
}
```

`instance` is the raw `Rig` object from the package's default export (see `nexus-core` SDK). Backward-compatible exports (bare `ToolDefinition` or `ToolDefinition[]`) are normalized to `{ tools: [...] }` on load.

### `Tool`

A `ToolDefinition` (from `nexus-core`) with provenance:

```typescript
interface Tool extends ToolDefinition {
  rigId: string;  // derived rig id of the rig that owns this tool (e.g. 'nexus-ledger')
}
```

### `ListToolsOptions`

```typescript
interface ListToolsOptions {
  channel?: 'cli' | 'mcp';   // filter to tools available in this channel
  roles?: string[];           // filter to tools accessible to these roles
}
```

### `deriveRigId(packageName)`

Converts an npm package name to the guild-facing rig id used in `guild.json`, CLI commands, and config sections:

```
@shardworks/nexus-stdlib  →  nexus-stdlib   (official scope stripped)
@acme/my-rig              →  acme/my-rig    (third-party: @ dropped)
my-rig                    →  my-rig         (unscoped: unchanged)
```

### `findGuildRoot()`

Re-exported from `nexus-core` for convenience — walks up from `cwd` to find the nearest guild root (directory containing `guild.json`).

## Built-in CLI commands

These ship with the arbor itself and are always available via `nsg`, regardless of what rigs are installed.

| Command | Description |
|---|---|
| `nsg init <path>` | Create a new guild: directory structure, `guild.json`, `package.json`, `.gitignore` |
| `nsg version` | Show Nexus framework version and installed rig versions |
| `nsg status` | Show guild identity, installed rigs, and configured roles |
| `nsg upgrade` | Upgrade framework and run pending rig migrations *(stub)* |
| `nsg rig list` | List installed rigs |
| `nsg rig install <source>` | Install a rig from npm, a git URL, or a local directory |
| `nsg rig remove <name>` | Remove a rig and unregister its tools |
| `nsg rig upgrade <name>` | Upgrade a rig to a newer version *(stub)* |

### `nsg init`

Writes the minimum viable guild. Does not run `git init`, create the database, or instantiate animas — those are separate steps.

```sh
nsg init ./my-guild --name my-guild
cd my-guild
nsg rig install @shardworks/nexus-stdlib
```

### `nsg rig install`

Accepts npm package specifiers, version pins, and git URLs:

```sh
nsg rig install @shardworks/nexus-stdlib
nsg rig install nexus-stdlib@1.2.0
nsg rig install git+https://github.com/acme/my-rig.git

# Symlink a local directory (dev workflow)
nsg rig install ./path/to/my-rig --type link
```

Tools are added to `baseTools` by default (available to all animas). Pass `--roles` to assign to specific roles instead:

```sh
nsg rig install @shardworks/nexus-stdlib --roles artificer,scribe
```

## Inter-rig API convention

Rigs that expose a typed API to other rigs export a `fromArbor` factory:

```typescript
// In a rig package
import type { Arbor } from '@shardworks/nexus-arbor';

export function fromArbor(arbor: Arbor) {
  const config = arbor.getRigConfig('my-rig');
  return {
    doSomething() { ... }
  };
}
```

Callers import the rig package and call `fromArbor(arbor)` to get a typed, initialized reference.

## Rig descriptor (`rig.json`)

A rig package may include a `rig.json` at its root to declare dependencies on other rigs. Checked at install time — missing dependencies cause `nsg rig install` to fail with a clear error.

```json
{
  "description": "My rig",
  "dependencies": [
    { "rig": "nexus-stdlib" }
  ]
}
```

All fields are optional. A rig with no dependencies needs no `rig.json`.

## Books database

The arbor manages a SQLite database at `.nexus/nexus.db` (WAL mode, foreign keys enabled) that provides document storage for rigs.

### Schema reconciliation

On first rig load, `reconcileBooks()` iterates each rig's declared `books` schema and creates tables and indexes. This is additive only — tables are never dropped or altered.

Each book gets a table named `books_<rigId>_<bookName>`:

```sql
CREATE TABLE IF NOT EXISTS "books_nexus_stdlib_writs" (
  id      TEXT PRIMARY KEY,
  content TEXT NOT NULL      -- JSON document
);
```

Indexed fields use `json_extract(content, '$.field')`.

### `BookStore<T>`

The document store backing each book. Implements `Book<T>` from `nexus-core`.

| Method | Description |
|---|---|
| `put(content)` | Upsert a document (JSON-serialized, keyed by `content.id`) |
| `get(id)` | Retrieve by id, or `null` |
| `delete(id)` | Remove by id |
| `find(query)` | Query with `where`, `orderBy`, `order`, `limit`, `offset` |
| `list(options?)` | Alias for `find()` |
| `count(where?)` | Count documents, optionally filtered |

All queries are parameterized. Field names in `where` and `orderBy` are validated against `^[A-Za-z0-9_.-]+$`.

### `BooksDatabase`

Low-level SQL interface returned by `arbor.getDatabase()`. Exposes a single `execute(sql, args?)` method returning `{ rows, columns, rowsAffected, lastInsertRowid }`.

### Public exports

```typescript
import {
  openBooksDatabase,    // factory: (guildRoot) => BooksDatabase
  BookStore,            // BookStore<T> class
  booksTableName,       // (rigId, bookName) => qualified table name
  reconcileBooks,       // (db, rigs) => Promise<void>
  type BooksDatabase,
  type SqlRow,
  type SqlResult,
} from '@shardworks/nexus-arbor';
```

## Lazy loading

Rig modules are imported dynamically from the guild's `node_modules` on the first call to `listRigs()` or `listTools()`, then cached for the lifetime of the `Arbor` instance. This keeps startup fast — the arbor reads `guild.json` synchronously at construction and defers all module I/O until tools are actually needed.

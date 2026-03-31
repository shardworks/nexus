# `@shardworks/nexus-arbor`

The guild runtime host for Nexus Mk 2.1. The arbor loads installed plugins, assembles the tool surface, and injects context into the CLI and MCP server.

## Package roles

```
@shardworks/nexus-core   — public SDK, types, tool() factory
@shardworks/nexus-arbor  — guild host, createArbor(), Arbor object
@shardworks/nexus (cli)  — nsg binary, maps Tool[] → Commander commands
plugins                  — import from nexus-core only
```

Plugin authors import from `@shardworks/nexus-core`. The arbor is an internal concern of the CLI and session provider — plugins never depend on it directly.

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
| `arbor.getPluginConfig(pluginId)` | `Record<string, unknown>` | Plugin-specific config section from `guild.json`. Accepts derived id (`'nexus-stdlib'`) or full package name. Returns `{}` if absent |
| `arbor.listKits()` | `Promise<LoadedKit[]>` | All installed kits, including the arbor's own built-ins. Lazy-loaded and cached |
| `arbor.listApparatuses()` | `Promise<LoadedApparatus[]>` | All installed apparatuses. Lazy-loaded and cached |
| `arbor.listPlugins()` | `Promise<LoadedPlugin[]>` | All installed plugins (kits + apparatuses). Lazy-loaded and cached |
| `arbor.findPlugin(name)` | `Promise<LoadedPlugin \| null>` | Find a plugin by derived id or full package name |
| `arbor.listTools(options?)` | `Promise<Tool[]>` | All tools, optionally filtered by `channel` and/or `roles` |
| `arbor.findTool(name)` | `Promise<Tool \| null>` | Find a tool by name, across all plugins |
| `arbor.createHandlerContext()` | `HandlerContext` | Create context for dispatching a tool or engine handler. Requires plugins to be loaded first |
| `arbor.getDatabase()` | `BooksDatabase` | Lazily-opened SQLite connection to `.nexus/nexus.db`. **Transitional** — will move to the nexus-books apparatus |

### `LoadedKit` and `LoadedApparatus`

Installed plugin packages as seen by the arbor runtime:

```typescript
interface LoadedKit {
  packageName: string;  // full npm name, e.g. '@shardworks/nexus-stdlib'
  id:          string;  // derived plugin id, e.g. 'nexus-stdlib'
  version:     string;
  kit:         Kit;     // the package's Kit object
}

interface LoadedApparatus {
  packageName: string;
  id:          string;
  version:     string;
  apparatus:   Apparatus;  // the package's Apparatus object
}

// Union type
type LoadedPlugin = LoadedKit | LoadedApparatus;
```

Type guards: `isLoadedKit(p)` and `isLoadedApparatus(p)` from `@shardworks/nexus-core`.

### `Tool`

A `ToolDefinition` (from `nexus-core`) with provenance:

```typescript
interface Tool extends ToolDefinition {
  pluginId: string;  // derived plugin id of the owning plugin (e.g. 'nexus-ledger')
}
```

### `ListToolsOptions`

```typescript
interface ListToolsOptions {
  channel?: 'cli' | 'mcp';  // filter to tools available in this channel
  roles?:   string[];        // filter to tools accessible to these roles
}
```

### `derivePluginId(packageName)`

Converts an npm package name to the guild-facing plugin id used in `guild.json`, CLI commands, and config sections:

```
@shardworks/nexus-stdlib  →  nexus-stdlib   (official scope stripped)
@acme/my-plugin           →  acme/my-plugin (third-party: @ dropped)
my-plugin                 →  my-plugin      (unscoped: unchanged)
```

### `findGuildRoot()`

Re-exported from `nexus-core` for convenience — walks up from `cwd` to find the nearest guild root (directory containing `guild.json`).

---

## Plugin loading

The arbor's `loadAndStart()` runs in five phases on the first call to any listing method:

1. **Load** — imports all declared plugin packages from `node_modules`, discriminates kit vs. apparatus
2. **Validate** — checks `requires` declarations, detects circular apparatus dependencies
3. **Warn** — advisory warnings for mismatched kit contributions vs. apparatus `consumes`
4. **Start** — calls `start(ctx)` on each apparatus in dependency-resolved order; fires `plugin:initialized` after each
5. **Reconcile** — scans kit `books` contributions and creates SQLite tables

Apparatus start order is determined by topological sort on `apparatus.requires`. Circular dependencies throw with a descriptive error. Kit `requires` validate that the named apparatuses are installed but do not affect start order (kits have no lifecycle).

---

## Built-in CLI commands

These ship with the arbor itself and are always available via `nsg`, regardless of what plugins are installed.

| Command | Description |
|---|---|
| `nsg init <path>` | Create a new guild: directory structure, `guild.json`, `package.json`, `.gitignore` |
| `nsg version` | Show Nexus framework version and installed plugin versions |
| `nsg status` | Show guild identity, installed plugins, and configured roles |
| `nsg upgrade` | Upgrade framework and run pending plugin migrations *(stub)* |
| `nsg rig list` | List installed plugins |
| `nsg rig install <source>` | Install a plugin from npm, a git URL, or a local directory |
| `nsg rig remove <name>` | Remove a plugin and unregister its tools |
| `nsg rig upgrade <name>` | Upgrade a plugin to a newer version *(stub)* |

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
nsg rig install git+https://github.com/acme/my-plugin.git

# Symlink a local directory (dev workflow)
nsg rig install ./path/to/my-plugin --type link
```

Tools are added to `baseTools` by default (available to all animas). Pass `--roles` to assign to specific roles instead:

```sh
nsg rig install @shardworks/nexus-stdlib --roles artificer,scribe
```

---

## Books database

The arbor manages a SQLite database at `.nexus/nexus.db` (WAL mode, foreign keys enabled).

> **Transitional:** Books database management will move to the `nexus-books` apparatus when it ships. `arbor.getDatabase()` is marked `@deprecated` and will be removed at that point.

### Schema reconciliation

On plugin load, `reconcileBooks()` scans each kit's `books` contribution field and creates tables and indexes. This is additive only — tables are never dropped or altered.

Each book gets a table named `books_<pluginId>_<bookName>`:

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
  booksTableName,       // (pluginId, bookName) => qualified table name
  reconcileBooks,       // (db, kits) => Promise<void>
  type BooksDatabase,
  type SqlRow,
  type SqlResult,
} from '@shardworks/nexus-arbor';
```

---

## Lazy loading

Plugin modules are imported dynamically from the guild's `node_modules` on the first call to `listKits()`, `listApparatuses()`, `listPlugins()`, or `listTools()`, then cached for the lifetime of the `Arbor` instance. This keeps startup fast — the arbor reads `guild.json` synchronously at construction and defers all module I/O until plugins are actually needed.

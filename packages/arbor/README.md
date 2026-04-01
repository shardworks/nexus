# `@shardworks/nexus-arbor`

The guild runtime host for Nexus Mk 2.1. The arbor reads `guild.json`, loads all declared plugins, validates the dependency graph, starts each apparatus in dependency order, and wires the `guild()` singleton. It is the bootstrap layer — every entry point (the CLI, the MCP server, the Clockworks daemon) calls `createGuild()` once at startup.

```
@shardworks/nexus-core   — public SDK, types, guild() singleton
@shardworks/nexus-arbor  — guild host, createGuild(), Guild object
@shardworks/nexus (cli)  — nsg binary, framework commands + Instrumentarium tools
plugins                  — import from nexus-core only
```

Plugin authors import from `@shardworks/nexus-core`. The arbor is an internal concern of the CLI and session provider — plugins never depend on it directly.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/nexus-arbor": "workspace:*"
  }
}
```

---

## API

### `createGuild(root?)`

The single entry point. Creates and starts a guild, returning the `Guild` object.

```typescript
import { createGuild } from '@shardworks/nexus-arbor';

const guild = await createGuild('/path/to/guild');
```

If `root` is omitted, auto-detects by walking up from cwd until `guild.json` is found.

`createGuild()` also sets the `guild()` singleton from `@shardworks/nexus-core`, so apparatus code can call `guild()` immediately after startup.

### `Guild`

The object returned by `createGuild()` — also accessible via `guild()` from `@shardworks/nexus-core`.

| Method | Returns | Description |
|---|---|---|
| `home` | `string` | Absolute path to the guild root |
| `apparatus<T>(name)` | `T` | Retrieve a started apparatus's `provides` API by plugin id. Throws if the apparatus has no `provides` |
| `config<T>(pluginId)` | `T` | Read the plugin-specific configuration section from `guild.json` |
| `guildConfig()` | `GuildConfig` | The full parsed `guild.json` |
| `kits()` | `LoadedKit[]` | All loaded kits (snapshot copy) |
| `apparatuses()` | `LoadedApparatus[]` | All loaded apparatus in start order (snapshot copy) |

### `LoadedKit` and `LoadedApparatus`

Installed plugin packages as seen by the runtime:

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

type LoadedPlugin = LoadedKit | LoadedApparatus;
```

Type guards: `isLoadedKit(p)` and `isLoadedApparatus(p)` from `@shardworks/nexus-core`.

---

## Plugin Lifecycle

`createGuild()` runs the full plugin lifecycle on each call:

1. **Load** — imports all declared plugin packages from `node_modules`, discriminates kit vs. apparatus.
2. **Validate** — checks `requires` declarations (apparatus and kit), detects circular apparatus dependencies. Fails loudly before any apparatus starts.
3. **Warn** — advisory warnings for kit contributions that no apparatus `consumes`, and for missing `recommends`.
4. **Wire** — sets the `guild()` singleton. The `provides` map is populated progressively as each apparatus starts; dependency ordering guarantees declared deps are available.
5. **Start** — fires `plugin:initialized` for all kits, then calls `start(ctx)` on each apparatus in dependency-resolved order, firing `plugin:initialized` after each.

Apparatus start order is determined by topological sort on `apparatus.requires`. Circular dependencies throw with a descriptive error. Kit `requires` validate that the named apparatus is installed but do not affect start order (kits have no lifecycle).

---

## Guild Lifecycle Internals

Pure validation and ordering logic lives in `guild-lifecycle.ts`, separated from I/O:

| Function | Description |
|---|---|
| `validateRequires(kits, apparatuses)` | Validates all `requires` declarations and detects circular dependencies |
| `topoSort(apparatuses)` | Topological sort by `requires` — determines apparatus start order |
| `collectStartupWarnings(kits, apparatuses)` | Advisory warnings for unconsumed contributions and missing recommends |
| `buildStartupContext(eventHandlers)` | Creates the `StartupContext` passed to `apparatus.start()` |
| `fireEvent(eventHandlers, event, ...args)` | Fires lifecycle events to registered handlers |

These are exported for testing but are not part of the consumer-facing API.

---

## Lazy Startup

The arbor does no work at import time. `createGuild()` is async and performs all plugin loading, validation, and startup in a single call. There is no background process or persistent state — the `Guild` object is alive for the lifetime of the process that created it.

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

The single entry point. Creates and starts a guild, returning a `StartedGuild` — a `Guild` plus a `shutdown()` method.

```typescript
import { createGuild } from '@shardworks/nexus-arbor';

const guild = await createGuild('/path/to/guild');
// ... do work ...
await guild.shutdown();
```

If `root` is omitted, auto-detects by walking up from cwd until `guild.json` is found.

`createGuild()` also sets the `guild()` singleton from `@shardworks/nexus-core`, so apparatus code can call `guild()` immediately after startup. Plugin code only ever sees the narrower `Guild` interface — `shutdown()` is intentionally absent there because plugins should never tear down the guild they are running inside. The bootstrap caller (the CLI, a daemon entry point, a one-shot helper) carries the `StartedGuild` reference and is responsible for calling `shutdown()` before exit.

### `StartedGuild`

`StartedGuild extends Guild` and adds:

| Method | Returns | Description |
|---|---|---|
| `shutdown()` | `Promise<void>` | Fire `guild:shutdown`, then call each started apparatus's optional `stop()` in reverse topological order (dependents before dependencies), then clear the `guild()` singleton. Idempotent — second and subsequent calls return immediately. Continues iterating even when one `stop()` throws; if any throw, an aggregate `Error` is thrown after every apparatus has been attempted, with per-apparatus failures attached as `.failures`. |

### `Guild`

The narrow contract plugin code sees through `guild()` — also returned (via the `StartedGuild` extension) from `createGuild()`.

| Method | Returns | Description |
|---|---|---|
| `home` | `string` | Absolute path to the guild root |
| `apparatus<T>(name)` | `T` | Retrieve a started apparatus's `provides` API by plugin id. Throws if the apparatus has no `provides` — use for `requires` dependencies |
| `tryApparatus<T>(name)` | `T \| null` | Same lookup as `apparatus<T>`, but returns `null` instead of throwing when the apparatus is absent. Use for `recommends` dependencies so the caller branches on presence rather than catching a thrown error |
| `config<T>(pluginId)` | `T` | Read the plugin-specific configuration section from `guild.json` |
| `writeConfig<T>(pluginId, value)` | `void` | Write a plugin's configuration section to `guild.json` and persist to disk |
| `guildConfig()` | `GuildConfig` | The full parsed `guild.json` |
| `kits()` | `LoadedKit[]` | All loaded kits (snapshot copy) |
| `apparatuses()` | `LoadedApparatus[]` | All loaded apparatus in start order (snapshot copy) |
| `failedPlugins()` | `FailedPlugin[]` | Plugins that failed to load, validate, or start (snapshot copy) |
| `startupWarnings()` | `string[]` | Advisory warnings collected during startup (missing recommends, unconsumed contributions) |

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
4. **Wire** — collects all kit contributions (standalone kits and apparatus `supportKit` entries) into a flat `KitEntry[]`, then sets the `guild()` singleton. The `provides` map is populated progressively as each apparatus starts; dependency ordering guarantees declared deps are available.
5. **Start** — calls `start(ctx)` on each apparatus in dependency-resolved order, firing `apparatus:started` after each. Once all apparatus have started, fires `phase:started` once.

Apparatus start order is determined by topological sort on `apparatus.requires`. Circular dependencies throw with a descriptive error. Kit `requires` validate that the named apparatus is installed but do not affect start order (kits have no lifecycle).

`StartedGuild.shutdown()` is the symmetric teardown path:

6. **Shutdown** — fires `guild:shutdown` once, then walks the started-apparatus list in reverse topological order (dependents before dependencies — e.g. Oculus closes its HTTP server before Stacks closes the sqlite handle that route handlers might query) and calls each apparatus's optional `stop()`. Errors from individual `stop()` calls are collected, not raised eagerly, so every apparatus gets a chance to release its handles; the aggregate is re-thrown after iteration completes. The call is idempotent (a second invocation is a no-op via an internal flag), and clears the `guild()` singleton as its last act so post-shutdown access fails loudly with the existing "Guild not initialized" error.

---

## Guild Lifecycle Internals

Pure validation and ordering logic lives in `guild-lifecycle.ts`, separated from I/O:

| Function | Description |
|---|---|
| `validateRequires(kits, apparatuses)` | Validates all `requires` declarations and detects circular dependencies |
| `filterFailedPlugins(kits, apparatuses, rootFailures)` | Removes plugins that transitively depend on any failed plugin; cascades until stable |
| `topoSort(apparatuses)` | Topological sort by `requires` — determines apparatus start order |
| `wireKitEntries(kits, orderedApparatuses)` | Collects all kit contributions (standalone + apparatus supportKit) into a flat `KitEntry[]` |
| `collectStartupWarnings(kits, apparatuses)` | Advisory warnings for unconsumed contributions and missing recommends |
| `buildStartupContext(eventHandlers, kitEntries)` | Creates the `StartupContext` passed to `apparatus.start()` |
| `fireEvent(eventHandlers, event, ...args)` | Fires lifecycle events to registered handlers |
| `shutdownStartedApparatuses(startedApparatuses, eventHandlers)` | Fires `guild:shutdown`, walks the started-apparatus list in reverse and calls each `stop()`, returning the per-apparatus failures as an array (the caller wraps with idempotency, `clearGuild()`, and aggregate-throw) |
| `formatShutdownFailures(failures)` | Render the aggregate-error message thrown when one or more `stop()` calls failed |

These are exported for testing but are not part of the consumer-facing API.

---

## Lazy Startup

The arbor does no work at import time. `createGuild()` is async and performs all plugin loading, validation, and startup in a single call. There is no background process or persistent state — the `Guild` object is alive for the lifetime of the process that created it.

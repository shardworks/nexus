# Core API Reference

`@shardworks/nexus-core` is the public SDK substrate for Nexus Mk 2.1. Every plugin — kit or apparatus — depends on this package for the `guild()` singleton, the Plugin/Kit/Apparatus type model, guild configuration helpers, and a small bag of process and path utilities. The package has zero runtime dependencies; the dependency graph runs one way (plugins → core).

This reference documents only what `@shardworks/nexus-core` re-exports. Each export is described with the audience it is intended for (plugin code vs framework infrastructure). For every surface that used to live here in v1 — anima identity, commissions and writs, sessions, conversations, the Clockworks runner and daemon, tool authoring and installation, workshops, bundles, migrations, upgrade, init, rehydrate, books and schemas — the migration map below points at its current owner.

This document mirrors the section order of the in-package [README](../../packages/framework/core/README.md). The two are intended to be read together; if they disagree, the README is the source of truth and this doc is the bug.

---

## Surface Migration Map

The v1 `nexus-core` surface area was much larger. Apparatus modularisation moved most of it into dedicated packages; a few v1 concepts (workshops, bundles, rehydrate) have been retired entirely and replaced by different machinery in v2. For every retired surface area, the table below names its current owner.

Each row is a single sentence with one link, matching the established Authoring-section convention (`tool()` and `relay()` rows below).

| Old surface area | New owner |
|---|---|
| `tool()` factory, `ToolDefinition`, `ToolCaller`, `isToolDefinition()`, `resolveToolFromExport()` | Moved to `@shardworks/tools-apparatus` — see the [Instrumentarium API Contract](../architecture/apparatus/instrumentarium.md) for the tool authoring API. |
| `relay()` factory, `RelayDefinition`, `RelayContext`, `RelayHandler`, `GuildEvent`, `isRelayDefinition()` | Moved to `@shardworks/clockworks-apparatus` — see [The Clockworks](../architecture/clockworks.md) for the relay authoring API. |
| Anima identity (`instantiate`, `listAnimas`, `showAnima`, `updateAnima`, `removeAnima`, `readAnima`) | Moved to The Loom — see the [Loom API Contract](../architecture/apparatus/loom.md) for the anima registry API. |
| System prompt composition (`readCodex`, `readRoleInstructions`, `assembleSystemPrompt`, `manifest`) and the role registry | Moved to The Loom — see the [Loom API Contract](../architecture/apparatus/loom.md) for the manifest/composition surface. |
| Commissions and writs (`commission`, `listCommissions`, `readCommission`, `showCommission`, `updateCommissionStatus`, `createWrit`, `listWrits`, `showWrit`, `updateWritStatus`, `completeWrit`, `failWrit`, `getWritProgress`) | Moved to The Clerk — see the [Clerk API Contract](../architecture/apparatus/clerk.md) for the writ and commission API. |
| Sessions, the Daybook, and the audit log (`listSessions`, `showSession`, `listAuditLog`, `launchSession`, `registerSessionProvider`, `getSessionProvider`, `resolveWorkspace`, `createTempWorktree`, `removeTempWorktree`) | Moved to The Animator — see the [Animator API Contract](../architecture/apparatus/animator.md) for the session funnel and Daybook API. |
| Conversations (`createConversation`, `takeTurn`, `endConversation`, `nextParticipant`, `formatConveneMessage`, `listConversations`, `showConversation`) | Moved to The Parlour — see the [Parlour API Contract](../architecture/apparatus/parlour.md) for the conversation API. |
| Events (`signalEvent`, `readEvent`, `listEvents`, `isFrameworkEvent`, `validateCustomEvent`) | Moved to The Clockworks; framework event names and payloads are catalogued in the [Event Catalog](event-catalog.md). |
| Clockworks runner and daemon lifecycle (`clockTick`, `clockRun`, `clockStart`, `clockStop`, `clockStatus`) | Moved to `@shardworks/clockworks-apparatus` — see [The Clockworks](../architecture/clockworks.md) for the runner and daemon contract. |
| Tool installation, removal, and registry (`installTool`, `removeTool`, `listTools`, `classifySource`, preconditions) | Moved to The Instrumentarium — see the [Instrumentarium API Contract](../architecture/apparatus/instrumentarium.md) for the tool registry surface. |
| Books and schemas (`booksPath`, `ledgerPath`, schema declaration and migration) | Moved to The Stacks — see the [Stacks API Contract](../architecture/apparatus/stacks.md) for the books/schemas API and migration model. |
| SQL migrations (`discoverMigrations`, `applyMigrations`, the `_migrations` table) | Subsumed by The Stacks — schema evolution is now per-book and apparatus-owned; see the [Stacks API Contract](../architecture/apparatus/stacks.md). |
| Workshops, worktrees, and the bare-clone lifecycle (`addWorkshop`, `removeWorkshop`, `listWorkshops`, `showWorkshop`, `createWorkshop`, `setupWorktree`, `teardownWorktree`, `listWorktrees`, `workshopsPath`, `workshopBarePath`) | Replaced by codexes and draft bindings under The Scriptorium — see the [Scriptorium API Contract](../architecture/apparatus/scriptorium.md). |
| Bundles (`readBundleManifest`, `installBundle`, `isBundleDir`, `BundleManifest`, etc.) | Retired in v2 — installation is now plugin-shaped and driven by `npm install` against the guild's `package.json`. |
| Guild upgrade (`planUpgrade`, `applyUpgrade`, `UpgradePlan`, `UpgradeResult`) | Retired in v2 — upgrades are driven by the `nsg upgrade` CLI command against the framework version recorded in `guild.json`. |
| Guild init (`initGuild`) | Retired in v2 — guild bootstrapping is owned by the `nsg init` CLI command. |
| Rehydrate (`rehydrate`, `RehydrateResult`) | Retired in v2 — `npm install` and the plugin loader's startup checks now reconstruct runtime state from `guild.json` and `package.json`. |

URL anchors that used to point at carved-out sections will no longer resolve; that is intended. Anchor stability is reset at this migration.

---

## `Guild` — Process-Level Singleton

`guild()` is the universal entry point all plugin code reaches for at runtime — apparatus `start()` bodies, tool handlers, engine handlers, relay handlers. It returns the process-level `Guild` instance Arbor created at startup, exposing the guild root path, the apparatus registry, plugin configuration, and snapshots of the loaded plugin graph.

```typescript
import { guild } from '@shardworks/nexus-core';

const home   = guild().home;
const stacks = guild().apparatus<StacksApi>('stacks');
const config = guild().config<MyConfig>('my-plugin');
```

### `Guild` interface

The narrow contract every plugin sees. Calling `guild()` before Arbor has initialised the singleton (typically at module import time) throws with a clear "Guild not initialized" message — the accessor is meant for handler/start scopes, not module scope.

| Member | Returns | Purpose |
|---|---|---|
| `home` | `string` | Absolute path to the guild root (the directory containing `guild.json`). |
| `apparatus<T>(name)` | `T` | Retrieve a started apparatus's `provides` object by plugin id. Throws if absent — use for `requires` dependencies. |
| `tryApparatus<T>(name)` | `T \| null` | Optional counterpart to `apparatus<T>` — returns `null` when the apparatus is not installed. Use for `recommends` dependencies so the caller can branch on presence rather than catch a thrown error. |
| `config<T>(pluginId)` | `T` | Read a plugin's configuration section from `guild.json`. Returns `{}` when no section exists. The generic is a cast — the framework does not validate config shape. |
| `writeConfig<T>(pluginId, value)` | `void` | Write a plugin's configuration section to `guild.json` (updates in-memory + disk). For framework-level keys (`name`, `nexus`, `plugins`, `settings`), use the standalone `writeGuildConfig()` instead. |
| `guildConfig()` | `GuildConfig` | Read the full parsed `guild.json` — the escape hatch for framework-level fields that don't belong to any specific plugin. |
| `kits()` | `LoadedKit[]` | Snapshot of all loaded standalone kit plugins (does not include apparatus `supportKit`s). |
| `apparatuses()` | `LoadedApparatus[]` | Snapshot of all started apparatuses. |
| `failedPlugins()` | `FailedPlugin[]` | Snapshot of plugins that failed to load, validate, or start. |
| `startupWarnings()` | `string[]` | Advisory warnings collected during guild startup (missing `recommends`, unconsumed contributions). |

### `StartedGuild` — bootstrap-only extension

`StartedGuild` extends `Guild` with a `shutdown()` method and is what `createGuild()` returns to its bootstrap caller (the CLI, a daemon entry point, a one-shot helper). Plugin code never sees `StartedGuild` — `shutdown()` is deliberately not on the singleton-facing `Guild` interface because plugin code has no legitimate reason to tear down the guild it is running inside.

`shutdown()` fires `guild:shutdown`, calls `stop()` on every started apparatus in reverse topological order, aggregates per-apparatus errors into a single throw, and clears the `guild()` singleton as its last act. It is idempotent under repeated calls.

### Framework-internal exports

These are public exports because Arbor and the test harness need them, but plugin code should not call them. Listed for honesty about the surface — not an invitation.

| Function | Purpose |
|---|---|
| `setGuild(g)` | Register the guild instance — called by Arbor at startup. |
| `clearGuild()` | Clear the guild instance — called as the last act of `StartedGuild.shutdown()` and by tests resetting between cases. |

---

## Plugin System — `Kit`, `Apparatus`, `Plugin`

Core types for the Kit/Apparatus model. A plugin is one of two kinds:

- **Kit** — a passive package contributing capabilities (tools, engines, roles, etc.) to consuming apparatuses. No lifecycle, no running state. Read at load time.
- **Apparatus** — a package contributing persistent running infrastructure. Has a `start`/`stop` lifecycle and receives a `StartupContext` at start.

```typescript
import type { Kit, Apparatus, Plugin } from '@shardworks/nexus-core';

// Kit example
export default { kit: { tools: [myTool] } } satisfies Plugin;

// Apparatus example
export default {
  apparatus: {
    requires: ['stacks'],
    provides: myApi,
    start: async (ctx) => { /* ... */ },
  },
} satisfies Plugin;
```

The framework-level fields on a `Kit` are `requires` and `recommends`; every other key is an open contribution slot defined by consuming apparatuses. An `Apparatus` may declare `requires`, `recommends`, `provides`, `start`, optional `stop`, optional `supportKit`, and `consumes`. See [Plugins](../architecture/plugins.md) for the full Kit/Apparatus model and the `consumes` warning rules.

### Types

| Type | Purpose |
|---|---|
| `Kit` | Open record with optional `requires` / `recommends`. Contribution fields are defined by consuming apparatuses. |
| `Apparatus` | Record with `start(ctx)`, optional `stop()`, optional `provides`, `requires`, `recommends`, `supportKit`, `consumes`. |
| `Plugin` | Discriminated union: `{ kit: Kit }` or `{ apparatus: Apparatus }`. |
| `LoadedKit` | A kit as tracked by Arbor: `packageName`, `id`, `version`, `kit`. |
| `LoadedApparatus` | An apparatus as tracked by Arbor: `packageName`, `id`, `version`, `apparatus`. |
| `LoadedPlugin` | Union of `LoadedKit` and `LoadedApparatus`. |
| `FailedPlugin` | A plugin that failed to load, validate, or start: `{ id, reason }`. |
| `StartupContext` | Passed to `apparatus.start()`. Provides `on(event, handler)` for lifecycle subscriptions and `kits(type)` for querying kit contributions collected during the Wire phase. |
| `KitEntry` | A single kit contribution collected during Wire: `{ pluginId, packageName, type, value }`. |

### Type guards

| Function | Purpose |
|---|---|
| `isKit(obj)` | Narrows an unknown export to `{ kit: Kit }`. |
| `isApparatus(obj)` | Narrows an unknown export to `{ apparatus: Apparatus }` (also checks that `apparatus.start` is a function). |
| `isLoadedKit(p)` | Narrows a `LoadedPlugin` to `LoadedKit`. |
| `isLoadedApparatus(p)` | Narrows a `LoadedPlugin` to `LoadedApparatus`. |

---

## Guild Configuration

Read and write `guild.json`, the guild's central configuration file. The standalone helpers are the right surface for framework-level fields and for migration / tooling code that needs to inspect or mutate the file outside an apparatus context; plugin code reading or writing its own configuration section should prefer `guild().config<T>()` and `guild().writeConfig<T>()` instead.

```typescript
import { readGuildConfig, writeGuildConfig } from '@shardworks/nexus-core';

const config = readGuildConfig(home);
writeGuildConfig(home, config);
```

### `GuildConfig`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Guild name — used as the guildhall npm package name. |
| `nexus` | `string` | Installed Nexus framework version (recorded at init / upgrade). |
| `plugins` | `string[]` | Installed plugin ids (derived from npm package names). Always present; starts empty. |
| `settings?` | `GuildSettings` | Operational flags and preferences: `model` (default LLM), `autoMigrate` (defaults to `true`). |

`GuildConfig` is an **open interface**. Every other top-level key on `guild.json` is a plugin configuration section keyed by derived plugin id, contributed by the owning apparatus package via `declare module '@shardworks/nexus-core'`. For example, the Clockworks apparatus augments `GuildConfig` with a `clockworks?: { events?, standingOrders? }` section in its own `clockworks.d.ts`; that augmentation is visible at every call site that imports `GuildConfig`. The shape of each augmented section lives with its plugin, not here. See [Plugins](../architecture/plugins.md) for the augmentation pattern.

### Other exports

| Function / Type | Purpose |
|---|---|
| `createInitialGuildConfig(name, nexusVersion, model)` | Default config for `nsg init`. All collections start empty; `model` is stored under `settings`. |
| `guildConfigPath(home)` | Resolve the path to `guild.json` in the guild root. |
| `GuildSettings` | `{ model?, autoMigrate? }` — operational flags. |

---

## Path Resolution — `nexus-home`

Resolve standard paths within a guild's `.nexus/` directory.

```typescript
import { findGuildRoot, nexusDir } from '@shardworks/nexus-core';

const home = findGuildRoot();   // walks up from cwd to find guild.json
const dir  = nexusDir(home);    // .nexus/
```

| Function | Returns |
|---|---|
| `findGuildRoot(startDir?)` | The guild root path. Walks up from `startDir` (or `process.cwd()` when omitted) looking for `guild.json`; throws `Not inside a guild. …` if none is found before the filesystem root. |
| `nexusDir(home)` | `.nexus/` — the framework-managed runtime directory. |
| `worktreesPath(home)` | `.nexus/worktrees/` — the top-level worktrees root used by writ worktrees. |
| `clockPidPath(home)` | `.nexus/clock.pid` — the Clockworks daemon PID file. |
| `clockLogPath(home)` | `.nexus/clock.log` — the Clockworks daemon log file. |

`findGuildRoot` is the one helper that does **not** take `home` as its first argument: it produces `home`. Every other `nexus-home` helper is a path builder that takes the resolved guild root and appends to it. There is no general "home-first" convention to assume in `@shardworks/nexus-core`; standalone helpers each have their own signatures, and runtime callers reach the guild root through `guild().home`.

---

## ID Generation

Generate sortable, prefixed IDs.

```typescript
import { generateId, shortId } from '@shardworks/nexus-core';

const id   = generateId('w');             // 'w-lzx3a91q-3f7b2c1de4a8'
const slug = shortId(id);                 // 'w-lzx3a91q'
```

| Function | Purpose |
|---|---|
| `generateId(prefix, randomByteCount?)` | Returns `{prefix}-{base36_timestamp}-{hex_random}`. The timestamp component (`Date.now()` in base36) gives lexicographic sort order by creation time; the random suffix prevents collisions without coordination. `randomByteCount` defaults to `6` (12 hex chars). |
| `shortId(id)` | Returns the `{prefix}-{base36_timestamp}` slice — the human-readable form that drops the random suffix. Apparatus `resolveId()` implementations (e.g. `ClerkApi`, `RatchetApi`) accept this form as a unique-prefix lookup, making it the natural shape for CLI output, tree renderings, and pulse-context payloads. |

Prefixes are **caller-owned**, not nexus-core-owned. The framework does not maintain a registry of prefix → entity mappings; each apparatus declares its own prefixes in its API contract. Refer to the relevant apparatus contracts (e.g. [Clerk](../architecture/apparatus/clerk.md), [Animator](../architecture/apparatus/animator.md), [Parlour](../architecture/apparatus/parlour.md)) for the prefixes a particular caller is expected to use.

---

## PID & Process Helpers

Shared primitives for daemon-style commands. Two daemons live in the framework today (the guild daemon `nsg start` and the Clockworks daemon `nsg clock start`), and both share the same lifecycle: read a pidfile, decide whether the named pid is alive, unlink the pidfile when the daemon is gone, poll for exit after SIGTERM. These helpers live in `@shardworks/nexus-core` so the CLI and the Clockworks apparatus can consume them without depending on one another.

These exports are public substrate for daemon implementations. Plugin code that only wants to ask "is the Clockworks daemon running?" should prefer the Clockworks apparatus's `status` API — see the [Clockworks contract](../architecture/clockworks.md).

| Function | Purpose |
|---|---|
| `isProcessAlive(pid)` | Returns `true` when a process with the given pid is alive on this host. Uses signal `0` (the existence probe); treats `EPERM` (process exists but we lack permission to signal it) as alive. |
| `readPidFile(pidFile)` | Read a pidfile and parse it into a positive integer pid. Returns `null` when the file is missing, unreadable, empty, or doesn't parse. |
| `tryUnlink(file)` | Delete a file, swallowing any error. Used for pidfile cleanup where a stale or already-deleted file should not be a fatal condition. |
| `waitForExit(pid, timeoutMs)` | Poll `isProcessAlive(pid)` every 200ms until the pid exits or the timeout elapses. Returns `true` if the process exited within the window, `false` otherwise. |

---

## Package Resolution

Utilities for resolving guild-installed npm packages and deriving plugin ids. These exist because guild plugins are ESM-only packages and `createRequire()` cannot resolve their `exports` maps directly.

```typescript
import { derivePluginId, resolveGuildPackageEntry } from '@shardworks/nexus-core';

derivePluginId('@shardworks/books-apparatus');  // → 'books'
derivePluginId('@acme/my-plugin');              // → 'acme/my-plugin'
derivePluginId('my-relay-kit');                 // → 'my-relay'
```

| Function | Purpose |
|---|---|
| `derivePluginId(packageName)` | Canonical npm package name → plugin id. Strips the `@shardworks/` scope (the official Nexus namespace), retains other scopes as `scope/name` prefixes (without `@`) to prevent third-party collisions, and strips descriptor suffixes (`-plugin`, `-apparatus`, `-kit`). |
| `readGuildPackageJson(guildRoot, pkgName)` | Read a package's `package.json` from the guild's `node_modules`. Returns `{ version, pkgJson }`; falls back gracefully when the file is missing. |
| `resolvePackageNameForPluginId(guildRoot, pluginId)` | Reverse lookup: scan the guild's root `package.json` dependencies and return the npm package name whose derived id matches `pluginId`. Prefers `@shardworks`-scoped packages on collisions. Returns `null` when nothing matches. |
| `resolveGuildPackageEntry(guildRoot, pkgName)` | Resolve the ESM entry point for a guild-installed package by reading the package's `exports` map (with sensible fallbacks to `main` and finally `index.js`). Returns an absolute path suitable for dynamic `import()`. |

---

## `VERSION`

```typescript
import { VERSION } from '@shardworks/nexus-core';
```

The `@shardworks/nexus-core` package version, read from `package.json` at runtime. The framework version recorded in `guild.json` (`config.nexus`) is set from this value at `nsg init` and `nsg upgrade`.

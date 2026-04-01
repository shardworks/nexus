# `@shardworks/nexus-core`

The public SDK surface for Nexus Mk 2.1. Every plugin — kit or apparatus — depends on this package for the guild singleton, plugin lifecycle types, guild configuration, and package resolution utilities.

This package has zero runtime dependencies. The dependency graph runs one way: plugins → core.

---

## `Guild` — Process-Level Singleton

The central access point for guild infrastructure at runtime. All plugin code (apparatus `start()`, tool handlers, engine handlers) imports `guild()` to access apparatus APIs, plugin config, and the guild root path.

```typescript
import { guild } from '@shardworks/nexus-core';

const home = guild().home;
const stacks = guild().apparatus<StacksApi>('stacks');
const config = guild().config<MyConfig>('my-plugin');
```

| Member | Returns | Description |
|---|---|---|
| `home` | `string` | Absolute path to the guild root |
| `apparatus<T>(name)` | `T` | Retrieve a started apparatus's `provides` object by plugin id |
| `config<T>(pluginId)` | `T` | Read a plugin's configuration section from guild.json |
| `guildConfig()` | `GuildConfig` | Read the full parsed guild.json |
| `kits()` | `LoadedKit[]` | Snapshot of all loaded kits (including apparatus supportKits) |
| `apparatuses()` | `LoadedApparatus[]` | Snapshot of all started apparatuses |

Framework functions (not for plugin use):

| Function | Description |
|---|---|
| `setGuild(g)` | Register the guild instance — called by Arbor at startup |
| `clearGuild()` | Clear the guild instance — called by Arbor at shutdown or in tests |

---

## Plugin System — `Kit`, `Apparatus`, `Plugin`

Core types for the Kit/Apparatus model. Plugins come in two kinds:

- **Kit** — passive package contributing capabilities. No lifecycle, no running state. Read at load time.
- **Apparatus** — package contributing persistent infrastructure. Has a `start`/`stop` lifecycle.

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

### Types

| Type | Description |
|---|---|
| `Kit` | Open record with optional `requires` and `recommends` arrays. Contribution fields are defined by consuming apparatuses. |
| `Apparatus` | Record with `start(ctx)`, optional `stop()`, optional `provides`, `requires`, `supportKit`, `consumes`. |
| `Plugin` | Discriminated union: `{ kit: Kit }` or `{ apparatus: Apparatus }` |
| `LoadedKit` | A kit as tracked by Arbor: `packageName`, `id`, `version`, `kit` |
| `LoadedApparatus` | An apparatus as tracked by Arbor: `packageName`, `id`, `version`, `apparatus` |
| `LoadedPlugin` | Union of `LoadedKit` and `LoadedApparatus` |
| `StartupContext` | Passed to `apparatus.start()`. Provides `on(event, handler)` for lifecycle subscriptions. |

### Type Guards

| Function | Description |
|---|---|
| `isKit(obj)` | Narrows to `{ kit: Kit }` |
| `isApparatus(obj)` | Narrows to `{ apparatus: Apparatus }` |
| `isLoadedKit(p)` | Narrows `LoadedPlugin` to `LoadedKit` |
| `isLoadedApparatus(p)` | Narrows `LoadedPlugin` to `LoadedApparatus` |

---

## `BookOptions` — Book Schema Declaration

Transitional type exported from core for kit packages declaring book schemas. Will move to a dedicated Books apparatus when that ships.

```typescript
interface BookOptions {
  indexes?: string[];  // field names to index (plain or dot-notation)
}
```

---

## Guild Configuration

Read and write `guild.json`, the guild's central configuration file.

```typescript
import { readGuildConfig, writeGuildConfig } from '@shardworks/nexus-core';

const config = readGuildConfig(home);
writeGuildConfig(home, config);
```

### `GuildConfig`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Guild name |
| `nexus` | `string` | Framework version at last init/upgrade |
| `plugins` | `string[]` | Installed plugin ids |
| `clockworks?` | `ClockworksConfig` | Events and standing orders |
| `writTypes?` | `Record<string, WritTypeDeclaration>` | Guild-declared writ types |
| `settings?` | `GuildSettings` | Operational flags including default `model` |

All other top-level keys are plugin configuration sections, keyed by derived plugin id.

### Other Exports

| Function / Type | Description |
|---|---|
| `createInitialGuildConfig(name, version, model)` | Default config for `nsg init` |
| `guildConfigPath(home)` | Resolve path to `guild.json` |
| `EventDeclaration` | Custom event: `description`, optional `schema` |
| `StandingOrder` | Event → action mapping (run / summon / brief) |
| `ClockworksConfig` | Container for events and standing orders |
| `WritTypeDeclaration` | Writ type: `description` |
| `GuildSettings` | Settings: `model`, `autoMigrate` |

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
| `findGuildRoot(startDir?)` | Guild root (walks up from cwd, throws if not found) |
| `nexusDir(home)` | `.nexus/` |
| `worktreesPath(home)` | `.nexus/worktrees/` |
| `clockPidPath(home)` | `.nexus/clock.pid` |
| `clockLogPath(home)` | `.nexus/clock.log` |

---

## Package Resolution

Utilities for resolving guild-installed npm packages and deriving plugin ids.

```typescript
import { derivePluginId, resolveGuildPackageEntry } from '@shardworks/nexus-core';

derivePluginId('@shardworks/books-apparatus');  // → 'books'
derivePluginId('@acme/my-plugin');              // → 'acme/my-plugin'
derivePluginId('my-relay-kit');                 // → 'my-relay'
```

| Function | Description |
|---|---|
| `derivePluginId(packageName)` | Canonical npm package name → plugin id. Strips `@shardworks/` scope and `-plugin`/`-apparatus`/`-kit` suffixes. |
| `readGuildPackageJson(guildRoot, pkgName)` | Read a package's `package.json` from the guild's `node_modules` |
| `resolvePackageNameForPluginId(guildRoot, pluginId)` | Reverse lookup: find the npm package name for a plugin id |
| `resolveGuildPackageEntry(guildRoot, pkgName)` | Resolve the ESM entry point for a guild-installed package |

---

## `VERSION`

The package version, read from `package.json` at runtime.

```typescript
import { VERSION } from '@shardworks/nexus-core';
```

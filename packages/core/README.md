# `@shardworks/nexus-core`

The public SDK for Nexus Mk 2.1. Rig authors import from this package to define tools, read guild configuration, and resolve file paths.

This package is a dependency of every rig. It does not depend on mainspring or the CLI — the dependency graph runs one way: rigs → core.

## What's here

Only the modules promoted out of `legacy/` are documented here. Additional exports exist for internal framework use and will be documented as they are promoted.

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
  handler: async ({ name }, { home }) => {
    return `Hello, ${name}! Guild root: ${home}`;
  },
});
```

A rig package exports a single tool or an array of tools as its default export. Mainspring discovers them automatically at install time.

### `ToolContext`

Injected into every handler call by the framework:

```typescript
interface ToolContext {
  home: string;  // absolute path to the guild root
}
```

### `ToolDefinition`

The return type of `tool()`. MCP, CLI, and engines all consume this shape.

### `ToolChannel`

`'cli' | 'mcp'` — controls which surfaces a tool appears on. Set via `allowedContexts`:

```typescript
tool({
  name: 'plugin-install',
  allowedContexts: ['cli'],   // CLI only — not exposed to animas via MCP
  ...
});
```

Defaults to both channels if omitted.

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

## `guild-config` — Guild Configuration

Read and write `guild.json`, the guild's central configuration file.

```typescript
import { readGuildConfig, writeGuildConfig } from '@shardworks/nexus-core';

const config = readGuildConfig(home);
config.baseTools.push('my-tool');
writeGuildConfig(home, config);
```

### `GuildConfig`

The shape of `guild.json`:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Guild name |
| `nexus` | `string` | Framework version at last init/upgrade |
| `model` | `string` | Default model for anima sessions |
| `plugins` | `string[]` | Installed rig keys |
| `roles` | `Record<string, RoleDefinition>` | Guild roles |
| `baseTools` | `string[]` | Tools available to all animas |
| `tools` | `Record<string, ToolEntry>` | Registered tools with provenance |
| `engines` | `Record<string, ToolEntry>` | Registered engines |
| `workshops` | `Record<string, WorkshopEntry>` | Registered workshops |
| `curricula` | `Record<string, TrainingEntry>` | Installed curricula |
| `temperaments` | `Record<string, TrainingEntry>` | Installed temperaments |
| `clockworks?` | `ClockworksConfig` | Standing orders and custom events |

### Other exports

```typescript
guildConfigPath(home)           // path to guild.json
createInitialGuildConfig(...)   // default config for nsg init
```

---

## `nexus-home` — Path Resolution

Resolve standard paths within a guild's `.nexus/` directory.

```typescript
import { findGuildRoot, booksPath, nexusDir } from '@shardworks/nexus-core';

const home = findGuildRoot();          // walks up from cwd to find guild.json
const db   = booksPath(home);          // .nexus/nexus.db
const dir  = nexusDir(home);           // .nexus/
```

### All path helpers

| Function | Returns |
|---|---|
| `findGuildRoot(startDir?)` | Guild root (walks up from cwd, throws if not found) |
| `nexusDir(home)` | `.nexus/` |
| `booksPath(home)` | `.nexus/nexus.db` |
| `worktreesPath(home)` | `.nexus/worktrees/` |
| `workshopsPath(home)` | `.nexus/workshops/` |
| `workshopBarePath(home, name)` | `.nexus/workshops/<name>.git` |
| `clockPidPath(home)` | `.nexus/clock.pid` |
| `clockLogPath(home)` | `.nexus/clock.log` |

---

## `plugin-descriptor` — Rig Descriptor Types

Types for `rig.json`, the optional descriptor a rig package can include at its root to declare dependencies and migrations.

```typescript
import type { PluginDescriptor } from '@shardworks/nexus-core';
```

### `PluginDescriptor`

```typescript
interface PluginDescriptor {
  description?: string;
  dependencies?: PluginDependency[];
  migrations?: string;   // path to migrations dir, relative to package root
}

interface PluginDependency {
  plugin: string;   // rig key, e.g. 'nexus-stdlib'
}
```

Mainspring reads `rig.json` at install time. If declared dependencies aren't installed, `nsg rig install` fails with a clear error. The `migrations` field is reserved for a future commission.

A rig with no dependencies needs no `rig.json` at all.

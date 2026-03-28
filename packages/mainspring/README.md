# `@shardworks/nexus-mainspring`

The guild runtime host for Nexus Mk 2.1. The mainspring loads installed rigs, assembles the tool surface, and injects guild context into the CLI and MCP server.

## Package roles

```
@shardworks/nexus-core        — public SDK, types, tool() factory
@shardworks/nexus-mainspring  — guild host, createMainspring(), Mainspring object
@shardworks/nexus (cli)       — nsg binary, maps Tool[] → Commander commands
rigs                          — import from nexus-core only
```

Rig authors import from `@shardworks/nexus-core`. The mainspring is an internal concern of the CLI and session provider — not something rigs depend on directly.

## Runtime API

```typescript
import { createMainspring } from '@shardworks/nexus-mainspring';

const ms = createMainspring('/path/to/guild');
```

### `Mainspring`

| Method | Returns | Description |
|---|---|---|
| `ms.home` | `string` | Absolute path to the guild root |
| `ms.getGuildConfig()` | `GuildConfig` | Parsed `guild.json`, read at construction time |
| `ms.getRigConfig(name)` | `Record<string, unknown>` | Rig-specific config section from `guild.json`. Accepts key (`'nexus-stdlib'`) or full package name |
| `ms.listRigs()` | `Promise<Rig[]>` | All installed rigs, including mainspring's own built-ins. Lazy-loaded and cached |
| `ms.findRig(name)` | `Promise<Rig \| null>` | Find a rig by key or full package name |
| `ms.listTools(options?)` | `Promise<Tool[]>` | All tools, optionally filtered by `channel` and/or `roles` |
| `ms.findTool(name)` | `Promise<Tool \| null>` | Find a tool by name, across all rigs |

### `Rig`

Represents an installed rig (npm package) as seen by the mainspring:

```typescript
interface Rig {
  packageName: string;  // full npm name, e.g. '@shardworks/nexus-stdlib'
  key: string;          // guild-facing key, e.g. 'nexus-stdlib'
  version: string;
  tools: Tool[];
}
```

### `Tool`

A `ToolDefinition` (from `nexus-core`) with provenance:

```typescript
interface Tool extends ToolDefinition {
  rigName: string;  // npm package name of the rig that owns this tool
}
```

### `ListToolsOptions`

```typescript
interface ListToolsOptions {
  channel?: 'cli' | 'mcp';   // filter to tools available in this channel
  roles?: string[];           // filter to tools accessible to these roles
}
```

### `deriveRigKey(packageName)`

Converts an npm package name to the guild-facing rig key used in `guild.json`, CLI commands, and config sections:

```
@shardworks/nexus-stdlib  →  nexus-stdlib   (official scope stripped)
@acme/my-rig              →  acme/my-rig    (third-party: @ dropped)
my-rig                    →  my-rig         (unscoped: unchanged)
```

### `findGuildRoot()`

Re-exported from `nexus-core` for convenience — walks up from `cwd` to find the nearest guild root (directory containing `guild.json`).

## Built-in CLI commands

These ship with mainspring itself and are always available via `nsg`, regardless of what rigs are installed.

| Command | Description |
|---|---|
| `nsg init <path>` | Create a new guild: directory structure, `guild.json`, `package.json`, `.gitignore` |
| `nsg version` | Show Nexus framework version and installed rig versions |
| `nsg status` | Show guild identity, installed rigs, and configured roles |
| `nsg upgrade` | Upgrade framework and run pending rig migrations *(stub)* |
| `nsg rig list` | List installed rigs and tool counts |
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

Rigs that expose a typed API to other rigs export a `fromMainspring` factory:

```typescript
// In a rig package
import type { Mainspring } from '@shardworks/nexus-mainspring';

export function fromMainspring(ms: Mainspring) {
  const config = ms.getRigConfig('my-rig');
  return {
    doSomething() { ... }
  };
}
```

Callers import the rig package and call `fromMainspring(ms)` to get a typed, initialized reference.

## Rig descriptor (`rig.json`)

A rig package may include a `rig.json` at its root to declare dependencies on other rigs. Checked at install time — missing dependencies cause `nsg rig install` to fail with a clear error.

```json
{
  "description": "My rig",
  "dependencies": [
    { "plugin": "nexus-stdlib" }
  ]
}
```

All fields are optional. A rig with no dependencies or migrations needs no `rig.json`.

## Lazy loading

Rig modules are imported dynamically from the guild's `node_modules` on the first call to `listRigs()` or `listTools()`, then cached for the lifetime of the `Mainspring` instance. This keeps startup fast — the mainspring reads `guild.json` synchronously at construction and defers all module I/O until tools are actually needed.

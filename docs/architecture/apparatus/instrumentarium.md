# The Instrumentarium — API Contract

Status: **Draft — MVP**

Package: `@shardworks/tools-apparatus` · Plugin id: `tools`

---

## Purpose

The Instrumentarium is the guild's tool registry. It owns the tool definition contract (`tool()` factory and `ToolDefinition` type), scans installed tools from kit contributions and apparatus supportKits at startup, resolves permission-gated tool sets on demand, and serves as the single source of truth for "what tools exist and who can use them."

The Instrumentarium is **role-agnostic** — it receives an already-resolved permissions array from the Loom and returns the matching tool set. Role definitions and permission grants are owned by the Loom.

Both the session layer (The Animator, via MCP) and the CLI depend on The Instrumentarium. It has no dependency on anima identity, sessions, or composition.

---

## Dependencies

```
requires: []
consumes: ['tools']      — scans kit and supportKit contributions for tool definitions
```

---

## Tool Definition Contract

The `@shardworks/tools-apparatus` package is the canonical home for the `tool()` factory and `ToolDefinition` type. Kit authors import from this package to define tools:

```typescript
import { tool } from '@shardworks/tools-apparatus'
import { guild } from '@shardworks/nexus-core'
import { z } from 'zod'

export default tool({
  name: 'commission-show',
  description: 'Show details of a commission',
  permission: 'read',
  params: {
    id: z.string().describe('Commission id'),
  },
  handler: async ({ id }) => {
    const stacks = guild().apparatus<StacksApi>('stacks')
    const writs = stacks.readBook<Writ>('clerk', 'writs')
    return await writs.get(id)
  },
})
```

### `tool()` factory

```typescript
function tool<T extends z.ZodRawShape>(config: ToolConfig<T>): ToolDefinition

interface ToolConfig<T extends z.ZodRawShape> {
  /** Tool name — the identifier used in resolution and CLI invocation. */
  name: string
  /** Brief description — exposed via MCP metadata and CLI help. */
  description: string
  /** Zod schema for input parameters. Validated before the handler runs. */
  params: T
  /** The handler function. Receives validated params. */
  handler: (params: z.infer<z.ZodObject<T>>) => Promise<unknown>
  /**
   * Optional permission level (e.g. 'read', 'write', 'admin').
   * Used by the Instrumentarium to resolve permission-gated tool sets.
   * Tools without a permission are "permissionless" — see Permission Model below.
   */
  permission?: string
  /**
   * Optional channel restriction. If set, the tool is only available
   * through the listed channels. If omitted, available everywhere.
   */
  callableFrom?: ToolCaller[]
}

type ToolCaller = 'mcp' | 'cli' | 'import'
```

### `ToolDefinition`

The compiled tool object stored in the registry:

```typescript
interface ToolDefinition {
  /** Tool name. */
  name: string
  /** Brief description. */
  description: string
  /** Zod object schema for input validation and MCP schema generation. */
  params: z.ZodObject<any>
  /** The handler function. */
  handler: (params: unknown) => Promise<unknown>
  /** Permission level for access control, if any. */
  permission?: string
  /** Channel restriction, if any. */
  callableFrom?: ToolCaller[]
}
```

### Guild Accessor

Tool handlers access guild infrastructure through the `guild()` singleton from `@shardworks/nexus-core`. See [The Guild Accessor](../plugins.md#the-guild-accessor) for detail.

```typescript
import { guild } from '@shardworks/nexus-core'

handler: async (params) => {
  const { home } = guild()
  const stacks = guild().apparatus<StacksApi>('stacks')
}
```

---

## Kit Contribution

Kits contribute tools via a `tools` field:

```typescript
export default {
  kit: {
    requires: ['tools'],
    tools: [commissionCreateTool, signalTool, writShowTool],
  },
} satisfies Plugin
```

Each entry is a `ToolDefinition` produced by the `tool()` factory. The Instrumentarium scans these contributions reactively via `plugin:initialized` at startup.

---

## `InstrumentariumApi` Interface (`provides`)

```typescript
interface InstrumentariumApi {
  /**
   * Resolve the tool set for a given set of permissions.
   *
   * Evaluates each registered tool against the permission grants:
   * - Tools with a `permission` field: included if any grant matches
   * - Permissionless tools: always included (default) or gated by `strict`
   * - Channel filtering applied last
   */
  resolve(options: ResolveOptions): ResolvedTool[]

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null

  /**
   * List all installed tools, regardless of permissions.
   */
  list(): ResolvedTool[]
}

interface ResolveOptions {
  /**
   * Permission grants in `plugin:level` format.
   * Supports wildcards: `plugin:*`, `*:level`, `*:*`.
   */
  permissions: string[]
  /**
   * When true, permissionless tools are excluded unless the role grants
   * `plugin:*` or `*:*` for the tool's plugin. When false (default),
   * permissionless tools are included unconditionally.
   */
  strict?: boolean
  /** Filter by invocation channel. Tools with no callableFrom pass all channels. */
  channel?: ToolCaller
}

interface ResolvedTool {
  /** The tool definition (name, description, params schema, handler). */
  definition: ToolDefinition
  /** Plugin id of the kit or apparatus that contributed this tool. */
  pluginId: string
}
```

---

## Permission Model

### Grant format

Callers provide permission grants as `plugin:level` strings:

| Grant | Matches |
|---|---|
| `stdlib:read` | Tools from `stdlib` with `permission: 'read'` |
| `stdlib:*` | All tools from `stdlib` (any permission level, plus permissionless in strict mode) |
| `*:read` | Tools from any plugin with `permission: 'read'` |
| `*:*` | All tools from all plugins (superuser) |

### Resolution logic

1. Parse each grant into `(plugin, level)` pairs
2. For each registered tool:
   - **Permissioned tool** (has `permission` field) — include if any grant matches (exact, plugin wildcard, level wildcard, or superuser)
   - **Permissionless tool** (no `permission` field):
     - Default mode (`strict: false`) → always included
     - Strict mode (`strict: true`) → included only if grants contain `plugin:*` or `*:*` for the tool's plugin
3. Filter by `channel` if specified (tools with no `callableFrom` pass all channels)

### No hierarchy

Permission levels are opaque strings with no implied hierarchy. `write` does **not** imply `read`. Each level must be granted explicitly, or use wildcards.

### Role ownership

The Instrumentarium does not know about roles. Role definitions (mapping role names to permission grants) live in `guild.json` under the Loom's configuration. The Loom resolves an anima's roles into a flat permissions array, then passes that array to `instrumentarium.resolve()`.

---

## Instructions

A tool can optionally ship with an `instructions.md` — a teaching document that provides craft guidance beyond what the MCP schema conveys (when to use the tool, when not to, workflow context, institutional conventions). Instructions are delivered to animas as part of the session context, assembled by The Loom.

The Instrumentarium does not read or serve instructions directly — it stores the path reference. The Loom reads instruction files at composition time (future, not MVP).

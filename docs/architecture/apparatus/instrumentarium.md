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
   * Optional caller restriction. If set, the tool is only available
   * to the listed callers. If omitted, available to everyone.
   */
  callableBy?: ToolCaller[]
}

type ToolCaller = 'cli' | 'anima' | 'library'
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
  /** Caller restriction, if any. */
  callableBy?: ToolCaller[]
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
   * - Caller filtering applied last
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
  /** Filter by caller type. Tools with no callableBy restriction pass all callers. */
  caller?: ToolCaller
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
3. Filter by `caller` if specified (tools with no `callableBy` pass all callers)

### No hierarchy

Permission levels are opaque strings with no implied hierarchy. `write` does **not** imply `read`. Each level must be granted explicitly, or use wildcards.

### Role ownership

The Instrumentarium does not know about roles. Role definitions (mapping role names to permission grants) live in `guild.json` under the Loom's configuration. The Loom resolves an anima's roles into a flat permissions array, then passes that array to `instrumentarium.resolve()`.

---

## Contributed Tools

The Instrumentarium contributes its own tools for registry introspection. These are **admin/operator tools** — they show what's installed in the guild, not what a specific anima can use. Animas discover their own available tools through the MCP protocol's native tool listing, which reflects the already-resolved set the Loom composed for their session.

### `tools-list`

List all tools installed in the guild, optionally filtered. This is an administrative view of the full registry.

```typescript
tool({
  name: 'tools-list',
  description: 'List all tools installed in the guild. Administrative view — shows the full registry, not a permission-resolved set.',
  permission: 'read',
  params: {
    caller: z.enum(['cli', 'anima', 'library']).optional()
      .describe('Filter to tools callable by this caller type.'),
    permission: z.string().optional()
      .describe('Filter to tools requiring this permission level (e.g. "read", "write").'),
    plugin: z.string().optional()
      .describe('Filter to tools contributed by this plugin id.'),
  },
  handler: async ({ caller, permission, plugin }) => { /* ... */ },
})
```

**Returns** an array of tool summaries:

```typescript
interface ToolSummary {
  name: string
  description: string
  pluginId: string
  permission: string | null
  callableBy: ToolCaller[] | null   // null means unrestricted
}
```

Filters are combined with AND logic. An empty/no-filter call returns all installed tools.

### `tools-show`

Show full details for a single tool, including its parameter schema and instructions.

```typescript
tool({
  name: 'tools-show',
  description: 'Show details for a tool by name, including parameter schema and instructions.',
  permission: 'read',
  params: {
    name: z.string().describe('Tool name to look up.'),
  },
  handler: async ({ name }) => { /* ... */ },
})
```

**Returns** the full tool detail, or null if not found:

```typescript
interface ToolDetail {
  name: string
  description: string
  pluginId: string
  permission: string | null
  callableBy: ToolCaller[] | null
  params: Record<string, ParamInfo>   // derived from Zod schema: type, description, optional
  instructions: string | null
}

interface ParamInfo {
  type: string            // JSON Schema type (string, number, boolean, array, object)
  description: string | null
  optional: boolean
}
```

### Design notes

- Both tools require **`tools:read` permission**. They're not in an anima's tool set by default — a role needs an explicit `tools:read` grant to see them. This keeps them out of the way for builder/scribe roles while letting admin-oriented roles (e.g. a steward) inspect the registry.
- CLI callers get these tools through the CLI's default permission set (which includes `*:*` or equivalent).
- `tools-list` does **not** include parameter schemas or instructions to keep the response compact. Use `tools-show` to drill in.
- `tools-list` shows the **full registry** — all installed tools regardless of the caller's own permissions. The `caller` filter narrows by `callableBy` restriction, not by permission grants. This is an admin inventory, not a permission simulation.
- Animas discover their *own* available tools through the MCP protocol's native tool listing at connection time, which reflects the permission-resolved set the Loom composed for their session. These admin tools answer a different question: "what's installed in the guild?"

---

## Instructions

A tool can optionally ship with instructions — a teaching document that provides craft guidance beyond what the MCP schema conveys (when to use the tool, when not to, workflow context, institutional conventions). Instructions are delivered to animas as part of the session context, assembled by The Loom.

Tools provide instructions in one of two ways:

- **`instructions`** — inline text on the `ToolConfig`
- **`instructionsFile`** — a path relative to the tool's npm package root (e.g. `'./instructions.md'`)

### Pre-loading at registration time

The Instrumentarium resolves `instructionsFile` at registration time, not at session time. When a tool with `instructionsFile` is registered, the Instrumentarium:

1. Resolves the file path: `{guildRoot}/node_modules/{packageName}/{instructionsFile}`
2. Reads the file contents
3. Sets `instructions` to the loaded text on its stored copy of the `ToolDefinition`
4. Clears `instructionsFile` — it has been consumed

After startup, `ResolvedTool.definition.instructions` is always a string or undefined — never a file path. Consumers (the Loom, MCP server) never do file I/O for instructions. Missing files produce a startup warning but do not prevent tool registration.

This means the `ToolDefinition` stored in the registry is a **mutated copy** of the original — `instructionsFile` is an authoring-time convenience that gets resolved into `instructions` text at load time. The single source of truth for instruction content is `definition.instructions`.

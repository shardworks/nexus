# The Instrumentarium — API Contract

Status: **Draft — MVP**

Package: `@shardworks/tools-apparatus` · Plugin id: `tools`

---

## Purpose

The Instrumentarium is the guild's tool registry. It owns the tool definition contract (`tool()` factory and `ToolDefinition` type), scans installed tools from kit contributions and apparatus supportKits at startup, resolves role-gated tool sets on demand, and serves as the single source of truth for "what tools exist and who can use them."

Both the session layer (The Animator, via MCP) and the CLI depend on The Instrumentarium. It has no dependency on anima identity, sessions, or composition.

---

## Dependencies

```
requires: []
consumes: ['tools']      — scans kit and supportKit contributions for tool definitions
```

---

## Tool Definition Contract

The `@shardworks/tools-apparatus` package exports the `tool()` factory and `ToolDefinition` type. Kit authors import from this package to define tools:

```typescript
import { tool } from '@shardworks/tools-apparatus'
import { z } from 'zod'

export default tool({
  name: 'commission-show',
  description: 'Show details of a commission',
  params: {
    id: z.string().describe('Commission id'),
  },
  handler: async ({ id }, ctx) => {
    const stacks = ctx.apparatus<StacksApi>('stacks')
    const writs = stacks.readBook<Writ>('clerk', 'writs')
    return await writs.get(id)
  },
})
```

### `tool()` factory

```typescript
function tool<T extends z.ZodRawShape>(config: ToolConfig<T>): ToolDefinition

interface ToolConfig<T extends z.ZodRawShape> {
  /** Tool name — the identifier used in role assignments and CLI invocation. */
  name: string
  /** Brief description — exposed via MCP metadata and CLI help. */
  description: string
  /** Zod schema for input parameters. Validated before the handler runs. */
  params: T
  /** The handler function. Receives validated params. */
  handler: (params: z.infer<z.ZodObject<T>>) => Promise<unknown>
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
   * Resolve the tool set for a given set of roles.
   *
   * Returns tools from baseTools + the union of each role's tool list,
   * filtered by the provided channel (mcp, cli, or import).
   */
  resolve(options: ResolveOptions): ResolvedTool[]

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null

  /**
   * List all installed tools, regardless of role assignment.
   */
  list(): ResolvedTool[]
}

interface ResolveOptions {
  /** Roles to resolve tools for. Tools are the union across all roles + baseTools. */
  roles: string[]
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

## Configuration

Roles and base tools are plugin configuration owned by The Instrumentarium, stored in `guild.json` under its plugin id:

```json
{
  "tools": {
    "baseTools": ["nexus-version"],
    "roles": {
      "artificer": ["commission-show", "signal", "complete-session"]
    }
  }
}
```

The Instrumentarium reads this via `ctx.config<InstrumentariumConfig>()`.

## Role-Gating Resolution

Resolution logic:

1. Collect tool names from `baseTools`
2. For each role in the request, collect tool names from `roles[role].tools`
3. Union all collected names
4. Match against installed tool definitions
5. Filter by `channel` if specified (tools with no `callableFrom` restriction pass all channels)

The resolved set includes the `ToolDefinition` (with handler) and provenance (`pluginId`) for each tool.

---

## Instructions

A tool can optionally ship with an `instructions.md` — a teaching document that provides craft guidance beyond what the MCP schema conveys (when to use the tool, when not to, workflow context, institutional conventions). Instructions are delivered to animas as part of the session context, assembled by The Loom.

The Instrumentarium does not read or serve instructions directly — it stores the path reference. The Loom reads instruction files at composition time (future, not MVP).

---

## Implementation Notes

- **`tool()` location during transition.** `tool()` currently lives in `@shardworks/nexus-core`. This should be moved to the Instrumentarium package, and removed from nexus-core.

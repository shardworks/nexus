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
requires: ['stacks']     — may persist tool metadata in future
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
  /** The handler function. Receives validated params and a HandlerContext. */
  handler: (params: z.infer<z.ZodObject<T>>, ctx: HandlerContext) => Promise<unknown>
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
  handler: (params: unknown, ctx: HandlerContext) => Promise<unknown>
  /** Channel restriction, if any. */
  callableFrom?: ToolCaller[]
}
```

### `HandlerContext`

The context injected into tool handlers at invocation time. Defined in `@shardworks/nexus-core` (re-exported by this package for convenience):

```typescript
interface HandlerContext {
  home:       string
  config<T>(pluginId?: string): T
  guildConfig(): GuildConfigV2
  apparatus<T>(name: string): T
}
```

The caller (MCP engine, CLI, or programmatic invocation) is responsible for creating the `HandlerContext` with appropriate scoping. The Instrumentarium does not create contexts — it resolves tools.

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
    "roles": {
      "artificer": {
        "seats": null,
        "tools": ["commission-show", "signal", "complete-session"],
        "instructions": "roles/artificer.md"
      }
    },
    "baseTools": ["nexus-version"]
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

## Relationship to Arbor

The Instrumentarium replaces Arbor's current `listTools()`, `findTool()`, and `createHandlerContext()` methods. Once The Instrumentarium ships, those methods are removed from the `Arbor` interface. Arbor returns to being purely a plugin loader and lifecycle manager.

---

## Instructions

A tool can optionally ship with an `instructions.md` — a teaching document that provides craft guidance beyond what the MCP schema conveys (when to use the tool, when not to, workflow context, institutional conventions). Instructions are delivered to animas as part of the session context, assembled by The Loom.

The Instrumentarium does not read or serve instructions directly — it stores the path reference. The Loom reads instruction files at composition time (future, not MVP).

---

## Open Questions

- **Tool metadata persistence.** Should The Instrumentarium store tool metadata (install timestamps, provenance) in The Stacks, or is `guild.json` sufficient? Current implementation uses `guild.json` only.
- **Hot reload.** Can tools be installed/removed while the guild is running, or only at startup? Current answer: startup only.
- **`tool()` location during transition.** `tool()` currently lives in `@shardworks/nexus-core`. Migration path: re-export from `@shardworks/tools-apparatus`, deprecate the core export, remove in a future version.

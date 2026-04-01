# The Instrumentarium — API Contract

Status: **Draft — MVP**

Package: `@shardworks/tools-apparatus` · Plugin id: `tools`

---

## Purpose

The Instrumentarium is the guild's tool registry. It owns the complete lifecycle of tool resolution: scanning installed tools from kit contributions and apparatus supportKits at startup, resolving role-gated tool sets on demand, and creating scoped `HandlerContext` objects for tool invocation.

Both the session layer (The Loom, The Animator) and the CLI depend on The Instrumentarium. It has no dependency on anima identity, sessions, or composition.

---

## Dependencies

```
requires: ['stacks']     — reads roles/baseTools config; may persist tool metadata
consumes: ['tools']      — scans kit and supportKit contributions for tool definitions
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

Each tool is a `ToolDefinition` produced by the `tool()` SDK factory. The Instrumentarium scans these contributions reactively via `plugin:initialized` at startup.

---

## `InstrumentariumApi` Interface (`provides`)

```typescript
interface InstrumentariumApi {
  /**
   * Resolve the tool set for a given set of roles.
   *
   * Returns tools from baseTools + the union of each role's tool list,
   * filtered by the provided channel (mcp, cli, or import).
   * Each returned tool includes its definition, handler, and owning plugin id.
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

  /**
   * Create a HandlerContext scoped to a specific plugin.
   *
   * The returned context has `config()` defaulting to the owning plugin's
   * config section, and `apparatus()` wired to the running apparatus graph.
   */
  createHandlerContext(owningPluginId: string): HandlerContext
}

interface ResolveOptions {
  /** Roles to resolve tools for. Tools are the union across all roles + baseTools. */
  roles: string[]
  /** Filter by invocation channel. Tools with no `callableFrom` pass all channels. */
  channel?: 'mcp' | 'cli' | 'import'
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

The Instrumentarium reads this via `ctx.config<InstrumentariumConfig>()` — no `guildConfig()` escape hatch needed.

## Role-Gating Resolution

Resolution logic:

1. Collect tool names from `baseTools`
2. For each role in the request, collect tool names from `roles[role].tools`
3. Union all collected names
4. Match against installed tool definitions
5. Filter by `channel` if specified (tools with no `callableFrom` restriction pass all channels)

The resolved set includes the `ToolDefinition` (with handler) and provenance (`pluginId`) for each tool.

---

## HandlerContext Creation

When a tool is invoked — by the MCP engine during a session, by the CLI, or by another tool/engine programmatically — the caller creates a `HandlerContext` scoped to the tool's owning plugin:

```typescript
const instrumentarium = ctx.apparatus<InstrumentariumApi>('instrumentarium')
const handlerCtx = instrumentarium.createHandlerContext(tool.pluginId)
await tool.definition.handler(params, handlerCtx)
```

The `HandlerContext` provides `home`, `config()` (defaulting to the owning plugin's config section), `guildConfig()`, and `apparatus()`.

---

## Relationship to Arbor

The Instrumentarium replaces Arbor's current `listTools()`, `findTool()`, and `createHandlerContext()` methods. Once The Instrumentarium ships, those methods are removed from the `Arbor` interface. Arbor returns to being purely a plugin loader and lifecycle manager.

---

## Open Questions

- **Tool metadata persistence.** Should The Instrumentarium store tool metadata (install timestamps, provenance) in The Stacks, or is `guild.json` sufficient? Current implementation uses `guild.json` only. Stacks persistence would enable audit/history queries but adds complexity.
- **Hot reload.** Can tools be installed/removed while the guild is running, or only at startup? Current answer: startup only. Hot reload is a future enhancement.

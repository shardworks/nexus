# `@shardworks/tools-apparatus`

The Instrumentarium — the guild's tool registry. This apparatus scans installed tools from kit contributions and apparatus supportKits at startup, resolves role-gated tool sets on demand, and serves as the single source of truth for "what tools exist and who can use them."

Both the CLI and the session layer (The Animator, via MCP) depend on The Instrumentarium to discover available tools. It sits low in the dependency graph — no dependencies on other apparatus.

```
@shardworks/nexus-core            — tool() factory, ToolDefinition type
@shardworks/tools-apparatus       — tool registry, role resolution, InstrumentariumApi
@shardworks/nexus (cli)           — queries InstrumentariumApi for CLI-callable tools
kits / apparatus supportKits      — contribute ToolDefinition[] via `tools` field
```

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/tools-apparatus": "workspace:*"
  }
}
```

Plugin id: `tools`

---

## API

The Instrumentarium exposes `InstrumentariumApi` via `provides`, accessed by other plugins as:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { InstrumentariumApi } from '@shardworks/tools-apparatus';

const instrumentarium = guild().apparatus<InstrumentariumApi>('tools');
```

### `InstrumentariumApi`

```typescript
interface InstrumentariumApi {
  /**
   * Resolve the tool set for a given set of roles.
   *
   * Returns tools from baseTools + the union of each role's tool list,
   * filtered by the provided channel (mcp, cli, or import).
   */
  resolve(options: ResolveOptions): ResolvedTool[];

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null;

  /**
   * List all installed tools, regardless of role assignment.
   */
  list(): ResolvedTool[];
}
```

### `ResolvedTool`

A tool with provenance metadata:

```typescript
interface ResolvedTool {
  /** The tool definition (name, description, params schema, handler). */
  definition: ToolDefinition;
  /** Plugin id of the kit or apparatus that contributed this tool. */
  pluginId: string;
}
```

### `ResolveOptions`

```typescript
interface ResolveOptions {
  /** Roles to resolve tools for. Tools are the union across all roles + baseTools. */
  roles: string[];
  /** Filter by invocation channel. Tools with no callableFrom pass all channels. */
  channel?: ToolCaller;
}
```

### Usage Examples

**Resolve tools for a session (The Animator's use case):**

```typescript
const tools = instrumentarium.resolve({
  roles: ['artificer', 'scribe'],
  channel: 'mcp',
});
// → ResolvedTool[] — all MCP-callable tools for those roles + baseTools
```

**Find a specific tool:**

```typescript
const tool = instrumentarium.find('commission-show');
if (tool) {
  const result = await tool.definition.handler({ id: 'writ-123' });
}
```

**List everything installed (the CLI's use case):**

```typescript
const cliTools = instrumentarium.list()
  .filter(r => !r.definition.callableFrom || r.definition.callableFrom.includes('cli'))
  .map(r => r.definition);
```

---

## Configuration

Role assignments and base tools are stored in `guild.json` under the `tools` key:

```json
{
  "tools": {
    "baseTools": ["nexus-version", "signal"],
    "roles": {
      "artificer": ["commission-show", "writ-update", "complete-session"],
      "scribe": ["commission-show", "writ-list"]
    }
  }
}
```

### `InstrumentariumConfig`

```typescript
interface InstrumentariumConfig {
  /** Tool names available to all animas regardless of role. */
  baseTools?: string[];
  /** Role → tool names mapping. */
  roles?: Record<string, string[]>;
}
```

**`baseTools`** — tools available to every anima, regardless of their role assignments. Defaults to `[]`.

**`roles`** — maps role names to arrays of tool names. An anima's available tools are the union of `baseTools` + all tools listed under each of its assigned roles.

---

## Kit Interface

Kits contribute tools via a `tools` field in their kit export:

```typescript
import { tool } from '@shardworks/tools-apparatus';
import { z } from 'zod';

const showTool = tool({
  name: 'commission-show',
  description: 'Show details of a commission',
  params: {
    id: z.string().describe('Commission id'),
  },
  handler: async ({ id }) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const writs = stacks.readBook<Writ>('clerk', 'writs');
    return await writs.get(id);
  },
});

export default {
  kit: {
    requires: ['tools'],
    tools: [showTool],
  },
} satisfies Plugin;
```

Each entry in the `tools` array is a `ToolDefinition` produced by the `tool()` factory. The Instrumentarium scans these contributions at startup via the `plugin:initialized` lifecycle event.

---

## Exports

The package re-exports the tool authoring API from `@shardworks/nexus-core` for convenience:

```typescript
// Tool authoring (re-exported from core during transition)
import { tool, type ToolDefinition, type ToolCaller } from '@shardworks/tools-apparatus';

// Instrumentarium API
import {
  type InstrumentariumApi,
  type InstrumentariumConfig,
  type ResolvedTool,
  type ResolveOptions,
  createInstrumentarium,
} from '@shardworks/tools-apparatus';
```

The default export is the apparatus plugin instance, ready for use in `guild.json`:

```typescript
import instrumentarium from '@shardworks/tools-apparatus';
// → Plugin with apparatus.provides = InstrumentariumApi
```

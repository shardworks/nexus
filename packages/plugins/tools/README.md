# `@shardworks/tools-apparatus`

The Instrumentarium — the guild's tool registry. This apparatus scans installed tools from kit contributions and apparatus supportKits at startup, resolves permission-gated tool sets on demand, and serves as the single source of truth for "what tools exist and who can use them."

Both the CLI and the session layer (The Animator, via MCP) depend on The Instrumentarium to discover available tools. It sits low in the dependency graph — no dependencies on other apparatus.

```
@shardworks/tools-apparatus       — tool() factory, ToolDefinition type, tool registry, InstrumentariumApi
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
   * Resolve the tool set for a given set of permissions.
   *
   * Evaluates each registered tool against the permission grants:
   * - Tools with a `permission` field: included if any grant matches
   * - Permissionless tools: always included (default) or gated by `strict`
   * - Channel filtering applied last
   */
  resolve(options: ResolveOptions): ResolvedTool[];

  /**
   * Find a single tool by name. Returns null if not installed.
   */
  find(name: string): ResolvedTool | null;

  /**
   * List all installed tools, regardless of permissions.
   */
  list(): ResolvedTool[];

  /**
   * Start the Tool HTTP server.
   *
   * Serves all registered tools over HTTP with session-scoped authorization.
   * Binds to 127.0.0.1. Port defaults to guild.json tools.serverPort or 7471.
   */
  startToolServer(opts?: ToolServerOptions): Promise<ToolServerHandle>;
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
  /**
   * Permission grants in `plugin:level` format.
   * Supports wildcards: `plugin:*`, `*:level`, `*:*`.
   */
  permissions: string[];
  /**
   * When true, permissionless tools are excluded unless the role grants
   * `plugin:*` or `*:*` for the tool's plugin. When false (default),
   * permissionless tools are included unconditionally.
   */
  strict?: boolean;
  /** Filter by caller type. Tools with no callableBy restriction pass all callers. */
  caller?: ToolCaller;
}
```

### Usage Examples

**Resolve tools for a session (The Loom's use case):**

```typescript
// The Loom resolves role → permissions, then asks the Instrumentarium
const tools = instrumentarium.resolve({
  permissions: ['stdlib:read', 'stdlib:write', 'animator:read'],
  caller: 'anima',
});
// → ResolvedTool[] — all anima-callable tools matching those permission grants
```

**Resolve with strict mode (lock down permissionless tools):**

```typescript
const tools = instrumentarium.resolve({
  permissions: ['stdlib:*'],
  strict: true,
});
// → Only tools from the stdlib plugin (both permissioned and permissionless)
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
  .filter(r => !r.definition.callableBy || r.definition.callableBy.includes('cli'))
  .map(r => r.definition);
```

---

## Permission Model

The Instrumentarium is **role-agnostic** — it receives an already-resolved permissions array and returns matching tools. Role definitions and permission grants are owned by the Loom.

### How permissions work

Each tool may declare a `permission` level (e.g. `'read'`, `'write'`, `'admin'`). Callers provide permission grants in `plugin:level` format:

| Grant format | Meaning |
|---|---|
| `stdlib:read` | Exact match — grants `read` tools from the `stdlib` plugin |
| `stdlib:*` | Plugin wildcard — grants all tools from `stdlib` |
| `*:read` | Level wildcard — grants `read` tools from any plugin |
| `*:*` | Superuser — grants all tools from all plugins |

There is **no permission hierarchy** — `write` does not imply `read`. Each level must be granted explicitly, or use wildcards.

### Permissionless tools

Tools without a `permission` field are **permissionless**. In default mode, they are always included in resolution results. In `strict` mode, they are excluded unless the caller has `plugin:*` or `*:*` for the tool's plugin.

---

## Tool HTTP Server

The Instrumentarium can serve all registered tools over HTTP, enabling out-of-process clients (such as detached session babysitters) to proxy tool calls back to the guild.

### Starting the server

```typescript
const instrumentarium = guild().apparatus<InstrumentariumApi>('tools');
const handle = await instrumentarium.startToolServer({ port: 7471 });
// → { port: 7471, url: 'http://127.0.0.1:7471', close() }
```

The port defaults to `guild.json` → `tools.serverPort`, or `7471` if not configured:

```json
{
  "tools": {
    "serverPort": 7471
  }
}
```

### Route mapping

Tool names map to REST routes. The first hyphen splits the name into resource and action:

| Tool name | Route | Method |
|---|---|---|
| `writ-list` | `GET /api/writ/list` | GET (permission: read) |
| `writ-create` | `POST /api/writ/create` | POST (permission: write) |
| `writ-remove` | `DELETE /api/writ/remove` | DELETE (permission: delete) |
| `signal` | `GET /api/signal` | GET (no permission) |

### Session-scoped authorization

Tools restricted to non-patron callers (e.g. `callableBy: ['anima']`) require a session ID header. Session babysitters register authorized tool sets before proxying calls:

```
POST /sessions
{ "sessionId": "s-abc123", "tools": ["writ-list", "writ-create"] }

GET /api/writ/list
X-Session-Id: s-abc123
→ 200 OK

DELETE /sessions/s-abc123
→ 200 OK
```

Patron-callable and unrestricted tools are accessible without a session header.

### `ToolServerHandle`

```typescript
interface ToolServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}
```

### Utility exports

The route mapping functions are exported for use by other packages (e.g. the Oculus):

```typescript
import { toolNameToRoute, permissionToMethod, coerceParams } from '@shardworks/tools-apparatus';
```

---

## Kit Interface

Kits contribute tools via a `tools` field in their kit export:

```typescript
import { tool } from '@shardworks/tools-apparatus';
import { z } from 'zod';

const showTool = tool({
  name: 'commission-show',
  description: 'Show details of a commission',
  permission: 'read',
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

Each entry in the `tools` array is a `ToolDefinition` produced by the `tool()` factory. The Instrumentarium scans these contributions at startup via `ctx.kits()` and reactively via the `apparatus:started` lifecycle event.

---

## Exports

```typescript
// Tool authoring API (canonical home)
import { tool, type ToolDefinition, type ToolCaller } from '@shardworks/tools-apparatus';

// Instrumentarium API
import {
  type InstrumentariumApi,
  type ResolvedTool,
  type ResolveOptions,
  createInstrumentarium,
} from '@shardworks/tools-apparatus';

// Tool server utilities
import {
  type ToolServerHandle,
  type ToolServerOptions,
  type ToolsConfig,
  toolNameToRoute,
  permissionToMethod,
  coerceParams,
  SessionRegistry,
} from '@shardworks/tools-apparatus';
```

The default export is the apparatus plugin instance, ready for use in `guild.json`:

```typescript
import instrumentarium from '@shardworks/tools-apparatus';
// → Plugin with apparatus.provides = InstrumentariumApi
```

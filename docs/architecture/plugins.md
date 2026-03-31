# Plugin Architecture

This document describes the plugin system — how the guild's capabilities are packaged, installed, and composed. For the broader system context, see [overview.md](overview.md).

---

## Overview

The guild framework ships with no running infrastructure of its own. The Clockworks, the Walker, the Surveyor — everything that makes a guild operational is contributed by plugins. `nsg init` installs a default plugin set; a guild's installed plugins determine what it can do.

This is a deliberate design choice. Keeping the framework core to a plugin loader and a set of type contracts means each piece of infrastructure is independently testable, replaceable, and comprehensible. There is no privileged built-in layer; the core apparatus and a community plugin are the same kind of thing.

A plugin is an npm package that exports a typed manifest object.

---

## The Plugin Manifest

```typescript
type Plugin = {
  name:      string
  requires?: string[]       // plugin names this plugin depends on
  provides?: unknown        // API surface exposed to other plugins via ctx.plugin()
  kit?:      Kit
  start:     (ctx: GuildContext) => void
  stop?:     () => void
  health?:   () => "ok" | "degraded" | "down"
}
```

`start` and `stop` are synchronous. If a plugin needs to initiate async work, it does so without blocking. `stop` is optional — kit-only plugins with no running state do not need it.

The entry point exports the manifest using the `satisfies` pattern:

```typescript
export default {
  name:     "nexus-git",
  kit: {
    engines: [createBranchEngine, deleteBranchEngine, mergeBranchEngine],
    tools:   [statusTool, diffTool, logTool],
  },
  start: (_ctx) => {},
} satisfies Plugin
```

---

## Kit

A kit contributes engine designs and anima tools to the guild.

```typescript
type Kit = {
  engines: EngineDesign[]
  tools?:  ToolDefinition[]
}
```

**Engine designs** are Walker-facing — blueprints for engines the Walker can mount into rigs. The Walker draws from all installed kits when extending a rig to meet a declared need.

**Tool definitions** are anima-facing — instruments animas wield during sessions. The manifest engine delivers tool instructions to animas at manifest time.

A plugin has at most one kit. If kit contributions are meaningfully distinct, they belong in separate plugins.

Kits are passive. The framework reads them at load time; nothing about a kit participates in `start`/`stop` or the plugin lifecycle.

---

## Apparatus

A plugin that contributes a persistent running system implements its lifecycle in `start` and `stop`. The Clockworks, Walker, and Surveyor are all plugins of this kind.

`start(ctx)` is where the plugin initialises its internal state, registers lifecycle hooks, and wires up its dependencies. `stop()` tears it down synchronously.

```typescript
export default {
  name:     "nexus-clockworks",
  requires: ["nexus-stacks"],
  provides: clockworksApi,

  start: (ctx) => {
    const stacks = ctx.plugin<StacksApi>("nexus-stacks")
    clockworksApi.init(stacks)
    ctx.on("guild:shutdown", () => clockworksApi.drain())
  },

  stop: () => {
    clockworksApi.shutdown()
  },
} satisfies Plugin
```

A plugin that provides an API creates a stable object reference at manifest definition time and populates it during `start`. The reference is stable; the object gains its contents when the plugin starts:

```typescript
const clockworksApi: ClockworksApi = {
  on:    (event, handler) => { ... },
  emit:  (event, payload) => { ... },
  drain: ()               => { ... },
  // implementations filled by init()
}
```

---

## The Plugin API Surface (`provides`)

A plugin that exposes an API to other plugins declares it via `provides`. This is the object returned when another plugin calls `ctx.plugin(name)`.

```typescript
export default {
  name:     "nexus-clockworks",
  provides: clockworksApi,
  // ...
} satisfies Plugin
```

Other plugins retrieve it by name:

```typescript
const clockworks = ctx.plugin<ClockworksApi>("nexus-clockworks")
```

The type parameter is the caller's assertion — the framework returns the raw `provides` value; the caller casts it to the expected type. Plugin authors ship their API type alongside their package so consumers can import and cast safely:

```typescript
import type { ClockworksApi } from "nexus-clockworks"
const clockworks = ctx.plugin<ClockworksApi>("nexus-clockworks")
```

For plugins with multiple internal components, `provides` is a single object that aggregates them:

```typescript
const api = { ledger: new LedgerApi(), daybook: new DayBookApi() }

export default {
  name:     "nexus-stacks",
  provides: api,
  start: (ctx) => {
    api.ledger.init(ctx)
    api.daybook.init(ctx)
  },
  stop: () => {
    api.ledger.close()
    api.daybook.close()
  },
} satisfies Plugin
```

Consumers receive `{ ledger, daybook }`. The internal component structure is an implementation detail.

---

## Dependencies

Plugins declare their dependencies by name in `requires`:

```typescript
export default {
  name:     "nexus-walker",
  requires: ["nexus-clockworks", "nexus-stacks"],
  start: (ctx) => {
    const clockworks = ctx.plugin<ClockworksApi>("nexus-clockworks")
    const stacks     = ctx.plugin<StacksApi>("nexus-stacks")
    // ...
  },
} satisfies Plugin
```

The framework validates `requires` at startup — before any `start` is called. If a declared dependency is not installed, the guild refuses to start with a specific error naming the missing plugin. If `ctx.plugin()` is called for a plugin not in `requires`, it fails at startup validation, not at runtime.

This means dependency problems surface when the guild starts, not mid-commission when an agent is doing work.

Dependencies determine start ordering. By the time a plugin's `start` runs, all plugins in its `requires` array are already started and their `provides` objects are populated.

Circular dependencies are rejected at load time.

---

## Lifecycle hooks

Plugins subscribe to guild lifecycle events inside `start` via `ctx.on()`:

```typescript
start: (ctx) => {
  ctx.on("writ:state-changed",  (writ)   => { ... })
  ctx.on("commission:received", (c)      => { ... })
  ctx.on("plugin:initialized",  (plugin) => { ... })
  ctx.on("guild:shutdown",      ()       => { ... })
}
```

All handlers are synchronous. The framework does not await return values; fire-and-forget async work is initiated inside the handler without blocking.

The interface is open-ended — new lifecycle events do not require interface changes. Plugins subscribe to what they need.

### `plugin:initialized`

When a plugin needs to respond to other plugins coming online, it handles both past and future:

```typescript
start: (ctx) => {
  for (const p of ctx.plugins()) { handle(p) }   // already initialized
  ctx.on("plugin:initialized", (p) => handle(p)) // future plugins
}
```

`ctx.plugins()` returns a snapshot. No priority fields, no initialization phases.

---

## GuildContext

```typescript
interface GuildContext {
  plugin<T>(name: string): T           // retrieve a dependency's provides object
  plugins(): PluginRecord[]            // snapshot of currently initialized plugins
  on(event: string, handler: (...args: unknown[]) => void): void
}
```

`ctx.plugin()` is validated against `requires` at startup. Calling it for an undeclared dependency fails at startup, not at call time.

If a plugin is present but declares no `provides`, `ctx.plugin()` returns a sentinel that throws a useful message on access rather than silently returning `undefined`.

---

## Static vs. Dynamic Contributions

**Static contributions** — anything knowable at manifest-definition time — belong in the manifest. The framework reads manifests before any `start` is called.

Examples: engine designs, tool definitions, kit contents, the `provides` object reference.

**Dynamic contributions** — things that require a running apparatus — are registered in `start`.

Prefer manifest declarations. Every contribution moved from a runtime hook into the manifest eliminates a lifecycle ordering concern.

---

## Failure Modes

**Missing dependency** — a plugin declares `requires: ["nexus-clockworks"]` and that plugin is not installed. Loud startup failure before any plugin starts: *"nexus-walker requires nexus-clockworks, which is not installed."*

**Undeclared access** — `ctx.plugin("nexus-clockworks")` called without declaring it in `requires`. Caught at startup validation, same loud failure. Never reaches `start`.

**Plugin provides nothing** — `ctx.plugin("some-kit")` where the plugin has no `provides`. Returns a sentinel; throws with a useful message on access.

**Bad cast** — `ctx.plugin<WrongType>("nexus-clockworks")`. Runtime error when the wrong method is called. Accepted tradeoff: the coupling is explicit in `requires` and visible in the type import; the developer takes responsibility for getting the type right.

---

## Installation

Installed plugins are declared in `guild.json`:

```json
{
  "plugins": [
    "nexus-clockworks",
    "nexus-walker",
    "nexus-surveyor",
    "nexus-stacks",
    "nexus-git"
  ]
}
```

The framework loads plugins in declaration order, resolves the dependency graph, validates all `requires` declarations, and calls `start` in dependency-resolved order. `nsg init` populates a default plugin set; additional plugins are added manually or via `nsg plugin install`.

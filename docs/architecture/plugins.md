# Plugin Architecture

This document describes the plugin system — how the guild's capabilities are packaged, installed, and composed. For the broader system context, see [overview.md](overview.md).

---

## Overview

The guild framework ships with no running infrastructure of its own. The Clockworks, the Spider, the Surveyor — everything that makes a guild operational is contributed by plugins. `nsg init` installs a default plugin set; a guild's installed plugins determine what it can do.

This is a deliberate design choice. Keeping the framework core to a plugin loader and a set of type contracts means each piece of infrastructure is independently testable, replaceable, and comprehensible. There is no privileged built-in layer; a core apparatus and a community kit are the same kind of thing.

Plugins come in two kinds:

- **Kits** — passive packages contributing capabilities to consuming apparatuses. No lifecycle, no running state. Read at load time and forwarded to consuming apparatuses.
- **Apparatuses** — packages contributing persistent running infrastructure. Have a `start`/`stop` lifecycle. May include a `supportKit` that exposes their capabilities to the rest of the guild.

**Plugin** is retained as a framework-internal and technical term for "either of the above." It appears in error messages, internal types, and npm package conventions, but is not the primary vocabulary users encounter. The guild vocabulary is Kit and Apparatus.

---

## Kit

A kit is a passive package contributing capabilities to the guild. Kits have no lifecycle — they are read at load time and their contributions are forwarded to consuming apparatuses. Nothing about a kit participates in `start`/`stop` or requires a running system.

```typescript
type Kit = {
  requires?:   string[]
  recommends?: string[]
  [key: string]:  unknown
}
```

A kit is an open record. The contribution fields (`relays`, `engines`, `tools`, or anything else) are defined by the apparatus packages that consume them, not by the framework. `requires` and `recommends` are the only framework-level fields.

**`requires`** is an array of apparatus names whose runtime APIs this kit's contributions depend on at handler invocation time. If a tool contributed by this kit calls `guild().apparatus("books")`, the kit must declare `requires: ["books"]`. Validated at startup — if a declared apparatus is not installed, the guild refuses to start with a specific error. Hard failure, not advisory.

**`recommends`** is an advisory list of apparatus names the kit's contributions are most useful with, used to generate startup warnings when expected apparatuses are absent. Not enforced.

A kit package exports its manifest as the default export:

```typescript
import type { ClockworksKit } from "nexus-clockworks"
import type { SpiderKit }     from "nexus-spider"
import type { AnimaKit }      from "nexus-sessions"

export default {
  kit: {
    requires:   ["nexus-books"],
    recommends: ["nexus-clockworks", "nexus-spider"],
    engines: [createBranchEngine, deleteBranchEngine, mergeBranchEngine],
    relays:  [onMergeRelay],
    tools:   [statusTool, diffTool, logTool],
  } satisfies ClockworksKit & SpiderKit & AnimaKit,
} satisfies Plugin
```

Type safety for contribution fields is provided by the apparatus that consumes them — not by the framework. Each apparatus package publishes a kit interface that kit authors can import and `satisfies` against:

- `ClockworksKit` — defines `relays`. See [ClockworksKit](clockworks.md#clockworkskit).
- `SpiderKit` — defines `engines`. See [Engine Designs](engine-designs.md).
- `AnimaKit` — defines `tools`. See [Tools](anima-lifecycle.md#tools).

Kit authors who don't want or need static type checking simply write a plain object — both approaches are valid.

The framework never inspects contribution field contents. It sees kit records as opaque objects, collects them into `KitEntry` records during the Wire phase, and makes them available via `ctx.kits(type)` during apparatus `start()`. It also cross-references field keys against `consumes` tokens for startup warnings. See [Kit Contribution Consumption](#kit-contribution-consumption).

---

## Apparatus

An apparatus is a package contributing persistent running infrastructure to the guild. It implements a lifecycle in `start` and `stop`. The Clockworks, Spider, and Surveyor are all apparatuses.

```typescript
type Apparatus = {
  requires?:   string[]
  provides?:   unknown
  start:       (ctx: StartupContext) => void
  stop?:       () => void
  supportKit?: Kit
  consumes?:   string[]
}
```

**`requires`** is an array of apparatus names that must be started before this apparatus's `start()` runs. Validated at startup before any `start` is called. Determines start ordering — by the time an apparatus's `start` runs, all its declared dependencies are already started with their `provides` objects populated. Circular dependencies are rejected at load time.

**`provides`** is the runtime API object this apparatus exposes to other plugins. Retrieved via `guild().apparatus<T>(name)`. The reference is created at manifest-definition time and populated during `start`. See [Providing an API](#providing-an-api).

`start(ctx)` is where the apparatus initialises its internal state, registers lifecycle hooks, and wires up its dependencies. `stop()` tears it down. Both may be async — the framework awaits them in dependency-resolved order.

`stop` is optional for apparatuses that have no shutdown logic beyond garbage collection.

A `supportKit` is a Kit that an apparatus composes to expose its capabilities to the rest of the guild — the same open record as any other kit, populated with whatever contribution fields the apparatus's own consuming peers understand. Consuming apparatuses treat `supportKit` contributions identically to standalone kit contributions; the source is an implementation detail callers never see.

An apparatus without a `supportKit` is meaningful — infrastructure that exposes its capabilities only through `provides` (the inter-apparatus API) rather than through the tool/relay/engine surface.

**`consumes`** is an optional array of string tokens declaring which Kit contribution types this apparatus scans for and registers. The tokens correspond to Kit field names (`"engines"`, `"relays"`, `"tools"`, or custom extension types). This declaration enables the framework to generate startup warnings when kits contribute to a type that no installed apparatus consumes. See [Kit Contribution Consumption](#kit-contribution-consumption).

```typescript
const clockworksApi: ClockworksApi = {
  on:    (event, handler) => { ... },
  emit:  (event, payload) => { ... },
  drain: ()               => { ... },
}

export default {
  apparatus: {
    requires: ["nexus-stacks"],
    provides: clockworksApi,

    supportKit: {
      relays: [signalRelay, drainRelay],
      tools:  [signalTool, clockStatusTool],
    },

    start: (ctx) => {
      const stacks = guild().apparatus<StacksApi>("nexus-stacks")
      clockworksApi.init(stacks)
    },

    stop: () => {
      clockworksApi.shutdown()
    },
  },
} satisfies Plugin
```

### Providing an API (`provides`)

An apparatus that exposes a typed API to other plugins declares it via `provides` on the apparatus. This is the object returned when another plugin calls `guild().apparatus(name)`.

```typescript
const clockworksApi: ClockworksApi = {
  on:    (event, handler) => { ... },
  emit:  (event, payload) => { ... },
  drain: ()               => { ... },
}

export default {
  apparatus: {
    requires: ["nexus-stacks"],
    provides: clockworksApi,
    start: (ctx) => { ... },
  },
} satisfies Plugin
```

A stable object reference is created at manifest-definition time and populated during `start`. The reference is stable; the object gains its runtime contents when the apparatus starts.

Plugin authors ship their API type alongside their package so consumers can import and cast safely:

```typescript
import type { ClockworksApi } from "nexus-clockworks"
const clockworks = guild().apparatus<ClockworksApi>("nexus-clockworks")
```

---

## Plugin IDs

Every plugin has a derived **plugin id** — the name used in `guild.json`, `requires` arrays, `guild().apparatus()` calls, and configuration keys. The id is derived from the npm package name at load time and never declared in the manifest.

Derivation rules, applied in order:

1. **Strip the `@shardworks/` scope** — the official Nexus namespace. `@shardworks/clockworks` → `clockworks`. Plugins in this scope are referenced by bare name everywhere.
2. **Retain other scopes as a prefix** — `@acme/my-relay` → `acme/my-relay`. Preserves uniqueness across third-party publishers without special registry entries.
3. **Strip a trailing `-(plugin|apparatus|kit)` suffix** — allows package authors to use descriptive npm names without polluting the plugin id. `my-relay-kit` → `my-relay`. `@acme/cache-apparatus` → `acme/cache`.

Examples:

| npm package name              | Plugin id         |
|-------------------------------|-------------------|
| `@shardworks/clockworks`      | `clockworks`      |
| `@shardworks/books-apparatus` | `books`           |
| `@shardworks/nexus-git`       | `nexus-git`       |
| `@acme/cache-apparatus`       | `acme/cache`      |
| `my-relay-kit`                | `my-relay`        |
| `my-plugin`                   | `my-plugin`       |

Plugin ids are also the keys under which plugin-specific configuration lives in `guild.json` — see [Configuration](#configuration).

---

## The Plugin Type

```typescript
type Plugin =
  | { kit:       Kit }
  | { apparatus: Apparatus }
```

A plugin is either a kit or an apparatus — the discriminating field (`kit` or `apparatus`) is required. All plugin-level concerns (`requires`, `provides`) live inside the respective type where their semantics are defined. The plugin name is always inferred from the npm package name at load time — it is never declared in the manifest.

---

## Dependencies

Both kits and apparatuses may declare `requires`, but the semantics differ:

**Apparatus `requires`** — two effects: validates that declared dependencies are installed, and determines start ordering. By the time the apparatus's `start()` runs, all declared dependencies are already started.

```typescript
export default {
  apparatus: {
    requires: ["nexus-clockworks", "nexus-stacks"],
    start: (ctx) => {
      const clockworks = guild().apparatus<ClockworksApi>("nexus-clockworks")
      const stacks     = guild().apparatus<StacksApi>("nexus-stacks")
      // ...
    },
  },
} satisfies Plugin
```

**Kit `requires`** — one effect: validates that declared apparatuses are installed and will be started. No ordering concern (kits have no `start`). Ensures that tools contributed by the kit can safely call `guild().apparatus(name)` at handler invocation time without a runtime failure.

```typescript
export default {
  kit: {
    requires: ["nexus-books"],
    tools:    [writeNoteTool, readNoteTool],
  },
} satisfies Plugin
```

Both produce the same operator-facing failure: a loud, early, specific error at guild startup before any agent does any work.

The framework validates all `requires` declarations at startup — before any `start` is called. If a declared dependency is not installed, the guild refuses to start with a specific error naming the missing plugin. Circular dependencies are rejected at load time.

### `recommends`

Both kits and apparatuses may declare `recommends` — advisory dependencies that generate startup warnings but do not prevent startup. Use `recommends` for soft dependencies needed by optional capabilities:

```typescript
export default {
  apparatus: {
    requires:   ["stacks"],
    recommends: ["loom"],     // summon() needs it, animate() doesn't
    // ...
  },
} satisfies Plugin
```

If a recommended plugin is not installed, Arbor logs a warning at startup but proceeds normally. The apparatus is responsible for producing a clear runtime error if the missing dependency is actually needed (e.g. "summon() requires The Loom apparatus to be installed").

---

## Internal Model

The framework maintains two separate internal lists — `LoadedKit[]` and `LoadedApparatus[]` — because they have genuinely different lifecycles:

```typescript
type GuildManifest = {
  kits:        LoadedKit[]
  apparatuses: LoadedApparatus[]
}
```

Lifecycle management (start ordering, shutdown) operates on the apparatus list. Kit records are loaded and cached; their contributions are collected during the Wire phase into `KitEntry` records and made available to consuming apparatuses via `ctx.kits(type)` during `start()`.

Each consuming apparatus maintains its own registry of the contribution types it understands. A Clockworks apparatus maintains a relay registry populated from both standalone kit packages and apparatus `supportKit`s; callers of the Clockworks API see a single relay list regardless of source. The framework does not maintain cross-apparatus registries — contribution type semantics belong to the apparatus that defined them.

---

## Kit Contribution Consumption

A kit is passive — it declares contributions but has no awareness of whether any apparatus is present to consume them. The Clockworks doesn't know which relays are installed until it scans at startup; a relay kit doesn't know whether Clockworks is installed. This loose coupling is intentional: kits and apparatuses can be authored and published independently.

But loose coupling creates a practical problem. An operator installs a relay-heavy kit expecting event handling to work, forgets to install the Clockworks, and gets silent inertness with no indication anything is wrong. The framework addresses this without compromising kit purity or imposing hard couplings.

### Wire Phase and `ctx.kits(type)`

Before any apparatus `start()` is called, Arbor runs a **Wire phase**: it collects all kit contributions from standalone kits and apparatus `supportKit`s into a flat list of `KitEntry` records, indexed by contribution type. This snapshot is then made available to every apparatus via `ctx.kits(type)` during `start()`.

```typescript
interface KitEntry {
  readonly pluginId:    string   // derived plugin id of the contributing plugin
  readonly packageName: string   // npm package name
  readonly type:        string   // contribution field key (e.g. 'relays', 'engines')
  readonly value:       unknown  // the contribution value (e.g. relay record, engines record)
}
```

The Clockworks, for example, scans for all relay contributions in its `start()`:

```typescript
// inside Clockworks apparatus start()
start: (ctx) => {
  for (const entry of ctx.kits('relays')) {
    registerRelays(entry.value, entry.pluginId)
  }
}
```

Because the Wire phase completes before any `start()` runs, `ctx.kits(type)` always returns the full snapshot — there are no late arrivals to worry about, and no ordering dependencies between kits and the apparatuses that consume them.

Kits declare; apparatuses consume. Neither needs to know about the other at authoring time.

### Startup Warnings

The Arbor cross-references Kit contributions against installed apparatus `consumes` declarations at startup and emits advisory warnings for mismatches. These are coherence checks, not hard errors — a guild without a Clockworks may be a perfectly valid configuration.

Warning conditions:
- A kit contributes a type (`relays`, `engines`, `tools`, or a custom token) and no installed apparatus declares `consumes` for that token.
- A kit declares `recommends: ["nexus-clockworks"]` and that apparatus is not installed.

```
warn: nexus-signals contributes relays but no installed apparatus consumes "relays"
      consider installing nexus-clockworks (recommended by nexus-signals)

warn: nexus-git contributes engines but no installed apparatus consumes "engines"
```

Warnings surface at startup where an operator can act on them — not silently at runtime when a commission fails because no Spider is present.

### Design Notes

Several alternatives were considered before arriving at this approach:

**Kits declare hard dependencies on consuming apparatuses** — rejected. Too strong. Prevents speculative installation, blurs the Kit/Apparatus distinction by giving kits lifecycle concerns, and makes kit authoring more complex for a case that is often not an error.

**Consuming apparatuses silently scan without declaring `consumes`** — rejected. Leaves the framework unable to generate useful warnings. An operator has no way to know whether inert contributions are intentional or a configuration mistake.

**Framework-owned contribution type registry** — rejected. Requires the framework to know about contribution types like `relays` or `engines`, coupling Arbor to apparatus semantics it doesn't need to understand. Type safety for contribution fields belongs to the apparatus packages that define them; kit authors opt into that safety by importing the relevant interfaces. Arbor's concern is loading and warning, not interpreting.

The chosen approach — open `Kit` record with apparatus-published interfaces for type safety, Wire phase collection via `ctx.kits(type)`, optional `recommends` on kits, `consumes` on apparatuses, advisory startup warnings — keeps each concern where it belongs and surfaces configuration mistakes without imposing constraints that would make valid configurations impossible.

---

## StartupContext

The context passed to an apparatus's `start(ctx)`. Provides kit contribution access and lifecycle event subscription — the only capabilities that are meaningful only during startup. All other guild access goes through `guild()`.

```typescript
interface StartupContext {
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void
  kits(type: string): KitEntry[]
}
```

`ctx.kits(type)` returns a snapshot of all `KitEntry` records of the given type, collected during the Wire phase before any `start()` ran. Returns a new array on each call (snapshot isolation). Used by consuming apparatuses to register kit contributions — see [Wire Phase and `ctx.kits(type)`](#wire-phase-and-ctxkitstype).

---

## The Guild Accessor

Tool, engine, and relay handlers access guild infrastructure through the **guild accessor** — a process-level singleton set by Arbor at startup:

```typescript
import { guild } from '@shardworks/nexus-core'

// Inside a handler:
const { home } = guild()                          // guild root path
const stacks = guild().apparatus<StacksApi>('stacks')  // apparatus API
const cfg = guild().config<MyConfig>('my-plugin')       // plugin config
const full = guild().guildConfig()                       // full guild.json
```

```typescript
interface Guild {
  readonly home: string
  apparatus<T>(name: string): T
  config<T = Record<string, unknown>>(pluginId: string): T
  guildConfig(): GuildConfig
  kits():        LoadedKit[]
  apparatuses(): LoadedApparatus[]
}
```

The guild instance is created by Arbor before apparatus start and is available throughout startup and at runtime. Calling `guild()` at module scope (before Arbor runs) throws with a clear error message. Always call it inside a handler or `start()`, never at import time.

For testing, `setGuild()` and `clearGuild()` are exported from `@shardworks/nexus-core` to wire a mock instance.

---

## Configuration

Plugin-specific configuration lives in `guild.json` under the plugin's derived id — the same id used in `requires` arrays and `guild().apparatus()` calls.

### Config in `guild.json`

Plugin config sections sit alongside the framework-level keys at the top level of `guild.json`. Because plugin ids are derived from package names, the standard apparatus get natural short keys — no special handling required:

```json
{
  "name":     "my-guild",
  "nexus":    "0.1.x",
  "plugins":  ["clockworks", "stacks", "animator", "..."],
  "settings": { "model": "claude-opus-4-5" },

  "codexes": {
    "settings": { "maxMergeRetries": 3 },
    "registered": { "my-app": { "remoteUrl": "git@github.com:patron/my-app.git" } }
  },
  "clockworks": {
    "events":        { ... },
    "standingOrders": [...]
  },
  "animator": {
    "sessionProvider": "claude-code"
  }
}
```

Third-party apparatus follow the same pattern under their derived id:

```json
{
  "acme/cache": {
    "ttl": 3600
  }
}
```

### Typed config via module augmentation (recommended)

`GuildConfig` types only the framework-level keys (`name`, `nexus`, `plugins`, `settings`, etc.). Plugin config sections are additional top-level keys that the base type doesn't model. The recommended approach is **module augmentation**: each plugin declares its config interface and augments `GuildConfig` so the section is typed.

```typescript
// In your plugin's types file:

export interface ClockworksConfig {
  maxConcurrent?: number;
  events?: Record<string, EventDeclaration>;
  standingOrders?: StandingOrder[];
}

declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    clockworks?: ClockworksConfig;
  }
}
```

Once augmented, code that imports your plugin's types gets typed access through `guildConfig()` with no manual cast:

```typescript
// Inside apparatus start():
const config = guild().guildConfig().clockworks ?? {};
const maxConcurrent = config.maxConcurrent ?? 2;
```

The augmentation is visible wherever your plugin's types are imported — which is exactly where it matters: inside the plugin itself, and in any consuming plugin that imports your types.

**Guidelines:**
- Define the config interface in your plugin's public types file, alongside the API types.
- Export the config interface from your package barrel so consumers can import it.
- Make the augmented property optional (`clockworks?: ClockworksConfig`) — the section may not be present in guild.json.
- Ship the augmentation in the same file as the config interface. It takes effect when any type from that file is imported.

### `config<T>(pluginId)` (untyped fallback)

For cases where module augmentation is not practical (dynamic plugin ids, third-party plugins whose types you don't import), `guild().config<T>(pluginId)` provides untyped access:

```typescript
const cfg = guild().config<{ maxConcurrent?: number }>('clockworks');
```

Returns `guild.json[pluginId]` cast to `T`, or `{}` if no section exists. The generic type parameter is an unchecked assertion — the framework does not validate config shape.

Prefer module augmentation over `config<T>()` for any plugin you control. The augmented path gives you type safety without a cast at every call site.

### `guildConfig()`

Returns the full parsed `GuildConfig` — includes both framework-level fields (`name`, `nexus`, `plugins`, `settings`) and any plugin config sections added via module augmentation:

```typescript
const { settings } = guild().guildConfig()
```

---

## Lifecycle Hooks

Apparatus plugins subscribe to guild lifecycle events inside `start` via `ctx.on()`:

```typescript
apparatus: {
  start: (ctx) => {
    ctx.on("apparatus:started",  (id)  => { ... })  // an apparatus has completed start()
    ctx.on("phase:started",      ()    => { ... })  // all apparatus start() calls complete
    ctx.on("guild:shutdown",     ()    => { ... })
  },
}
```

Handlers may be async. The framework awaits each handler in turn before invoking the next — handlers for the same event run sequentially, not concurrently. This gives each handler predictable execution order without requiring them to be synchronous.

The interface is open-ended — new lifecycle events do not require interface changes. Apparatuses subscribe to what they need.

**`apparatus:started`** fires after each apparatus completes its `start()` call, with the apparatus's plugin id as its argument. Can be used to react to the progressive availability of apparatus APIs.

**`phase:started`** fires once after all apparatus `start()` calls have completed. Useful for work that requires every apparatus to be fully initialised.

Kit contributions should be consumed via `ctx.kits(type)` during `start()` rather than via lifecycle events — the Wire phase guarantees the full snapshot is available before any `start()` runs. See [Wire Phase and `ctx.kits(type)`](#wire-phase-and-ctxkitstype).

---

## Static vs. Dynamic Contributions

**Static contributions** — anything knowable at manifest-definition time — belong in the manifest. The framework reads manifests before any `start` is called.

Examples: kit contents, the `provides` object reference.

**Dynamic contributions** — things that require a running apparatus — are registered in `start`.

The Kit/Apparatus split makes this concrete: everything contributed by a kit is inherently static (kits have no `start`). Dynamic wiring can only happen inside an apparatus's `start()`. Prefer declaring contributions in a kit or `supportKit` over wiring them dynamically in `start` wherever possible — every contribution moved from a runtime hook into a kit declaration eliminates a lifecycle ordering concern.

---

## Failure Modes

**Missing dependency** — a plugin declares `requires: ["nexus-clockworks"]` and that plugin is not installed. Loud startup failure before any apparatus starts: *"nexus-spider requires nexus-clockworks, which is not installed."*

**Plugin provides nothing** — `guild().apparatus("nexus-git")` where the apparatus has no `provides`. Returns a sentinel; throws with a useful message on access.

**Bad cast** — `guild().apparatus<WrongType>("nexus-clockworks")`. Runtime error when the wrong method is called. Accepted tradeoff: the coupling is explicit in `requires` and visible in the type import; the developer takes responsibility for getting the type right.

---

## Installation

Installed plugins are declared in `guild.json`:

```json
{
  "plugins": [
    "nexus-clockworks",
    "nexus-spider",
    "nexus-surveyor",
    "nexus-stacks",
    "nexus-git"
  ]
}
```

The `"plugins"` key uses the internal term — users simply list package names. The framework determines whether each is a kit or apparatus at load time by inspecting the package manifest. No user-side declaration of the type is needed.

The framework loads plugins in declaration order, resolves the dependency graph, validates all `requires` declarations, and calls `start` on each apparatus in dependency-resolved order. All kits are loaded and cached before any apparatus starts, ensuring that kit contributions are available when apparatus `start()` handlers run. `nsg init` populates a default plugin set; additional plugins are added via `nsg install`.

### CLI Surface

```sh
nsg install nexus-clockworks
nsg install nexus-git
nsg remove  nexus-git
```

The `nsg install` command does not require specifying kit or apparatus — the package declares what it is. The distinction surfaces in `nsg status`, where apparatuses and kits appear in separate sections: apparatuses as running infrastructure, kits as passive capability inventory.

---

## Future Enhancements

### Apparatus Health Checks

A `health()` method on `Apparatus` is a natural addition once operational tooling matures:

```typescript
health?: () => "ok" | "degraded" | "down"
```

This would enable `nsg status` to report live apparatus health, and give operators a fast signal when infrastructure is degraded without needing to inspect logs. Deferred until there is a concrete operational need to drive the contract design.

### Dynamic Kit Discovery in Handlers

The current model supports tool-to-tool calls via direct import — if a handler needs the logic from another tool in a known kit, it imports that handler function directly. No framework involvement is required for this case.

A second pattern — dynamic discovery of kit contributions at handler invocation time — is not yet supported. This would allow a handler to discover all installed contributions of a given type without knowing which kits are present at author time (e.g., "run all installed pre-commit hooks"). A `guild().fromKit(type, name?)` or similar API is the likely shape. Deferred until a concrete use case motivates the contract.

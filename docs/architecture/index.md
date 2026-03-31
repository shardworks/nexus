# Nexus Architecture

**Nexus** is a framework for running an autonomous workforce of *animas* — AI agents who produce work in service of a guild, which ultimately delivers those works to a human patron. This is a technical document which describes the system itself — the structures, concepts, and machinery that any guild requires. It is meant to assist Nexus developers in their work, or provide users deeper insight into the workings of their guild. It is not intended as a general user guide for people who just want to run a guild.

For the conceptual vocabulary — what guilds, animas, commissions, writs, and apparatus *are* in the abstract — read [The Guild Metaphor](../guild-metaphor.md) first. This document describes how those concepts are implemented.

---

## System at a Glance

> This section describes the **standard guild** — the configuration `nsg init` produces. The framework itself is a plugin loader; every apparatus named below is part of the default plugin set, not a hard requirement. §4 ([Plugin Architecture](#plugin-architecture)) explains the underlying model; the [Standard Guild](#the-standard-guild) section catalogues what the default set includes.

A Nexus guild is a git repository with a `guild.json` at its root and a `.nexus/` directory holding runtime state. When the system starts, **Arbor** — the guild runtime — reads `guild.json`, loads the declared plugins, validates their dependencies, and starts each apparatus in order. From that point, the guild operates: the patron commissions work; **The Clerk** receives it and issues writs; **The Walker** assembles rigs and drives their engines to completion; **The Clockworks** turns events into action, activating relays in response to standing orders; and **anima sessions** — AI processes launched by **The Summoner** — do the work that requires judgment. Results land in codexes and documents; the patron consumes what the guild delivers.

```
  PATRON
    │  commission                                        ▲  works
    ▼                                                    │
  ┌──────────────────────────────────────────────────────┴──────┐
  │  Guild  (guild.json + .nexus/)                               │
  │                                                              │
  │  ┌───────────────────────────────────────────────────────┐  │
  │  │  Arbor  —  runtime · plugin loader · lifecycle        │  │
  │  ├───────────────────────────────────────────────────────┤  │
  │  │  Foundation   Stacks (persistence)                    │  │
  │  ├───────────────────────────────────────────────────────┤  │
  │  │  Reactive     Clockworks · Surveyor                   │  │
  │  │  Obligation   Clerk                                   │  │
  │  ├───────────────────────────────────────────────────────┤  │
  │  │  Execution    Walker · Formulary · Executor           │  │
  │  │  Session      Manifester · Summoner                   │  │
  │  └─────────────────────────┬─────────────────────────────┘  │
  │                            │                                 │
  │  Anima Sessions  ◄─────────┘                                │
  │  AI process · MCP server · role-gated tools                 │
  │                   │                                          │
  │  Works  ◄─────────┘                                         │
  │  codexes · documents · yields                               │
  └──────────────────────────────────────────────────────────────┘
```

### Patron

The patron is the human outside the system. They commission work and consume what the guild delivers — and that is the full extent of their participation. The patron does not assign animas, orchestrate apparatus, or direct how labor is organized. The interface is intentionally narrow: commission in, works out. What happens in the guild to convert one to the other is the guild's concern.

### The Guild

Physically, a guild is a directory. Its configuration root is `guild.json` — a single file that declares the guild's name, the plugins it has installed, its anima roles, and the standing orders that govern its reactive behavior. Everything the guild *is* lives in that file and the versioned content alongside it. Runtime activity — the persistence database, daemon state, active worktrees — accumulates in `.nexus/`, which is gitignored. The guild's identity is versioned; its running state is not.

### Arbor

Arbor is the guild runtime. It reads `guild.json` at startup, imports every declared plugin, resolves the dependency graph, and starts each apparatus in dependency order. It is not a persistent server or a central process — it is a library that each entry point (the CLI, the MCP server, the Clockworks daemon) instantiates independently at startup. There is no Arbor "service" to connect to; there is an Arbor instance alive for as long as the process that created it is running.

### Apparatus Layers

The guild's operational fabric is provided by apparatus — plugins with a start/stop lifecycle that collectively cover three concerns:

**Foundation** apparatus are always-on infrastructure that everything else depends on. **The Stacks** is the guild's persistence layer — a document store and change-data-capture substrate that all other apparatus read from and write to. It is the guild's source of truth for identity, work state, and operational history.

**Reactive** apparatus drive the guild's event-driven behavior. **The Clockworks** is the guild's nervous system: it maintains an event queue, processes standing orders in response to events, and dispatches responses — including summoning animas when a standing order calls for one. **The Surveyor** maintains the guild's knowledge of its registered codexes, so the guild knows what kind of work applies to each.

**Obligation** apparatus govern the work pipeline. **The Clerk** sits at commission intake: it receives incoming commissions from the patron, creates mandate writs, and signals downstream when a writ is ready to execute.

### Execution and Sessions

When a writ is ready — signaled by The Clerk — **The Walker** spawns a rig and begins traversal: identifying engines whose upstream work is complete, dispatching ready engines, and extending the rig with new engines (via **The Formulary**'s capability resolution) as the work unfolds. **The Executor** runs each engine: clockwork engines deterministically, quick engines by assembling an anima session.

Session assembly is a two-step hand-off. **The Manifester** composes the session context deterministically — combining the anima's curriculum, temperament, the guild charter, and the tool instructions for their role into a complete system prompt. **The Summoner** then launches the AI process with that context and an MCP server carrying the role's tools, monitors the session, and records the result to the guild's persistence layer.

The Clockworks also reaches The Summoner directly: when a standing order fires the summon relay, The Summoner launches an anima session without going through The Walker or rig machinery at all. From The Summoner's perspective, the caller doesn't matter — manifest, launch, record.

### Anima Sessions and Works

An anima session is a running AI process equipped with an MCP server carrying the role's tools. The session is ephemeral — it runs, produces output, and exits. The anima it represents is not: the anima's identity and session history persist in the guild's records. What the anima does during a session is captured; what the anima *is* outlasts any individual session.

The session's output lands wherever the work requires: inscriptions to a draft binding in a codex, entries in a document, signals to the Clockworks, or structured yields for downstream engines. When rigs complete and draft bindings are sealed, the result is work the patron can consume — running software, deployed services, written documents. The guild's measure of success is whether the patron can use what it delivered.

---

## The Guild Root

A guild is a directory — a regular git repository with a `guild.json` at its root. The framework discovers the guild root the same way git discovers `.git/`: by walking up from the current working directory until it finds `guild.json`. The `--guild-root` flag overrides this for explicit invocation.

### Directory Structure

<!-- TODO: full annotated directory tree, similar to what's in the outdated overview but updated for the current apparatus/kit model -->

```
GUILD_ROOT/
  guild.json                    ← central configuration
  package.json
  node_modules/                 ← gitignored; plugin runtime code lives here
  .nexus/                       ← runtime state, gitignored
    nexus.db                    ← The Books (SQLite)
    clock.pid                   ← Clockworks daemon PID
    clock.log                   ← Clockworks daemon log
    workshops/                  ← bare clones of registered codexes
    worktrees/                  ← commission worktrees
```

### `guild.json`

`guild.json` is the guild's central configuration file and the index of everything installed. Arbor reads it at startup; nothing in the guild system runs without it.

```json
{
  "name": "my-guild",
  "version": "...",
  "nexusVersion": "...",
  "defaultModel": "claude-opus-4-5",
  "plugins": ["nexus-stacks", "nexus-clockworks", "nexus-sessions", "..."],
  "roles": { ... },
  "baseTools": [...],
  "clockworks": {
    "events": { ... },
    "standingOrders": [...]
  }
}
```

<!-- TODO: walk through each top-level key with brief descriptions — plugins array, roles, baseTools, clockworks, and any apparatus-specific keys contributed at install time -->

### Runtime State (`.nexus/`)

<!-- TODO: describe .nexus/ as gitignored runtime territory — the Books database, daemon state, bare clones of workshops, and commission worktrees. Nothing in .nexus/ is part of the guild's versioned configuration; everything in guild.json and the filesystem is. -->

---

## Plugin Architecture

Everything operational in a guild is contributed by a **plugin** — there is no privileged built-in layer. Arbor, the guild runtime, is only a plugin loader, a dependency graph, and the startup/shutdown lifecycle for what gets loaded. The Clockworks, the Books, anima sessions, writ tracking — all of it is contributed by plugins.

Plugins come in two kinds:

### Kit

A **kit** is a passive package contributing capabilities to the guild. Kits have no lifecycle — they are read at load time and their contributions are forwarded to consuming apparatuses. Nothing about a kit participates in `start`/`stop` or requires a running system.

```typescript
// A kit's default export — an open record, contributions defined
// by the apparatus packages that consume them.
export default {
  name: "nexus-git",
  kit: {
    engines: [createBranchEngine, mergeBranchEngine],
    relays:  [onMergeRelay],
    tools:   [statusTool, diffTool],
    recommends: ["nexus-clockworks", "nexus-walker"],
  },
} satisfies Plugin
```

<!-- TODO: explain the open record model — kit field names (engines, relays, tools, etc.) are defined by consuming apparatus, not the framework. Explain recommends. Link to plugins.md for full detail. -->

### Apparatus

An **apparatus** is a package contributing persistent running infrastructure to the guild. It implements a `start`/`stop` lifecycle. The Clockworks, Walker, Stacks — all are apparatuses.

```typescript
export default {
  name:     "nexus-clockworks",
  requires: ["nexus-stacks"],
  provides: clockworksApi,

  apparatus: {
    start: (ctx) => {
      const stacks = ctx.plugin<StacksApi>("nexus-stacks")
      clockworksApi.init(stacks)
    },
    stop:   () => clockworksApi.shutdown(),
    health: () => clockworksApi.isHealthy() ? "ok" : "degraded",

    supportKit: {
      relays: [signalRelay, drainRelay],
      tools:  [signalTool, clockStatusTool],
    },
  },
} satisfies Plugin
```

<!-- TODO: explain start/stop lifecycle, supportKit (an apparatus's own kit contributions), provides (the inter-plugin API surface), health reporting. -->

### Arbor and GuildContext

**Arbor** is the runtime object created at guild startup. It reads `guild.json`, imports all declared plugins, validates the dependency graph, and starts each apparatus in dependency-resolved order. Arbor is the natural dependency-injection carrier for the guild runtime — the CLI, MCP server, and daemon each create one Arbor instance at startup and hold it for the session's lifetime.

Each apparatus's `start(ctx)` receives a **GuildContext** — the interface through which apparatus access their dependencies, inspect loaded plugins, and subscribe to lifecycle events:

```typescript
interface GuildContext {
  plugin<T>(name: string): T               // retrieve a dependency's provides object
  kits():        LoadedKit[]               // snapshot of loaded kits
  apparatuses(): LoadedApparatus[]         // snapshot of started apparatuses
  plugins():     LoadedPlugin[]            // union of kits and apparatuses
  on(event: string, handler: fn): void     // subscribe to lifecycle events
}
```

<!-- TODO: explain startup validation (missing required plugins fail loud before any start() runs), dependency ordering, plugin:initialized lifecycle event for reactive kit consumption. -->

### Installation

Plugins are declared in `guild.json` as an ordered list of package names. The framework determines whether each is a kit or apparatus at load time by inspecting the package manifest — no user-side declaration needed.

```json
{
  "plugins": [
    "nexus-stacks",
    "nexus-clockworks",
    "nexus-walker",
    "nexus-sessions",
    "nexus-git"
  ]
}
```

```sh
nsg install nexus-git     # add a plugin
nsg remove  nexus-git     # remove a plugin
nsg status                # show apparatus health + kit inventory
```

`nsg init` populates the default plugin set for a new guild. See [Plugin Architecture](plugins.md) for full detail on the Kit/Apparatus contracts, reactive consumption, startup warnings, and failure modes.

---

---

## The Standard Guild

The plugin architecture described above is general-purpose: any guild can install any combination of kits and apparatus. In practice, nearly every guild uses the same foundational set — the apparatus and kits that `nsg init` installs by default. The sections that follow document this standard configuration.

Each section introduces one or more apparatus or kits from the default set. Understanding that they are plugins — replaceable, independently testable, authored against the same contracts as any community extension — is the main thing §4 provides. The remaining sections don't repeat it.

> **Note:** The list below is provisional. The standard guild configuration is still being finalized as individual apparatus are built out. Treat this as a working inventory, not a commitment.

### Default Apparatus

| Apparatus | Layer | Function |
|-----------|-------|----------|
| **Stacks** | Foundation | Persistence substrate — owns and provides the Books (Register, Ledger, Daybook) backed by SQLite |
| **Guildhall** | Foundation | Configuration and training content access — the charter, installed curricula, temperaments, tool definitions |
| **Clockworks** | Reactive | Event-driven nervous system — standing orders, event queue, the summon relay |
| **Surveyor** | Reactive | Codex knowledge — surveys registered codexes so the guild knows what work applies to each |
| **Clerk** | Obligation | Commission intake and writ lifecycle — receives commissions, creates and manages writs, signals Walker on ready |
| **Manifester** | Session | Anima session assembly — deterministic composition of curriculum, temperament, charter, tool instructions into a session context |
| **Summoner** | Session | AI session lifecycle — launches, monitors, and records anima sessions on behalf of the Executor and Clockworks |
| **Formulary** | Execution | Engine design registry — answers "what engine chain satisfies this need?" from installed kits |
| **Walker** | Execution | Rig lifecycle — spawns, traverses, extends, and strikes rigs as work progresses |
| **Executor** | Execution | Engine runner — executes clockwork and quick engines against a configured substrate |
| **Warden** | Observability | Health aggregation — surfaces apparatus health for `nsg status`; optional |

### Default Kits

| Kit | Contributes |
|-----|-------------|
| **nexus-stdlib** | Base tools (commission-create, tool-install, anima-create, signal, writ/session CRUD, etc.) and the summon relay |
| **nexus-clockworks** (kit portion) | Clockworks tools (clock-start, clock-stop, clock-status, event-list, signal) and the events/dispatches Books |
| **nexus-sessions** (kit portion) | Session tools (session-list, session-show, conversation-list) and the sessions Book |

<!-- TODO: confirm the kit split as individual apparatus are riggified — some current "rigs" (in the code sense) will become apparatus with supportKits once the apparatus model is fully implemented -->

---

## The Books

<!-- TODO: Persistence model. Stacks apparatus; SQLite at .nexus/nexus.db; four Books — Register (who exists), Ledger (what work is happening), Daybook (what happened), Clockworks (event/dispatch operational state). The Book API (arbor.book() / RigContext.rigBook()). Note: Books are owned by apparatus, not the framework — Stacks provides Register/Ledger/Daybook; Clockworks owns its own event tables. Link to schema.md. -->

---

## Animas

<!-- TODO: Identity and composition. An anima = name + curriculum + temperament + role assignments. The Register as persistent identity record. The Roster as active-anima view. Composition model: curriculum (what you know), temperament (who you are) — both versioned, immutable per version. The Manifester assembles them at session time. Anima states: active / retired. Link to forthcoming anima-composition.md. -->

---

## Work Model

<!-- TODO: The obligation pipeline. Commission (patron's request) → Mandate writ (guild's formal record, created by Clerk) → child writs as the guild decomposes the work → Rigs as the execution scaffolding for a writ. Writ lifecycle (ready → active → pending → completed/failed/cancelled). Writ hierarchy and completion rollup. Brief intro to rigs (assembled by Walker from engine designs contributed by kits via Formulary). Link to rigging.md for rig execution detail. -->

---

## Kit Components: Tools, Engines & Relays

<!-- TODO: The three installable artifact types. Tools — instruments animas wield, accessible via MCP / CLI / import, role-gated, optionally ship with instructions.md. Engines — rig workhorses mounted by Walker, clockwork or quick, no role gating. Relays — Clockworks handlers invoked by standing orders via run:, export relay() contract, all clockwork. Descriptor files (nexus-tool.json, nexus-engine.json, nexus-relay.json). Installation via nsg install / tool-install tool. Link to kit-components.md. -->

---

## Sessions

<!-- TODO: The session funnel. Triggered by Clockworks summon relay (standing order) or directly via nsg consult. Manifester assembles context (curriculum + temperament + charter + tool instructions + writ context) → Summoner launches AI process with MCP engine → session runs → Summoner records result in Daybook. The MCP engine: one process per session, all role-gated tools registered, stdio JSON-RPC. Session providers: pluggable AI backend (e.g. claude-code-session-provider). System prompt vs. initial prompt distinction. Sessions run in bare mode (no CLAUDE.md). Link to reference/conversations.md. -->

---

## The Clockworks

<!-- TODO: Event-driven nervous system. Events as immutable persisted facts (not intents). Standing orders as guild policy in guild.json — bind event patterns to relays. The summon verb as sugar for the summon relay. Framework events (automatic, from nexus-core operations) vs. custom guild events (declared in guild.json, signaled by animas via signal tool). The runner: manual (nsg clock tick/run) vs. daemon (nsg clock start). Error handling: standing-order.failed, loop guard. Link to clockworks.md. -->

---

## Core Apparatus Reference

<!-- TODO: Quick-reference table of all standard apparatus — name, package, layer, what it provides, links to detailed docs where they exist. Covers the same set as the table in "The Standard Guild" section but with package names, API surface hints, and links. -->


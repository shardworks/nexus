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
  │  │  Stacks (persistence)                                 │  │
  │  ├───────────────────────────────────────────────────────┤  │
  │  │  Clockworks · Surveyor · Clerk                        │  │
  │  ├───────────────────────────────────────────────────────┤  │
  │  │  Walker · Formulary · Executor                        │  │
  │  │  Manifester · Summoner                                │  │
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

### The Apparatus

The guild's operational fabric is provided by apparatus — plugins with a start/stop lifecycle that Arbor starts in dependency order. **The Stacks** is the persistence substrate everything else reads from and writes to. **The Clockworks** is the event-driven nervous system: standing orders bind events to relays, and the summon relay dispatches anima sessions in response. **The Surveyor** tracks what work applies to each registered codex. **The Clerk** handles commission intake, converting patron requests into writs and signaling when work is ready to execute. The Formulary, Walker, Executor, Manifester, and Summoner then take it from there — covered in the next section.

Each of these is a plugin from the default set, not a built-in. The [Standard Guild](#the-standard-guild) section lists them; the sections that follow document each in detail.

### Execution, Sessions, and Works

When The Clerk signals a writ is ready, **The Walker** spawns a rig and begins driving it: traversing active engines, dispatching those whose upstream work is complete, and extending the rig by querying **The Formulary** for engine chains that satisfy declared needs. **The Executor** runs each engine — clockwork engines run their code directly; quick engines launch an anima session.

An anima session is an AI process running against an MCP server loaded with the role's tools. Before launch, **The Manifester** assembles the session context: system prompt, tool instructions, writ context. **The Summoner** then starts the process, monitors it, and records the result. The session exits; the output persists. The Clockworks can also trigger sessions directly via the summon relay, bypassing the rig machinery entirely — The Summoner handles both paths the same way.

Session output is concrete: modified files committed to a git branch, new documents written to disk, structured data passed as engine yield to downstream steps. When a rig completes, any pending git work is merged, and the result is whatever the patron commissioned — a working feature, a fixed bug, a written report. The patron's codexes are updated; the patron can pull, deploy, and use them.

---

## The Guild Root

A guild is a directory — a regular git repository with a `guild.json` at its root. The framework discovers the guild root the same way git discovers `.git/`: by walking up from the current working directory until it finds `guild.json`. The `--guild-root` flag overrides this for explicit invocation.

### Directory Structure

```
GUILD_ROOT/
  guild.json                    ← central configuration (versioned)
  package.json                  ← npm package; plugins are npm dependencies
  package-lock.json
  node_modules/                 ← gitignored; plugin code lives here
  <guild content>/              ← versioned guild files (roles/, training/,
                                   tools/, engines/, etc.) — structure is
                                   guild-specific, not framework-prescribed
  .nexus/                       ← runtime state, gitignored
    nexus.db                    ← persistence database (SQLite)
    clock.pid                   ← Clockworks daemon PID
    clock.log                   ← Clockworks daemon log
    sessions/                   ← per-session working files
    workshops/                  ← bare git clones of registered workshops
    worktrees/                  ← git worktrees for active commissions
```

The versioned files — `guild.json`, `package.json`, and the guild's own content — are the guild's identity. `.nexus/` is operational territory: it can be deleted and rebuilt without losing configuration. Nothing in `.nexus/` is committed; everything that matters is in the versioned files.

### `guild.json`

`guild.json` is the guild's central configuration file. Arbor reads it at startup; nothing in the guild system runs without it. It has a small number of framework-level keys that Arbor reads directly, plus any number of **plugin configuration sections** — top-level keys owned by individual plugins, keyed by their derived plugin id.

```json
{
  "name": "my-guild",
  "nexus": "0.1.x",
  "plugins": ["books", "clockworks", "sessions", "..."],
  "settings": {
    "model": "claude-opus-4-5"
  },

  "clockworks": {
    "events": {
      "craft.question": { "description": "An artificer hit a decision outside commission scope." }
    },
    "standingOrders": [
      { "on": "writ.ready",            "run": "workshop-prepare" },
      { "on": "writ.workspace-ready",  "summon": "artificer", "prompt": "..." },
      { "on": "writ.completed",        "run": "workshop-merge" }
    ]
  }
}
```

#### Framework keys

**`name`** — the guild's identifier, used as the npm package name for the guild's own content package.

**`nexus`** — the installed framework version. Written by `nsg init` and `nsg upgrade`; not edited by hand.

**`plugins`** — ordered list of installed plugin ids. Arbor loads them in this order, respecting the dependency graph. `nsg install` and `nsg remove` manage this list. Starts empty on `nsg init`; the standard guild adds the default set.

**`settings`** — operational configuration. Currently holds `model` (the default LLM model for anima sessions) and `autoMigrate` (whether to apply database migrations automatically on startup).

#### Plugin configuration

All remaining top-level keys are plugin configuration sections, keyed by derived plugin id (see [Plugin IDs](#plugin-ids)). Each apparatus reads its own section via `ctx.config()` at startup or handler invocation time.

In the standard guild, `clockworks` contains events and standing orders; `workshops` tracks registered repositories; `roles` and `baseTools` define anima role assignments and tool access. These are all plugin config — not framework-owned fields — they just get natural top-level keys because of the `@shardworks/` naming convention. See [Configuration](plugins.md#configuration) for the full model.

### Runtime State (`.nexus/`)

`.nexus/` is entirely gitignored. It is created on first run and can be deleted safely — the guild will rebuild it from `guild.json` and the versioned content files.

**`nexus.db`** — the SQLite database owned by The Stacks. All guild state that needs to survive process restarts lives here: anima records, writ history, session records, event and dispatch logs.

**`clock.pid` / `clock.log`** — daemon bookkeeping for The Clockworks. `clock.pid` holds the PID of the running daemon process; `clock.log` is its output. Both are absent when the daemon is not running.

**`sessions/`** — working files for active and recently-completed sessions. Each session gets a JSON record here at launch; The Summoner writes the result back when the session exits.

**`workshops/`** — bare git clones of every registered workshop, named `<workshop-name>.git`. Git worktrees are checked out from these clones rather than from the remotes directly, keeping network operations to `fetch` calls rather than repeated clones.

**`worktrees/`** — git worktrees for active commissions. Each commission that requires file changes gets a dedicated worktree here, isolated from other concurrent work. Worktrees are created when a commission's workspace is prepared and removed when the work is merged or abandoned.

---

## Plugin Architecture

The apparatus described in §2 — The Stacks, The Clockworks, The Clerk, The Walker, and the rest — are all plugins. There is no privileged built-in layer. Arbor, the guild runtime, is only a plugin loader, a dependency graph, and the startup/shutdown lifecycle for what gets loaded. Every piece of operational infrastructure is contributed by a plugin package; the standard guild is simply a particular set of those packages.

Plugins come in two kinds: **kits** and **apparatus**. This section introduces them; [Plugin Architecture](plugins.md) is the full specification.

### Kit

A **kit** is a passive package contributing capabilities to the guild. Kits have no lifecycle — they are read at load time and their contributions are forwarded to consuming apparatus. Nothing about a kit participates in `start`/`stop` or requires a running system.

```typescript
// @shardworks/nexus-git — a kit contributing git-related tools, engines, and relays
export default {
  kit: {
    requires:   ["books"],
    recommends: ["clockworks", "walker"],
    engines: [createBranchEngine, mergeBranchEngine],
    relays:  [onMergeRelay],
    tools:   [statusTool, diffTool],
  },
} satisfies Plugin
```

A kit is an **open record**: the contribution fields (`engines`, `relays`, `tools`, etc.) are defined by the apparatus packages that consume them, not by the framework. The framework only reads `requires` (hard dependency on an apparatus — validated at startup) and `recommends` (advisory — generates a startup warning if absent). Everything else is forwarded opaquely to consuming apparatus via the `plugin:initialized` lifecycle event.

Type safety for contribution fields is opt-in — each apparatus publishes a kit interface (`ClockworksKit`, `WalkerKit`, etc.) that kit authors can import and `satisfies` against.

### Apparatus

An **apparatus** is a package contributing persistent running infrastructure. It has a `start`/`stop` lifecycle, may declare dependencies on other apparatus, and may expose a runtime API.

```typescript
// @shardworks/clockworks — the guild's event-driven nervous system
const clockworksApi: ClockworksApi = { ... }

export default {
  apparatus: {
    requires: ["books"],
    provides: clockworksApi,

    start: (ctx) => {
      const books = ctx.apparatus<BooksApi>("books")
      clockworksApi.init(books)
    },
    stop: () => clockworksApi.shutdown(),

    supportKit: {
      relays: [signalRelay, drainRelay],
      tools:  [signalTool, clockStatusTool],
    },

    consumes: ["relays"],
  },
} satisfies Plugin
```

**`requires`** declares apparatus that must be started first — validated at startup, determines start ordering. **`provides`** is the runtime API other plugins retrieve via `ctx.apparatus<T>(name)`. **`supportKit`** is the apparatus's own kit contributions (tools, relays, etc.) — treated identically to standalone kit contributions by consumers. **`consumes`** declares which kit contribution types this apparatus scans for, enabling startup warnings when kits contribute types no apparatus consumes.

### Plugin IDs

Plugin names are never declared in the manifest — they are derived from the npm package name at load time:

1. Strip the `@shardworks/` scope (the official Nexus namespace)
2. Retain other scopes as a prefix without `@` (`@acme/foo` → `acme/foo`)
3. Strip a trailing `-(plugin|apparatus|kit)` suffix

So `@shardworks/clockworks` → `clockworks`, `@shardworks/books-apparatus` → `books`, `@acme/cache-kit` → `acme/cache`. Plugin ids are used in `requires` arrays, `ctx.apparatus()` calls, and as the key for plugin-specific configuration in `guild.json`. See [Plugin IDs](plugins.md#plugin-ids) for the full derivation table.

### Arbor and Contexts

**Arbor** is the runtime object. It reads `guild.json`, imports all declared plugins, validates the dependency graph, and starts each apparatus in dependency-resolved order. The CLI, MCP server, and Clockworks daemon each create one Arbor instance at startup; it lives for the process's lifetime.

Each apparatus's `start(ctx)` receives a **GuildContext**. Tool and engine handlers receive a **HandlerContext** at invocation time. Both expose the same core methods:

```typescript
interface GuildContext {
  home:       string                                        // guild root path
  config<T>(pluginId?: string): T                           // plugin config from guild.json
  guildConfig(): GuildConfigV2                               // full guild.json (escape hatch)
  apparatus<T>(name: string): T                              // retrieve a dependency's API
  kits():        LoadedKit[]                                 // snapshot of loaded kits
  apparatuses(): LoadedApparatus[]                           // snapshot of started apparatus
  plugins():     LoadedPlugin[]                              // union of kits and apparatus
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void
}

interface HandlerContext {
  home:       string
  config<T>(pluginId?: string): T
  guildConfig(): GuildConfigV2
  apparatus<T>(name: string): T
}
```

**`ctx.apparatus()`** is validated against the calling plugin's `requires` — calling it for an undeclared dependency fails at startup, not at runtime. **`ctx.config()`** returns the plugin's configuration section from `guild.json` (or another plugin's, if a plugin id is passed). **`ctx.guildConfig()`** returns the full parsed config for cases where framework-level fields (`roles`, `workshops`, `settings`) are needed directly. See [Configuration](plugins.md#configuration) for detail.

Startup validation is strict: missing dependencies, undeclared `ctx.apparatus()` calls, and circular dependency graphs all fail loudly before any apparatus starts. Kit contributions are forwarded to consuming apparatus reactively via the `plugin:initialized` lifecycle event, ensuring load-order independence. See [Plugin Architecture](plugins.md) for the full specification.

### Installation

Plugins are listed in `guild.json` by their plugin id. The framework determines whether each is a kit or apparatus at load time from the package manifest — no user-side declaration needed.

```json
{
  "plugins": ["books", "clockworks", "walker", "sessions", "nexus-git"]
}
```

```sh
nsg install nexus-git     # add a plugin
nsg remove  nexus-git     # remove a plugin
nsg status                # show apparatus health + kit inventory
```

`nsg init` populates the default plugin set for a new guild.

---

## The Standard Guild

The plugin architecture described above is general-purpose: any guild can install any combination of kits and apparatus. In practice, nearly every guild uses the same foundational set — the apparatus and kits that `nsg init` installs by default. The sections that follow document this standard configuration.

Each section introduces one or more apparatus or kits from the default set. Understanding that they are plugins — replaceable, independently testable, authored against the same contracts as any community extension — is the main thing §4 provides. The remaining sections don't repeat it.

### Default Apparatus

| Apparatus | Plugin id | Function |
|-----------|-----------|----------|
| **The Stacks** | `books` | Persistence substrate — SQLite-backed document store and change-data-capture events |
| **The Clockworks** | `clockworks` | Event-driven nervous system — standing orders, event queue, the summon relay |
| **The Surveyor** | `surveyor` | Codex knowledge — surveys registered codexes so the guild knows what work applies to each |
| **The Clerk** | `clerk` | Commission intake and writ lifecycle — receives commissions, creates writs, signals when work is ready |
| **The Manifester** | `manifester` | Anima session assembly — deterministic composition of curriculum, temperament, charter, tool instructions |
| **The Summoner** | `summoner` | AI session lifecycle — launches, monitors, and records anima sessions |
| **The Formulary** | `formulary` | Engine design registry — answers "what engine chain satisfies this need?" from installed kits |
| **The Walker** | `walker` | Rig lifecycle — spawns, traverses, extends, and strikes rigs as work progresses |
| **The Executor** | `executor` | Engine runner — executes clockwork and quick engines against a configured substrate |

### Default Kits

| Kit | Contributes |
|-----|-------------|
| **nexus-stdlib** | Base tools (commission-create, tool-install, anima-create, signal, writ/session CRUD, etc.) and the summon relay |
| **clockworks** (supportKit) | Clockworks tools (clock-start, clock-stop, clock-status, event-list, signal) |
| **sessions** (supportKit) | Session tools (session-list, session-show, conversation-list) |

> **Note:** The list above is provisional. The standard guild configuration is still being finalized as individual apparatus are built out. Some entries listed as apparatus are not yet implemented as separate packages — see [What's Implemented vs. Aspirational](_agent-context.md#whats-implemented-vs-aspirational) for the current state. Treat this as a working inventory, not a commitment.

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


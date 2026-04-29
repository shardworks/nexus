# Nexus Architecture

**Nexus** is a framework for running an autonomous workforce of *animas* — AI agents who produce work in service of a guild, which ultimately delivers those works to a human patron. This is a technical document which describes the system itself — the structures, concepts, and machinery that any guild requires. It is meant to assist Nexus developers in their work, or provide users deeper insight into the workings of their guild. It is not intended as a general user guide for people who just want to run a guild.

For the conceptual vocabulary — what guilds, animas, commissions, writs, and apparatus *are* in the abstract — read [The Guild Metaphor](../guild-metaphor.md) first. This document describes how those concepts are implemented.

---

## System at a Glance

> This section describes the **standard guild** — the curated baseline the rest of this document assumes. The framework itself is a plugin loader; every apparatus named below is part of that baseline, not a hard requirement, and the baseline itself is assembled by installing plugins after `nsg init` rather than shipped automatically. §4 ([Plugin Architecture](#plugin-architecture)) explains the underlying model; the [Standard Guild](#the-standard-guild) section catalogues what the baseline includes.

A Nexus guild is a git repository with a `guild.json` at its root and a `.nexus/` directory holding runtime state. When the system starts, **Arbor** — the guild runtime — reads `guild.json`, loads the declared plugins, validates their dependencies, and starts each apparatus in order. From that point, the guild operates: the patron commissions work; **The Clerk** receives it and issues writs; **The Spider** assembles rigs and drives their engines to completion; **The Clockworks** turns events into action, activating relays in response to standing orders; and **anima sessions** — AI processes launched by **The Animator** — do the work that requires judgment. Results land in codexes and documents; the patron consumes what the guild delivers.

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
  │  │  Spider · Fabricator · Executor                        │  │
  │  │  Loom · Animator                                      │  │
  │  └─────────────────────────┬─────────────────────────────┘  │
  │                            │                                 │
  │  Anima Sessions  ◄─────────┘                                │
  │  AI process · MCP server · permission-gated tools                 │
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

Arbor is the guild runtime. Its single entry point, `createGuild()`, reads `guild.json`, imports every declared plugin, validates the dependency graph, starts each apparatus in dependency order, and wires the `guild()` singleton. It is not a persistent server or a central process — it is a library that each entry point (the CLI, the MCP server, the Clockworks daemon) calls once at startup. There is no Arbor "service" to connect to; the `Guild` object it returns is alive for as long as the process that created it is running.

Arbor's scope is deliberately narrow: plugin loading, dependency validation, and apparatus lifecycle. It does not own tool discovery (that belongs to The Instrumentarium), persistence (that belongs to The Stacks), or any CLI commands.

### The CLI

The `nsg` command is the patron's and operator's entry point into the guild. It has two layers of commands:

**Framework commands** are defined in the CLI package itself — guild lifecycle (`init`, `status`, `version`, `upgrade`) and plugin management (`plugin list/install/remove`). These are always available, even without a guild.

**Plugin tools** are discovered dynamically from **The Instrumentarium** (the `tools` apparatus). At startup, the CLI calls `createGuild()` to boot the runtime, then queries the Instrumentarium for all installed tools that are CLI-callable. Each tool's Zod param schema is auto-converted to Commander flags. This means the plugin tool surface grows automatically as plugins are installed — `nsg --help` always reflects exactly what's available.

Tool names are auto-grouped by hyphen prefix — `session-list` and `session-show` become `nsg session list` and `nsg session show`.

Two additional commands bypass the tool registry: `nsg consult` and `nsg convene` (interactive sessions with streaming output — not simple tool invocations). These are built into the v1 CLI and will migrate when the Animator and Parlour expose the necessary APIs.

### The Apparatus

The guild's operational fabric is provided by apparatus — plugins with a start/stop lifecycle that Arbor starts in dependency order. **The Stacks** is the persistence substrate everything else reads from and writes to. **The Scriptorium** manages codexes — bare clones, draft bindings (worktrees), and the seal-and-push lifecycle. **The Clockworks** is the event-driven nervous system: standing orders bind events to relays, and the summon relay dispatches anima sessions in response. **The Surveyor** is the cartograph-decomposition substrate: it surveys cartograph nodes (visions, charges, pieces), produces structural decompositions, and routes each node to whichever kit-contributed surveyor claims its node-type — see [Surveying Cascade](surveying-cascade.md) for the contract. **The Clerk** handles commission intake, converting patron requests into writs and signaling when work is ready to execute. The Fabricator, Spider, Executor, Loom, and Animator then take it from there — covered in the next section.

Each of these is a plugin from the default set, not a built-in. The [Standard Guild](#the-standard-guild) section lists them; the sections that follow document each in detail.

### Execution, Sessions, and Works

When The Clerk signals a writ is ready, **The Spider** spawns a rig and begins driving it: traversing active engines, dispatching those whose upstream work is complete, and extending the rig by querying **The Fabricator** for engine chains that satisfy declared needs. **The Executor** runs each engine — clockwork engines run their code directly; quick engines launch an anima session.

An anima session is an AI process running against an MCP server loaded with the role's tools. Before launch, **The Loom** weaves the session context: system prompt, tool instructions, writ context. **The Animator** then starts the process, monitors it, and records the result. The session exits; the output persists. The Clockworks can also trigger sessions directly via the summon relay, bypassing the rig machinery entirely — The Animator handles both paths the same way.

Session output is concrete: modified files committed to a git branch, new documents written to disk, structured data passed as engine yields to downstream steps. When a rig completes, any pending git work is merged, and the result is whatever the patron commissioned — a working feature, a fixed bug, a written report. The patron's codexes are updated; the patron can pull, deploy, and use them.

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
    codexes/                    ← bare git clones of registered codexes
    worktrees/                  ← git worktrees for active draft bindings
```

The versioned files — `guild.json`, `package.json`, and the guild's own content — are the guild's identity. `.nexus/` is operational territory: it can be deleted and rebuilt without losing configuration. Nothing in `.nexus/` is committed; everything that matters is in the versioned files.

### `guild.json`

`guild.json` is the guild's central configuration file. Arbor reads it at startup; nothing in the guild system runs without it. It has a small number of framework-level keys that Arbor reads directly, plus any number of **plugin configuration sections** — top-level keys owned by individual plugins, keyed by their derived plugin id.

```json
{
  "name": "my-guild",
  "nexus": "0.1.x",
  "plugins": ["stacks", "clockworks", "sessions", "..."],
  "settings": {
    "model": "claude-opus-4-5"
  },

  "clockworks": {
    "events": {
      "craft.question": { "description": "An artificer hit a decision outside commission scope." }
    },
    "standingOrders": [
      { "on": "writ.ready",            "run": "draft-prepare" },
      { "on": "writ.workspace-ready",  "summon": "artificer", "prompt": "..." },
      { "on": "writ.completed",        "run": "draft-seal" }
    ]
  }
}
```

#### Framework keys

**`name`** — the guild's identifier, used as the npm package name for the guild's own content package.

**`nexus`** — the installed framework version. Written by `nsg init` and `nsg upgrade`; not edited by hand.

**`plugins`** — ordered list of installed plugin ids. Arbor loads them in this order, respecting the dependency graph. `nsg install` and `nsg remove` manage this list. Starts empty on `nsg init`; the standard guild is assembled afterward by installing each plugin listed in [The Standard Guild](#the-standard-guild).

**`settings`** — operational configuration. Currently holds `model` (the default LLM model for anima sessions) and `autoMigrate` (whether to apply database migrations automatically on startup).

#### Plugin configuration

All remaining top-level keys are plugin configuration sections, keyed by derived plugin id (see [Plugin IDs](#plugin-ids)). Each plugin reads its own section via `guild().config(pluginId)` at startup or handler invocation time.

In the standard guild, `clockworks` contains events and standing orders; `codexes` tracks registered repositories and draft settings; `loom` holds role definitions and permission grants. These are all plugin config — not framework-owned fields — they get natural short keys because of the `@shardworks/` naming convention and `-(plugin|apparatus|kit)` suffix stripping (e.g. `@shardworks/tools-apparatus` → `tools`). See [Configuration](plugins.md#configuration) for the full model.

### Runtime State (`.nexus/`)

`.nexus/` is entirely gitignored. It is created on first run and can be deleted safely — the guild will rebuild it from `guild.json` and the versioned content files.

**`nexus.db`** — the SQLite database owned by The Stacks. All guild state that needs to survive process restarts lives here: anima records, writ history, session records, event and dispatch logs.

**`clock.pid` / `clock.log`** — daemon bookkeeping for The Clockworks. `clock.pid` holds the PID of the running daemon process; `clock.log` is its output. Both are absent when the daemon is not running.

**`sessions/`** — working files for active and recently-completed sessions. Each session gets a JSON record here at launch; The Animator writes the result back when the session exits.

**`codexes/`** — bare git clones of every registered codex, named `<codex-name>.git`. Managed by The Scriptorium. Draft worktrees are checked out from these clones rather than from the remotes directly, keeping network operations to `fetch` calls rather than repeated clones.

**`worktrees/`** — git worktrees for active draft bindings. Each draft gets a dedicated worktree here, isolated from other concurrent work. Drafts are opened when work begins and sealed or abandoned when the work completes. See [The Scriptorium](apparatus/scriptorium.md).

---

## Plugin Architecture

The apparatus described in §2 — The Stacks, The Clockworks, The Clerk, The Spider, and the rest — are all plugins. There is no privileged built-in layer. Arbor, the guild runtime, is only a plugin loader, a dependency graph, and the startup/shutdown lifecycle for what gets loaded — startup walks the apparatus dependency graph in topological order calling each `start()`, and shutdown (driven by `StartedGuild.shutdown()`, exposed to the bootstrap caller of `createGuild()`) walks the same graph in reverse calling each `stop()`. Every piece of operational infrastructure is contributed by a plugin package; the standard guild is simply a particular set of those packages.

Plugins come in two kinds: **kits** and **apparatus**. This section introduces them; [Plugin Architecture](plugins.md) is the full specification.

### Kit

A **kit** is a passive package contributing capabilities to the guild. Kits have no lifecycle — they are read at load time and their contributions are forwarded to consuming apparatus. Nothing about a kit participates in `start`/`stop` or requires a running system.

```typescript
// @shardworks/nexus-git — a kit contributing git-related tools, engines, and relays
export default {
  kit: {
    requires:   ["stacks"],
    recommends: ["clockworks", "spider"],
    engines: [createBranchEngine, mergeBranchEngine],
    relays:  [onMergeRelay],
    tools:   [statusTool, diffTool],
  },
} satisfies Plugin
```

A kit is an **open record**: the contribution fields (`engines`, `relays`, `tools`, etc.) are defined by the apparatus packages that consume them, not by the framework. The framework only reads `requires` (hard dependency on an apparatus — validated at startup) and `recommends` (advisory — generates a startup warning if absent). Everything else is available to consuming apparatus via the `apparatus:started` lifecycle event (or read eagerly from `ctx.kits()` at start time).

Type safety for contribution fields is opt-in — each apparatus publishes a kit interface (`ClockworksKit`, `SpiderKit`, etc.) that kit authors can import and `satisfies` against.

### Apparatus

An **apparatus** is a package contributing persistent running infrastructure. It has a `start`/`stop` lifecycle, may declare dependencies on other apparatus, and may expose a runtime API.

```typescript
// @shardworks/clockworks-apparatus — the guild's event-driven nervous system
const clockworksApi: ClockworksApi = { ... }

export default {
  apparatus: {
    requires: ["stacks"],
    provides: clockworksApi,

    start: (ctx) => {
      const stacks = guild().apparatus<StacksApi>("stacks")
      clockworksApi.init(stacks)
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

**`requires`** declares apparatus that must be started first — validated at startup, determines start ordering. **`provides`** is the runtime API other plugins retrieve via `guild().apparatus<T>(name)`. **`supportKit`** is the apparatus's own kit contributions (tools, relays, etc.) — treated identically to standalone kit contributions by consumers. **`consumes`** declares which kit contribution types this apparatus scans for, enabling startup warnings when kits contribute types no apparatus consumes.

### Plugin IDs

Plugin names are never declared in the manifest — they are derived from the npm package name at load time:

1. Strip the `@shardworks/` scope (the official Nexus namespace)
2. Retain other scopes as a prefix without `@` (`@acme/foo` → `acme/foo`)
3. Strip a trailing `-(plugin|apparatus|kit)` suffix

So `@shardworks/clockworks-apparatus` → `clockworks`, `@shardworks/stacks-apparatus` → `stacks`, `@acme/cache-kit` → `acme/cache`. Plugin ids are used in `requires` arrays, `guild().apparatus()` calls, and as the key for plugin-specific configuration in `guild.json`. See [Plugin IDs](plugins.md#plugin-ids) for the full derivation table.

### Arbor and Contexts

**Arbor** is the runtime object. It reads `guild.json`, imports all declared plugins, validates the dependency graph, and starts each apparatus in dependency-resolved order. The CLI, MCP server, and Clockworks daemon each create one Arbor instance at startup; it lives for the process's lifetime.

All plugin code — apparatus `start()`, tool handlers, CDC handlers — accesses guild infrastructure through the **`guild()` singleton** from `@shardworks/nexus-core`. It provides access to apparatus APIs, plugin config, the guild root path, and the loaded plugin graph. Apparatus `start(ctx)` additionally receives a **`StartupContext`** for subscribing to lifecycle events via `ctx.on()`.

Startup validation is strict: missing dependencies and circular dependency graphs fail loudly before any apparatus starts. Kit contributions are available to consuming apparatus via `ctx.kits()` at start time and reactively via the `apparatus:started` lifecycle event. See [Plugin Architecture](plugins.md) for the full specification, including the [guild() singleton](plugins.md#the-guild-accessor), [StartupContext](plugins.md#startupcontext), and [Configuration](plugins.md#configuration).

### Installation

Plugins are listed in `guild.json` by their plugin id. The framework determines whether each is a kit or apparatus at load time from the package manifest — no user-side declaration needed.

```json
{
  "plugins": ["stacks", "clockworks", "spider", "sessions", "nexus-git"]
}
```

```sh
nsg install nexus-git     # add a plugin
nsg remove  nexus-git     # remove a plugin
nsg status                # show apparatus health + kit inventory
```

`nsg init` writes an empty `plugins` array; the standard guild is assembled afterward by installing each plugin listed in [The Standard Guild](#the-standard-guild).

---

## The Standard Guild

The plugin architecture described above is general-purpose: any guild can install any combination of kits and apparatus. In practice, nearly every guild starts from the same foundational set — the apparatus catalogued below. The sections that follow treat this curated baseline as the working assumption.

Each section introduces one or more apparatus or kits from the default set. Understanding that they are plugins — replaceable, independently testable, authored against the same contracts as any community extension — is the main thing §4 provides. The remaining sections don't repeat it.

### Default Apparatus

| Apparatus | Plugin id | Function |
|-----------|-----------|----------|
| **[The Stacks](apparatus/stacks.md)** | `stacks` | Persistence substrate — SQLite-backed document store with change-data-capture events |
| **[The Scriptorium](apparatus/scriptorium.md)** | `codexes` | Codex management — repository registry, bare clones, draft binding lifecycle, sealing and push |
| **[The Clerk](apparatus/clerk.md)** | `clerk` | Commission intake and writ lifecycle — receives commissions, creates writs, signals when work is ready |
| **[The Clockworks](clockworks.md)** | `clockworks` | Event-driven nervous system — binds events to relays via standing orders; the summon relay dispatches anima sessions |
| **[The Ratchet](apparatus/ratchet.md)** | `ratchet` | Decision tracking — manages the click tree of questions and conclusions guiding the guild's reasoning |
| **[The Fabricator](apparatus/fabricator.md)** | `fabricator` | Engine design registry — answers "what engine chain satisfies this need?" from installed kits |
| **[The Spider](apparatus/spider.md)** | `spider` | Rig lifecycle — spawns, traverses, extends, and strikes rigs as work progresses |
| **[The Loom](apparatus/loom.md)** | `loom` | Session context composition — weaves role instructions, tool instructions, curricula, and temperaments into a session context |
| **[The Instrumentarium](apparatus/instrumentarium.md)** | `tools` | Tool registry — resolves installed tools into permission-gated tool sets |
| **[The Animator](apparatus/animator.md)** | `animator` | Session lifecycle — launches, monitors, and records anima sessions |
| **[Claude Code](apparatus/claude-code.md)** | `claude-code` | Session provider — launches Claude Code CLI processes and parses their structured telemetry |
| **[The Parlour](apparatus/parlour.md)** | `parlour` | Conversation orchestration — drives `nsg consult` and `nsg convene` across multiple turns |

The Surveyor is anticipated as the planned `surveyor` package — the cartograph-decomposition substrate described in [Surveying Cascade](surveying-cascade.md), landing in a separate commission. The Executor is described elsewhere in this document as part of the guild's operational fabric, but is not yet extracted as a standalone package.

### Opt-in Apparatus

Some opt-ins form coherent stacks that only make sense when installed together — notably the notifications stack (`lattice` + `sentinel` + `lattice-discord`), which observes guild activity and fans pulses out to external channels.

| Apparatus | Plugin id | Function |
|-----------|-----------|----------|
| **[The Astrolabe](apparatus/astrolabe.md)** | `astrolabe` | Plan-and-ship pipeline — turns patron briefs into structured specs and drives them through implementation |
| **[The Copilot](apparatus/copilot.md)** | `copilot` | Alternate session provider — launches sessions via the GitHub Models API |
| **[The Lattice](apparatus/lattice.md)** | `lattice` | Notification substrate — part of the opt-in notifications stack |
| **The Lattice-Discord** | `lattice-discord` | Discord channel for Lattice pulses — part of the opt-in notifications stack |
| **The Oculus** | `oculus` | Web dashboard — serves an HTTP dashboard with kit-contributed pages and routes |
| **[The Sentinel](apparatus/sentinel.md)** | `sentinel` | Stall, failure, and drain observer — part of the opt-in notifications stack |
| **[The Reckoner](apparatus/reckoner.md)** | `reckoner` | Petitioner-scheduler contract surface — kit-static petitioner registry and `petition()` / `withdraw()` helpers |

Today the default apparatus each contribute their own supportKits (tools, engines, relays); no standalone default kits ship.

> **Note:** The Standard Guild above is a curated documentation baseline. `nsg init` does not auto-install these plugins today — install each with `nsg plugin install` after initializing a new guild.

---

## The Stacks

**The Stacks** (plugin id: `stacks`) is the guild's persistence layer — a document store backed by SQLite at `.nexus/nexus.db`, with change data capture (CDC) as its primary integration mechanism.

### Document Model

The Stacks stores JSON documents in named collections called **books**. Every document must include an `id: string` field; the framework adds nothing else — no envelopes, timestamps, or revision tracking. Domain types own their own fields.

Plugins declare the books they need via a `books` contribution field in their kit export:

```typescript
export default {
  kit: {
    requires: ['stacks'],
    books: {
      writs:    { indexes: ['status', 'createdAt', 'parent.id'] },
      sessions: { indexes: ['writId', 'startedAt', 'animaId'] },
    },
  },
} satisfies Plugin
```

The Stacks reads these declarations at startup and creates or reconciles the backing tables. Startup-time schema reconciliation is additive only — new books and indexes are safe; kit contributions cannot remove a book, and nothing is dropped implicitly from kit declarations alone. Whole-book retirement is a separate, explicit imperative path: `StacksApi.dropBook(ownerId, bookName)` is the sanctioned way to retire a book at runtime, and it is never invoked implicitly from kit declarations.

### API Surface

Plugins access persistence through `guild().apparatus<StacksApi>('stacks')`, which exposes five methods:

- **`book<T>(ownerId, name)`** — returns a writable handle for the named book. Supports `put()` (upsert), `patch()` (top-level field merge), `delete()`, and the full read API (`get`, `find`, `list`, `count`). Queries support equality, range, pattern matching (`LIKE`), set membership (`IN`), null checks, multi-field sorting, and offset/limit pagination.

- **`readBook<T>(ownerId, name)`** — returns a read-only handle for another plugin's book. Cross-plugin writes are not supported; they go through the owning plugin's tools.

- **`watch(ownerId, bookName, handler, options?)`** — registers a CDC handler that fires on every write to the named book. CDC events carry the document's previous state (`prev`) for updates and deletes, enabling diff-based logic.

- **`transaction(fn)`** — executes a function within an atomic transaction. All writes inside `fn` commit or roll back together. Reads inside the transaction see uncommitted writes (read-your-writes).

- **`dropBook(ownerId, bookName)`** — imperatively retires a book at runtime. Drops the underlying storage, fires a single Phase 2 `delete-book` CDC event, and is idempotent (silent no-op when the book is missing). Refuses to run inside an active `transaction(...)` — DDL is hard-separated from DML. Never invoked implicitly from kit declarations.

### Change Data Capture

All writes go through The Stacks API — there is no raw SQL escape hatch. This is what makes CDC reliable: if the API is the only write path, the event stream is complete.

CDC handlers execute in two phases:

**Phase 1 (cascade)** — runs inside the transaction, before commit. The handler's writes join the same atomic unit. If the handler throws, everything rolls back — the triggering write, the handler's writes, and all nested cascades. This is the correct phase for maintaining referential integrity (e.g. cancelling child writs when a parent is cancelled).

**Phase 2 (notification)** — runs after the transaction commits. Data is already persisted. Handler failures are logged as warnings but cannot affect committed data. This is the correct phase for external notifications like Clockworks event emission.

Within a transaction, multiple writes to the same document are coalesced into a single CDC event reflecting the net change. External observers never see intermediate states.

### Backend

The Stacks depends on a `StacksBackend` interface, not SQLite directly. The default implementation uses SQLite via `better-sqlite3`; alternative backends (in-memory for tests, libSQL for edge) implement the same interface. No SQLite types leak into the public API.

See [The Stacks — API Contract](apparatus/stacks.md) for the full specification: complete type signatures, query language, transaction semantics, coalescing rules, use case coverage matrix, and backend interface.

---

## Patterns

Cross-cutting conventions used across multiple apparatus. These are not features of any one apparatus but shared idioms consumers should recognize.

### Plugin-keyed slots on writs: `ext` vs `status`

Writs carry two plugin-keyed metadata slots. The Clerk owns the slots themselves; individual plugins own a sub-key under each, identified by their plugin id. Both slots are sub-key-namespaced — multiple plugins may co-stamp on the same writ without colliding, and the read-modify-write APIs (`setWritExt` / `setWritStatus`) preserve sibling sub-keys under concurrent writers.

- **`writ.ext[plugin]`** — data the writ *carries*. Declared at write time; may evolve via `clerk.setWritExt(writId, plugin, value)`. Conceptually part of the writ's identity.
- **`writ.status[plugin]`** — the substrate's *observations about* the writ. Stamped post-hoc via `clerk.setWritStatus(writId, plugin, value)`. A sibling annotation, not part of the writ's identity.

**Choosing which slot:**

- If the data is something the writ *is* — its current configuration, its provenance, its ladder-layer state — use **`ext`**.
- If the data is something the substrate *learned about* the writ — its outcome, its observed behavior, its measured state — use **`status`**.

**Examples:**

| Slot | Use |
|---|---|
| `ext['cartograph']` on vision/charge/piece writs | `{ stage }` — the writ's current ladder phase |
| `ext['surveyor']` on cartograph writs | Patron- / rig-supplied priority hints (`severity`, `deadline`, `decay`, `complexity`) |
| `ext['surveyor']` on survey writs | Registration-time provenance (`rigVersion`, `surveyorId`) |
| `status['surveyor']` on survey writs | Survey outcome and per-completion observations stamped at termination |

**When to use neither.** The Clerk's canonical fields — `type`, `parentId`, `body`, `phase`, `resolvedAt`, `createdAt`, `updatedAt`, `codex` — are the source of truth for those concerns. Don't duplicate them in `ext`/`status`; letting them drift creates a coordination liability. The cartograph slot-cleanup dropped `targetNodeId`, `rigName`, and `completedAt` from the survey-writ envelope for exactly this reason — each was a parallel name for a Clerk-canonical field.

The pattern is not limited to writs in principle, but writs are where it has been formalized. Other plugin-owned domain objects (sessions, codexes, etc.) carry their own typed shapes and don't currently expose plugin-keyed extension slots.

---

## Animas

<!-- TODO: Identity and composition. An anima = name + curriculum + temperament + role assignments. Composition model: curriculum (what you know), temperament (who you are) — both versioned, immutable per version. The Loom weaves them at session time. Anima states: active / retired. MVP: no identity layer; The Loom returns a fixed composition per role. Link to forthcoming anima-composition.md. -->

---

## Work Model

<!-- TODO: The obligation pipeline. Commission (patron's request) → Mandate writ (guild's formal record, created by Clerk) → child writs as the guild decomposes the work → Rigs as the execution scaffolding for a writ. Writ lifecycle (ready → active → pending → completed/failed/cancelled). Writ hierarchy and completion rollup. Brief intro to rigs (assembled by Spider from engine designs contributed by kits via Fabricator). Link to rigging.md for rig execution detail. -->

---

## Kit Components: Tools, Engines & Relays

Kits contribute three kinds of installable artifacts. All three follow the same packaging pattern — a descriptor file, an entry point, and a registration entry — but they serve different roles in the guild.

### Tools

**Tools** are instruments animas wield during work. A tool is a handler with a defined contract (inputs in, structured result out), accessible through three paths:

- **MCP** — animas invoke tools as typed MCP calls during sessions. The framework launches a single MCP engine per session loaded with the anima's permitted tools.
- **CLI** — humans invoke tools via `nsg` subcommands.
- **Import** — engines, relays, and other tools can import handlers programmatically.

All three paths execute the same logic. Tool authors write the handler once using the `tool()` SDK factory from `@shardworks/tools-apparatus`, which wraps a Zod schema and handler function into a `ToolDefinition`:

```typescript
export default tool({
  description: "Look up an anima by name",
  params: { name: z.string() },
  handler: async ({ name }, ctx) => { ... },
})
```

Tools can be TypeScript modules or plain scripts (bash, Python, any executable). Script tools need no SDK — a one-line descriptor and an executable is enough. The framework infers the kind from the file extension.

**Permission gating:** Tools may declare a `permission` level (e.g. `'read'`, `'write'`, `'admin'`). Roles grant permission strings in `plugin:level` format (with wildcard support). The Loom resolves an anima's roles into a flat permissions array; the Instrumentarium matches those grants against each tool's declared permission to resolve the available set. Tools without a `permission` field are permissionless — included by default, or gated in strict mode.

**Instructions:** A tool can optionally ship with an `instructions.md` — a teaching document delivered to the anima as part of its system prompt. Instructions provide craft guidance (when to use the tool, when not to, workflow context) that MCP's schema metadata cannot convey.

### Engines

**Engines** are the workhorse components of rigs — bounded units of work the Spider mounts and sets in motion. An engine runs when its upstream dependencies (givens) are satisfied and produces yields when done. Two kinds:

- **Clockwork** — deterministic, no AI. Runs its code directly against the configured substrate.
- **Quick** — inhabited by an anima for work requiring judgment. The engine defines the work context; the anima brings the skill.

Kits contribute engine designs; the Spider draws on them (via The Fabricator) to extend rigs as work progresses. Engines are not role-gated — they are not wielded by animas directly; they are the work context an anima staffs.

### Relays

**Relays** are Clockworks handlers — purpose-built to respond to events via standing orders. A relay exports a standard `relay()` contract that the Clockworks runner calls when a matching event fires. All relays are clockwork (no anima involvement). The built-in **summon relay** is the mechanism that dispatches anima sessions in response to standing orders.

### Comparison

| | Tools | Engines | Relays |
|---|---|---|---|
| **Purpose** | Instruments animas wield | Rig workhorses | Clockworks event handlers |
| **Invoked by** | Animas (MCP), humans (CLI), code | Spider (within a rig) | Clockworks runner (standing order) |
| **Role gating?** | Yes | No | No |
| **Instructions?** | Optional | No | No |
| **Clockwork or quick?** | Neither (runs on demand) | Either | Always clockwork |

See [Kit Components](kit-components.md) for the full specification: descriptor schemas, on-disk layout, installation mechanics, the MCP engine, and local development workflow.

---

## Sessions

A **session** is a single AI process doing work. It is the fundamental unit of labor in the guild — every anima interaction, whether launched by a standing order or started interactively from the CLI, is a session. Three apparatus collaborate to make a session happen: **The Loom** composes the context, **The Animator** launches the process and records the result, and (when available) **The Instrumentarium** resolves the tools the anima can wield.

### The Session Funnel

Every session passes through the same funnel regardless of how it was triggered:

```
  Trigger (summon relay / nsg consult / nsg convene)
    │
    ├─ 1. Weave context  (The Loom)
    │     system prompt: charter + tool instructions + role instructions
    │     future: + curriculum + temperament
    │
    ├─ 2. Launch process  (The Animator → Session Provider)
    │     AI process starts in a working directory
    │     MCP tool server attached (future: when Instrumentarium ships)
    │
    ├─ 3. Session runs
    │     anima reads context, uses tools, produces output
    │
    └─ 4. Record result  (The Animator → The Stacks)
          status, duration, token usage, cost, exit code
          ALWAYS recorded — even on crash (try/finally guarantee)
```

The trigger determines *what* work is done (the prompt, the workspace, the metadata), but the funnel is identical. The Animator doesn't know or care whether it was called from a standing order or an interactive session.

### Context Composition (The Loom)

The Loom weaves anima identity into session contexts. Given a role name, it produces an `AnimaWeave` — the composed identity context that The Animator uses to launch a session. The work prompt (what the anima should do) bypasses The Loom and goes directly from the caller to the session provider. The Loom currently handles two concerns: **tool resolution** (role → permissions → Instrumentarium → permission-gated tool set, returned on the `AnimaWeave`) and **git identity** (deriving `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` from the role name). System prompt composition is not yet implemented — the `systemPrompt` field on `AnimaWeave` remains undefined until the Loom gains composition logic. The Animator never assembles prompts, so when real composition arrives, nothing downstream changes.

The target design composes the system prompt from layers, in order: **guild charter** (institutional policy) → **curriculum** (what the anima knows) → **temperament** (who the anima is) → **role instructions** → **tool instructions** → **writ context**. Each layer is versioned and immutable per version, making sessions reproducible — given the same inputs, The Loom produces the same context.

The distinction between **system prompt** and **work prompt** matters: the system prompt is the anima's identity and operating instructions (persistent across turns in a conversation, composed by The Loom); the work prompt is the specific work request for this session (changes each turn, bypasses The Loom). The Animator sends both to the provider.

### Session Launch (The Animator)

The Animator brings animas to life. It takes an `AnimaWeave`, a working directory, and optional metadata, then delegates to a **session provider** — a pluggable backend that knows how to launch and communicate with a specific AI system. Both `summon()` and `animate()` return an `AnimateHandle` synchronously — a `{ chunks, result }` pair where `result` is a promise for the final `SessionResult` and `chunks` is an async iterable of output (empty unless `streaming: true` is set on the request). The MVP provider is `claude-code-apparatus`, which launches a `claude` CLI process in **bare mode** (no CLAUDE.md, no persistent project context — the session context is entirely what The Loom wove).

The Animator's error handling contract is strict: session results are **always** recorded to The Stacks, even when the provider crashes or times out. The launch is wrapped in try/finally — if the provider throws, the session record still gets written with `status: 'failed'` and whatever telemetry was available. If the Stacks write itself fails, that error is logged but doesn't mask the provider error. Session data loss is preferable to swallowing the original failure.

Every session record captures structured telemetry: wall-clock duration, exit code, token usage (input, output, cache read, cache write), and cost in USD. Callers attach opaque **metadata** — the Animator stores it without interpreting it. The summon relay attaches dispatch context (writ id, anima name, codex); `nsg consult` attaches interactive session context. Downstream queries against metadata use The Stacks' JSON path queries.

### Session Providers

Session providers are the pluggable backend behind The Animator. A provider implements a single `launch()` method that returns `{ chunks, result }` synchronously — the same shape as `AnimateHandle`. When `config.streaming` is true, the provider yields output chunks through the `chunks` async iterable as the session runs; when false (or when the provider doesn't support streaming), the chunks iterable completes immediately with no items. The Animator does not branch on streaming capability — it passes the flag through and trusts the provider.

Providers handle the mechanics of a specific AI system — process spawning, stdio communication, result parsing — but not session lifecycle. The Animator owns lifecycle (id generation, timing, recording); the provider owns the process. This split means adding a new AI backend (GPT, Gemini, local models) requires only a new provider package, not changes to The Animator.

MVP: one hardcoded provider (`claude-code`). Future: provider discovery via kit contributions or guild config.

### Tool-Equipped Sessions

Sessions can be equipped with guild tools via the MCP integration pipeline. The Loom resolves the anima's role into permission grants, then calls The Instrumentarium to resolve the permission-gated tool set. The resolved tools are returned on the `AnimaWeave` and passed through The Animator to the session provider. The claude-code provider starts an in-process MCP HTTP server (one per session, SSE transport on an ephemeral localhost port), writes a `--mcp-config` file pointing at it, and tears it down when the session exits.

Tools are the mechanism through which animas act on the guild — creating writs, reading documents, signaling events, modifying files. Without tools, a session is advisory; with tools, it is operational.

### Conversations (The Parlour)

A **conversation** groups multiple sessions into a coherent multi-turn interaction. Two kinds exist: **consult** (a human talks to an anima — the `nsg consult` command) and **convene** (multiple animas hold a structured dialogue — `nsg convene`). The Parlour manages both.

The Parlour orchestrates, it doesn't execute. For each turn, it determines whose turn it is, assembles the inter-turn context (what happened since this participant last spoke), and delegates the actual session to The Animator. Each anima participant maintains **provider session continuity** via the `--resume` mechanism — the provider's conversation id is stored on the participant record and passed back on the next turn, allowing the AI process to maintain its full context window across turns.

For convene conversations, The Parlour assembles inter-turn messages: when it's Participant A's turn, it collects the responses from all participants who spoke since A's last turn and formats them as the input message. Each participant sees a coherent dialogue without The Parlour re-sending the full history (the provider's `--resume` handles that).

Conversations have an optional **turn limit** — when reached, the conversation auto-concludes. The Parlour tracks all state in The Stacks (no in-memory state between turns), making it safe for concurrent callers and process restarts.

**Workspace constraint:** Provider session continuity depends on local filesystem state (e.g. Claude Code's `.claude/` directory). All turns in a conversation must run in the same working directory, or the session data needed for `--resume` won't be present. The Parlour enforces this by passing a consistent `cwd` to The Animator for every turn.

### Invocation Paths

Sessions enter the system through three paths:

1. **Clockworks summon relay** — a standing order fires, the summon relay calls The Loom and The Animator. This is the autonomous path — no human involved.
2. **`nsg consult`** — the patron starts an interactive session. The CLI calls The Loom and The Animator directly, with streaming output to the terminal. For multi-turn conversations, The Parlour manages the session sequence.
3. **`nsg convene`** — the patron convenes a multi-anima dialogue. The CLI creates a Parlour conversation and drives the turn loop, with each turn delegating to The Animator.

All three paths converge on the same `AnimatorApi.animate()` call. The Animator is the single chokepoint for session telemetry — every session, regardless of trigger, gets the same structured recording.

See [The Animator — API Contract](apparatus/animator.md), [The Loom — API Contract](apparatus/loom.md), and [The Parlour — API Contract](apparatus/parlour.md) for the full specifications.

---

## The Clockworks

<!-- TODO: Event-driven nervous system. Events as immutable persisted facts (not intents). Standing orders as guild policy in guild.json — bind event patterns to relays. The summon verb as sugar for the summon relay. Framework events (automatic, from nexus-core operations) vs. custom guild events (declared in guild.json, signaled by animas via signal tool). The runner: manual (nsg clock tick/run) vs. daemon (nsg clock start). Error handling: clockworks.standing-order.failed, loop guard. Link to clockworks.md. -->

---

## Core Apparatus Reference

<!-- TODO: Quick-reference table of all standard apparatus — name, package, layer, what it provides, links to detailed docs where they exist. Covers the same set as the table in "The Standard Guild" section but with package names, API surface hints, and links. -->

---

## Future State

Known gaps in the framework infrastructure that will be addressed as apparatus are built out.

### Config write path on `Guild` interface

The `Guild` interface (`guild()` singleton) exposes `config<T>(pluginId)` for reading plugin configuration from `guild.json`, but has no corresponding write method. Currently, plugins that need to modify their config section must use the standalone `writeGuildConfig()` function from `@shardworks/nexus-core`, which reads the full file, modifies it, and writes it back. This works but has no atomicity guarantees and no event emission.

A `guild().writeConfig(pluginId, config)` method (or equivalent) would provide:
- Scoped writes (a plugin modifies only its own section)
- Atomic file updates (read-modify-write under a lock)
- Config change events (for downstream reactivity)

**First consumer:** [The Scriptorium](apparatus/scriptorium.md) — `codex-add` and `codex-remove` need to modify the `codexes` config section programmatically. Update the Scriptorium's implementation when this API ships.

### `workshops` → `codexes` migration in nexus-core

The nexus-core cleanup has landed. `GuildConfig` no longer carries a framework-level `workshops` field, the `WorkshopEntry` type is gone, `workshopsPath()` and `workshopBarePath()` have been removed from `nexus-home.ts`, and `createInitialGuildConfig()` no longer seeds `workshops: {}`. Codex registration is now fully owned by The Scriptorium as plugin config (read via `guild().config<CodexesConfig>('codexes')`); nothing in the framework retains workshop/codex awareness.

Residual drift remains outside the core package and is the work that still needs doing:
- Plugin test fixtures in arbor and elsewhere still pass `workshops: {}` in their setup helpers and need to drop that key.
- `docs/reference/core-api.md` and `docs/guides/building-tools.md` still describe the legacy `workshops`-shaped paths and result types and need to be updated to the codex-config vocabulary.

See [Cross-Package Coupling](cross-package-coupling.md) for the inbound edges that still exercise the legacy types and the audit driving the remaining cleanup.


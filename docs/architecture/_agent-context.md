# Agent Context: Architecture Doc Codebase Scan

> **Purpose:** Notes for agents working on `docs/architecture/index.md` so they don't have to re-scan the codebase from scratch. Written during the initial scaffolding session (2026-03-31). May drift from reality — treat as orientation, not ground truth.

---

## Repo Layout

The Nexus framework lives at `/workspace/nexus/`. Key directories:

```
/workspace/nexus/
  packages/               ← TypeScript packages (pnpm workspace)
  docs/
    architecture/         ← THIS IS WHERE YOU ARE
    reference/            ← API reference (core-api.md, schema.md, event-catalog.md, conversations.md)
    guides/               ← How-to guides (building-engines.md, building-tools.md)
    guild-metaphor.md     ← Conceptual vocabulary; read this first
    philosophy.md         ← Project "why"
```

The live guild workspace (where animas operate) is at `/workspace/shardworks/`.

The patron-side sanctum (experiments, session notes, Coco config) is at `/workspace/nexus-mk2/`.

---

## Packages

| Package | npm name | What it is |
|---------|----------|------------|
| `core` | `@shardworks/nexus-core` | Shared library — Books, config, path utilities, writ/anima/event functions, `tool()` and `engine()` SDK factories, `Rig` type |
| `arbor` | `@shardworks/nexus-arbor` (approx) | Guild runtime object — loads plugins (currently "rigs"), manages tool registry, owns Books database connection |
| `cli` | `@shardworks/nexus` | The `nsg` CLI binary |
| `nexus-clockworks` | `@shardworks/nexus-clockworks` | Clockworks as a rig — contributes clockworks tools and events/dispatches Books tables |
| `nexus-sessions` | `@shardworks/nexus-sessions` | Sessions as a rig — contributes session tools and sessions Book |
| `guild-starter-kit` | `@shardworks/guild-starter-kit` | Starter bundle — curricula, temperaments, migration snapshots |
| `claude-code-session-provider` | (local) | Session provider implementation for Claude Code / claude CLI |
| `stdlib` | `@shardworks/nexus-stdlib` | Standard tools, engines, relays |

---

## The Rig Terminology Collision

**This is the most important thing to understand before touching this doc.**

The word "rig" means two completely different things in this codebase:

| Context | Meaning |
|---------|---------|
| **Guild metaphor / target architecture** | The execution scaffold assembled to fulfill a commission — seeded at commission time, built out by Walker with engines, struck when work is done |
| **Current code** (`Rig` type in `core/src/rig.ts`, loaded by Arbor) | A package contributing tools, Books declarations, and other capabilities to the guild — basically what the target architecture calls a Kit or Apparatus |

The current code's `Rig` is what we're moving toward calling a **Kit** (or Apparatus, for packages with a lifecycle). This rename is in progress. When reading source code, mentally substitute "plugin" for `Rig`.

The architecture docs use "rig" exclusively in the metaphor sense (execution scaffold). The source code uses it in the plugin sense. Both are in the same repo. Don't mix them up.

---

## Architecture Docs Status

### Exists and reasonably current

| Doc | Status | Notes |
|-----|--------|-------|
| `architecture/plugins.md` | Good | Describes the Kit/Apparatus model with full type signatures. This is aspirational architecture, not fully implemented. |
| `architecture/clockworks.md` | Good | Detailed; covers events, standing orders, relays, runner phases, daemon. Generally matches current implementation. |
| `architecture/kit-components.md` | Good | Tools, engines, relays — artifact model, descriptors, role gating, installation. Generally accurate. |
| `architecture/rigging.md` | Forward-looking | Describes Walker/Formulary/Executor/Loom/Animator/Clerk as separate apparatus. This is the *target* design; currently much of this logic is either in core or not yet implemented. |
| `reference/schema.md` | Good | SQLite schema, ERD, entity ID prefixes. Reflects current database. |
| `reference/core-api.md` | Good | Function signatures for `@shardworks/nexus-core`. Generally accurate but some functions are in `legacy/1/` indicating in-flight migration. |
| `reference/event-catalog.md` | Not read | Should describe all framework events and payload shapes. |
| `guides/building-engines.md` | Good | How to write a clockwork engine. Code examples use `engine()` factory from nexus-core. Accurate for current implementation. |
| `guides/building-tools.md` | Not read | Parallel to building-engines.md for tools. |

### Outdated / moved

| Doc | Status | Notes |
|-----|--------|-------|
| `outdated-architecture/overview.md` (in nexus-mk2) | Outdated | Long overview doc from before the apparatus/kit fragmentation. Useful for historical context and some section content (instruction environment, data storage breakdown). Don't trust its package names or directory structures. |

### Exists in nexus-mk2 future/ but not yet written

| Doc | Where referenced | What it should cover |
|-----|-----------------|---------------------|
| `anima-composition.md` | kit-components.md | Curricula, temperaments, oaths — composition artifacts |
| `writs.md` | multiple places | Writ lifecycle, completion rollup, prompt templates, commission→mandate bridge |
| `engine-designs.md` | plugins.md, future/ | WalkerKit engine design specifications |
| `anima-lifecycle.md` | future/ | Anima states, instantiation, retirement |

---

## What's Implemented vs. Aspirational

The codebase is in active transition from a "rig-centric" model (current) toward the full "apparatus/kit" plugin model (target).

### Currently implemented (in actual packages)

- `Rig` type as the plugin interface (tools + books declarations)
- Arbor as the rig loader and runtime object
- Clockworks as a nexus-sessions-style rig (contributes tools + Books)
- Sessions as a rig (contributes tools + Books)
- `tool()` and `engine()` SDK factories in nexus-core
- SQLite Books database with schema migrations
- Standing orders, event queue, Clockworks daemon
- Writ lifecycle (create, activate, complete, fail, cancel)
- Anima instantiation, roster, role assignments
- Commission → mandate writ → dispatch flow
- Session funnel (manifest → MCP engine launch → session record)
- Session providers (pluggable; claude-code-session-provider exists)

### Target architecture (described in docs, not yet fully built)

- Formal `Plugin` type with explicit Kit/Apparatus discriminant
- `Apparatus` with `start`/`stop`/`health`/`supportKit`/`consumes`
- `GuildContext` with `ctx.plugin()`, `ctx.kits()`, `ctx.plugins()`
- Separate named apparatus: Stacks, Guildhall, Clerk, Loom, Animator, Formulary, Walker, Executor, Surveyor, Warden
- Walker-driven rig execution (the commission → rig → engine chain)
- Formulary (capability resolution from installed kits)
- `plugin:initialized` reactive consumption
- Startup validation with `requires` / `consumes` cross-referencing

---

## Key Files to Read

If you're working on a specific section of the architecture doc, start with:

| Section | Most relevant files |
|---------|-------------------|
| Plugin Architecture | `docs/architecture/plugins.md`, `packages/arbor/src/arbor.ts` |
| The Books | `docs/reference/schema.md`, `packages/core/src/book.ts`, `packages/arbor/src/db/` |
| Animas | `packages/core/src/legacy/1/anima.ts`, `guild-metaphor.md` (Anima section) |
| Work Model | `packages/core/src/legacy/1/writ.ts`, `docs/reference/schema.md` (writs table), `clockworks.md` |
| Kit Components | `docs/architecture/kit-components.md`, `packages/core/src/tool.ts` |
| Sessions | `packages/nexus-sessions/src/`, `packages/claude-code-session-provider/src/` (if exists), `docs/reference/conversations.md` |
| Clockworks | `docs/architecture/clockworks.md`, `packages/nexus-clockworks/src/` |
| Rigging | `docs/architecture/rigging.md` (aspirational), `packages/arbor/src/arbor.ts` (current) |

---

## guild.json Shape

The V2 type (`GuildConfigV2` in `packages/core/src/guild-config.ts`) defines the framework keys. All other top-level keys are plugin configuration sections, keyed by derived plugin id.

**Framework keys:** `name`, `nexus`, `plugins` (string array), `settings` (object with `model`, `autoMigrate`).

**Plugin config keys (standard guild):** `clockworks`, `workshops`, `roles`, `baseTools` — owned by their respective apparatus, not by the framework. They sit at the top level because `@shardworks/clockworks` → `clockworks`, etc.

Note: the live guild at `/workspace/shardworks/` is still running the V1 config shape (per-capability registries: `tools`, `engines`, `curricula`, `temperaments` as objects, no `plugins` array). V2 has `plugins` as a flat string array and drops per-capability registries. The architecture docs describe V2.

---

## Terminology Quick Reference

| Term in metaphor | Term in code (current) | Term in target architecture |
|-----------------|----------------------|----------------------------|
| Rig (execution scaffold) | (not yet implemented) | Rig |
| Kit / Apparatus | Rig (plugin package) | Kit / Apparatus |
| The Books | nexus.db / SQLite tables | The Stacks (`books` apparatus) |
| Summon relay | built-in clockworks dispatch | summon relay (installed via nexus-stdlib) |
| Arbor | Arbor | Arbor |
| Walker | (not yet implemented) | The Walker (`walker` apparatus) |
| Formulary | (not yet implemented) | The Formulary (`formulary` apparatus) |

---

## Session Notes

- **2026-03-31 (session 1):** Initial scaffold session. Wrote §1–4 scaffold + "Standard Guild" bridge section. Created this context doc. Architecture doc is at `docs/architecture/index.md`. Companion detailed docs are already written for clockworks, plugins, kit-components, and rigging — they're good references even if partially aspirational.

- **2026-03-31 (session 2):** Wrote §2 content (intro paragraph, ASCII diagram, narrative subsections). Scoped §2 explicitly as the "standard guild" — blockquote caveat added before the intro paragraph. Established the intended narrative arc: §2 gives the standard-guild mental model → §4 peels it back ("everything in §2 is a plugin, there is no privileged built-in layer") → Standard Guild bridge lists the defaults → detail sections proceed without hedging. **When writing §4**, open with a callback to §2: *"The apparatus described in §2 — Clerk, Walker, Clockworks, and the rest — are all plugins..."* This converts §2 into setup and §4 into the architectural reveal.

- **2026-03-31 (session 3):** Completed §3 (Guild Root) and §4 (Plugin Architecture). Corrected `guild.json` key names from real V2 type. Documented real `.nexus/` contents. Identified and resolved a plugin configuration specification gap — see design decisions below. Rewrote §4 with the §2 callback opening, corrected Kit/Apparatus examples (new naming convention, correct manifest shape), added Plugin IDs and Configuration subsections, updated GuildContext/HandlerContext interfaces with `config<T>()` and `guildConfig()`. Cleaned up Standard Guild table (dropped Guildhall, dropped layer column, added plugin id column, updated Stacks description). Restructured `guild.json` section to separate framework keys (`name`, `nexus`, `plugins`, `settings`) from plugin config sections (everything else, keyed by plugin id). Updated `plugins.md` spec with Plugin IDs section, Configuration section, and updated context interfaces.

---

## Design Decisions (session 3)

### Plugin name derivation

Plugin ids are derived from npm package names with three rules applied in order:
1. Strip `@shardworks/` scope entirely (bare name)
2. Retain other scopes as prefix without `@` (`@acme/foo` → `acme/foo`)
3. Strip trailing `-(plugin|apparatus|kit)` suffix

This means `@shardworks/clockworks` → `clockworks`, `@shardworks/books-apparatus` → `books`, `@acme/cache-apparatus` → `acme/cache`. Documented in `plugins.md` (Plugin IDs section). **Not yet implemented** — see implementation plan.

### Plugin configuration access

**Problem identified:** `plugins.md` and the context type docs had no specification for how apparatus access their own configuration from `guild.json`. The implementation had an undocumented `getPluginConfig(pluginId)` on Arbor that was never used.

**Decision:** Remove `getPluginConfig` from Arbor. Add to both `GuildContext` and `HandlerContext`:
- `ctx.config<T>(pluginId?: string): T` — returns `guild.json[pluginId]` (defaults to the calling plugin's id if no arg). Returns `{}` if no config section. Generic is a cast, not validated.
- `ctx.guildConfig(): GuildConfigV2` — escape hatch for full config (roles, workshops, settings, etc.)

Config sections live at the top level of `guild.json` under the plugin's derived id. Because `@shardworks/clockworks` → `clockworks`, the Clockworks apparatus gets `guild.json["clockworks"]` naturally — no privileged handling.

For `HandlerContext`, `ctx.config()` with no args requires knowing which plugin owns the handler. `createHandlerContext(owningPluginId?)` takes an optional plugin id; callers dispatching a specific tool pass `tool.pluginId`.

Documented in `plugins.md` (Plugin IDs section + Configuration section). **Not yet implemented** — implementation plan at `.scratch/arbor-config-impl-plan.md` in the sanctum.

---

## Next Steps for Architecture Doc (`index.md`)

### Completed sections
- **§1 Introduction** ✅
- **§2 System at a Glance** ✅ — scoped as standard guild, ASCII diagram, narrative subsections
- **§3 The Guild Root** ✅ — directory structure, guild.json (framework keys + plugin config), .nexus/ runtime state
- **§4 Plugin Architecture** ✅ — §2 callback opening, Kit/Apparatus with correct examples, Plugin IDs, Arbor and Contexts (with config/guildConfig), Installation
- **The Standard Guild** ✅ — bridge section with apparatus table (plugin ids) and kit table

### Remaining stub sections
All are `<!-- TODO -->` blocks. In rough priority order:

1. **The Books** — The Stacks apparatus (`books`). SQLite at `.nexus/nexus.db`. Generic persistence layer + CDC events. Avoid naming specific books (Register, Ledger, Daybook) — those are deemphasised. Describe the Book API. Note: persistence is owned by the apparatus, not the framework. Link to `reference/schema.md`.

2. **Work Model** — Commission → Mandate writ → child writs → Rigs. Writ lifecycle states (`ready → active → pending → completed/failed/cancelled`). Writ hierarchy and completion rollup. Brief rig intro (Walker assembles from engine designs via Formulary). Link to `rigging.md`.

3. **The Clockworks** — Abbreviate; `clockworks.md` is detailed and current. Cover: events as immutable facts, standing orders as guild policy, summon verb, framework vs custom events, runner (manual vs daemon), error handling. Link to `clockworks.md`.

4. **Animas** — MVP: no identity layer. Composition is per-role, not per-anima. The Loom weaves role instructions + tool instructions into a session context. Future: anima identity records, curricula, temperaments, states (active/retired). Keep section light on implementation since apparatus are being designed.

5. **Kit Components** — Tools, engines, relays. Abbreviate; `kit-components.md` covers this well. Role gating for tools, clockwork vs quick for engines, relay contract. Descriptor files. Installation.

6. **Sessions** — Session funnel. Triggered by summon relay or `nsg consult`. Loom → Animator → AI process with MCP server → result recorded. Session providers (pluggable). System prompt vs initial prompt. Bare mode. Link to `reference/conversations.md`.

7. **Core Apparatus Reference** — Quick-reference table with plugin ids, package names, API surface hints, links to detailed docs.

### Implementation work (not architecture doc)
- **Arbor config API** — implementation plan at `nexus-mk2/.scratch/arbor-config-impl-plan.md`. Updates `derivePluginId`, adds `ctx.config()` / `ctx.guildConfig()` to GuildContext/HandlerContext, removes `getPluginConfig` from Arbor. Not yet commissioned.
- **Plugin rename** — standard apparatus packages should be renamed to match new naming convention (e.g. `@shardworks/nexus-clockworks` → `@shardworks/clockworks`). Not yet commissioned. Scope TBD.
- **The Instrumentarium** — new apparatus, see design decisions (session 4) below.
- **Loom MVP** — new apparatus, see design decisions (session 4) below.
- **Animator MVP** — new apparatus, see design decisions (session 4) below.

---

## Design Decisions (session 4)

### New apparatus: The Instrumentarium (`instrumentarium`)

**Problem:** Tools are currently owned by Arbor (`listTools()`, `findTool()`), but Arbor's design goal is "plugin loader only." Tools need a home that both the session layer (Loom/Animator) and the CLI can depend on, without coupling either to anima identity.

**Decision:** Create a new apparatus — **The Instrumentarium** (`instrumentarium`, package `@shardworks/instrumentarium`). It owns:
- Tool registry — scanning kit `tools` contributions and apparatus `supportKit` tools at startup
- Role-gating resolution — given a set of roles + baseTools, return the resolved tool set
- HandlerContext creation — scoped to the invoking plugin, with `config()` and `apparatus()` wired
- CLI tool discovery — `nsg <tool>` resolves through The Instrumentarium

The Instrumentarium has no dependency on animas, sessions, or composition. Both The Loom and the CLI depend on it independently. Apparatus that need to invoke tools programmatically depend on it.

`consumes: ["tools"]` — scans kit and supportKit contributions for tool definitions.

### Loom MVP — composition without identity

**Problem:** Full anima composition (identity lookup → curriculum resolution → temperament resolution → charter + tool instructions) requires several systems that don't exist yet. But The Animator needs *some* composed context to launch sessions.

**Decision:** MVP Loom returns a fixed composition for a given role:
- Reads the role's `instructions` file from disk (the path in `guild.json` roles config)
- Reads tool instructions from The Instrumentarium for the resolved tool set
- Returns a composed system prompt: role instructions + tool instructions
- No anima identity lookup, no curriculum, no temperament, no charter

This is enough for The Animator to launch useful sessions. Identity and full composition are layered on later without changing The Animator's interface — it always receives a composed context and a tool set, regardless of how they were assembled.

### Animator MVP

**Decision:** The Animator takes a composed context (from Loom) + a resolved tool set (from Instrumentarium) and:
1. Launches a session provider (e.g. `claude-code-session-provider`) with the system prompt and an MCP server loaded with the tool set
2. Monitors the process
3. Records the session result to The Stacks (sessions book)

The Animator does not know how the context was composed or which anima is being manifested (in MVP, there are no anima identity records). It receives inputs and runs a session.

### Dependency graph (MVP)

```
The Stacks (books)
    │
    ├── The Instrumentarium (instrumentarium)
    │       │
    │       ├── The Loom (loom)
    │       │       │
    │       │       └── The Animator (animator)
    │       │
    │       └── CLI (nsg)
    │
    └── The Clockworks (clockworks)
            │
            └── summon relay → The Animator
```

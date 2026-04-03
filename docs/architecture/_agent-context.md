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
| `claude-code-apparatus` | `@shardworks/claude-code-apparatus` | Session provider implementation for Claude Code / claude CLI |
| `stdlib` | `@shardworks/nexus-stdlib` | Standard tools, engines, relays |

---

## The Rig Terminology Collision

**This is the most important thing to understand before touching this doc.**

The word "rig" means two completely different things in this codebase:

| Context | Meaning |
|---------|---------|
| **Guild metaphor / target architecture** | The execution scaffold assembled to fulfill a commission — seeded at commission time, built out by Spider with engines, struck when work is done |
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
| `architecture/rigging.md` | Forward-looking | Describes Spider/Fabricator/Executor/Loom/Animator/Clerk as separate apparatus. This is the *target* design; currently much of this logic is either in core or not yet implemented. |
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
| `engine-designs.md` | plugins.md, future/ | SpiderKit engine design specifications |
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
- Session providers (pluggable; claude-code-apparatus exists)

### Target architecture (described in docs, not yet fully built)

- Formal `Plugin` type with explicit Kit/Apparatus discriminant
- `Apparatus` with `start`/`stop`/`health`/`supportKit`/`consumes`
- `GuildContext` with `ctx.plugin()`, `ctx.kits()`, `ctx.plugins()`
- Separate named apparatus: Stacks, Guildhall, Clerk, Loom, Animator, Fabricator, Spider, Executor, Surveyor, Warden
- Spider-driven rig execution (the commission → rig → engine chain)
- Fabricator (capability resolution from installed kits)
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
| Sessions | `packages/plugins/claude-code/src/`, `docs/reference/conversations.md` |
| Clockworks | `docs/architecture/clockworks.md`, `packages/nexus-clockworks/src/` |
| Rigging | `docs/architecture/rigging.md` (aspirational), `packages/arbor/src/arbor.ts` (current) |

---

## guild.json Shape

The V2 type (`GuildConfig` in `packages/core/src/guild-config.ts`) defines the framework keys. All other top-level keys are plugin configuration sections, keyed by derived plugin id.

**Framework keys:** `name`, `nexus`, `plugins` (string array), `settings` (object with `model`, `autoMigrate`).

**Plugin config keys (standard guild):** `clockworks`, `codexes`, `roles`, `baseTools` — owned by their respective apparatus, not by the framework. They sit at the top level because `@shardworks/clockworks` → `clockworks`, `@shardworks/codexes-apparatus` → `codexes`, etc.

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
| Spider | (not yet implemented) | The Spider (`spider` apparatus) |
| Fabricator | (not yet implemented) | The Fabricator (`fabricator` apparatus) |

---

## Session Notes

- **2026-03-31 (session 1):** Initial scaffold session. Wrote §1–4 scaffold + "Standard Guild" bridge section. Created this context doc. Architecture doc is at `docs/architecture/index.md`. Companion detailed docs are already written for clockworks, plugins, kit-components, and rigging — they're good references even if partially aspirational.

- **2026-03-31 (session 2):** Wrote §2 content (intro paragraph, ASCII diagram, narrative subsections). Scoped §2 explicitly as the "standard guild" — blockquote caveat added before the intro paragraph. Established the intended narrative arc: §2 gives the standard-guild mental model → §4 peels it back ("everything in §2 is a plugin, there is no privileged built-in layer") → Standard Guild bridge lists the defaults → detail sections proceed without hedging. **When writing §4**, open with a callback to §2: *"The apparatus described in §2 — Clerk, Spider, Clockworks, and the rest — are all plugins..."* This converts §2 into setup and §4 into the architectural reveal.

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

Config sections live at the top level of `guild.json` under the plugin's derived id. Because `@shardworks/clockworks` → `clockworks`, the Clockworks apparatus gets `guild.json["clockworks"]` naturally — no privileged handling.

Access is via `guild().config<T>(pluginId)` — always requires an explicit plugin id (no implicit scoping). `guild().guildConfig()` is the escape hatch for framework-level fields.

Documented in `plugins.md` (Plugin IDs section + Configuration section). **Implemented** in session 4.

### guild() singleton — replaces HandlerContext

**Problem identified:** `HandlerContext` was injected into tool handlers as a second parameter, but the MCP server created a broken stub (all methods threw), and the pattern required a context factory in Arbor, the CLI, and the CDC registry.

**Decision:** Replace with a process-level singleton `guild()` from `@shardworks/nexus-core`. All plugin code — apparatus `start()`, tool handlers, CDC handlers — calls `guild()` to access `home`, `apparatus()`, `config()`, `guildConfig()`, `kits()`, `apparatuses()`.

Arbor creates the `Guild` instance before starting any apparatus (backed by the live `provides` Map, so dependency ordering works). `setGuild()` and `clearGuild()` are exported for testing.

`HandlerContext` and `GuildContext` removed from plugin.ts. `createHandlerContext` removed from Arbor interface. `createMinimalHandlerContext` removed from CLI. Tool handler signature: `(params) => unknown | Promise<unknown>` — no context parameter.

### GuildContext → StartupContext

**Problem:** `GuildContext` (passed to apparatus `start()`) overlapped with `guild()` — same methods (`apparatus()`, `config()`, `home`, etc.), different scoping behavior. Two contexts with similar methods but different semantics is confusing.

**Decision:** Strip `GuildContext` down to `StartupContext` with a single method: `on(event, handler)` for lifecycle event subscription. All other guild access in `start()` goes through `guild()`, same as everywhere else. No overlap, no confusion.

### GuildConfigV2 → GuildConfig

Renamed everywhere. Dropped V2 suffixes from `createInitialGuildConfig`, `readGuildConfig`, `writeGuildConfig`. Legacy V1 `GuildConfig` untouched in its own module scope (`legacy/1/guild-config.ts`).

### CDC handlers — no context injection

CDC handlers (`ChangeHandler`) no longer receive a context parameter. They capture dependencies via closure from the `start()` scope where they're registered. Signature: `(event: ChangeEvent<T>) => Promise<void> | void`.

---

## Next Steps for Architecture Doc (`index.md`)

### Completed sections
- **§1 Introduction** ✅
- **§2 System at a Glance** ✅ — scoped as standard guild, ASCII diagram, narrative subsections
- **§3 The Guild Root** ✅ — directory structure, guild.json (framework keys + plugin config), .nexus/ runtime state
- **§4 Plugin Architecture** ✅ — §2 callback, Kit/Apparatus examples, Plugin IDs, guild() singleton, StartupContext, Installation
- **The Standard Guild** ✅ — apparatus table (plugin ids) and kit table
- **The Books** ✅ — Stacks apparatus, document model, API surface, CDC, backend
- **Kit Components** ✅ — tools/engines/relays, comparison table, link to kit-components.md

### Remaining stub sections
All are `<!-- TODO -->` blocks. In rough priority order:

1. **Work Model** — Commission → Mandate writ → child writs → Rigs. Writ lifecycle states (`ready → active → pending → completed/failed/cancelled`). Writ hierarchy and completion rollup. Brief rig intro (Spider assembles from engine designs via Fabricator). Link to `rigging.md`.

2. **The Clockworks** — Abbreviate; `clockworks.md` is detailed and current. Cover: events as immutable facts, standing orders as guild policy, summon verb, framework vs custom events, runner (manual vs daemon), error handling. Link to `clockworks.md`.

3. **Animas** — MVP: no identity layer. Composition is per-role, not per-anima. The Loom weaves caller-provided system prompt into a session context (pass-through for MVP). Future: anima identity records, curricula, temperaments, states (active/retired). Keep section light on implementation since apparatus are being designed.

4. **Sessions** — Session funnel. Triggered by summon relay or `nsg consult`. Loom → Animator → AI process → result recorded. Session providers (pluggable). System prompt vs initial prompt. Bare mode. Link to `reference/conversations.md`.

5. **Core Apparatus Reference** — Quick-reference table with plugin ids, package names, API surface hints, links to detailed docs.

### Implementation work (not architecture doc)
- **guild() singleton** ✅ — implemented in session 4. `Guild` interface, `setGuild`/`clearGuild`, Arbor wiring, all handlers migrated.
- **GuildContext → StartupContext** ✅ — implemented in session 4. HandlerContext removed. createHandlerContext removed from Arbor.
- **GuildConfigV2 → GuildConfig** ✅ — renamed everywhere in session 4.
- **Plugin rename** — standard apparatus packages should be renamed to match new naming convention (e.g. `@shardworks/nexus-clockworks` → `@shardworks/clockworks`). Not yet commissioned. Scope TBD.
- **The Instrumentarium** — specs at `apparatus/instrumentarium.md`. Not yet implemented.
- **Loom MVP** — specs at `apparatus/loom.md`. Not yet implemented.
- **Animator MVP** — specs at `apparatus/animator.md`. Not yet implemented.

---

## Design Decisions (session 4)

### New apparatus: The Instrumentarium (`tools`)

**Problem:** Tools are currently owned by Arbor (`listTools()`, `findTool()`), but Arbor's design goal is "plugin loader only." Tools need a home that both the session layer (Loom/Animator) and the CLI can depend on, without coupling either to anima identity.

**Decision:** Create a new apparatus — **The Instrumentarium** (plugin id `tools`, package `@shardworks/tools-apparatus`). It owns:
- Tool registry — scanning kit `tools` contributions and apparatus `supportKit` tools at startup
- Role-gating resolution — given a set of roles + baseTools, return the resolved tool set
- CLI tool discovery — `nsg <tool>` resolves through The Instrumentarium

The Instrumentarium has no dependency on animas, sessions, or composition. Both The Loom and the CLI depend on it independently. Apparatus that need to invoke tools programmatically depend on it.

`consumes: ["tools"]` — scans kit and supportKit contributions for tool definitions.

### Loom MVP — composition without identity

**Problem:** Full anima composition (identity lookup → curriculum resolution → temperament resolution → charter + tool instructions) requires several systems that don't exist yet. But The Animator needs *some* composed context to launch sessions.

**Decision:** MVP Loom is a pass-through — the caller provides the system prompt and optional initial prompt. The Loom packages them into a `WovenContext` that The Animator consumes. No role resolution, no tool instructions, no file reading, no identity lookup.

The Loom exists as a separate apparatus even at MVP so that The Animator never assembles prompts itself. As composition grows (role instructions, tool instructions, curricula, temperaments, charter), The Loom's internals change but its output shape (`WovenContext`) stays stable — The Animator is unaffected.

### Animator MVP

**Decision:** MVP Animator takes a `WovenContext` (from Loom) + a working directory and:
1. Launches a session provider (e.g. `claude-code-apparatus`) with the system prompt
2. Monitors the process
3. Records the session result to The Stacks (sessions book)

No MCP tool server, no Instrumentarium dependency, no role awareness in MVP. Tool-equipped sessions with MCP are documented as future state in `apparatus/animator.md`.

### Dependency graph (MVP)

```
The Stacks (books)
    │
    └── The Animator (animator)
            │
            └── The Loom (loom)   ← zero apparatus dependencies, pass-through

The Clockworks (clockworks)
    │
    └── summon relay → The Loom → The Animator

The Instrumentarium (tools)   ← no dependencies in MVP, not yet wired to sessions
    │
    └── CLI (nsg)
```

Note: in MVP, The Loom and The Animator do not depend on The Instrumentarium. Tool-equipped sessions (Animator → Instrumentarium for MCP tool set) are future state.

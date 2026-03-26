# Guild System Architecture

The guild system is a framework for running an autonomous AI workforce. **Nexus** is the name of both the framework and the CLI that manages it. This document describes the system itself — the structures, concepts, and machinery that any guild requires. Decisions specific to a particular guild (organizational structure, workshop choices, migration plans) belong in that guild's own documentation.

## Overview

The guild is an autonomous workforce. The patron gives it work; it delivers results. Five pillars define the system:

### 1. The Commission Pipeline & Writs

The guild receives work as commissions and organizes the resulting labor through **writs** — typed, tree-structured work items. When a commission is posted, the framework creates a **mandate** writ (the root obligation). The guild decomposes that mandate into child writs as needed, using whatever types fit its workflow — `task`, `feature`, `step`, `bug`, or any guild-defined vocabulary. Writs can nest to arbitrary depth; completion rolls up automatically from children to parents.

The pipeline is not a fixed sequence; it's a framework for composing phases as the guild's sophistication grows. Guilds decide which roles handle which writ types: one guild might have sages who plan and artificers who build; another might use a single generalist role. The framework provides the writ lifecycle, completion rollup, and event-driven routing; the guild provides the organizational structure.

See [Writs](writs.md) for the full design — lifecycle, completion rollup, prompt templates, and writ types.

### 2. Tools & Engines

The guild equips its members with **tools** — versioned instruments described by a `nexus-tool.json` descriptor and (for tools) an instruction document. The guildhall also houses **engines** — mechanical processes that handle the guild's automated operations (manifesting animas for sessions, setting up worktrees, running migrations), each described by a `nexus-engine.json` descriptor. **Curricula** and **temperaments** follow the same packaging model with their own descriptors. Together, these form the guild's installable, shareable artifact system.

See [Tools, Engines, Curricula & Temperaments](tools-and-engines.md) for the full artifact model, packaging, and installation details.

### 3. The Manifest Engine

When an anima is manifested for a session, the guild assembles a complete instruction set from multiple sources: the codex (institutional policy), the anima's curriculum (skills and training), its temperament (personality and disposition), and the instruction documents for every tool available to the anima's role. This assembled identity is delivered as a system prompt; the commission context arrives as the task prompt. The anima arrives at the workbench fully equipped — knowing who it is, how the guild operates, what tools it has, and what it's been asked to build.

### 4. The Register

The guild does not run anonymous agents. Every anima is a named entity with a tracked composition, a persistent history, and an accountable record. The Register — one of the guild's Books — knows who exists, what they're made of, and what role they fill. Identity is what makes the guild a learning organization rather than a stateless script.

### 5. The Clockworks

The four pillars above make the guild capable. This one makes it alive. The Clockworks is the guild's event-driven nervous system — an extensible hook system where events are signaled as things happen and standing orders define how the guild responds. Guilds define custom events and register standing orders that invoke engines or manifest animas in response. The Clockworks starts operator-driven (manual `nsg clock` commands) and grows toward a continuous daemon as trust is established.

See [The Clockworks](clockworks.md) for full architecture and design details.

---

## Nexus — The Framework

Nexus is the runtime that makes the guild system operational. It provides the base tools and engines needed for the five pillars to function, manages the database schema, and offers a CLI for guild lifecycle management.

### What Nexus provides

**The CLI** — a single installable binary that contains all core guild operations as subcommands. This is the single artifact operators install; everything else is derived from it.

**Base engines:**
- `manifest` — prepare animas for sessions (resolve composition, assemble instructions, select model, launch session)
- `worktree-setup` — prepare isolated work environments for commissions
- `ledger-migrate` — manage database schema (the Books and Clockworks tables)

**Base tools** — module-based tools defined with the `tool()` SDK factory. Each tool ships with instructions delivered to the anima at manifest time. Tools follow a `<noun>-<verb>` naming convention. All tools are packaged in `@shardworks/nexus-stdlib`:
- `commission-create` — post commissions targeting a workshop
- `tool-install` — install a tool or engine into the guild (from registry, git URL, workshop, tarball, or local link)
- `tool-remove` — remove a tool or engine from the guild
- `anima-create` — create animas from curriculum + temperament
- `signal` — signal custom guild events for the Clockworks
- Plus CRUD tools for all entity types: anima, workshop, commission, writ, clock

**Database schema** — the base migrations that define the guild's Books and Clockworks tables.

### The Nexus CLI

The CLI is both the operator interface and the runtime behind tools. Tools are module-based (using the `tool()` SDK factory) and the CLI auto-generates subcommands from tool definitions. This means one `npm install` gives the guild all its core capabilities.

| Command | What it does |
|---------|-------------|
| `nsg init` | Create a new guild — git repo, directory structure, `guild.json`, Books database, starter kit installed |
| `nsg commission create <spec>` | Post a commission targeting a workshop |
| `nsg consult <name>` | Consult a standing anima (e.g., `nsg consult steward`) |
| `nsg anima create` | Create a new anima from curriculum + temperament |
| `nsg tool install <source>` | Install a tool, engine, curriculum, or temperament |
| `nsg tool remove <name>` | Remove an installed tool |
| `nsg status` | Show guild status |
| `nsg signal <event>` | Signal a custom guild event |
| `nsg clock list` | Show pending Clockworks events |
| `nsg clock tick [id]` | Process the next pending event (or a specific one) |
| `nsg clock run` | Process all pending events |
| `nsg clock run` | Process all pending events until the queue is empty |

Subcommands that correspond to tools share the same core logic — the CLI command and the tool wrapper are two interfaces to the same operation.

The framework version is tracked in `guild.json`.

### Separation of framework and guild

Base tools provided by Nexus and tools authored by the guild live in separate locations within the guild root:

```
GUILD_ROOT/
  nexus/                    ← framework-managed
    migrations/
      001-schema.sql
  tools/                    ← tool metadata (descriptors, instructions)
  engines/                  ← engine metadata
  roles/                    ← role instruction files
  codex/                    ← guild-wide policy documents
  training/
    curricula/
    temperaments/
  guild.json
  package.json
  node_modules/             ← tool/engine runtime code (npm packages)
```

**`nexus/`** is framework territory — holds migrations and framework-managed state. Tools and engines are npm packages installed into `node_modules/`, with metadata (descriptors, instructions) in `tools/` and `engines/` directories. The `guild.json` indexes everything.

**Guild tools and engines** are installed via `nsg tool install` from external sources (registry, git URL, tarball, or local link); the framework doesn't touch them.

Both framework and guild tools follow the same artifact pattern — see [Tools, Engines, Curricula & Temperaments](tools-and-engines.md). `guild.json` indexes tools from both locations, tracking their source, installation provenance, and role access.

The manifest engine resolves tool paths based on `source` — `nexus` means look in `nexus/tools/` or `nexus/engines/`, `guild` means look in the root-level `tools/` or `engines/`. Animas don't know or care where their tools came from.

### What this protects against

- **Bad guild publish** — a custom tool breaks things. `nexus repair` restores base tools. Guild content untouched.
- **Corrupted guildhall** — someone mangles framework files. `nexus repair` restores the framework layer. Guild content (codex, training, guild-authored tools and engines) is the guild's problem, but the machinery works.
- **Framework upgrade** — `nexus install 2.4` brings new base tools and migrations. Guild tools untouched. Rollback with `nexus install 2.3`.

---

## Topology

The guild root IS the guildhall — a regular git clone with `guild.json` at the root. Workshop bare clones and commission worktrees live inside `.nexus/` (gitignored). The Books database also lives in `.nexus/`.

The guild root is discovered by walking up from the current directory looking for `guild.json` (like git finds `.git/`). The `--guild-root` CLI flag provides explicit override. No env var is required.

Workshops are registered in `guild.json` and cloned into `.nexus/workshops/` when they are added.

Sessions run in **bare mode** (no CLAUDE.md). Animas do not receive instructions from the workshop repository itself — all instruction content is assembled by the manifest engine and delivered directly. If a workshop needs to communicate conventions to animas, those conventions belong in the codex or as tool instructions, not in repo-level config files. The cwd is always a worktree directory; path references within assembled instructions are resolved by the manifest engine.

### Directory Structure

```
GUILD_ROOT/                           ← regular git clone (IS the guildhall)
  .git/
  .gitignore                          ← ignores: node_modules/, .nexus/
  .nexus/                             ← framework-managed, gitignored
    nexus.db                          ← The Books (SQLite — Register, Ledger, Daybook, Clockworks)
    workshops/
      workshop-a.git/                 ← bare clone
      workshop-b.git/                 ← bare clone
    worktrees/
      workshop-a/
        commission-42/                ← commission worktree
      workshop-b/
        commission-17/                ← commission worktree
  guild.json                          ← central config
  package.json                        ← npm package identity
  package-lock.json
  node_modules/                       ← gitignored
  nexus/
    tools/                            ← framework tools (metadata + source)
    engines/
    migrations/
  tools/                              ← guild tools
  engines/
  codex/
  training/
```

### guild.json

The guild's central configuration file. Contains:

- **Nexus version** — the installed framework version
- **Default model** — the model used for anima sessions unless overridden. Model resolution is designed to be flexible — future layers (per-role, per-curriculum, per-anima, per-commission) can be added as the system matures. For now, only the guild-wide default exists.
- **Workshop registry** — list of registered workshops with their repo URLs.
- **Active tools** — which tools are available, their installation provenance, and package info.
- **Active engines** — which engines are available, their provenance, and package info.
- **Curricula** — which curricula are available, with installation provenance.
- **Temperaments** — which temperaments are available, with installation provenance.

`guild.json` is the source of truth for "what's installed." The filesystem holds the actual artifacts; `guild.json` is the index.

---

## Data Storage

### Flat Files in the guildhall

Authored artifacts, git-managed, meaningful as text:

- **Guild configuration** — `guild.json`
- **Codex, all-members** — `codex/all.md` — included in every anima's instructions
- **Codex, per-role** — `codex/roles/artificer.md` etc — included only for animas that hold the matching role
- **Curricula** — `training/curricula/artificer-craft/` — contains `nexus-curriculum.json` and content markdown. Committed to git.
- **Temperaments** — `training/temperaments/stoic/` — same pattern as curricula, with `nexus-temperament.json`.
- **Tools** — `tools/foo/` — contains `nexus-tool.json`, entry point, `instructions.md`, and any other files from the source package. Committed to git.
- **Engines** — `engines/` — same pattern as tools but with `nexus-engine.json` and no `instructions.md`
- **Framework migrations** — `nexus/migrations/*.sql` — managed by Nexus CLI

### The Books & Clockworks (SQLite at `.nexus/nexus.db`)

Operational state — queryable, relational, runtime data — organized into the guild's Books plus Clockworks internal state:

**Register** (who exists):
- **Anima records** — name, status, state history, timestamps
- **Anima composition** — references to curriculum (name + version), temperament (name + version); full content snapshots at instantiation, immutable after creation. *(v2 adds oaths.)*
- **Roster** — role assignments, standing vs commissioned status

**Ledger** (what work is happening):
- **Commission metadata** — content, timestamps, assigned animas, status, state transitions
- **Writs** — typed work items with tree structure, status lifecycle, and session binding
- **Anima self-recorded memory and notes** — written via tool, not direct database access
- **Edict history** *(v2)* — active edicts and lifecycle

**Daybook** (what happened):
- **Session records** — who ran, when, how long, what it cost
- **Audit log** — who did what, when

**Clockworks** (internal operational state):
- **Event queue** — pending and processed events
- **Dispatch trace** — execution records of standing order processing

The Books hold operational state only. "What exists and what version is active" is answered by `guild.json` and the filesystem. The Books answer "who is doing what, what happened, and what were they told."

### Workshop Repositories

Work product lives where it was made — commission artifacts and outputs, referenced by commission record in Ledger.

---

## Anima Composition

An anima is not a monolithic instruction file. It is composed from discrete, reusable components, assembled at instantiation time:

### Components

| Component | What it provides | Source |
|-----------|-----------------|--------|
| **Curriculum** | Training content — skills, approach to work, craft knowledge. "What you know and how you work." | Packaged artifact in the guildhall (`training/curricula/`), referenced by name in Register |
| **Temperament** | Personality, disposition, communication style. "Who you are." | Packaged artifact in the guildhall (`training/temperaments/`), referenced by name in Register |
| **Oaths** *(v2)* | Identity-level binding commitments. "What you will always/never do." | Stored in Register, per-anima |

### Assembly

At instantiation, the Register records which curriculum (name + version) and temperament (name + version) were assigned. *(v2 adds oaths as a third composition component.)* The **manifest engine** assembles these components — along with guild-level content from the codex and available tool instructions — into the full instruction set delivered to the AI model.

The composition template is part of the manifest engine and versioned with it. When the template changes, a new framework version is published.

```
template(
  codex       = codex/all.md + codex/roles/<role>.md,
  curriculum  = training/curricula/<name>/<version>.md,
  temperament = training/temperaments/<name>/<version>.md,
  oaths       = [from Register],             ← v2
  edicts      = [active edicts from Ledger], ← v2 (governance)
  tools       = [instructions.md for each tool available to this role],
  commission  = [spec + sage advice + clarification thread, if commissioned]
)
→ assembled instructions delivered to model
```

No per-anima markdown files on the filesystem. The anima's identity is the *combination* of its components, not a bespoke document.

---

## Commissions, Writs, and Workshops

All commission and work-tracking infrastructure lives in the guildhall — the pipeline, the engines, the dispatch logic, the Ledger tables that track commissions and writs. When a commission is posted, it specifies a **target workshop**: the repo where animas will do the work. Animas are manifested and launched into worktrees of that target workshop, but the work lifecycle (posting, decomposition, tracking, status transitions) is managed centrally through the guildhall's tools and engines.

### Writs

The framework provides **writs** — typed, tree-structured work items — for organizing labor. A writ has a type, a title, a status, and optionally a parent and children. The guild defines its own writ types (`task`, `feature`, `bug`, etc.) to match its workflow vocabulary. Two types are built in:

- **mandate** — created automatically when a commission is posted. The mandate is the root writ for the commission; completing it completes the commission.
- **summon** — synthesized for non-writ-driven sessions (e.g. `nsg consult`). Ensures every session has a trackable work item.

Writs form trees of arbitrary depth. A mandate might have `task` children, which might have `step` children. Completion rolls up automatically: when all children complete, the parent transitions from `pending` → `ready` (if a standing order exists for that type) or auto-completes (if not).

A **commission** is the patron's request — it describes origin, not scope. The guild receives a commission and determines how to decompose the mandate: a simple commission might be worked directly; a complex one might be broken into many child writs dispatched to different animas.

See [Writs](writs.md) for the full design: status lifecycle, completion model, dispatch integration, prompt templates, and the commission→mandate bridge.

### Roles and Writs

The framework provides infrastructure for roles — registration in `guild.json`, role-based tool gating, role resolution in standing orders — but does not prescribe which roles a guild must have. The guild's standing orders define which roles handle which writ types.

For example, the guild-starter-kit maps:
- **Scope triage** → Master Sage (reviews incoming commissions)
- **Planning** → Sage (decomposes mandates into concrete writs with acceptance criteria)
- **Execution** → Artificer (receives a writ, builds the thing, calls `complete-session`)

Other guilds can use different role structures and writ type vocabularies.

### Workshops

Some workshops produce works for the patron (applications, services, tools). Others produce artifacts destined for the guildhall — new tools, engines, curricula, or temperaments. The guild system doesn't distinguish between these at the commission level.

When a commission produces artifacts for the guildhall (new tools, curricula, etc.), `tool-install` handles the boundary crossing. The anima commits its work to the workshop repo, and the artifact is installed into the guild via `nsg tool install workshop:<name>#<ref>`. This resolves the git ref from the workshop's bare clone, installs the package into `node_modules/` for dependency resolution, and copies the full source to the tool directory for durability. The guildhall itself is never a workspace — artifacts flow in through deliberate install operations.

---

## The Instruction Environment

When an anima is manifested for a session, its instructions are assembled by the manifest engine from its components and guild context, then delivered to the model.

### Delivery

- **System prompt**: Anima-specific instructions — codex, curriculum, temperament, tool instructions. Everything that defines *who this anima is and how they operate*. Frozen at manifest time. *(v2 adds oaths and edicts.)*
- **Initial prompt**: Work context — the writ specification, any planning advice, work-specific instructions. Everything about *what to do right now*.

### What reaches an anima

```
SYSTEM PROMPT (identity + environment):
┌─────────────────────────────────────┐
│  1. The Codex                       │  codex/all.md — guild-wide policy
│     (from the guildhall, filtered   │  codex/roles/<role>.md — only for
│      by the anima's roles)          │  roles the anima holds
├─────────────────────────────────────┤
│  2. Curriculum                      │  Training content — skills,
│     (from composition)              │  craft knowledge, approach to work
├─────────────────────────────────────┤
│  3. Temperament                     │  Personality, disposition,
│     (from composition)              │  communication style
├─────────────────────────────────────┤
│  4. Oaths (v2)                      │  Personal binding commitments
│     (from composition)              │
├─────────────────────────────────────┤
│  5. Active edicts (v2)              │  Current directives from leadership
│     (from the Ledger — governance)  │
├─────────────────────────────────────┤
│  6. Tool instructions               │  instructions.md for each tool
│     (from nexus/ and guild,         │  the anima has access to
│      gated by role)                 │
└─────────────────────────────────────┘

INITIAL PROMPT (task):
┌─────────────────────────────────────┐
│  7. Work context                    │  Writ spec, planning advice,
│     (when commissioned)             │  writ description and context
└─────────────────────────────────────┘
```

Instructions are assembled at manifest time and frozen for the duration of the session. The guildhall may change during a commission; the anima does not see those changes.

Sessions run in bare mode (no CLAUDE.md), with session persistence disabled, and with appropriate permissions flags.

---

## The Books

The guild's operational database is organized into the guild's Books — the Register (who exists), the Ledger (what work is happening), and the Daybook (what happened) — plus the Clockworks' own internal state. See [The Guild Metaphor](../guild-metaphor.md#the-books) for the full conceptual model.

The Books do not track what's installed (that's `guild.json`) or what artifacts exist (that's the filesystem).

**Schema** is owned by the Nexus framework and lives in `nexus/migrations/`. The `ledger-migrate` engine (also framework-provided) applies pending migrations. It runs at guild bootstrap, before dispatch, and on demand after framework upgrades.

**Access** is always mediated through tools. Animas never touch the Books directly — they use tools that provide a clean interface. This means:

- The schema can change without changing anima behavior (tool absorbs the change)
- Animas can't accidentally corrupt operational data
- All writes are auditable through the tool layer

The Books are guild infrastructure — owned by the institution, maintained by framework engines, accessed through tools.

---

## Vocabulary

This document uses the guild vocabulary defined in [`guild-metaphor.md`](../guild-metaphor.md), the writ design in [`writs.md`](writs.md), and the project philosophy in [`philosophy.md`](../philosophy.md). Key metaphor concepts used throughout: guild, patron, anima, commission, writ, mandate, works, workshop, threshold, codex, curriculum, temperament, oath *(v2)*, edict *(v2)*, engine, tool, relic, guildhall, the Books (register, ledger, daybook), clockworks, standing order.

One term is specific to this architecture and not defined in the metaphor:

**Nexus** — the framework that makes guilds operational. Provides the base tools, engines, and database schema (Books + Clockworks). Managed via the Nexus CLI.

---

## Dispatch / Manifest Boundary

The dispatch tool and manifest engine have a clean separation of concerns:

- **Dispatch** (tool, wielded by leadership) — the *decision*. Posts a commission to the Ledger, assigns an anima, records the assignment, and triggers the manifest engine.
- **Manifest** (engine, mechanical) — the *preparation*. Reads the assignment from the Ledger, resolves the anima's composition from the Register, gathers all instruction sources (codex, curriculum, temperament, tool instructions), assembles the system prompt via template, prepares the commission brief as the initial prompt, configures the session (model, worktree cwd, flags), and launches it.

The boundary: dispatch writes to the Ledger and triggers; manifest reads from the Ledger and Register and executes. Dispatch decides *who does what*; manifest handles *assembling their identity and sending them to work*.

---

## Open Questions

---

## Future Work (draft documents needed)

- **Performance assessment and improvement** — How the guild monitors outcome quality, identifies underperforming curricula or temperaments, and drives improvement.

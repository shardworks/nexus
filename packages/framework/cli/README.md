# `@shardworks/nexus`

The `nsg` command-line interface for Nexus guilds. The CLI is the patron's and operator's primary entry point — it provides framework commands for guild lifecycle and plugin management, and dynamically discovers plugin-contributed tools via The Instrumentarium.

The CLI has two layers of commands:

1. **Framework commands** — hardcoded in the CLI package. Always available, even without a guild. Guild lifecycle (`init`, `status`, `version`, `upgrade`) and plugin management (`plugin list/install/remove/upgrade`).
2. **Plugin tools** — discovered at runtime from The Instrumentarium (`tools` apparatus). Only available when inside a guild that has the tools apparatus installed. Each tool is contributed by a kit or apparatus; the CLI auto-generates Commander commands from the tool's Zod param schema.

---

## Binary Names

| Binary | Description |
|---|---|
| `nsg` | The v2 CLI — framework commands + dynamic tool discovery via The Instrumentarium |

During development from the monorepo root:

```sh
pnpm nsg <command>
```

---

## How It Works

### Command Discovery

At startup:

1. Pre-parse `--guild-root` to locate the guild (or auto-detect by walking up from cwd)
2. Register framework commands (always available — see [Framework Commands](#framework-commands))
3. If inside a guild: call `createGuild()` to start the runtime, then query The Instrumentarium for all tools with `callableBy: 'cli'`
4. Auto-generate Commander commands from each tool's Zod param schema

If the guild doesn't have the tools apparatus installed, only framework commands are available.

### Auto-Grouping

Tool names are automatically grouped by hyphen prefix when two or more tools share a prefix:

```
plugin-list + plugin-install  →  nsg plugin list / nsg plugin install
session-list + session-show   →  nsg session list / nsg session show
signal (no group)             →  nsg signal
```

A tool like `show-writ` stays flat (`nsg show-writ`) if no other tool starts with `show-`.

### Flag Generation

Zod param schemas are converted to Commander flags:

| Zod schema | Commander flag |
|---|---|
| `z.string()` (required) | `--param <value>` (required) |
| `z.string().optional()` | `--param <value>` (optional) |
| `z.boolean()` | `--param` (flag, no value) |
| `z.union([z.enum([…]), z.array(…)])` | `--param <value>` (repeatable, collects into array) |
| camelCase key | `--kebab-case` flag |

### Positional ID Convention

Tools with exactly one required string parameter named `id` or ending with `Id` automatically accept that parameter as a positional argument in addition to the `--id` flag:

```sh
# These are equivalent:
nsg click show c-abc123
nsg click show --id c-abc123
```

The flag takes precedence if both are provided. This convention applies automatically to any matching tool — no metadata changes needed.

### Guild Root Resolution

The CLI resolves the guild root in priority order:

1. **`--guild-root <path>`** — CLI flag (highest priority)
2. **`GUILD_ROOT` environment variable** — useful for CI, containers, and scripted workflows
3. **Auto-detect** — walks up from cwd until it finds `guild.json` (same as how git finds `.git/`)

```sh
# Explicit flag
nsg --guild-root /opt/guilds/my-guild status

# Environment variable
export GUILD_ROOT=/opt/guilds/my-guild
nsg status

# Auto-detect (default) — run from inside the guild tree
cd /opt/guilds/my-guild/some/subdir
nsg status
```

Plugin-contributed tools require a guild. Framework commands work without one.

---

## Framework Commands

Framework commands are defined in the CLI package itself (`src/commands/`). They handle guild lifecycle and plugin management — operations that need to work before any plugins are loaded, or without a guild at all.

### Guild Lifecycle

| Command | Description |
|---|---|
| `nsg init <path>` | Create a new guild: directory structure, `guild.json`, `package.json`, `.gitignore` |
| `nsg status` | Show guild identity and installed plugins |
| `nsg version` | Show Nexus framework version and installed plugin versions |
| `nsg upgrade` | Upgrade framework and run pending plugin migrations *(stub)* |

### Plugin Management

| Command | Description |
|---|---|
| `nsg plugin list` | List installed plugins |
| `nsg plugin install <source>` | Install a plugin from npm, a git URL, or a local directory |
| `nsg plugin remove <name>` | Remove a plugin |
| `nsg plugin upgrade <name>` | Upgrade a plugin to a newer version *(stub)* |

### Event Emission

| Command | Description |
|---|---|
| `nsg signal <name> [--payload '<json>']` | Emit a custom event into the Clockworks events book with `emitter='operator'` |

`nsg signal` is hand-written rather than auto-generated from the
clockworks `signal` tool — the auto-builder cannot JSON-parse a
record-shaped `--payload` flag, and the operator emitter default
differs from the tool's `'anima'` default. The event name must be
declared under `clockworks.events` in `guild.json`; reserved framework
namespaces (`anima.`, `commission.`, `tool.`, `migration.`, `guild.`,
`standing-order.`, `session.`) and writ-lifecycle patterns
(`<type>.{ready,completed,stuck,failed}`) are rejected.

#### `nsg init`

Writes the minimum viable guild. Does not run `git init`, create the database, or instantiate animas — those are separate steps.

```sh
nsg init ./my-guild --name my-guild
cd my-guild
nsg plugin install @shardworks/clerk
```

#### `nsg plugin install`

Accepts npm package specifiers, version pins, and git URLs:

```sh
nsg plugin install @shardworks/clerk
nsg plugin install @shardworks/clerk@1.2.0
nsg plugin install git+https://github.com/acme/my-plugin.git

# Symlink a local directory (dev workflow)
nsg plugin install ./path/to/my-plugin --type link
```

Plugin install is a pure npm + guild.json operation — it adds the package as a dependency and registers the plugin id. Tool access is controlled by the permission model: tools declare permission levels, and roles grant `plugin:level` permissions via the Loom's configuration. See [The Instrumentarium](../../docs/architecture/apparatus/instrumentarium.md) for the permission model.

---

## Standard Guild Commands

The Guild CLI bundles command implementations from several plugin packages. Each plugin registers its own command groups.

### Commissions and Writs

All commission and writ commands come from the `clerk` plugin.

| Command | Source | Description |
|---|---|---|
| `nsg commission post` | clerk | Post a new commission, creating a writ in ready status |
| `nsg writ list` | clerk | List writs with optional filters |
| `nsg writ show` | clerk | Show full detail for a writ |
| `nsg writ accept` | clerk | Accept a writ, transitioning it from ready to active |
| `nsg writ complete` | clerk | Complete a writ, transitioning it from ready or active to completed |
| `nsg writ fail` | clerk | Fail a writ, transitioning it from active to failed |
| `nsg writ cancel` | clerk | Cancel a writ, transitioning it from ready or active to cancelled |
| `nsg writ link` | clerk | Link two writs with a typed relationship |
| `nsg writ unlink` | clerk | Remove a link between two writs |

### Sessions

Session commands come from the `animator` and `parlour` plugins.

| Command | Source | Description |
|---|---|---|
| `nsg summon` | animator | Summon an anima -- compose context and launch a session |
| `nsg session list` | animator | List recent sessions with optional filters |
| `nsg session show` | animator | Show full detail for a single session by id |
| `nsg conversation list` | parlour | List conversations with optional filters |
| `nsg conversation show` | parlour | Show full detail for a conversation including all turns |
| `nsg conversation end` | parlour | End an active conversation |

### Codexes and Drafts

Codex and draft commands come from the `codexes` plugin.

| Command | Source | Description |
|---|---|---|
| `nsg codex add` | codexes | Register an existing git repository as a guild codex |
| `nsg codex list` | codexes | List all codexes registered with the guild |
| `nsg codex show` | codexes | Show details of a registered codex including active draft bindings |
| `nsg codex remove` | codexes | Remove a codex from the guild (does not affect the remote repository) |
| `nsg codex push` | codexes | Push a branch to the codex remote |
| `nsg draft open` | codexes | Open a draft binding on a codex (creates an isolated git worktree) |
| `nsg draft list` | codexes | List active draft bindings, optionally filtered by codex |
| `nsg draft abandon` | codexes | Abandon a draft binding (removes the git worktree and branch) |
| `nsg draft seal` | codexes | Seal a draft binding into the codex (ff-only merge or rebase; no merge commits) |

### Rigs

Rig and crawl commands come from the `spider` plugin.

| Command | Source | Description |
|---|---|---|
| `nsg rig list` | spider | List rigs with optional filters |
| `nsg rig show` | spider | Retrieve a rig by id |
| `nsg rig for-writ` | spider | Find the rig for a given writ |
| `nsg rig resume` | spider | Manually clear a block on a specific engine, regardless of checker result |
| `nsg crawl one` | spider | Execute one step of the Spider's crawl loop |
| `nsg crawl continual` | spider | Run the Spider's crawl loop continuously |

### Clicks

Click (task tracking) commands come from the `ratchet` plugin.

| Command | Source | Description |
|---|---|---|
| `nsg click create` | ratchet | Create a new click |
| `nsg click show` | ratchet | Show full detail for a click including links, parent, and children context |
| `nsg click list` | ratchet | List clicks with optional filters (status, parentId, rootId) |
| `nsg click tree` | ratchet | Display click hierarchy as a visual tree with status indicators |
| `nsg click park` | ratchet | Park a live click |
| `nsg click resume` | ratchet | Resume a parked click |
| `nsg click conclude` | ratchet | Conclude a click |
| `nsg click drop` | ratchet | Drop a click |
| `nsg click reparent` | ratchet | Move a click to a new parent or root |
| `nsg click link` | ratchet | Create a typed link between clicks |
| `nsg click unlink` | ratchet | Remove a link |
| `nsg click extract` | ratchet | Extract a click tree as markdown or JSON |

### Introspection

Introspection commands come from the `tools` plugin (Instrumentarium).

| Command | Source | Description |
|---|---|---|
| `nsg tools list` | tools | List available tools with optional caller/plugin filters |
| `nsg tools show` | tools | Show full detail for a tool by name |

### Planned

The following commands are planned but not yet implemented. No plugin currently contributes them.

| Command | Source | Description |
|---|---|---|
| `nsg anima create` | — | *(Planned)* Create a new anima |
| `nsg anima list` | — | *(Planned)* List animas |
| `nsg anima show` | — | *(Planned)* Show anima detail |
| `nsg anima update` | — | *(Planned)* Update anima configuration |
| `nsg anima remove` | — | *(Planned)* Retire an anima |
| `nsg anima manifest` | — | *(Planned)* Preview the manifest for an anima |
| `nsg event list` | — | *(Planned)* List recent events |
| `nsg event show` | — | *(Planned)* Show event detail |
| `nsg dispatch list` | — | *(Planned)* List recent dispatches |
| `nsg audit list` | — | *(Planned)* List audit entries |

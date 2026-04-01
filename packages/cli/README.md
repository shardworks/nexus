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
3. If inside a guild: call `createGuild()` to start the runtime, then query The Instrumentarium for all tools with `callableFrom: 'cli'`
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
| camelCase key | `--kebab-case` flag |

### Guild Root Resolution

The CLI finds the guild root the same way git finds `.git/` — walking up from cwd until it finds `guild.json`. Override with `--guild-root <path>`.

Plugin-contributed tools require a guild. Framework commands work without one.

---

## Framework Commands

Framework commands are defined in the CLI package itself (`src/commands/`). They handle guild lifecycle and plugin management — operations that need to work before any plugins are loaded, or without a guild at all.

### Guild Lifecycle

| Command | Description |
|---|---|
| `nsg init <path>` | Create a new guild: directory structure, `guild.json`, `package.json`, `.gitignore` |
| `nsg status` | Show guild identity, installed plugins, and configured roles |
| `nsg version` | Show Nexus framework version and installed plugin versions |
| `nsg upgrade` | Upgrade framework and run pending plugin migrations *(stub)* |

### Plugin Management

| Command | Description |
|---|---|
| `nsg plugin list` | List installed plugins |
| `nsg plugin install <source>` | Install a plugin from npm, a git URL, or a local directory |
| `nsg plugin remove <name>` | Remove a plugin and unregister its tools |
| `nsg plugin upgrade <name>` | Upgrade a plugin to a newer version *(stub)* |

#### `nsg init`

Writes the minimum viable guild. Does not run `git init`, create the database, or instantiate animas — those are separate steps.

```sh
nsg init ./my-guild --name my-guild
cd my-guild
nsg plugin install @shardworks/nexus-stdlib
```

#### `nsg plugin install`

Accepts npm package specifiers, version pins, and git URLs:

```sh
nsg plugin install @shardworks/nexus-stdlib
nsg plugin install nexus-stdlib@1.2.0
nsg plugin install git+https://github.com/acme/my-plugin.git

# Symlink a local directory (dev workflow)
nsg plugin install ./path/to/my-plugin --type link
```

Tools are added to `baseTools` by default (available to all animas). Pass `--roles` to assign to specific roles instead:

```sh
nsg plugin install @shardworks/nexus-stdlib --roles artificer,scribe
```

---

## Standard Guild Commands

> **Note:** The standard kits are still being developed. This inventory reflects the target command set for a default `nsg init` guild. Some commands listed here are only available via `nsg1` (v1 legacy) until migration is complete. Update this section once the standard kit set is finalized.

### Commissions and Writs

| Command | Source | Description |
|---|---|---|
| `nsg writ post` | nexus-stdlib | Post a new commission (creates a mandate writ) |
| `nsg writ list` | nexus-stdlib | List writs with optional filters |
| `nsg writ show` | nexus-stdlib | Show full detail for a writ |
| `nsg writ update` | nexus-stdlib | Update writ fields (status, spec, etc.) |

### Animas

| Command | Source | Description |
|---|---|---|
| `nsg anima create` | nexus-stdlib | Create a new anima |
| `nsg anima list` | nexus-stdlib | List animas |
| `nsg anima show` | nexus-stdlib | Show anima detail (roles, curriculum, temperament) |
| `nsg anima update` | nexus-stdlib | Update anima configuration |
| `nsg anima remove` | nexus-stdlib | Retire an anima |
| `nsg anima manifest` | nexus-stdlib | Preview the manifest that would be assembled for an anima |

### Sessions and Conversations

| Command | Source | Description |
|---|---|---|
| `nsg consult` | cli (v1) | Start an interactive conversation with an anima |
| `nsg convene` | cli (v1) | Start a multi-anima conversation |
| `nsg session list` | animator (supportKit) | List recent sessions |
| `nsg session show` | animator (supportKit) | Show session detail (tokens, cost, duration) |
| `nsg conversation list` | parlour (supportKit) | List conversations |
| `nsg conversation show` | parlour (supportKit) | Show conversation detail with turn history |
| `nsg conversation end` | parlour (supportKit) | End an active conversation |

### Clockworks

| Command | Source | Description |
|---|---|---|
| `nsg signal` | nexus-stdlib | Signal a custom event |
| `nsg clock start` | cli (v1) | Start the Clockworks daemon |
| `nsg clock stop` | cli (v1) | Stop the Clockworks daemon |
| `nsg clock status` | cli (v1) | Show daemon status |
| `nsg clock tick` | cli (v1) | Process one pending event (manual mode) |
| `nsg clock run` | cli (v1) | Process all pending events (manual mode) |
| `nsg clock list` | cli (v1) | List standing orders |
| `nsg event list` | nexus-stdlib | List recent events |
| `nsg event show` | nexus-stdlib | Show event detail |

### Workshops

| Command | Source | Description |
|---|---|---|
| `nsg workshop create` | cli (v1) | Create a new workshop (bare repo) |
| `nsg workshop register` | cli (v1) | Register an existing repo as a workshop |
| `nsg workshop list` | cli (v1) | List registered workshops |
| `nsg workshop show` | cli (v1) | Show workshop detail |
| `nsg workshop remove` | cli (v1) | Unregister a workshop |

### Operations

| Command | Source | Description |
|---|---|---|
| `nsg dispatch list` | nexus-stdlib | List recent dispatches |
| `nsg audit list` | nexus-stdlib | List audit entries |
| `nsg dashboard` | cli (v1) | Open the guild dashboard |

---

## Migration Status (v1 → v2)

The v2 CLI dynamically discovers plugin-contributed tools via The Instrumentarium. Commands that are still hardcoded in v1 need to be migrated to the plugin architecture (either as tools in a kit/apparatus supportKit, or as framework commands).

**Migrated to v2:**
- Framework commands: `init`, `status`, `version`, `upgrade`, `plugin list/install/remove/upgrade`
- All tool-based commands discovered via The Instrumentarium

**Remaining in v1 only:**
- `consult`, `convene` — interactive session launchers (need Animator/Parlour integration)
- `clock *` — Clockworks daemon management
- `workshop *` — workshop lifecycle
- `dashboard` — guild dashboard
- `guild restore`, `guild upgrade-books` — guild maintenance

These will migrate as the corresponding apparatus are implemented and expose the necessary tools via their supportKits.

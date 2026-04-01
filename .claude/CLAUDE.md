# Nexus Framework — Agent Instructions

This is the source repository for the Nexus framework: the TypeScript packages that power multi-agent guild workspaces.

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js (v24)
- **Monorepo:** pnpm workspaces
- **Database:** SQLite (WAL mode) via better-sqlite3
- **CLI:** Commander.js (`nsg` command)
- **Published under:** `@shardworks` npm scope

## Project Structure

```
nexus/
├── packages/                    # pnpm workspace packages
│   ├── core/                    # @shardworks/nexus-core — shared framework library
│   │   └── src/                 #   anima, clockworks, commission, conversation, writ,
│   │                            #   session, events, manifest, guild-config, workshop, etc.
│   ├── cli/                     # @shardworks/nexus — the `nsg` CLI
│   │   └── src/commands/        #   init, status, version, upgrade, plugin management
│   ├── claude-code-session-provider/  # Session provider (launches claude CLI sessions)
│   └── guild-starter-kit/       # Scaffolding for new guilds
│       ├── migrations/          #   SQL migrations (001-initial, 002-writs, 003-conversations)
│       ├── curricula/           #   guild-operations curriculum
│       └── temperaments/        #   artisan, guide
├── docs/                        # Framework documentation
│   ├── philosophy.md            #   Project "why" — experiment goals, Mk 2.0 vs 2.1
│   ├── guild-metaphor.md        #   Conceptual model (metaphorical register, not technical)
│   ├── architecture/            #   System design: overview, clockworks, writs, tools-and-engines
│   ├── reference/               #   Lookup docs: core-api, schema, event-catalog, conversations
│   └── guides/                  #   How-to: building-tools, building-engines
├── bin/
│   └── upgrade-guild.sh         # Wait for publish workflow, then upgrade nsg in a guild
└── .github/workflows/           # CI (ci.yml) and npm publish (publish.yml)
```

### Key Concepts

- **Guild** — an instantiated workspace where animas operate. Created via `nsg init`.
- **Anima** — an AI identity with a name, role, curriculum, and temperament.
- **Commission** — a posted unit of work from the patron. Creates a `mandate` writ.
- **Writ** — a typed, tree-structured work item tracking an obligation through its lifecycle (`ready → active → pending → completed/failed/cancelled`).
- **Clockworks** — the event-driven dispatch layer. Standing orders bind event patterns to handlers (engines or summons).
- **Session** — a single agent invocation through the session funnel (manifest → launch → record).
- **Conversation** — multi-turn interaction grouping multiple sessions via `--resume`.

## Directives

- **Self-document for other agents.** Write commit messages, code comments, and documentation with the assumption that your primary audience is other agents who will continue the work. Be precise and concise; include enough context for an agent to pick up where you left off.
- **Commit early and often.** Make small, atomic commits as work is completed. Do not accumulate large uncommitted changesets. Never leave uncommitted or untracked files in the project root. This is critical in a multi-agent environment where conflicts are a real risk.
- **Minimize conflict surface.** Structure work to reduce the likelihood of git conflicts with other agents. Prefer adding new files over modifying shared ones. When modifying shared files, keep changes narrow and well-scoped. Commit and merge promptly rather than holding long-lived branches.
- **Tests are not optional.** All changes to `core` must include tests. Run `pnpm test` before committing.
- **Version bumps trigger publish.** The `publish.yml` workflow fires on every push to `main` and publishes any packages whose version has changed. Bump versions deliberately.

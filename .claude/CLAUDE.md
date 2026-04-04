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
├── packages/
│   ├── framework/                   # Core infrastructure (not plugins)
│   │   ├── core/                    #   @shardworks/nexus-core — public SDK surface
│   │   ├── arbor/                   #   @shardworks/nexus-arbor — guild runtime host
│   │   └── cli/                     #   @shardworks/nexus — the `nsg` CLI
│   └── plugins/                     # Guild plugins (apparatus + kits)
│       ├── stacks/                  #   @shardworks/stacks-apparatus — persistence (NoSQL + CDC)
│       ├── tools/                   #   @shardworks/tools-apparatus — tool registry
│       ├── loom/                    #   @shardworks/loom-apparatus — session context composition
│       ├── animator/                #   @shardworks/animator-apparatus — session launch + recording
│       ├── claude-code/             #   @shardworks/claude-code-apparatus — Claude CLI provider
│       ├── clerk/                   #   @shardworks/clerk-apparatus — writ lifecycle management
│       ├── codexes/                 #   @shardworks/codexes-apparatus — git repo management (bare clones, drafts, worktrees)
│       ├── fabricator/              #   @shardworks/fabricator-apparatus — engine pipeline definitions
│       ├── spider/                  #   @shardworks/spider-apparatus — autonomous dispatch (crawl → rig → engine pipeline)
│       ├── parlour/                 #   @shardworks/parlour-apparatus — web dashboard
│       └── walker/                  #   (deprecated — renamed to spider)
├── docs/                            # Framework documentation
│   ├── philosophy.md                #   Project "why" — experiment goals, Mk 2.0 vs 2.1
│   ├── guild-metaphor.md            #   Conceptual model (metaphorical register, not technical)
│   ├── architecture/                #   System design docs and apparatus API contracts
│   ├── reference/                   #   API reference (core-api, schema, event-catalog, conversations)
│   ├── guides/                      #   How-to guides (building engines, building tools)
│   └── feature-specs/               #   Authoritative design specs for major features
├── bin/
│   └── upgrade-guild.sh             # Wait for publish workflow, then upgrade nsg in a guild
└── .github/workflows/               # CI (ci.yml) and npm publish (publish.yml)
```

## Directives

- **Self-document for other agents.** Write commit messages, code comments, and documentation with the assumption that your primary audience is other agents who will continue the work. Be precise and concise; include enough context for an agent to pick up where you left off.
- **Minimize conflict surface.** Structure work to reduce the likelihood of git conflicts with other agents. Prefer adding new files over modifying shared ones. When modifying shared files, keep changes narrow and well-scoped. Commit and merge promptly rather than holding long-lived branches.

# Core API Reference

`@shardworks/nexus-core` — the shared infrastructure library for the guild system. All functions take `home: string` (the guild root path) as their first argument unless noted otherwise.

---

## Authoring

The SDK factories for building tools and engines. These are the primary entry points for anyone extending the guild with new capabilities.

### `tool(def): ToolDefinition`

Define a Nexus tool. The primary SDK entry point for module-based tools.

```typescript
tool({
  name: string,
  description: string,
  params: { [key: string]: ZodType },
  handler: (params, context: ToolContext) => unknown | Promise<unknown>,
  instructions?: string,        // inline text (mutually exclusive with instructionsFile)
  instructionsFile?: string,    // path resolved at manifest time
}): ToolDefinition
```

The handler receives validated params (typed from the Zod schemas) and a `ToolContext` (`{ home: string }`). Return any JSON-serializable value. Throw for errors.

### `engine(def): EngineDefinition`

Define a clockwork engine — an event-driven handler invoked by standing orders.

```typescript
engine({
  name: string,
  handler: (event: GuildEvent | null, ctx: EngineContext) => Promise<void>,
}): EngineDefinition
```

The handler receives the triggering `GuildEvent` (or `null` for direct invocation) and an `EngineContext` (`{ home: string }`).

### `isToolDefinition(obj): obj is ToolDefinition`

Type guard — checks if a value is a `ToolDefinition` (has `name`, `description`, `params`, `handler`).

### `isClockworkEngine(obj): obj is EngineDefinition`

Type guard — checks if a value has the `__clockwork: true` brand.

### `resolveToolFromExport(moduleDefault, toolName?): ToolDefinition | null`

Resolve a single tool from a module's default export. Handles single-tool exports (`export default tool({...})`) and array exports (`export default [tool({...}), ...]`). For arrays, matches by `toolName`.

### `resolveAllToolsFromExport(moduleDefault): ToolDefinition[]`

Resolve all tools from a module's default export. Returns an array regardless of whether the export is a single tool or an array.

### `resolveEngineFromExport(moduleDefault, engineName?): EngineDefinition | null`

Resolve a single engine from a module's default export. Same pattern as `resolveToolFromExport`.

### Types

| Type | Description |
|------|-------------|
| `ToolContext` | `{ home: string }` — injected into tool handlers |
| `ToolDefinition<TShape>` | A fully-defined tool (return type of `tool()`) |
| `GuildEvent` | `{ id, name, payload, emitter, firedAt }` — immutable event from the queue |
| `EngineContext` | `{ home: string }` — injected into engine handlers |
| `EngineDefinition` | A fully-defined clockwork engine (return type of `engine()`) |

---

## Events

The event system — signaling, reading, validation, dispatch recording. Events are immutable facts persisted to the Clockworks event queue. The Clockworks runner processes them separately via `nsg clock`.

### `signalEvent(home, name, payload, emitter): string`

Signal an event — persist it to the Clockworks events table. Does **not** process the event.

- `name` — event name (e.g. `"commission.posted"`, `"code.reviewed"`)
- `payload` — JSON-serializable event data, or `null`
- `emitter` — who signaled it: anima name, engine name, or `"framework"`
- **Returns:** the event ID (e.g. `"evt-a3f7b2c1"`)

### `isFrameworkEvent(name): boolean`

Check if an event name is in a reserved framework namespace. Reserved namespaces: `anima.`, `commission.`, `tool.`, `migration.`, `guild.`, `standing-order.`, `session.`. Note: writ lifecycle events (e.g. `mandate.ready`, `task.completed`) are framework-emitted but use guild-defined type names — they are not in this list. See [Event Catalog](event-catalog.md#writ-lifecycle-events).

### `validateCustomEvent(home, name): void`

Validate that a custom event name is declared in `guild.json` clockworks.events. **Throws** if the name is in a reserved namespace or not declared.

### `readPendingEvents(home): GuildEvent[]`

Read all unprocessed events from the queue, ordered by `fired_at` ascending.

### `readEvent(home, id): GuildEvent | null`

Read a single event by ID.

### `markEventProcessed(home, eventId): void`

Mark an event as processed (sets `processed = 1`).

### `listEvents(home, opts?): GuildEvent[]`

List events with optional filters. Returns newest first.

**Options (`ListEventsOptions`):**
- `name?: string` — filter by name pattern (SQL `LIKE` — use `%` for wildcards)
- `emitter?: string` — filter by emitter
- `pending?: boolean` — `true` = unprocessed only, `false` = processed only, omit for all
- `limit?: number` — max results

### `listDispatches(home, opts?): DispatchRecord[]`

List event dispatch records with optional filters.

**Options (`ListDispatchesOptions`):**
- `eventId?: string`
- `handlerType?: string` — `"engine"` or `"anima"`
- `handlerName?: string`
- `status?: string` — `"success"` or `"error"`
- `limit?: number`

### `recordDispatch(home, opts): void`

Record a dispatch in the `event_dispatches` table. Used by the Clockworks runner.

```typescript
recordDispatch(home, {
  eventId: string,
  handlerType: 'engine' | 'anima',
  handlerName: string,
  targetRole?: string,
  noticeType?: 'summon' | 'brief',
  startedAt: string,
  endedAt: string,
  status: 'success' | 'error',
  error?: string,
})
```

### Types

| Type | Description |
|------|-------------|
| `ListEventsOptions` | Filters for `listEvents()` |
| `DispatchRecord` | A single dispatch record (id, eventId, handlerType, handlerName, etc.) |
| `ListDispatchesOptions` | Filters for `listDispatches()` |

---

## Register

Anima identity and lifecycle — creation, querying, updating, and removal.

### `instantiate(opts): InstantiateResult`

Create a new anima in the guild. Validates roles exist and have available seats, reads and snapshots curriculum/temperament content at current versions. All operations run in a single transaction.

**Options (`InstantiateOptions`):**
- `home: string`
- `name: string` — must be unique
- `roles: string[]` — at least one required; each must be defined in guild.json
- `curriculum?: string` — by name (must be registered in guild.json)
- `temperament?: string` — by name (must be registered in guild.json)

**Returns (`InstantiateResult`):** `{ animaId, name, roles, curriculum, temperament }`

### `listAnimas(home, opts?): AnimaSummary[]`

List animas with optional filters by `status` and/or `role`.

### `showAnima(home, animaId): AnimaDetail | null`

Show detailed info for a single anima. Accepts either ID or name.

### `updateAnima(home, animaId, opts): AnimaDetail`

Update an anima's status and/or roles. Accepts either ID or name. When updating roles, replaces all existing roles.

**Options (`UpdateAnimaOptions`):**
- `status?: string` — new status value
- `roles?: string[]` — complete replacement set

### `removeAnima(home, animaId): void`

Retire an anima — sets status to `'retired'` and removes all roster entries. Accepts either ID or name.

### Manifest Functions

These functions assemble an anima's identity for a session.

### `readAnima(home, animaName): AnimaRecord`

Read an anima's full record including roles and composition metadata. **Throws** if not found.

### `resolveTools(home, config, animaRoles): Promise<{ available, unavailable, warnings }>`

Resolve the set of tools an anima has access to based on role definitions and precondition checks. Starts with `baseTools`, unions in each role's tools, deduplicates, resolves from disk, runs precondition checks.

**Returns:**
- `available: ResolvedTool[]` — tools the anima can use
- `unavailable: UnavailableTool[]` — tools that failed preconditions
- `warnings: string[]` — e.g. undefined roles, missing tools

### `readCodex(home): string`

Read all `.md` files from the `codex/` directory (non-recursive). Returns them joined with `---` separators.

### `readRoleInstructions(home, config, animaRoles): string`

Read role-specific instructions for an anima's roles from the files pointed to by role definitions in guild.json.

### `assembleSystemPrompt(codex, roleInstructions, anima, tools, unavailable?): string`

Assemble the composed system prompt. Sections included in order: Codex → Role Instructions → Training (curriculum) → Temperament → Tool Instructions → Unavailable Tools notice.

### `manifest(home, animaName): Promise<ManifestResult>`

The main entry point for session preparation. Reads composition, resolves tools, assembles system prompt. **Throws** if anima is not active.

**Returns (`ManifestResult`):**
- `anima: AnimaRecord`
- `systemPrompt: string`
- `composition: { codex, roleInstructions, curriculum, temperament, toolInstructions }`
- `tools: ResolvedTool[]`
- `unavailable: UnavailableTool[]`
- `warnings: string[]`

### Types

| Type | Description |
|------|-------------|
| `AnimaSummary` | id, name, status, roles, createdAt |
| `AnimaDetail` | Full detail including curriculum/temperament names and versions |
| `AnimaRecord` | Full record with composition snapshots (used by manifest) |
| `ListAnimasOptions` | `{ status?, role? }` |
| `UpdateAnimaOptions` | `{ status?, roles? }` |
| `InstantiateOptions` | Options for `instantiate()` |
| `InstantiateResult` | `{ animaId, name, roles, curriculum, temperament }` |
| `ResolvedTool` | `{ name, path, instructions, package }` |
| `UnavailableTool` | `{ name, reasons[] }` |
| `ManifestResult` | Full manifest with composition provenance |

---

## Ledger

Commission lifecycle and writ CRUD. All entities are historical records — no deletes, only status transitions.

### Commissions

#### `commission(opts): CommissionResult`

Post a commission to the guild. Creates a record with status `"posted"`, creates a mandate writ linked to the commission, and signals `commission.posted`. Validates that the workshop exists in guild.json.

**Options (`CommissionOptions`):** `{ home, spec, workshop }`

**Returns:** `{ commissionId }`

#### `listCommissions(home, opts?): CommissionSummary[]`

List commissions. Filter by `status` and/or `workshop`.

#### `readCommission(home, commissionId): { id, content, status, workshop, statusReason, writId } | null`

Read a commission record (basic fields only).

#### `showCommission(home, commissionId): CommissionDetail | null`

Extended commission view including assignments (anima ID, name, assigned-at) and linked sessions (session ID, anima ID, started/ended-at).

#### `updateCommissionStatus(home, commissionId, status, reason): void`

Update a commission's status and reason.

### Writs

#### `createWrit(home, opts): WritRecord`

Create a writ. Signals `{type}.ready`. Options: `{ type, title, description?, parentId? }`. The type must be a built-in type (`mandate`, `summon`) or declared in `guild.json` `writTypes`.

#### `listWrits(home, opts?): WritRecord[]`

Filter by `status`, `type`, and/or `parentId`.

#### `showWrit(home, writId): WritRecord | null`

#### `updateWritStatus(home, writId, status): WritRecord`

Transition a writ's status. Signals `{type}.completed` on completion, `{type}.failed` on failure. Failure cascades cancellation to incomplete children.

#### `completeWrit(home, writId): CompletionResult`

Mark a writ as completed. If the writ has incomplete children, transitions to `pending` instead. When all children complete, auto-transitions to `ready` (if a standing order exists for `{type}.ready`) or `completed` (if not). Returns `{ changed, newStatus }`.

#### `failWrit(home, writId, reason): void`

Mark a writ as failed. Cascades cancellation to all incomplete children. Signals `{type}.failed`.

#### `getWritProgress(home, writId): WritProgress`

Returns `{ total, completed, failed, cancelled, pending, active, ready }` — counts of child writs by status.

### Shared Types

| Type | Description |
|------|-------------|
| `CompletionCheck` | `{ complete: boolean, total, done, pending, failed }` |
| `CompletionResult` | `{ changed: boolean, newStatus: string }` |
| `CommissionOptions` | `{ home, spec, workshop }` |
| `CommissionResult` | `{ commissionId }` |
| `CommissionSummary` | id, content, status, workshop, statusReason, createdAt, updatedAt |
| `CommissionDetail` | Summary + assignments[] + sessions[] |
| `ListCommissionsOptions` | `{ status?, workshop? }` |
| `WorkRecord` | id, commissionId, title, description, status, createdAt, updatedAt |
| `CreateWorkOptions` | `{ title, description?, commissionId? }` |
| `ListWorksOptions` | `{ status?, commissionId? }` |
| `UpdateWorkOptions` | `{ title?, description?, status? }` |
| `PieceRecord` | id, workId, title, description, status, createdAt, updatedAt |
| `CreatePieceOptions` | `{ title, description?, workId? }` |
| `ListPiecesOptions` | `{ status?, workId? }` |
| `UpdatePieceOptions` | `{ title?, description?, status? }` |
| `JobRecord` | id, pieceId, title, description, status, assignee, createdAt, updatedAt |
| `CreateJobOptions` | `{ title, description?, pieceId?, assignee? }` |
| `ListJobsOptions` | `{ status?, pieceId?, assignee? }` |
| `UpdateJobOptions` | `{ title?, description?, status?, assignee? }` |
| `StrokeRecord` | id, jobId, kind, content, status, createdAt, updatedAt |
| `CreateStrokeOptions` | `{ jobId, kind, content? }` |
| `ListStrokesOptions` | `{ jobId?, status? }` |
| `UpdateStrokeOptions` | `{ status?, content? }` |

---

## Daybook

Session tracking and audit trail.

### `listSessions(home, opts?): SessionSummary[]`

List sessions with optional filters. Returns newest first.

**Options (`ListSessionsOptions`):**
- `anima?: string` — filter by anima name or ID
- `workshop?: string`
- `trigger?: string` — `"consult"`, `"summon"`, `"brief"`, or `"convene"`
- `status?: 'active' | 'completed'` — active = no `ended_at`, completed = has `ended_at`
- `limit?: number`

### `showSession(home, sessionId): SessionDetail | null`

Full session detail including all token usage, cost, duration, composition metadata, and record path.

### `listAuditLog(home, opts?): AuditEntry[]`

List audit log entries, newest first.

**Options (`ListAuditLogOptions`):**
- `actor?: string` — e.g. `"patron"`, `"operator"`, `"framework"`, `"instantiate"`
- `action?: string` — e.g. `"commission_posted"`, `"anima_updated"`
- `targetType?: string` — e.g. `"commission"`, `"anima"`, `"writ"`
- `targetId?: string`
- `limit?: number`

### Session Funnel

The unified session infrastructure. ALL sessions flow through `launchSession()`.

### `registerSessionProvider(provider): void`

Register a session provider (e.g. claude-code, claude-api). Called once at startup.

### `getSessionProvider(): SessionProvider | null`

Get the registered session provider.

### `resolveWorkspace(payload): ResolvedWorkspace`

Resolve workspace context from an event payload. Returns `{ kind: 'guildhall' }`, `{ kind: 'workshop-temp', workshop, worktreePath }`, or `{ kind: 'workshop-managed', workshop, worktreePath }`.

### `createTempWorktree(home, workshop): string`

Create a temporary worktree from a workshop's bare repo (detached HEAD at main). Returns the absolute path.

### `removeTempWorktree(home, workshop, worktreePath): void`

Remove a temporary worktree. Logs but does not throw on failure.

### `launchSession(options): Promise<SessionResult>`

Launch a session through the registered provider. The complete lifecycle:
1. Create temp worktree (if `workshop-temp`)
2. Insert `session.started` row in Daybook
3. Signal `session.started` event
4. Delegate to provider
5. Update session row with metrics
6. Write SessionRecord JSON to `.nexus/sessions/`
7. Signal `session.ended` event
8. Tear down temp worktree (if autonomous + workshop-temp)

**Guarantees:** Steps 5–8 execute even if the provider throws.

### Types

| Type | Description |
|------|-------------|
| `SessionSummary` | id, animaId, provider, trigger, workshop, workspaceKind, startedAt, endedAt, exitCode, costUsd, durationMs |
| `SessionDetail` | Full record including token usage, composition metadata, providerSessionId, recordPath |
| `ListSessionsOptions` | Filters for `listSessions()` |
| `SessionProvider` | `{ name, launch(opts), launchStreaming?(opts) }` — the provider contract |
| `SessionProviderLaunchOptions` | What the provider receives (home, manifest, prompt, interactive, cwd, claudeSessionId?, ...) |
| `SessionProviderResult` | What the provider returns (exitCode, tokenUsage?, costUsd?, durationMs, ...) |
| `SessionLaunchOptions` | Full options for `launchSession()` — includes conversationId?, turnNumber?, claudeSessionId?, onChunk? |
| `SessionResult` | `{ sessionId, exitCode, tokenUsage?, costUsd?, durationMs, providerSessionId?, transcript?, conversationId?, turnNumber? }` |
| `SessionChunk` | Union: `{ type: 'text', text }` \| `{ type: 'tool_use', tool }` \| `{ type: 'tool_result', tool }` |
| `WorkspaceContext` | `{ workshop?, worktreePath? }` — standard event payload fields |
| `ResolvedWorkspace` | Discriminated union: guildhall, workshop-temp, or workshop-managed |
| `SessionRecord` | Full session record written to disk as JSON |
| `AuditEntry` | id, actor, action, targetType, targetId, detail, timestamp |
| `ListAuditLogOptions` | Filters for `listAuditLog()` |

---

## Conversations

Multi-turn interaction with animas — web consultation and convene sessions. See the **[Conversations API Reference](./conversations.md)** for the full guide including schema, integration patterns, and analytics queries.

### `createConversation(home, opts): CreateConversationResult`

Create a new conversation with participant records. Does NOT take a first turn.

### `takeTurn(home, conversationId, participantId, message): AsyncGenerator<ConversationChunk>`

Take a turn in a conversation. Manifests the anima, calls `launchSession()` with `--resume` threading, streams response chunks. The core primitive.

### `endConversation(home, conversationId, reason?): void`

End a conversation. Sets status to `'concluded'` or `'abandoned'`.

### `nextParticipant(home, conversationId): { participantId, name } | null`

Next participant in a convene rotation (round-robin). Returns `null` if done.

### `formatConveneMessage(home, conversationId, participantId): string`

Format the message for the next convene participant (new turns since their last).

### `listConversations(home, opts?): ConversationSummary[]`

List conversations. Filter by `status`, `kind`, `limit`.

### `showConversation(home, conversationId): ConversationDetail | null`

Full conversation detail including all turns.

### Types

| Type | Description |
|------|-------------|
| `ConversationChunk` | Union: text, tool_use, tool_result, turn_complete |
| `CreateConversationOptions` | Options for `createConversation()` |
| `CreateConversationResult` | `{ conversationId, participants[] }` |
| `ConversationSummary` | List view with computed turnCount and totalCostUsd |
| `ConversationDetail` | Full view with turns array |
| `ListConversationsOptions` | Filters for `listConversations()` |

---

## Clockworks

The event processing runner — matches pending events to standing orders and dispatches them.

### `clockTick(home, eventId?): Promise<TickResult | null>`

Process a single event. If `eventId` is provided, processes that specific event. Otherwise, processes the next pending event. Returns `null` if no events to process.

### `clockRun(home): Promise<ClockRunResult>`

Process all pending events until the queue is empty. Loops because standing order failures may generate new events (`standing-order.failed`).

### `clockStart(home, options?): ClockStartResult`

Start the clockworks daemon as a detached background process. The daemon polls the event queue at the specified interval and processes events automatically.

```typescript
clockStart(home, { interval: 2000 })
// => { pid: 12345, logFile: '/path/to/.nexus/clock.log' }
```

Options: `{ interval?: number }` — polling interval in ms (default 2000). All options are optional. Throws if the daemon is already running.

### `clockStop(home): ClockStopResult`

Stop the running clockworks daemon. Sends SIGTERM and removes the PID file. Handles stale PID files gracefully.

```typescript
clockStop(home)
// => { pid: 12345, stopped: true }
```

### `clockStatus(home): ClockStatus`

Check whether the clockworks daemon is running. Cleans up stale PID files automatically.

```typescript
clockStatus(home)
// => { running: true, pid: 12345, logFile: '...', uptime: 360000 }
// or { running: false }
```

### Types

| Type | Description |
|------|-------------|
| `TickResult` | `{ eventId, eventName, dispatches: DispatchSummary[] }` |
| `DispatchSummary` | `{ handlerType, handlerName, status, error? }` |
| `ClockRunResult` | `{ processed: TickResult[], totalEvents }` |
| `ClockStartOptions` | `{ interval?: number }` |
| `ClockStartResult` | `{ pid, logFile }` |
| `ClockStopResult` | `{ pid, stopped }` |
| `ClockStatus` | `{ running, pid?, logFile?, uptime? }` |

---

## Guild Config

Reading and writing `guild.json` — the guild's central configuration file.

### `readGuildConfig(home): GuildConfig`

Read and parse `guild.json` from the guild root.

### `writeGuildConfig(home, config): void`

Write `guild.json` to the guild root (pretty-printed with trailing newline).

### `guildConfigPath(home): string`

Resolve the path to `guild.json`.

### `createInitialGuildConfig(name, nexusVersion, model): GuildConfig`

Create the default guild.json content for a new guild. All registries start empty.

### Types

| Type | Description |
|------|-------------|
| `GuildConfig` | The full guild.json shape: name, nexus, model, workshops, roles, baseTools, tools, engines, curricula, temperaments, clockworks? |
| `RoleDefinition` | `{ seats: number \| null, tools: string[], instructions?: string }` |
| `ToolEntry` | `{ upstream, installedAt, package?, bundle? }` |
| `TrainingEntry` | `{ upstream, installedAt, bundle? }` |
| `WorkshopEntry` | `{ remoteUrl, addedAt }` |
| `EventDeclaration` | `{ description?, schema? }` |
| `StandingOrder` | `{ on, run }` or `{ on, summon }` or `{ on, brief }` |
| `ClockworksConfig` | `{ events?, standingOrders? }` |

---

## Infrastructure

Path resolution, ID generation, preconditions, workshops, worktrees, bundles, migrations, tool installation, and guild initialization.

### Paths

| Function | Returns |
|----------|---------|
| `findGuildRoot(startDir?)` | Guild root path (walks up looking for `guild.json`). Throws if not found. |
| `nexusDir(home)` | `.nexus` directory path |
| `booksPath(home)` | `.nexus/nexus.db` — the Books SQLite database |
| `ledgerPath(home)` | *(Deprecated)* Alias for `booksPath()` |
| `worktreesPath(home)` | `.nexus/worktrees` — commission worktrees root |
| `workshopsPath(home)` | `.nexus/workshops` — bare clone directory |
| `workshopBarePath(home, name)` | `.nexus/workshops/{name}.git` |

### IDs

#### `generateId(prefix): string`

Generate a prefixed hex ID: `{prefix}-{8 hex chars}`.

| Prefix | Entity |
|--------|--------|
| `a-` | anima |
| `c-` | commission |
| `conv-` | conversation |
| `cpart-` | conversation participant |
| `evt-` | event |
| `ses-` | session |
| `wrt-` | writ |

Additional prefixes used internally: `aud-` (audit log), `ed-` (event dispatch), `r-` (roster), `ac-` (anima composition), `ca-` (commission assignment).

### `VERSION: string`

The framework version string, read from `@shardworks/nexus-core/package.json`.

### Tool Installation

#### `installTool(opts): InstallResult`

Install a tool, engine, curriculum, or temperament into the guild. Supports five source types: registry, git-url, workshop, tarball, link.

**Options (`InstallToolOptions`):** `{ home, source, name?, roles?, commit?, link?, bundle? }`

**Returns (`InstallResult`):** `{ category, name, installedTo, sourceKind, warnings }`

#### `removeTool(opts): RemoveResult`

Remove a tool from the guild. Deregisters from guild.json, removes from disk, cleans up node_modules.

**Options (`RemoveToolOptions`):** `{ home, name, category? }`

#### `classifySource(source, link?): SourceKind`

Classify a source string: `'registry'`, `'git-url'`, `'workshop'`, `'tarball'`, or `'link'`.

### Tool Registry

#### `listTools(home, category?): ToolSummary[]`

List all installed artifacts from guild.json. Filter by category (`'tools'`, `'engines'`, `'curricula'`, `'temperaments'`).

### Preconditions

#### `readPreconditions(descriptorPath): Precondition[]`

Read preconditions from a descriptor file. Returns empty array if none declared.

#### `checkOne(precondition): PreconditionCheckResult`

Run a single precondition check.

#### `checkPreconditions(preconditions): PreconditionCheckResult[]`

Check all preconditions in an array.

#### `checkAllPreconditions(home, config): ToolPreconditionResult[]`

Check preconditions for all tools and engines in a guild.

#### `checkToolPreconditions(descriptorPath): PreconditionCheckResult[]`

Convenience wrapper for install-time warnings.

**Precondition types:**
- `CommandPrecondition` — checks if a command exists on PATH
- `CommandOutputPrecondition` — runs a command, checks stdout against a regex
- `EnvPrecondition` — checks if an env var is set and non-empty

### Workshops

#### `addWorkshop(opts): AddWorkshopResult`

Clone a remote repo as a bare clone and register in guild.json.

#### `removeWorkshop(opts): void`

Remove bare clone, worktrees, and guild.json entry.

#### `listWorkshops(home): WorkshopInfo[]`

List all workshops with status (cloned, active worktree count).

#### `showWorkshop(home, name): WorkshopDetail | null`

Detailed workshop info including bare path and default branch.

#### `createWorkshop(opts): AddWorkshopResult`

Create a new GitHub repo via `gh`, then add it as a workshop. Seeds with an initial commit on `main`.

#### `checkGhAuth(): string | null`

Check if `gh` is installed and authenticated. Returns `null` if OK, error message otherwise.

#### `deriveWorkshopName(input): string`

Derive a workshop name from a URL or `org/name` format.

### Worktrees

#### `setupWorktree(config): WorktreeResult`

Create a git worktree for a commission session. Creates a branch `commission-{id}` from the base branch.

#### `teardownWorktree(home, workshop, commissionId): void`

Remove a commission worktree. Does **not** delete the branch.

#### `listWorktrees(home, workshop?): WorktreeResult[]`

List active commission worktrees.

### Bundles

#### `readBundleManifest(bundleDir): BundleManifest`

Read and validate `nexus-bundle.json`. Enforces: tools/engines require `package`, content requires `package` or `path`, migrations require `path`.

#### `installBundle(opts): InstallBundleResult`

Install all artifacts from a bundle manifest. Handles transitive bundles (nested `nexus-bundle.json`).

#### `isBundleDir(dir): boolean`

Check if a directory contains `nexus-bundle.json`.

### Migrations

#### `discoverMigrations(migrationsDir): MigrationFile[]`

Discover migration files matching `NNN-description.sql`, sorted by sequence.

#### `applyMigrations(home, provenance?): MigrateResult`

Apply pending SQL migrations. Each runs in its own transaction. Tracks applied migrations in `_migrations` table.

### Upgrade

#### `planUpgrade(home, bundleDir, bundleSource?): UpgradePlan`

Plan a framework upgrade by diffing the guild's current state against a bundle. Read-only — inspects the guild and bundle but makes no changes. Returns an `UpgradePlan` describing new migrations, updated content, and stale animas.

#### `applyUpgrade(home, bundleDir, plan): UpgradeResult`

Apply an upgrade plan. Installs new migrations (renumbered into the guild's sequence), updates content artifacts (curricula/temperaments), and bumps the nexus version in `guild.json`. Does **not** recompose stale animas — that is a separate operator decision.

**Types:**
- `UpgradePlan` — `{ bundleSource, migrations, contentUpdates, staleAnimas, isEmpty }`
- `UpgradeResult` — `{ migrationsApplied, contentUpdated, staleAnimaCount }`
- `MigrationPlanEntry` — `{ bundleFilename, guildSequence, guildFilename }`
- `ContentUpdateEntry` — `{ category, name, installedVersion, bundleVersion, bundlePath }`
- `StaleAnimaEntry` — `{ id, name, roles, curriculum, temperament }` (curriculum/temperament are `{ composedVersion, currentVersion } | null`)

### Guild Init

#### `initGuild(home, name, model): void`

Initialize a new guild — creates guild.json, package.json, .git, .nexus directory, and applies migrations.

### Rehydrate

#### `rehydrate(home): RehydrateResult`

Reconstruct runtime state after a fresh clone: re-clone workshop bare repos, `npm install` for registry deps, reinstall workshop/tarball tools from on-disk source, report linked tools needing re-linking.

### Types

| Type | Description |
|------|-------------|
| `SourceKind` | `'registry' \| 'git-url' \| 'workshop' \| 'tarball' \| 'link'` |
| `InstallToolOptions` | Full options for `installTool()` |
| `InstallResult` | `{ category, name, installedTo, sourceKind, warnings }` |
| `RemoveToolOptions` | `{ home, name, category? }` |
| `RemoveResult` | `{ category, name, removedFrom }` |
| `ToolSummary` | `{ name, category, upstream, installedAt, bundle? }` |
| `Precondition` | Union: CommandPrecondition \| CommandOutputPrecondition \| EnvPrecondition |
| `PreconditionCheckResult` | `{ precondition, passed, message? }` |
| `ToolPreconditionResult` | `{ name, category, available, checks, failures }` |
| `AddWorkshopOptions` | `{ home, name, remoteUrl }` |
| `AddWorkshopResult` | `{ name, remoteUrl, barePath }` |
| `RemoveWorkshopOptions` | `{ home, name }` |
| `WorkshopInfo` | `{ name, remoteUrl, addedAt, cloned, activeWorktrees }` |
| `WorkshopDetail` | WorkshopInfo + `{ barePath, defaultBranch }` |
| `CreateWorkshopOptions` | `{ home, repoName, private? }` |
| `WorktreeConfig` | `{ home, workshop, commissionId, baseBranch? }` |
| `WorktreeResult` | `{ path, branch, commissionId }` |
| `BundleManifest` | `{ description?, tools?, engines?, curricula?, temperaments?, migrations? }` |
| `BundlePackageEntry` | `{ package, name? }` |
| `BundleContentEntry` | `{ package?, path?, name? }` |
| `BundleMigrationEntry` | `{ path }` |
| `InstallBundleOptions` | `{ home, bundleDir, bundleSource?, commit? }` |
| `InstallBundleResult` | `{ installed, artifacts, migrationProvenance? }` |
| `MigrationFile` | `{ sequence, filename, path }` |
| `MigrationProvenance` | `{ bundle, originalName }` |
| `MigrateResult` | `{ applied[], skipped[], total }` |
| `RehydrateResult` | `{ workshopsCloned[], workshopsFailed[], fromPackageJson, fromSlotSource[], needsRelink[] }` |

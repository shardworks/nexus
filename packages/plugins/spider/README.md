# `@shardworks/spider-apparatus`

The Spider is the guild's rig execution engine. It spawns rigs for open writs, drives engine pipelines to completion, and transitions writs via the Clerk when rigs finish. Each rig is an ordered pipeline of engine instances; the Spider's `crawl()` loop advances that pipeline one step at a time.

The Spider's state model is:

- **`EngineStatus`** — `'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'`. Holds (rate-limit, block-type, retry back-off) are **pending-plus-metadata**, not a distinct state: `status='pending'` + `holdReason` / `holdUntil` / `holdCondition` on the engine instance. `holdReason` is either a registered BlockType id (e.g. `'animator-paused'` — the rate-limit gate) or the sentinel `'retry-backoff'` for purely timer-driven retry holds (no BlockType; cleared when `holdUntil` elapses).
- **`RigStatus`** — `'running' | 'completed' | 'failed' | 'cancelled'`. Rig status is a **pure projection** of the engine set: running if any engine is non-terminal, failed if any terminal-failed with no running, completed if all terminal-success with at least one completed, cancelled if `cancelledAt` is set. It is never written independently — every engine-state-change goes through a patch-wrapper (`patchRigWithRollup`) that recomputes the status and writes both fields in one transaction.
- **Retry** — opt-in on engine designs via a nested `retry: { maxAttempts, backoff }` block. Transient failures (session crash, engine throw) retry in place on the same rig up to the design's budget, with exponential back-off. Rate-limit is a hold (no budget consumed); definitional failures (invalid graft, unknown design, non-serializable yields) fail terminally on first observation. Legacy rigs persisted with `'stuck'` / `'blocked'` statuses remain in place — readers tolerate them; no migration.
- **Attempts** — every engine dispatch appends a row to `attempts[]` carrying `startedAt`, `endedAt`, terminal `status`, optional `error`, `sessionId`, and `yields`. Scalar engine-level `startedAt` / `completedAt` / `error` / `sessionId` / `yields` fields **do not exist** — `attempts[-1]` is authoritative.

The Spider maintains bidirectional CDC cascades between writs and rigs: when a rig reaches a terminal state, the associated writ is transitioned to match; when a writ is cancelled, the associated rig is cancelled (writs transitioning to `completed` or `failed` do not cancel the rig). Engine-failure retry now lives inside the rig — only terminal retry exhaustion routes the rig to `failed`, which cascades the writ directly to `phase='failed'`. Guards in both handlers break the circular cascade path so that a writ cancellation that triggers a rig cancellation does not attempt to re-transition the already-terminal writ.

Depends on `@shardworks/stacks-apparatus` for rig persistence, `@shardworks/fabricator-apparatus` to look up engine designs, `@shardworks/clerk-apparatus` to transition writs, and `@shardworks/animator-apparatus` to launch quick-engine sessions. Recommends `@shardworks/loom-apparatus` so the Spider's support kit can contribute the `mender` role used by the seal-engine recovery tail.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/spider-apparatus": "workspace:*"
  }
}
```

## API

The Spider exposes its API via `guild().apparatus<SpiderApi>('spider')`:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { SpiderApi } from '@shardworks/spider-apparatus';

const spider = guild().apparatus<SpiderApi>('spider');
```

### `crawl(): Promise<CrawlResult | null>`

Execute one step of the crawl loop. The Spider evaluates pending work in priority order — collect > processGrafts > run > autoUnstick > spawn (guarded by the Animator-paused gate) — and returns a description of the action taken, or `null` if no work was available.

Dispatch (inside `tryRun`) is governed by a single **dispatch predicate** that composes four checks per pending engine: status is `'pending'`, every upstream is terminal-success, `holdUntil` is absent or in the past, and — if `holdReason` names a registered `BlockType` — the BlockType's `check()` returns `'cleared'` (honouring its `pollIntervalMs` against the engine's `lastCheckedAt` stamp). The top-level `isAnimatorPaused()` gate now only guards `trySpawn`; `tryRun` is handled uniformly by the per-engine predicate.

```typescript
const result = await spider.crawl();
if (result) {
  console.log(result.action); // 'rig-spawned' | 'engine-started' | 'engine-completed' | ...
}
```

CrawlResult variants:

| Action | Description |
|---|---|
| `'rig-spawned'` | Created a new rig for an open writ |
| `'engine-started'` | Launched a quick engine's session |
| `'engine-completed'` | An engine finished; rig still running |
| `'engine-held'` | Engine transitioned to `'pending'` with a hold (rate-limit, block-type gate) |
| `'engine-retrying'` | A retryable failure was observed; engine is pending with a back-off `holdUntil` and `attemptCount` was incremented |
| `'engine-skipped'` | Engine (and any downstream-only dependents) was skipped due to `when` condition |
| `'engine-grafted'` | Engine injected additional engines into the pipeline |
| `'rig-completed'` | Rig reached terminal state (`completed`, `failed`, or `cancelled`) |
| `'writ-unstuck'` | `autoUnstick` phase returned a previously-Spider-stuck writ to `open` because its recorded blockers resolved |

A `null` return means no dispatchable candidate was found this tick — either the queue is empty, or every candidate writ was gated on non-terminal blockers. Gate state lives on the writ substrate (`phase` + `status.spider`), not in the `CrawlResult`.

### Dispatch gating via `spider.follows`

Spider contributes a `spider.follows` link kind and consults outbound `spider.follows` links when deciding whether to spawn a rig for an open writ. The gate is evaluated in `trySpawn` before any rig is created:

- If any direct outbound `spider.follows` target is still `new`, `open`, or `stuck` — the writ is held. The scan continues to the next candidate so a later, unblocked writ can still dispatch this tick; the gated writ stays `open` and no status is persisted.
- If any direct outbound target is `failed` — the writ is cascaded to `stuck`. A `status.spider` record is written with `stuckCause: 'failed-blocker'` and the ids of every failed blocker. The resolution text is `Blocked by failed dependency: <short-id>` (or `Blocked by failed dependencies: …` when plural). The scan then continues with the next candidate.
- If the full transitive `spider.follows` walk from the writ visits a cycle — every cycle member is cascaded to `stuck` with `stuckCause: 'cycle'` and the cycle members as blockers. The resolution text is `Cycle detected in spider.follows graph`. The scan then continues with the next candidate.
- Only when every direct outbound target is in a terminal-success state (`completed`, or `cancelled`) does the writ proceed to rig spawn.

Before `trySpawn`, each crawl tick runs an `autoUnstick` pass that re-evaluates every writ whose `status.spider.stuckCause` is one of the dependency-recovery causes (`failed-blocker` or `cycle`). When the recorded cause resolves (all `failed-blocker` ids are now `completed`/`cancelled`, or any `cycle` member has moved out of `open`/`stuck`), the writ is returned to `open` and emits a `'writ-unstuck'` result. Writs stuck with other causes — including `engine-failure` writs (see below) and operator-stuck writs with no `status.spider` slot — are left alone; their recovery is owned by a separate retry clockwork, not by `autoUnstick`.

### Engine-level retry (in-place within the rig)

Engine designs may declare an opt-in retry policy:

```typescript
const myEngine: EngineDesign = {
  id: 'my-engine',
  retry: { maxAttempts: 2, backoff: { initialMs: 30_000, maxMs: 600_000, factor: 2 } },
  async run(givens, ctx) { /* … */ },
};
```

When an engine observes a retryable failure (session crash, engine throw, `collect()` throw) and the design has remaining budget, the unified failure handler:

1. Finalizes the in-flight `attempts[-1]` row with `status='failed'` and the error message.
2. Increments `engine.attemptCount`.
3. Sets `engine.status='pending'` with `holdReason='retry-backoff'` and `holdUntil` computed from the back-off policy.
4. Leaves downstream engines pending (no cascade-cancel).

The dispatch predicate picks the engine up again once `holdUntil` elapses; a fresh attempt row is appended to `attempts[]`, and the sequence repeats until the attempt succeeds or the budget is exhausted.

Retry is **opt-in**. Engine designs without a `retry` block default to `maxAttempts: 0` — the first retryable failure is terminal. Definitional failures (invalid graft, unknown design, unknown block type, non-JSON-serializable yields) fail terminally regardless of budget.

Designs shipping with retry enabled in this commission: `anima-session`, `implement`, `review`, `revise`, `astrolabe.reader-analyst`, `astrolabe.patron-anima`, `astrolabe.decision-review`. All others (including `draft`, `seal`, `manual-merge`, `piece-session`, `implement-loop`, `astrolabe.plan-init`, `astrolabe.inventory-check`, `astrolabe.plan-finalize`, `astrolabe.observation-lift`) default to no retry.

### Terminal engine-failure cascade

When an engine exhausts its retry budget (or observes a definitional failure), the unified failure handler:

1. Finalizes the in-flight attempts[] row.
2. Sets `engine.status='failed'`.
3. Cascade-cancels every non-terminal engine (both plain pending and pending-with-hold) in one pass.
4. The `patchRigWithRollup` wrapper projects `rig.status='failed'` as the natural derivation.

The existing rigs→writs CDC handler translates `rig.status='failed'` directly to `writ.phase='failed'` — no intermediate stuck state. Consequently the writ's `status.spider.stuckCause='engine-failure'` slot (and its companion `retryable` / `detail` fields) is **no longer written on the engine-failure path**. It remains on the interface for read-compatibility with legacy writs; the sibling retry clockwork (`clockworks-retry`) reads that flag but its trigger condition simply no longer fires, since writs now skip stuck and go to failed.

### `show(id): Promise<RigDoc>`

Show a rig by ID. Throws if not found.

### `list(filters?): Promise<RigDoc[]>`

List rigs, ordered by `createdAt` descending.

```typescript
const running = await spider.list({ status: 'running', limit: 10 });
```

### `forWrit(writId): Promise<RigDoc | null>`

Find the rig for a given writ. Returns `null` if no rig exists.

### `resume(rigId, engineId): Promise<void>`

Manually clear a block on a specific engine, bypassing the block type's checker. Throws if the engine is not currently blocked.

### `cancel(rigId, options?): Promise<RigDoc>`

Cancel a running, blocked, or stuck rig. The cancellation cascade:

1. If the active engine has a session, calls `AnimatorApi.cancel()` to kill it.
2. Marks the active engine (running or blocked) as `'cancelled'`.
3. Marks all pending/blocked downstream engines as `'cancelled'`.
4. Rejects any pending `InputRequestDoc` entries for the rig.
5. Transitions the rig to `'cancelled'` status, which triggers the CDC handler to transition the writ to `'cancelled'`.

For stuck rigs (engine failure, no active engines), only step 5 applies — the rig transitions directly from `stuck` to `cancelled`.

Cancellation is also triggered automatically when the associated writ is cancelled — for example, when a writ is cancelled directly via the Clerk or when a parent writ's cancellation cascades to its children. The cancel reason is set to `"Writ <writId> cancelled"`. Writs transitioning to `completed` or `failed` do not trigger rig cancellation.

Idempotent: returns the rig unchanged if already in a terminal state (`'completed'`, `'failed'`, or `'cancelled'`). Throws if the rig is not found.

```typescript
const rig = await spider.cancel('rig-abc', { reason: 'No longer needed' });
```

### Rig terminal timestamp (`terminalAt`)

Every rig terminal-status transition (`completed`, `failed`, `cancelled`, `stuck`) writes a `terminalAt` ISO timestamp on the rig in the same patch. The field uses **keep-first** semantics: once set, subsequent terminal transitions (e.g. `stuck → cancelled`) do **not** overwrite it. This pins the moment the rig first stopped making forward progress, which is the meaningful signal for elapsed-time and end-time displays — they need a stable anchor, not the timestamp of the most recent status flip.

Every rig-terminal code path (`failEngine`, `cancelEngine`, the `tryCollect` completion arm, the `tryRun` when-skipped and clockwork-completion arms, and both `SpiderApi.cancel` terminal arms) routes through a single `terminalAtPatch(rig)` helper that returns `{}` when `rig.terminalAt` is already set. Rigs persisted before this field existed simply omit it; the dashboard falls back to `max(engine.completedAt)` and finally to `rig.createdAt`.

### `getBlockType(id): BlockType | undefined`

Look up a registered block type by ID.

### `listBlockTypes(): BlockTypeInfo[]`

List all registered block types with summary info.

### `listTemplates(): RigTemplateInfo[]`

List all registered rig templates with provenance info (config-defined or kit-contributed).

### `listTemplateMappings(): Record<string, string>`

Return the merged effective writ-type → template-name mapping. Config mappings override kit mappings for the same writ type.

## Configuration

The Spider reads its config from `guild.json["spider"]`. Zero-config works out of the box for mandate dispatch — Spider's apparatus contributes a plugin-default rig template (`default`: draft → implement → review → revise → seal) and a default mapping (`mandate → default`) via its own supportKit. A minimal guild only needs to declare `spider.variables` so the default template can interpolate role / build command / test command:

```json
{
  "spider": {
    "variables": {
      "role": "artificer",
      "buildCommand": "pnpm -w build",
      "testCommand": "pnpm -w test"
    }
  }
}
```

Guilds that need a custom pipeline can override the plugin defaults by declaring their own `rigTemplates` and/or `rigTemplateMappings`:

```json
{
  "spider": {
    "pollIntervalMs": 5000,
    "variables": {
      "plannerRole": "planner",
      "buildCommand": "pnpm build"
    },
    "rigTemplates": {
      "default": {
        "engines": [
          {
            "id": "draft",
            "designId": "anima-session",
            "givens": {
              "role": "${vars.plannerRole}",
              "prompt": "Draft the implementation plan."
            }
          },
          {
            "id": "implement",
            "designId": "anima-session",
            "upstream": ["draft"],
            "givens": {
              "role": "artificer",
              "conversationId": "${yields.draft.conversationId}",
              "prompt": "Implement the plan from the draft."
            }
          }
        ]
      }
    },
    "rigTemplateMappings": {
      "feature": "default"
    }
  }
}
```

A config-level template named `default` overrides the plugin-contributed `spider.default` for the `mandate → default` lookup: the registry resolves the kit mapping against the bare name first, then falls back to `${pluginId}.${templateName}` when the bare name is not claimed.

| Field | Type | Default | Description |
|---|---|---|---|
| `pollIntervalMs` | `number` | `5000` | Polling interval for the `crawl-continual` tool (ms). |
| `buildCommand` | `string` | — | Build command forwarded to quick engines. |
| `testCommand` | `string` | — | Test command forwarded to quick engines. |
| `variables` | `Record<string, unknown>` | — | Named values available in rig template givens via `${vars.<path>}`. The plugin-default template requires `role`, `buildCommand`, and `testCommand`. |
| `rigTemplates` | `Record<string, RigTemplate>` | plugin default `default` (draft → seal) | Named rig template definitions. Config-level entries override plugin-contributed templates of the same name. |
| `rigTemplateMappings` | `Record<string, string>` | plugin default `{ mandate: 'default' }` | Writ type → template name. Config-level entries override plugin-contributed mappings for the same writ type. Two kits contributing a mapping for the same writ type is a hard error at guild startup; resolve by removing one kit mapping or by overriding here in config (config always wins). |
| `maxConcurrentEngines` | `number` | `3` | Maximum number of engines running concurrently across all rigs. When the limit is reached, runnable engines stay in `pending` and new rigs are not spawned until a slot frees. |
| `maxConcurrentEnginesPerRig` | `number` | `1` | Maximum number of engines running concurrently within a single rig. Prevents race conditions with rig-local resources. |

## Rig Templates

A rig template defines the engine pipeline for a class of writs. Each engine in the pipeline is an `id`/`designId` pair with optional `upstream`, `givens`, and `when`.

### Engine Givens

The `givens` object passes values to the engine at run time. String values may contain `${...}` template expressions that are resolved when the rig is spawned (for `writ` and `vars` references) or when the engine runs (for `yields` references):

| Expression | Resolved | Value |
|---|---|---|
| `${writ}` | Spawn time | Full `WritDoc` for this rig's writ |
| `${writ.<path>}` | Spawn time | A field of the `WritDoc` (dot-path) |
| `${vars.<path>}` | Spawn time | A value from `spider.variables` config (dot-path) |
| `${yields.<engineId>.<path>}` | Run time | A property from an upstream engine's yields (dot-path) |

**Type preservation:** When a string is exactly one `${...}` expression (e.g. `"${writ}"`), the resolved value keeps its original type. When expressions are embedded in larger text (e.g. `"Hello ${writ.title}"`), the result is always a string.

**Undefined handling:** A whole-value expression that resolves to `undefined` causes the givens key to be omitted. An inline expression that resolves to `undefined` is replaced with empty string.

**Escaping:** Use `\${` to produce a literal `${` in the output without interpolation.

```json
{
  "givens": {
    "writ": "${writ}",
    "title": "${writ.title}",
    "role": "${vars.plannerRole}",
    "prevConversation": "${yields.draft.conversationId}",
    "greeting": "Hello ${writ.author}, your writ is ready.",
    "literal": "Use \\${vars.key} syntax in your template."
  }
}
```

### Conditional Activation (`when`)

The `when` field controls whether an engine runs or is skipped. It takes a `${yields.<engineId>.<property>}` expression (with optional `!` negation prefix), evaluated after the engine's upstream completes:

```json
{
  "id": "fix",
  "designId": "anima-session",
  "upstream": ["review"],
  "when": "!${yields.review.passed}",
  "givens": { "prompt": "Fix the review failures." }
}
```

When the condition is falsy, the engine (and any engines that have no other upstream) is set to `skipped` status and the pipeline continues.

### Upstream and Ordering

`upstream` lists engine IDs within this template that must complete before this engine can run. The Spider validates that upstream references are acyclic and that `${yields.*}` givens only reference upstream engines.

### Grafting and `graftTail`

Clockwork and quick engines can dynamically inject engines into the rig pipeline by returning a `graft` array (via `SpiderEngineRunResult` or `SpiderCollectResult`). Grafted engines are appended to the rig and processed on the next crawl cycle.

When grafting sequential work that existing downstream engines should wait for, use `graftTail` — the ID of the last grafted engine in the chain. The Spider patches any existing engine that depends on the grafting engine to also depend on the `graftTail` engine, ensuring downstream work waits for all grafted engines to complete.

```typescript
// Clockwork engine that grafts two sequential tasks before seal runs:
return {
  status: 'completed',
  yields: { taskCount: 2 },
  graft: [
    { id: 'task-0', designId: 'task-runner', upstream: ['orchestrator'], givens: { ... } },
    { id: 'task-1', designId: 'task-runner', upstream: ['task-0'], givens: { ... } },
  ],
  graftTail: 'task-1', // engines downstream of 'orchestrator' now also wait for 'task-1'
};
```

## Rig Template Kit Interface

Apparatus plugins can contribute rig templates and block types via their kit:

```typescript
import type { SpiderKit } from '@shardworks/spider-apparatus';

const myPlugin = {
  apparatus: {
    provides: { /* ... */ },
    kit: {
      spider: {
        rigTemplates: {
          'my-template': {
            engines: [
              { id: 'work', designId: 'anima-session', givens: { role: 'artificer' } }
            ]
          }
        },
        rigTemplateMappings: {
          'my-writ-type': 'my-template'
        },
        blockTypes: [
          {
            id: 'my-block',
            conditionSchema: z.object({ /* ... */ }),
            check: async (condition) => ({ status: 'cleared' }),
          }
        ]
      }
    }
  }
};
```

Config-defined templates and mappings override kit-contributed ones with the same name.

### Kit-vs-kit collisions are a hard error

Two kits contributing overlapping entries to a merge registry refuse to start the guild. The rule applies to every kit-merge site at registration time:

- `rigTemplateMappings` — two kits mapping the same writ type (including Spider's own plugin-default `mandate → default`)
- `blockTypes` — two kits contributing the same block-type id
- Clerk `writTypes` — two kits contributing the same writ type
- Fabricator `engines` — two kits contributing the same engine-design id

When a collision is detected the guild fails to start with an error naming both contributing plugins and the conflicting key. Operators resolve by removing one of the kit contributions, or — for the Spider sites that support it — by declaring a config-level override in `guild.json["spider"]` (config always wins over any kit contribution, silently). The winner is never selected by kit load order.


## Support Kit

The Spider contributes books, tools, engines, and a role for rig inspection and control.

### Books

| Book | Indexes | Description |
|---|---|---|
| `spider/rigs` | `writId`, `status`, `createdAt` | Rig documents — one per spawned writ. |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `rig-list` | `read` | List rigs with optional status/limit filters (returns enriched `RigView[]`). `--status` accepts the four current values (`running`/`completed`/`failed`/`cancelled`) **plus** the deprecated legacy values `stuck` and `blocked` for inspecting rigs that predate the engine-level retry reshape. |
| `rig-show` | `read` | Show full detail for a rig by id. Default `--format text` renders a human-readable CLI view surfacing per-engine attempt count, hold state (`holdReason` / `holdUntil` / `lastCheckedAt`), and the latest attempt's error — the minimum bar the engine-level retry commission calls for. Pass `--format json` for the raw enriched `RigView`. |
| `rig-resume` | `write` | Manually clear a hold on a specific pending engine |
| `rig-cancel` | `write` | Cancel a running rig (also tolerates legacy `'stuck'` / `'blocked'` rigs) |
| `crawl` | `write` | Execute a single crawl step |
| `crawl-continual` | `write` | Poll `crawl()` in a loop until no work remains |

#### Rig view enrichment

`rig-list` and `rig-show` return `RigView` — the persisted `RigDoc` plus three derived fields aggregated from other books:

- `costSummary?: { costUsd, inputTokens?, outputTokens? }` — totals across every engine session in the rig. Absent when no engine has a `sessionId`; `inputTokens`/`outputTokens` are absent when no session reported token usage.
- `engineCosts?: Record<engineId, { costUsd, inputTokens?, outputTokens? }>` — per-engine cost entries. Only engines with a `sessionId` (i.e. anima engines) get an entry — clockwork and skipped engines are omitted. Engines whose sessions can't be resolved contribute zero.
- `writTitle?: string` — the current title of the rig's writ, joined from the `clerk/writs` book. Absent when the writ cannot be resolved (e.g. deleted). Never persisted on `RigDoc`; recomputed on every read so `writ-edit` title changes are reflected on the next dashboard poll.

The enrichment happens in the tool layer. `SpiderApi.list()` and `SpiderApi.show()` still return the persisted `RigDoc` shape for internal callers that don't need the derived fields.

### Block Types

Built-in block types contributed via the Spider's support kit:

| Id | Poll interval | Condition | Description |
|---|---|---|---|
| `writ-phase` | 10s | `{ writId, targetPhase }` | Blocks until a specific writ reaches the named phase. |
| `scheduled-time` | 30s | `{ resumeAt: ISO-8601 }` | Blocks until a wall-clock timestamp is reached. |
| `book-updated` | 10s | `{ book, sinceId? }` | Blocks until a book gets a new entry. |
| `patron-input` | 10s | `{ requestId }` | Blocks until an `InputRequestDoc` is answered or rejected. |
| `animator-paused` | 10s | `{ sessionId? }` | Blocks until the Animator's rate-limit back-off machine reports `state === 'running'` OR `pausedUntil` has elapsed. Entered via `tryCollect` when a session terminates with `status: 'rate-limited'`. |

### Engines

| Engine | Kind | Description |
|---|---|---|
| `draft` | clockwork | Open a draft binding on the commission's target codex |
| `implement` | quick | Run the implementation session |
| `review` | quick | Run the review session |
| `revise` | quick | Revise based on review findings |
| `seal` | clockwork | Seal the draft (or grafts a recovery tail on rebase conflict — see below) |
| `anima-session` | quick | General-purpose anima session engine |
| `manual-merge` | quick | Grafted by the `seal` engine — summons the `spider.mender` anima to reconcile rebase conflicts |

### Roles

The Spider contributes one role via its support kit (registered with Loom as `spider.mender`):

| Role | Permissions | Description |
|---|---|---|
| `mender` | *(none)* | A merge-conflict reconciliation anima. Summoned by the grafted `manual-merge` engine when Scriptorium reports a rebase conflict during sealing. The role has no tool permissions; it operates through the draft worktree's local `git` binary (available on the host). Its instructions live at `loom-roles/mender.md` in this package. |

### Seal Recovery Tail

The `seal` engine's default behavior is to try Scriptorium's `seal()` and return `SealYields` on success. When Scriptorium throws a rebase-conflict failure (message prefix `Sealing seized:`) and the optional `recover` given is not `false`, the engine instead completes with `SealRecoveryYields = { ok: false, reason, grafted: true }` and grafts a two-engine recovery tail onto the rig:

1. `manual-merge` — summons the `spider.mender` anima in the draft worktree. The anima rebases the draft onto the latest target, resolves conflicts by hand, and emits `### Merge: SUCCESS` when the worktree is ready for a fast-forward push.
2. `seal` (retry) — a second `seal` engine with `givens.recover = false`, preventing a second recovery layer.

Recovery is disabled on three paths:
- `abandon: true` — abandon failures always re-throw unchanged.
- `recover: false` — the retry seal itself, so a second rebase conflict takes the rig to `stuck`.
- Any error whose message does not start with `Sealing seized:` (auth, network, missing branch, push race, etc.) — re-throws unchanged.

If the mender emits `### Merge: FAILURE`, emits no marker, or the retry seal also fails, the rig goes `stuck` via the standard `failEngine` path. There is no third attempt.

## Types

```typescript
import type {
  SpiderApi,
  SpiderConfig,
  RigDoc,
  RigView,
  RigCostSummary,
  EngineCostSummary,
  RigTemplate,
  RigTemplateEngine,
  RigTemplateInfo,
  RigFilters,
  RigStatus,
  EngineInstance,
  EngineStatus,
  CrawlResult,
  BlockType,
  BlockRecord,
  BlockTypeInfo,
  CheckResult,
  DraftYields,
  SealYields,
  SpiderEngineRunResult,
  SpiderCollectResult,
  InputRequestDoc,
  InputRequestStatus,
  QuestionSpec,
  AnswerValue,
} from '@shardworks/spider-apparatus';
```

The default export is a pre-created apparatus plugin instance:

```typescript
import spider from '@shardworks/spider-apparatus';
// spider is { apparatus: { requires: ['stacks', 'fabricator', 'clerk'], provides: SpiderApi, ... } }
```

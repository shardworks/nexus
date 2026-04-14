# `@shardworks/spider-apparatus`

The Spider is the guild's rig execution engine. It spawns rigs for open writs, drives engine pipelines to completion, and transitions writs via the Clerk when rigs finish. Each rig is an ordered pipeline of engine instances; the Spider's `crawl()` loop advances that pipeline one step at a time.

The Spider maintains bidirectional CDC cascades between writs and rigs: when a rig reaches a terminal state, the associated writ is transitioned to match; when a writ is cancelled, the associated rig is cancelled (writs transitioning to `completed` or `failed` do not cancel the rig). Guards in both handlers break the circular cascade path so that a writ cancellation that triggers a rig cancellation does not attempt to re-transition the already-terminal writ.

Depends on `@shardworks/stacks-apparatus` for rig persistence, `@shardworks/fabricator-apparatus` to look up engine designs, `@shardworks/clerk-apparatus` to transition writs, and `@shardworks/animator-apparatus` to launch quick-engine sessions.

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

Execute one step of the crawl loop. The Spider evaluates pending work in priority order — collect > processGrafts > checkBlocked > run > spawn — and returns a description of the action taken, or `null` if no work was available.

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
| `'engine-blocked'` | Engine entered blocked status |
| `'engine-unblocked'` | A blocked engine's condition cleared |
| `'engine-skipped'` | Engine (and any downstream-only dependents) was skipped due to `when` condition |
| `'engine-grafted'` | Engine injected additional engines into the pipeline |
| `'rig-completed'` | Rig reached terminal state (completed, failed, or cancelled) |
| `'rig-blocked'` | All forward progress stalled; rig entered blocked status |

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

Cancel a running or blocked rig. The cancellation cascade:

1. If the active engine has a session, calls `AnimatorApi.cancel()` to kill it.
2. Marks the active engine (running or blocked) as `'cancelled'`.
3. Marks all pending/blocked downstream engines as `'cancelled'`.
4. Rejects any pending `InputRequestDoc` entries for the rig.
5. Transitions the rig to `'cancelled'` status, which triggers the CDC handler to transition the writ to `'cancelled'`.

Cancellation is also triggered automatically when the associated writ is cancelled — for example, when a writ is cancelled directly via the Clerk or when a parent writ's cancellation cascades to its children. The cancel reason is set to `"Writ <writId> cancelled"`. Writs transitioning to `completed` or `failed` do not trigger rig cancellation.

Idempotent: returns the rig unchanged if already in a terminal state (`'completed'`, `'failed'`, or `'cancelled'`). Throws if the rig is not found.

```typescript
const rig = await spider.cancel('rig-abc', { reason: 'No longer needed' });
```

### `getBlockType(id): BlockType | undefined`

Look up a registered block type by ID.

### `listBlockTypes(): BlockTypeInfo[]`

List all registered block types with summary info.

### `listTemplates(): RigTemplateInfo[]`

List all registered rig templates with provenance info (config-defined or kit-contributed).

### `listTemplateMappings(): Record<string, string>`

Return the merged effective writ-type → template-name mapping. Config mappings override kit mappings for the same writ type.

## Configuration

The Spider reads its config from `guild.json["spider"]`:

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

| Field | Type | Default | Description |
|---|---|---|---|
| `pollIntervalMs` | `number` | `5000` | Polling interval for the `crawl-continual` tool (ms). |
| `buildCommand` | `string` | — | Build command forwarded to quick engines. |
| `testCommand` | `string` | — | Test command forwarded to quick engines. |
| `variables` | `Record<string, unknown>` | — | Named values available in rig template givens via `${vars.<path>}`. |
| `rigTemplates` | `Record<string, RigTemplate>` | — | Named rig template definitions. |
| `rigTemplateMappings` | `Record<string, string>` | — | Writ type → template name. `'default'` is the fallback. |
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

## Support Kit

The Spider contributes books and tools for rig inspection and control.

### Books

| Book | Indexes | Description |
|---|---|---|
| `spider/rigs` | `writId`, `status`, `createdAt` | Rig documents — one per spawned writ. |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `rig-list` | `read` | List rigs with optional status/limit filters |
| `rig-show` | `read` | Show full detail for a rig by id |
| `rig-resume` | `write` | Manually clear a block on a specific engine |
| `rig-cancel` | `write` | Cancel a running or blocked rig |
| `crawl` | `write` | Execute a single crawl step |
| `crawl-continual` | `write` | Poll `crawl()` in a loop until no work remains |

## Types

```typescript
import type {
  SpiderApi,
  SpiderConfig,
  RigDoc,
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

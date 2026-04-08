# The Astrolabe — API Contract

Status: **Draft**

Package: `@shardworks/astrolabe` · Plugin id: `astrolabe`

> **⚠️ Future state.** The Astrolabe is not yet implemented. This document captures the design as a target for implementation commissions. Several prerequisites must land in the Spider first: the `anima-session` built-in engine, givens inline string interpolation, and the `QuestionSpec.details` field.

---

## Purpose

The Astrolabe refines minimal briefs from the patron into detailed work specifications. When the patron commissions work — often as little as a sentence or two — the Astrolabe takes that raw intent and produces a structured spec: an inventory of the relevant codebase, analytical observations, scoped decisions, and concrete requirements. The final output is a `mandate` writ posted to the Clerk — ready for the Spider to build an implementation rig.

The Astrolabe does **not** execute implementation work (that's the implementation rig's domain). It does **not** modify the original commission writ. It maintains its own books for planning artifacts (inventory, observations, decisions, specs) and provides tools for the animas that staff its engines to read and write those artifacts. The planning flow terminates by posting a new mandate writ — the Astrolabe's output *is* a commission.

---

## Dependencies

```
requires: [clerk, stacks, spider, loom, fabricator]
```

- **Clerk** — the spec-writer engine posts the generated writ as the final output of the planning pipeline.
- **Stacks** — the Astrolabe's own books store planning artifacts: inventory, observations, scope, decisions, and generated specs.
- **Spider** — the Astrolabe contributes a planning rig template and the `brief` → template mapping. Planning engines use the Spider's `patron-input` block type for decision review. The Astrolabe's quick engines use the Spider's built-in `anima-session` engine design.
- **Loom** — the Astrolabe contributes a single planning role shared across all quick engines in the pipeline.
- **Fabricator** — the Astrolabe contributes clockwork engine designs for validation checkpoints.

---

## Kit Contributions

The Astrolabe is primarily a kit contributor — installing it extends the guild's capabilities through the existing kit contribution mechanisms.

### Writ Type: `brief`

Contributed to the **Clerk** via `writTypes`. A `brief` is the patron's raw request — a sentence, a paragraph, a rough idea. Posting a `brief` triggers the planning rig rather than an implementation rig.

### Rig Template

Contributed to the **Spider** via `rigTemplates`, with a `rigTemplateMapping` from `brief` → the planning template. The template defines the engine pipeline:

```
brief writ posted
  │
  ├─ 1. Plan init (astrolabe.plan-init, clockwork)
  │     → creates a PlanDoc in the plans book keyed by the brief writ ID
  │     → yields { planId }
  │
  ├─ 2. Draft (draft, clockwork) — opens a draft binding on the brief's codex
  │     → yields { path, codexName, branch, ... }
  │
  ├─ 3. Reader (anima-session) — inventories the codebase against the brief
  │     → launched in draft worktree (cwd from upstream draft yields)
  │     → receives planId via ${yields.plan-init.planId}
  │     → writes inventory to the plans book via astrolabe tools
  │     → yields { conversationId }
  │
  ├─ 4. Inventory checkpoint (astrolabe.inventory-check, clockwork)
  │     → validates inventory was produced in the plans book
  │
  ├─ 5. Analyst (anima-session) — produces scope, decisions, observations
  │     → resumes reader's conversation via ${yields.reader.conversationId}
  │     → receives planId via ${yields.plan-init.planId}
  │     → writes analysis artifacts to the plans book via astrolabe tools
  │     → yields { conversationId }
  │
  ├─ 6. Patron review (astrolabe.decision-review, clockwork)
  │     → reads decisions from the plans book
  │     → creates an InputRequestDoc with each decision as a ChoiceQuestionSpec
  │     → pre-fills answers with analyst recommendations
  │     → blocks on patron-input until patron completes the request
  │     → on resume: reads completed InputRequestDoc, reconciles patron
  │       answers back into PlanDoc.decisions (selected / patronOverride)
  │     → validates all decisions resolved and scope is consistent
  │
  ├─ 7. Spec-writer (anima-session) — synthesizes inventory + decisions
  │     → resumes the analyst's conversation via ${yields.analyst.conversationId}
  │     → receives planId via ${yields.plan-init.planId}
  │     → posts the generated writ to the Clerk
  │     → links generated writ back to the brief writ
  │
  ├─ 8. Seal (seal, clockwork, abandon: true) — abandons the draft binding
  │     → planning rigs don't produce inscriptions to merge
  │
  └─ done — the generated writ triggers an implementation rig via the
           Spider's normal template lookup
```

All three `anima-session` engines use the Spider's built-in engine design, configured with the same role (`astrolabe.sage`) but different prompts. Conversation chaining is wired through the rig template's givens using `${yields.<engineId>.conversationId}` references, which the Spider resolves at engine start time from upstream yields.

The patron review engine (step 4) is clockwork — it deterministically creates the `InputRequestDoc` from the plan's decisions, blocks, and reconciles answers on resume. This keeps the `anima-session` engines pure (no blocking logic) and makes the patron interaction point explicit in the rig graph.

### Role: `astrolabe.sage`

A single shared role contributed to the **Loom** via `roles`. All quick engines in the planning pipeline summon animas in this role. Sharing a role means sharing a system prompt — which is necessary because the conversation is shared across stages. Each stage is differentiated by its work prompt (the `prompt` given), not by its role.

The sage role carries permissions to read/write the Astrolabe's books, create patron-input requests, and post writs to the Clerk (for the final generated writ).

### Clockwork Engine Designs

The Astrolabe contributes three clockwork engine designs to the Fabricator:

- **`astrolabe.plan-init`** — creates a `PlanDoc` in the plans book, keyed by the brief writ ID. Sets initial status to `reading`. Yields `{ planId }` so downstream engines can reference the plan via `${yields.plan-init.planId}` in their givens/prompts.
- **`astrolabe.inventory-check`** — reads the plans book, validates that an inventory document exists for the current plan. Completes immediately if valid; fails the engine if no inventory is found.
- **`astrolabe.decision-review`** — the patron interaction engine. On first run: reads decisions from the plans book, maps them to an `InputRequestDoc` (each `Decision` → `ChoiceQuestionSpec`), pre-fills answers with analyst recommendations, writes the request to the Spider's `input-requests` book, and returns `{ status: 'blocked', blockType: 'patron-input', condition: { requestId } }`. On re-run after block clears (detected via `priorBlock` in context): reads the completed `InputRequestDoc`, reconciles patron answers back into `PlanDoc.decisions` (setting `selected` and `patronOverride` fields), validates all decisions are resolved and scope is consistent, and completes normally. Yields `{ decisionSummary }` — a human-readable string summarizing all decisions and the patron's selections, for injection into the spec-writer's prompt via inline interpolation.

---

## Books

The Astrolabe declares one book in its `supportKit`:

### `astrolabe/plans`

One document per planning run, keyed by the brief writ ID. The document accumulates fields as the pipeline progresses — the reader writes the inventory, the analyst writes scope/decisions/observations, the spec-writer writes the final spec.

```typescript
interface PlanDoc {
  /** The brief writ ID — primary key. */
  id: string;
  /** The codex this plan targets. */
  codex: string;
  /** Planning status. */
  status: 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed';

  // ── Reader output ─────────────────────────────────────────
  /** Codebase inventory: affected files, types, interfaces, patterns. */
  inventory?: string;   // markdown

  // ── Analyst output ────────────────────────────────────────
  /** Analyst observations: refactoring opportunities, risks, conventions. */
  observations?: string;   // markdown
  /** Scope items: what's in and what's out. */
  scope?: ScopeItem[];
  /** Architectural/design decisions with options and analysis. */
  decisions?: Decision[];

  // ── Spec-writer output ────────────────────────────────────
  /** The generated specification. */
  spec?: string;   // markdown
  /** The writ ID of the generated mandate (or configured type). */
  generatedWritId?: string;

  createdAt: string;
  updatedAt: string;
}

interface ScopeItem {
  id: string;
  description: string;
  rationale: string;
  included: boolean;
}

interface Decision {
  id: string;
  scope: string[];              // scope item IDs this decision relates to
  question: string;
  context?: string;             // analyst's long-form context/explanation
  options: Record<string, string>;   // key → description
  recommendation?: string;      // option key the analyst recommends
  rationale?: string;           // analyst's reasoning for the recommendation
  selected?: string;            // patron's chosen option key (set by decision-review engine)
  patronOverride?: string;      // patron's freeform override (set by decision-review engine)
}
```

**Indexes:** `['status', 'codex', 'createdAt']`

### Mapping to `patron-input` Questions

The `astrolabe.decision-review` engine maps each `Decision` to a `ChoiceQuestionSpec` in the `InputRequestDoc`. The question key is the decision's `id`.

| Decision field | InputRequestDoc field |
|---|---|
| `id` | question key in `questions` map |
| `question` | `questions[id].label` |
| `context` + `rationale` | `questions[id].details` |
| `options` | `questions[id].options` |
| `recommendation` | pre-filled in `answers[id]` as `{ selected: recommendation }` |
| — | `questions[id].allowCustom: true` (always, for patron overrides) |

When the patron completes the request, the `decision-review` engine reconciles answers back:

| InputRequestDoc answer | Decision field |
|---|---|
| `{ selected: key }` | `selected = key` |
| `{ custom: text }` | `patronOverride = text` |

The `InputRequestDoc.message` field carries a summary of the brief and scope context so the patron has orientation when reviewing decisions outside the planning conversation.

---

## Tools

The Astrolabe provides tools scoped to the `astrolabe` permission namespace. Planning animas use these to build up the plan document incrementally. The `planId` parameter is the brief writ ID (set by the `plan-init` engine and delivered to anima-session engines via givens).

### `plan-show`

Read the current state of a plan.

- **Permission:** `astrolabe:read`
- **Params:** `planId` (string)
- **Behavior:** Returns the full `PlanDoc`. Fails if not found.

### `inventory-write`

Write the codebase inventory for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `inventory` (string — markdown)
- **Behavior:** Patches the plan's `inventory` field and sets `updatedAt`.

### `scope-write`

Write or replace the scope items for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `scope` (ScopeItem[])
- **Behavior:** Patches the plan's `scope` field and sets `updatedAt`.

### `decisions-write`

Write or replace the decisions for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `decisions` (Decision[])
- **Behavior:** Patches the plan's `decisions` field and sets `updatedAt`.

### `observations-write`

Write the analyst observations for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `observations` (string — markdown)
- **Behavior:** Patches the plan's `observations` field and sets `updatedAt`.

### `spec-write`

Write the generated specification for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `spec` (string — markdown)
- **Behavior:** Patches the plan's `spec` field and sets `updatedAt`.

### `plan-list`

List plans, optionally filtered by status or codex.

- **Permission:** `astrolabe:read`
- **Params:** `status` (optional), `codex` (optional), `limit` (optional, default 20)
- **Behavior:** Queries the plans book with optional filters.

---

## Configuration

```json
{
  "astrolabe": {
    "generatedWritType": "mandate"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `generatedWritType` | `string` | `"mandate"` | The writ type posted by the spec-writer engine. Configurable per guild so the output can feed into a different pipeline (e.g. a `reviewed-mandate` type with an additional review step). |

---

## Writ Linking

When the spec-writer posts the generated writ, it links the mandate back to the originating brief:

```
generated mandate writ ──(refines)──▶ brief writ
```

**Link type: `refines`.** The mandate *refines* the brief — it's a more detailed, actionable expression of the same intent. Direction is source→target: the mandate points back to the brief it refines. This makes the most common query efficient: given a mandate, follow its outbound `refines` link to find the brief that spawned it.

---

## Design Decisions

- **Analyst revision loop.** For MVP, rejecting a plan's `InputRequestDoc` fails the rig. The patron posts a new brief to start over. A revision loop (reject → re-analyze) may come later via rig retry/recovery mechanisms.
- **Spec-writer prompt composition.** The spec-writer resumes the analyst's conversation for full context. Patron decision answers (which happen outside the conversation via `input-request-answer` tools) are injected into the spec-writer's prompt via inline interpolation — the `decision-review` engine yields a `decisionSummary` string, wired into the prompt as `${yields.decision-review.decisionSummary}`.
- **Single PlanDoc.** All planning artifacts live in one document per planning run. Simpler for tools, querying, and checkpoint validation. If finer-grained CDC or independent artifact lifecycle is needed later, splitting into separate books is straightforward since tools already namespace by artifact type.

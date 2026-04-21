# The Astrolabe — API Contract

Status: **Implemented**

Package: `@shardworks/astrolabe-apparatus` · Plugin id: `astrolabe`

---

## Purpose

The Astrolabe refines minimal briefs from the patron into detailed work specifications, then carries the brief through implementation on the same writ. When the patron commissions work — often as little as a sentence or two — the Astrolabe takes that raw intent and produces a structured spec: an inventory of the relevant codebase, analytical observations, scoped decisions, and concrete requirements. By default (`astrolabe.plan-and-ship` rig) the same rig then hands the written spec directly to a Spider `implement` engine on the brief's own codex, runs review / revise, and seals. The brief writ reaches `completed` only when the final seal completes.

The Astrolabe maintains its own books for planning artifacts (inventory, observations, decisions, specs) and provides tools for the animas that staff its engines to read and write those artifacts.

> **Legacy flow.** The Astrolabe also still ships two planning-only rig templates (`astrolabe.two-phase-planning` and `astrolabe.three-phase-planning`) that terminate at a `spec-publish` engine which posts a new `mandate` writ. Those templates are reachable via explicit `spider.rigTemplateMappings.brief` override in `guild.json` and are preserved for backward compatibility.

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

### Rig Template (`astrolabe.plan-and-ship`)

Contributed to the **Spider** via `rigTemplates`, with a `rigTemplateMapping` from `brief` → `astrolabe.plan-and-ship`. A single combined rig carries the brief through planning and implementation on the same writ:

```
brief writ posted
  │
  ├─ 1. Plan init (astrolabe.plan-init, clockwork)
  │     → creates a PlanDoc in the plans book keyed by the brief writ ID
  │     → yields { planId }
  │
  ├─ 2. Draft (draft, clockwork) — opens a draft binding on the brief's codex
  │     → shared by both the planning animas and the implement engine
  │     → yields { path, codexName, branch, ... }
  │
  ├─ 3. Reader-analyst (anima-session) — single pass: inventory + scope +
  │     decisions + observations
  │     → launched in draft worktree (cwd from upstream draft yields)
  │     → receives planId via ${yields.plan-init.planId}
  │     → writes artifacts to the plans book via astrolabe tools
  │     → yields { conversationId }
  │
  ├─ 4. Inventory checkpoint (astrolabe.inventory-check, clockwork)
  │     → validates inventory was produced; transitions 'reading' → 'analyzing'
  │
  ├─ 5. Patron anima pre-fill (astrolabe.patron-anima, clockwork; no-op when
  │     `astrolabe.patronRole` is unset)
  │     → consults the configured patron role under a tailored operational
  │       prompt (see `patron-anima-prompt.md`) that encodes the engine's
  │       mode discipline: one option per decision, principle-structural
  │       confidence calibration, abstain-by-omission, and an out-of-lane
  │       prohibition on codebase audit
  │     → applies each confidently-resolved verdict to Decision.selected (and
  │       records the full verdict on Decision.patron); abstained decisions
  │       are left unfilled for decision-review to surface
  │
  ├─ 6. Patron review (astrolabe.decision-review, clockwork)
  │     → pre-decided decisions (`selected` set by the analyst or the patron
  │       anima) are auto-accepted and excluded from the InputRequestDoc
  │     → fast-paths to 'writing' when no reviewable decisions remain
  │     → otherwise blocks on patron-input; on resume reconciles answers back
  │       into PlanDoc.decisions (selected / patronOverride)
  │
  ├─ 7. Spec-writer (anima-session) — synthesizes the spec into the plan
  │     → resumes the analyst's conversation via ${yields.reader-analyst.conversationId}
  │     → writes the spec into PlanDoc.spec (does NOT post a writ)
  │
  ├─ 8. Plan finalize (astrolabe.plan-finalize, clockwork)
  │     → transitions plan status 'writing' → 'completed'
  │     → yields { spec } — the written specification, passed directly to the
  │       implement engine via ${yields.plan-finalize.spec}
  │
  ├─ 9. Implement (implement, quick) — runs the implementation session
  │     → receives the spec as its prompt via the optional `prompt` given
  │       (overrides the default behaviour of using writ.body)
  │     → runs inside the same draft worktree opened in step 2
  │
  ├─ 10. Review (review, quick) — reviewer anima + mechanical checks
  │     → runs ${vars.buildCommand} and ${vars.testCommand}
  │
  ├─ 11. Revise (revise, quick, skipped when review passes)
  │     → addresses review findings
  │
  └─ 12. Seal (seal, clockwork) — seals the draft binding and merges
          → brief writ reaches `completed` here
```

The two `anima-session` engines (reader-analyst and spec-writer) use the Spider's built-in engine design, configured with Astrolabe's sage roles. Conversation chaining is wired through `${yields.<engineId>.conversationId}` references that the Spider resolves at engine start time.

The patron review engine is clockwork — it deterministically creates the `InputRequestDoc` from the plan's decisions, blocks, and reconciles answers on resume. This keeps the `anima-session` engines pure (no blocking logic) and makes the patron interaction point explicit in the rig graph.

The patron-anima engine (stage 5) consults a configured patron role under a tailored operational prompt and pre-fills decisions the anima can confidently resolve on the patron's behalf, leaving the rest for decision-review to surface to the patron. The operational prompt — packaged with the plugin as `patron-anima-prompt.md` and loaded by the engine at startup — governs how the anima acts in a single run: it constrains `selection` to one of each decision's offered option keys, calibrates confidence structurally (one principle fires cleanly = `high`; multiple principles conflict = `med`; no principle speaks = abstain by omission), forbids emitting a low-confidence placeholder when abstaining is the right move, and explicitly forecloses the anima treating its worktree `cwd` as an invitation to audit the codebase. The patron's *taste* (principles) continues to live in the role's system prompt; the operational prompt supplies the complementary mode discipline for this single engine run.

The `plan-finalize` engine is the seam between planning and implementation: it completes the plan, and its `spec` yield is wired into the downstream `implement` engine's `prompt` given. No `mandate` writ is posted by this rig.

#### Legacy planning-only templates

Two additional templates remain registered for backward compatibility:

| Template | Engines |
|---|---|
| `astrolabe.two-phase-planning` | plan-init → draft → reader-analyst → inventory-check → decision-review → spec-writer → spec-publish → seal |
| `astrolabe.three-phase-planning` | plan-init → draft → reader → inventory-check → analyst → decision-review → spec-writer → spec-publish → seal |

Both terminate at a `spec-publish` engine that posts a new `mandate` writ to the Clerk and seal the brief's rig with `abandon: true`. They are reachable via an explicit `spider.rigTemplateMappings.brief` override in `guild.json`.

### Role: `astrolabe.sage`

A single shared role contributed to the **Loom** via `roles`. All quick engines in the planning pipeline summon animas in this role. Sharing a role means sharing a system prompt — which is necessary because the conversation is shared across stages. Each stage is differentiated by its work prompt (the `prompt` given), not by its role.

The sage role carries permissions to read/write the Astrolabe's books, create patron-input requests, and post writs to the Clerk (for the final generated writ).

### Clockwork Engine Designs

The Astrolabe contributes four clockwork engine designs to the Fabricator:

- **`astrolabe.plan-init`** — creates a `PlanDoc` in the plans book, keyed by the brief writ ID. Sets initial status to `reading`. Yields `{ planId }` so downstream engines can reference the plan via `${yields.plan-init.planId}` in their givens/prompts.
- **`astrolabe.inventory-check`** — reads the plans book, validates that an inventory document exists for the current plan. On success, transitions the plan status from `'reading'` to `'analyzing'`, marking the reading phase complete and enabling the analyst stage and subsequent `decision-review` engine to proceed. Fails the engine if no inventory is found.
- **`astrolabe.patron-anima`** — consults a configured patron anima to pre-fill decisions on the patron's behalf before `decision-review` opens. When `astrolabe.patronRole` is unset (or when no reviewable decisions remain), the engine no-ops. Otherwise it launches a single-pass anima session under the configured role, supplying a tailored operational prompt that encodes the engine's mode discipline: one option per decision (selection must be one of the offered keys), principle-structural confidence calibration (`high`/`med`), abstain-by-omission (decisions the anima cannot confidently resolve are absent from the emission array rather than carried as low-confidence placeholders), and an explicit out-of-lane prohibition on codebase audit work (no file reads, grep, or implementation-feasibility probing). The engine parses a single fenced JSON emission, validates each verdict against the decision's offered option keys and the confirm/override/fill-in internal consistency rules, applies each valid verdict to `Decision.selected`, and records the full emission — selection, confidence, and optional rationale — on `Decision.patron`. Unparseable emissions, invalid verdicts, and abstained decisions are left unfilled so they flow through to `decision-review` in the normal path. The engine does not retry. The static portion of the operational prompt is checked in as `patron-anima-prompt.md`, packaged with the plugin alongside the sage role files; per-decision content (ids, questions, options, optional analyst recommendation) is interpolated by the engine at prompt-build time.
- **`astrolabe.decision-review`** — the patron interaction engine. On first run: reads decisions from the plans book and partitions them into pre-decided decisions (where the analyst or the patron anima already set `selected`) and reviewable decisions (where `selected` is unset). Pre-decided decisions are auto-accepted and skipped entirely — they produce no `questions[id]` or `answers[id]` entry in the `InputRequestDoc`. If no reviewable decisions remain, the engine fast-paths to `'writing'` without opening the patron-review gate, regardless of whether scope items exist (scope items are implicitly auto-accepted). Otherwise the engine maps each reviewable decision to a `ChoiceQuestionSpec`, pre-fills answers with analyst recommendations, writes the request to the Spider's `input-requests` book, and returns `{ status: 'blocked', blockType: 'patron-input', condition: { requestId } }`. On re-run after block clears (detected via `priorBlock` in context): reads the completed `InputRequestDoc`, reconciles patron answers back into `PlanDoc.decisions` (setting `selected` and `patronOverride` fields), validates all decisions are resolved and scope is consistent, and completes normally. Pre-decided decisions flow through reconcile unchanged — the analyst-set or anima-set `selected` is preserved and the invariant (exactly one of `selected` / `patronOverride`) still holds. Yields `{ decisionSummary }` — a human-readable string summarizing all decisions and the patron's selections, for injection into the spec-writer's prompt via inline interpolation. The decision summary renders auto-decided and patron-confirmed decisions identically.

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
  /** Architectural/design decisions with options. */
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

The `astrolabe.decision-review` engine maps each **reviewable** `Decision` — one where `selected` is unset — to a `ChoiceQuestionSpec` in the `InputRequestDoc`. Pre-decided decisions (analyst-set `selected`) are skipped entirely: no `questions[id]` entry, no `answers[id]` entry. The question key is the decision's `id`.

| Decision field | InputRequestDoc field |
|---|---|
| `id` | question key in `questions` map |
| `question` | `questions[id].label` |
| `context` + `rationale` | `questions[id].details` |
| `options` | `questions[id].options` |
| `recommendation` | pre-filled in `answers[id]` as `{ selected: recommendation }` |
| `selected` (analyst pre-set) | decision omitted from `questions` and `answers` — auto-accepted |
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
    "patronRole": "my-plugin.patron"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `patronRole` | `string` | `""` (unset) | Qualified role name of the Patron Anima consulted before decision-review. When set, the `patron-anima` engine launches an anima in this role under a tailored operational prompt (`patron-anima-prompt.md`) that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration, abstain-by-omission, and an out-of-lane prohibition on codebase audit — so the anima pre-fills decisions it can confidently resolve and leaves the rest for decision-review. When unset or empty, the engine no-ops and decision-review behaves exactly as it did before the engine existed. |

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

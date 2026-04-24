# The Astrolabe — API Contract

Status: **Implemented**

Package: `@shardworks/astrolabe-apparatus` · Plugin id: `astrolabe`

---

## Purpose

The Astrolabe refines minimal briefs from the patron into detailed work specifications, then carries the originating `mandate` writ through implementation on the same writ. When the patron commissions work — often as little as a sentence or two — the Astrolabe takes that raw intent and produces a structured spec: an inventory of the relevant codebase, analytical observations, scoped decisions, and concrete requirements. By default (`astrolabe.plan-and-ship` rig) the same rig then hands the written spec directly to a Spider `implement` engine on the mandate's own codex, runs review / revise, and seals. The originating `mandate` writ reaches `completed` only when the final seal completes.

The Astrolabe maintains its own books for planning artifacts (inventory, observations, decisions, specs) and provides tools for the animas that staff its engines to read and write those artifacts.

---

## Dependencies

```
requires: [clerk, stacks, spider, loom, fabricator]
```

- **Clerk** — the spec-writer engine posts the generated writ as the final output of the planning pipeline.
- **Stacks** — the Astrolabe's own books store planning artifacts: inventory, observations, scope, decisions, and generated specs.
- **Spider** — the Astrolabe contributes a planning rig template and the `mandate` → template mapping. Planning engines use the Spider's `patron-input` block type for decision review. The spec-writer stage uses the Spider's built-in `anima-session` engine design; the `reader-analyst` slot uses the astrolabe-owned `astrolabe.reader-analyst` engine (which mirrors the `anima-session` surface but chooses the primer role at run time from live guild config).
- **Loom** — the Astrolabe contributes a single planning role shared across all quick engines in the pipeline.
- **Fabricator** — the Astrolabe contributes clockwork engine designs for validation checkpoints.

---

## Kit Contributions

The Astrolabe is primarily a kit contributor — installing it extends the guild's capabilities through the existing kit contribution mechanisms.

### Rig Template (`astrolabe.plan-and-ship`)

Contributed to the **Spider** via `rigTemplates`, with a `rigTemplateMapping` from `mandate` → `astrolabe.plan-and-ship`. A single combined rig carries the mandate through planning and implementation on the same writ:

```
mandate writ posted
  │
  ├─ 1. Plan init (astrolabe.plan-init, clockwork)
  │     → creates a PlanDoc in the plans book keyed by the originating mandate writ ID
  │     → yields { planId }
  │
  ├─ 2. Draft (draft, clockwork) — opens a draft binding on the mandate's codex
  │     → shared by both the planning animas and the implement engine
  │     → yields { path, codexName, branch, ... }
  │
  ├─ 3. Reader-analyst (astrolabe.reader-analyst) — single pass: inventory
  │     + scope + decisions + observations, driven by the astrolabe-owned
  │     engine that selects between sage-primer-attended (when
  │     `astrolabe.patronRole` is non-empty; primer pre-fills every
  │     decision) and sage-primer-solo (otherwise; primer carries the
  │     razor itself) at engine-run time from live guild config
  │     → launched in draft worktree (cwd from upstream draft yields)
  │     → receives planId via ${yields.plan-init.planId}
  │     → writes artifacts to the plans book via astrolabe tools
  │     → yields { conversationId }
  │
  ├─ 4. Inventory checkpoint (astrolabe.inventory-check, clockwork)
  │     → validates inventory was produced; transitions 'reading' → 'analyzing'
  │
  ├─ 5. Patron anima principle-check (astrolabe.patron-anima, clockwork;
  │     no-op when `astrolabe.patronRole` is unset)
  │     → consults the configured patron role under a tailored operational
  │       prompt (see `patron-anima-prompt.md`) that encodes the engine's
  │       mode discipline: one option per decision, principle-structural
  │       confidence calibration (`high` = one principle fires cleanly;
  │       `med` = multiple principles conflict and the anima resolves;
  │       `low` = no principle speaks, confirm the primer), narrow
  │       abstention reserved for *irresolvable principle conflict* or
  │       *broken decision frame* only, and an out-of-lane prohibition on
  │       codebase audit
  │     → applies each verdict (confirm including `low`-confirm,
  │       override, fill-in) to Decision.selected and records the full
  │       verdict on Decision.patron; abstained decisions (the two narrow
  │       cases) have Decision.selected and Decision.patronOverride
  │       cleared so decision-review surfaces them
  │
  ├─ 6. Patron review (astrolabe.decision-review, clockwork)
  │     → pre-decided decisions (`selected` set by the primer or the patron
  │       anima) are auto-accepted and excluded from the InputRequestDoc
  │     → fast-paths to 'writing' when every decision is already pre-decided
  │     → otherwise blocks on patron-input; on resume reconciles answers back
  │       into PlanDoc.decisions (selected / patronOverride)
  │
  ├─ 7. Spec-writer (anima-session) — synthesizes the spec into the plan
  │     → resumes the primer's conversation via ${yields.reader-analyst.conversationId}
  │     → writes the spec into PlanDoc.spec (does NOT post a writ)
  │
  ├─ 8. Plan finalize (astrolabe.plan-finalize, clockwork)
  │     → transitions plan status 'writing' → 'completed'
  │     → yields { spec } — the written specification, passed directly to the
  │       implement engine via ${yields.plan-finalize.spec}
  │
  ├─ 9. Observation lift (astrolabe.observation-lift, clockwork)
  │     → walks plan.observations and creates draft writs at the top level
  │       (never as children of the originating mandate — provenance lives on
  │       a dedicated link kind instead, so Clerk's completion-before-parent
  │       contract is preserved)
  │     → single observation: one top-level draft `mandate` carrying two
  │       outbound edges to the originating mandate — `astrolabe.lifted-from`
  │       (provenance) and `spider.follows` (precedence gate)
  │     → two or more observations: one top-level draft `observation-set`
  │       container carrying only `astrolabe.lifted-from`, then one draft
  │       `mandate` per record with parentId set to the container and its
  │       own `spider.follows` edge back to the originating mandate
  │     → the Spider's trySpawn gate uses each `spider.follows` edge to hold
  │       the lifted writ until the originating mandate reaches a terminal
  │       state; the `observation-set` container is non-dispatchable by type
  │       and therefore carries no `spider.follows` edge
  │     → no-ops silently when observations is empty, absent, or carries
  │       a legacy string shape
  │     → yields { writIds } — the ids of the draft observation writs in
  │       record order (the `observation-set` container id, when one exists,
  │       is NOT included)
  │
  ├─ 10. Implement (implement, quick) — runs the implementation session
  │     → receives the spec as its prompt via the optional `prompt` given
  │       (overrides the default behaviour of using writ.body)
  │     → runs inside the same draft worktree opened in step 2
  │
  ├─ 11. Review (review, quick) — reviewer anima + mechanical checks
  │     → runs ${vars.buildCommand} and ${vars.testCommand}
  │
  ├─ 12. Revise (revise, quick, skipped when review passes)
  │     → addresses review findings
  │
  └─ 13. Seal (seal, clockwork) — seals the draft binding and merges
          → originating `mandate` writ reaches `completed` here
```

The `reader-analyst` stage uses the astrolabe-owned `astrolabe.reader-analyst` engine, which mirrors the generic `anima-session` surface but selects the primer role at engine-run time from live guild config. The spec-writer stage continues to use the generic `anima-session` engine with the `astrolabe.sage-writer` role. Conversation chaining is wired through `${yields.<engineId>.conversationId}` references that the Spider resolves at engine start time.

The patron review engine is clockwork — it deterministically creates the `InputRequestDoc` from the plan's decisions, blocks, and reconciles answers on resume. This keeps the quick engines pure (no blocking logic) and makes the patron interaction point explicit in the rig graph.

The patron-anima engine (stage 5) consults a configured patron role under a tailored operational prompt and principle-checks every decision the primer produced, confirming (including first-class `low`-confidence confirms when no principle speaks), overriding, filling in, or abstaining on the two narrow failure modes. The operational prompt — packaged with the plugin as `patron-anima-prompt.md` and loaded by the engine at startup — governs how the anima acts in a single run: it constrains `selection` to one of each decision's offered option keys, calibrates confidence structurally (one principle fires cleanly = `high`; multiple principles conflict and the anima resolves = `med`; no principle speaks = `low`-confirm the primer), reserves abstention-by-omission for *irresolvable principle conflict* and *broken decision frame* only, and explicitly forecloses the anima treating its worktree `cwd` as an invitation to audit the codebase. The patron's *taste* (principles) continues to live in the role's system prompt; the operational prompt supplies the complementary mode discipline for this single engine run.

The `plan-finalize` engine is the seam between planning and implementation: it completes the plan, and its `spec` yield is wired into the downstream `implement` engine's `prompt` given. No `mandate` writ is posted by this rig.

The `observation-lift` engine runs immediately after `plan-finalize`. Placement is deliberate: the plan has reached its final `completed` state so the observation records are stable, while the originating `mandate` writ itself is still in `open` phase — the rig's seal stage transitions the mandate later. Lifted writs are created at the top level (never as children of the originating mandate): a parent-child edge carries a completion-before-parent contract that provenance does not fit, and attaching lifted observations as children of the mandate violates that contract by requiring the children to complete *after* the mandate. Provenance instead rides on a dedicated kit-registered link kind, `astrolabe.lifted-from`, with direction source=lifted writ, target=originating mandate.

The engine operates in one of two modes, selected by a fixed threshold of two observation records:

- **Flat mode — single observation.** The engine calls `clerk.post({ type: 'mandate', title, body, codex, draft: true })` (no `parentId`) to create a single top-level draft `mandate` writ, then installs two outbound edges back to the originating mandate: `clerk.link(newWritId, planId, 'lifted from', 'astrolabe.lifted-from')` (provenance) and `clerk.link(newWritId, planId, 'depends on', 'spider.follows')` (precedence gate).
- **Grouped mode — two or more observations.** The engine first creates a top-level draft container via `clerk.post({ type: 'observation-set', title: 'Observations from "{originating title}"', body, codex, draft: true })` whose body begins with a short preamble naming the originating writ and lists the child titles numerically, then installs a single outbound `astrolabe.lifted-from` edge from the container to the originating mandate. The container carries *no* `spider.follows` edge — `observation-set` is non-dispatchable by type (it has no `rigTemplateMappings` entry), so Spider never attempts to pick it up, and a precedence edge on it would be dead data. For each observation record in record order, the engine then posts a draft `mandate` with `parentId` set to the container's id and installs a single outbound `spider.follows` edge from the child back to the originating mandate. Children do not carry `astrolabe.lifted-from`; their provenance is discoverable via their `parentId` and the container's edge.

Every lifted `mandate` writ enters `new` (draft) phase, invisible to the Spider, ready for a curator (human or an overseer shipped separately) to promote to `open`. Once promoted, the `spider.follows` edge enlists the Spider's `trySpawn` gate to hold the lifted writ until the originating mandate reaches a terminal state (release on `completed`/`cancelled`, cascade to `stuck` on `failed`) — the lifted observations describe concerns that presume the originating mandate has shipped, and the gate makes that latent dependency explicit in the writ graph rather than relying on curator memory. The engine is unconditional — empty, absent, or legacy-string observations are handled internally with a silent no-op, so no `when:` guard is needed. The two link kinds play complementary roles: `astrolabe.lifted-from` is the provenance trail (which observation came from which plan's planning run) and `spider.follows` is the precedence gate (which lifted writ waits on which mandate). In grouped mode the two edges sit on different writs — the container carries `astrolabe.lifted-from` only, and each child carries `spider.follows` only — but together they still form the full audit trail.

### Roles

Several sage roles are contributed to the **Loom** via `roles`, each tailored to a pipeline stage:

- **`astrolabe.sage-primer-reader`** — reserved. No current rig template summons this role; it remains registered so a guild can wire it into a custom rig template if desired.
- **`astrolabe.sage-primer-scoping`** — reserved. No current rig template summons this role; it remains registered for the same reason as `sage-primer-reader`.
- **`astrolabe.sage-primer-solo`** — combined reader + scoping primer for the plan-and-ship rig, used when `astrolabe.patronRole` is unset or empty. Carries the razor itself, leaving only razor-matched decisions unset for the patron.
- **`astrolabe.sage-primer-attended`** — combined reader + scoping primer for the plan-and-ship rig, used when `astrolabe.patronRole` is non-empty. Pre-fills `selected` on every decision; the downstream patron-anima principle-checks each one and confirms, overrides, fills in, or narrowly abstains.
- **`astrolabe.sage-writer`** — spec-writer stage.

The `astrolabe.reader-analyst` engine selects between the two primer variants (solo / attended) at engine-run time by reading `astrolabe.patronRole` from live guild config. Sage roles carry permissions to read/write the Astrolabe's books, create patron-input requests, and post writs to the Clerk (for the final generated writ).

### Clockwork Engine Designs

The Astrolabe contributes clockwork engine designs to the Fabricator:

- **`astrolabe.plan-init`** — creates a `PlanDoc` in the plans book, keyed by the originating `mandate` writ ID. Sets initial status to `reading`. Yields `{ planId }` so downstream engines can reference the plan via `${yields.plan-init.planId}` in their givens/prompts.
- **`astrolabe.inventory-check`** — reads the plans book, validates that an inventory document exists for the current plan. On success, transitions the plan status from `'reading'` to `'analyzing'`, marking the reading phase complete and enabling the scoping-primer stage and subsequent `decision-review` engine to proceed. Fails the engine if no inventory is found.
- **`astrolabe.reader-analyst`** — quick engine (animator-backed). Mirrors the generic `anima-session` engine surface but resolves the primer role at engine-run time from live guild config: `sage-primer-attended` when `astrolabe.patronRole` is non-empty, `sage-primer-solo` otherwise. Run-time selection (per writ, not per guild startup) lets the patron reconfigure the patron role mid-experiment and have the next brief behave according to the live config. The engine accepts `prompt`, `cwd`, optional `writ`, and optional `metadata` givens — the `role` given is intentionally rejected, since the engine chooses the role itself. Returns `{ status: 'launched', sessionId }`.
- **`astrolabe.patron-anima`** — consults a configured patron anima to principle-check every decision the primer produced, before `decision-review` opens. When `astrolabe.patronRole` is unset, the engine no-ops. Otherwise it launches a single-pass anima session under the configured role, supplying a tailored operational prompt that encodes the engine's mode discipline: one option per decision (selection must be one of the offered keys), principle-structural confidence calibration (`high` = one principle fires cleanly; `med` = multiple principles conflict and the anima resolves; `low` = no principle speaks and the anima confirms the primer), narrow abstention-by-omission reserved for *irresolvable principle conflict* and *broken decision frame* only, and an explicit out-of-lane prohibition on codebase audit work (no file reads, grep, or implementation-feasibility probing). The engine parses a single fenced JSON emission, validates each verdict against the decision's offered option keys and the confirm/override/fill-in internal consistency rules, applies each valid verdict to `Decision.selected`, and records the full emission — selection, confidence (`high`/`med`/`low`), and optional rationale — on `Decision.patron`. Unparseable emissions, invalid verdicts, and abstained decisions (the two narrow cases) have both `Decision.selected` and `Decision.patronOverride` cleared so they surface to `decision-review` via its `selected === undefined` filter in the normal path. The engine does not retry. The static portion of the operational prompt is checked in as `patron-anima-prompt.md`, packaged with the plugin alongside the sage role files; per-decision content (ids, questions, options, optional primer recommendation) is interpolated by the engine at prompt-build time.
- **`astrolabe.decision-review`** — the patron interaction engine. On first run: reads decisions from the plans book and partitions them into pre-decided decisions (where the primer or the patron anima already set `selected`) and reviewable decisions (where `selected` is unset). Pre-decided decisions are auto-accepted and skipped entirely — they produce no `questions[id]` or `answers[id]` entry in the `InputRequestDoc`. If every decision has already been pre-decided, the engine fast-paths to `'writing'` without opening the patron-review gate, regardless of whether scope items exist (scope items are implicitly auto-accepted). Otherwise the engine maps each reviewable decision to a `ChoiceQuestionSpec`, pre-fills answers with primer recommendations, writes the request to the Spider's `input-requests` book, and returns `{ status: 'blocked', blockType: 'patron-input', condition: { requestId } }`. On re-run after block clears (detected via `priorBlock` in context): reads the completed `InputRequestDoc`, reconciles patron answers back into `PlanDoc.decisions` (setting `selected` and `patronOverride` fields), validates all decisions are resolved and scope is consistent, and completes normally. Pre-decided decisions flow through reconcile unchanged — the primer-set or anima-set `selected` is preserved and the invariant (exactly one of `selected` / `patronOverride`) still holds. Yields `{ decisionSummary }` — a human-readable string summarizing all decisions and the patron's selections, for injection into the spec-writer's prompt via inline interpolation. The decision summary renders auto-decided and patron-confirmed decisions identically.
- **`astrolabe.plan-finalize`** — planning-phase terminator for the combined plan-and-ship rig. Validates that `plan.spec` is a non-empty string, transitions `plan.status` from `'writing'` to `'completed'`, and yields `{ spec }` so the downstream `implement` engine can read the spec via `${yields.plan-finalize.spec}` without posting a mandate writ.
- **`astrolabe.observation-lift`** — top-level writ fan-out stage. Reads the plan, validates its status is `'completed'` (placement after `plan-finalize` guarantees this), and walks `plan.observations`. If the field is not an array or is empty, the engine silently no-ops and yields `{ writIds: [] }`. Otherwise it produces top-level writs using one of two modes selected by a fixed threshold of two records. **Flat mode** (single observation): calls `clerk.post({ type: 'mandate', title, body, codex, draft: true })` (no `parentId`) and then installs two outbound edges back to the originating mandate — `clerk.link(newWritId, planId, 'lifted from', 'astrolabe.lifted-from')` (provenance) and `clerk.link(newWritId, planId, 'depends on', 'spider.follows')` (precedence gate that hands the writ to the Spider's `trySpawn` gate once a curator promotes the draft). **Grouped mode** (two or more observations): first posts a top-level draft `observation-set` container whose title embeds the originating mandate's title (`Observations from "{title}"`) and whose body lists the observation titles with a short preamble naming the originating writ, then installs a single outbound `astrolabe.lifted-from` edge from the container to the originating mandate (the container carries *no* `spider.follows` edge — `observation-set` is non-dispatchable and any precedence edge on it would be dead data); then, per observation record in record order, posts a draft `mandate` whose `parentId` is the container's id and installs exactly one outbound `spider.follows` edge from that child back to the originating mandate (children do not carry `astrolabe.lifted-from`; their provenance is implied by the container's edge plus the parent-child relationship). The post and the link(s) are paired per record, so a mid-loop failure leaves a coherent prefix persisted. Fails fast on the first `clerk.post` or `clerk.link` error — already-created writs and links persist (invisible to the Spider until a curator publishes them), and a `clerk.link` failure leaves the in-flight writ posted but only partially linked for curator reconciliation. The engine never mutates the plan document; the two link kinds together — `astrolabe.lifted-from` for provenance, `spider.follows` for precedence — form the audit trail. Yields `{ writIds }` — the ids of the draft observation writs in the same order as the observation records; the `observation-set` container id (when one exists) is *not* included in this array. Wired unconditionally in the plan-and-ship rig between `plan-finalize` and `seal`.

---

## Books

The Astrolabe declares one book in its `supportKit`:

### `astrolabe/plans`

One document per planning run, keyed by the originating `mandate` writ ID. The document accumulates fields as the pipeline progresses — the reader writes the inventory, the scoping primer writes scope/decisions/observations, the spec-writer writes the final spec.

```typescript
interface PlanDoc {
  /** The originating `mandate` writ ID — primary key. */
  id: string;
  /** The codex this plan targets. */
  codex: string;
  /** Planning status. */
  status: 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed';

  // ── Reader output ─────────────────────────────────────────
  /** Codebase inventory: affected files, types, interfaces, patterns. */
  inventory?: string;   // markdown

  // ── Analyst output ────────────────────────────────────────
  /**
   * Primer observations. Each entry is an atomic, commissionable concern
   * (refactoring opportunity, risk, convention drift, bug, etc.) named
   * outside the originating mandate's scope but worth recording. The
   * `astrolabe.observation-lift` engine lifts each record into a draft
   * top-level `mandate` writ (never a child of the originating mandate),
   * with an `astrolabe.lifted-from` edge pointing back to the originating
   * mandate for provenance. When two or more observations exist, the
   * engine also creates a top-level `observation-set` container that
   * parents the draft mandates. In all cases a curator (human or
   * automated) promotes each draft to open status before the Spider
   * picks it up.
   */
  observations?: Observation[];
  /** Scope items: what's in and what's out. */
  scope?: ScopeItem[];
  /** Architectural/design decisions with options. */
  decisions?: Decision[];

  // ── Spec-writer output ────────────────────────────────────
  /** The generated specification. */
  spec?: string;   // markdown
  /**
   * Legacy: writ ID of a mandate produced by the retired `spec-publish`
   * engine. Current rig templates do not set this field — it survives
   * solely so historic plandocs continue to deserialise and render.
   */
  generatedWritId?: string;

  createdAt: string;
  updatedAt: string;
}

interface Observation {
  /** Plandoc-local identifier assigned by the sage (convention: obs-1, obs-2, …). */
  id: string;
  /** One-line commission-title-style phrase (~10 words, no trailing punctuation). */
  title: string;
  /** Tactical detail in markdown — file paths, symbols, preconditions, etc. */
  body: string;
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
  context?: string;             // primer's long-form context/explanation
  options: Record<string, string>;   // key → description
  recommendation?: string;      // option key the primer recommends
  rationale?: string;           // primer's reasoning for the recommendation
  selected?: string;            // patron's chosen option key (set by decision-review engine)
  patronOverride?: string;      // patron's freeform override (set by decision-review engine)
}
```

**Indexes:** `['status', 'codex', 'createdAt']`

### Mapping to `patron-input` Questions

The `astrolabe.decision-review` engine maps each **reviewable** `Decision` — one where `selected` is unset — to a `ChoiceQuestionSpec` in the `InputRequestDoc`. Pre-decided decisions (primer-set `selected`) are skipped entirely: no `questions[id]` entry, no `answers[id]` entry. The question key is the decision's `id`.

| Decision field | InputRequestDoc field |
|---|---|
| `id` | question key in `questions` map |
| `question` | `questions[id].label` |
| `context` + `rationale` | `questions[id].details` |
| `options` | `questions[id].options` |
| `recommendation` | pre-filled in `answers[id]` as `{ selected: recommendation }` |
| `selected` (primer pre-set) | decision omitted from `questions` and `answers` — auto-accepted |
| — | `questions[id].allowCustom: true` (always, for patron overrides) |

When the patron completes the request, the `decision-review` engine reconciles answers back:

| InputRequestDoc answer | Decision field |
|---|---|
| `{ selected: key }` | `selected = key` |
| `{ custom: text }` | `patronOverride = text` |

The `InputRequestDoc.message` field carries a summary of the originating mandate and scope context so the patron has orientation when reviewing decisions outside the planning conversation.

---

## Tools

The Astrolabe provides tools scoped to the `astrolabe` permission namespace. Planning animas use these to build up the plan document incrementally. The `planId` parameter is the originating `mandate` writ ID (set by the `plan-init` engine and delivered to anima-session engines via givens).

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

Write or replace the primer observations for a plan.

- **Permission:** `astrolabe:write`
- **Params:** `planId` (string), `observations` (`Observation[]` — strict array of records with non-empty `id`, `title`, and `body`)
- **Behavior:** Patches the plan's `observations` field and sets `updatedAt`. Zod validates each record's shape and rejects the legacy prose-string payload at param validation. The tool is a thin pass-through — sages assign their own `id` values (convention: `obs-1`, `obs-2`, …); the tool does not enforce id-uniqueness. Downstream, the `astrolabe.observation-lift` engine walks the array and creates one draft `mandate` writ per record at the top level, each carrying an `astrolabe.lifted-from` edge back to the originating mandate; when two or more observations exist, the mandates are grouped under a top-level `observation-set` container that itself carries the `astrolabe.lifted-from` edge on behalf of the batch.

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
| `patronRole` | `string` | `""` (unset) | Qualified role name of the Patron Anima consulted before decision-review. When set (non-empty string), `astrolabe.reader-analyst` selects the `sage-primer-attended` role (every decision gets pre-filled) and the `patron-anima` engine launches an anima in the configured role under a tailored operational prompt (`patron-anima-prompt.md`) that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration (`high`/`med`/`low`-confirm), narrow abstention reserved for *irresolvable principle conflict* and *broken decision frame*, and an out-of-lane prohibition on codebase audit — so the anima principle-checks every decision and either confirms (including `low`-confirms), overrides, fills in, or narrowly abstains. When unset, empty, or whitespace-only, `astrolabe.reader-analyst` selects the `sage-primer-solo` role (primer carries the razor itself), the `patron-anima` engine no-ops, and `decision-review` behaves exactly as it did before the engine existed. |

---

## Design Decisions

- **Analyst revision loop.** For MVP, rejecting a plan's `InputRequestDoc` fails the rig. The patron posts a new brief to start over. A revision loop (reject → re-analyze) may come later via rig retry/recovery mechanisms.
- **Spec-writer prompt composition.** The spec-writer resumes the primer's conversation for full context. Patron decision answers (which happen outside the conversation via `input-request-answer` tools) are injected into the spec-writer's prompt via inline interpolation — the `decision-review` engine yields a `decisionSummary` string, wired into the prompt as `${yields.decision-review.decisionSummary}`.
- **Single PlanDoc.** All planning artifacts live in one document per planning run. Simpler for tools, querying, and checkpoint validation. If finer-grained CDC or independent artifact lifecycle is needed later, splitting into separate books is straightforward since tools already namespace by artifact type.

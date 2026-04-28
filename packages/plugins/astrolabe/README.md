# `@shardworks/astrolabe-apparatus`

The Astrolabe transforms patron briefs into structured work specifications and carries them through implementation. A single combined rig (`astrolabe.plan-and-ship`) runs the planning pipeline — inventory, analysis, optional Patron Anima pre-fill, patron review, specification writing — and then continues into draft → implement → review → revise → seal on the same `mandate` writ. The mandate reaches `completed` only after the final seal engine finishes. It sits between the Clerk (writ lifecycle) and the Spider (rig execution), contributing kit pieces to both.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/astrolabe-apparatus": "workspace:*"
  }
}
```

The Astrolabe requires `stacks` and `clerk` and recommends `spider`, `loom`, `fabricator`, `oculus`, `ratchet`, `animator`, and `clockworks`. Clockworks is a soft dependency: when it's installed the `plan-finalize` engine emits the predicted-files soft-warn event into the events book; when it's absent the engine silently skips the emission. Resolution is lazy at engine-run time so an Astrolabe-without-Clockworks install remains viable.

## API

The Astrolabe exposes an `AstrolabeApi` via `provides`, accessible at runtime via `guild().apparatus<AstrolabeApi>('astrolabe')`.

```typescript
import type { AstrolabeApi } from '@shardworks/astrolabe-apparatus';

const astrolabe = guild().apparatus<AstrolabeApi>('astrolabe');

// Show a single plan
const plan = await astrolabe.show('w-abc123-def456');

// List plans with filters
const plans = await astrolabe.list({ status: 'writing', codex: 'my-codex', limit: 10 });

// Partially update a plan (engines and tools use this internally)
const updated = await astrolabe.patch('w-abc123-def456', { spec: '# Spec\n...' });
```

### `AstrolabeApi`

```typescript
interface AstrolabeApi {
  /** Show a plan by id. Throws if not found. */
  show(planId: string): Promise<PlanDoc>;

  /** List plans with optional filters, ordered by createdAt descending. */
  list(filters?: PlanFilters): Promise<PlanDoc[]>;

  /** Partially update a plan. Returns the updated document. Throws if not found. */
  patch(planId: string, fields: Partial<Omit<PlanDoc, 'id'>>): Promise<PlanDoc>;
}
```

### `PlanDoc`

A `PlanDoc` is keyed by the originating `mandate` writ ID and tracks the full planning lifecycle:

```typescript
interface PlanDoc {
  id: string;               // Originating mandate writ ID
  codex: string;            // Target codex
  status: PlanStatus;       // 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed'
  inventory?: string;       // Markdown: affected files, types, interfaces, patterns
  observations?: Observation[]; // Atomic, commissionable concerns (see Observation below)
  scope?: ScopeItem[];      // What's in and what's out
  decisions?: Decision[];   // Architectural/design decisions with options
  spec?: string;            // The generated specification (implementation brief + task manifest)
  generatedWritId?: string; // ID of a mandate produced by the retired spec-publish engine — may be present on historic plans; current rigs do not set this
  manifestFilesCount?: number; // Predicted-files-touched cost signal — count of distinct path tokens predicted by the spec's task-manifest <files> elements; set on every plan that reaches `completed` (0 when no manifest is present or no path tokens were found)
  createdAt: string;
  updatedAt: string;
}

interface Observation {
  /** Plandoc-local identifier assigned by the sage (convention: obs-1, obs-2, …). */
  id: string;
  /** One-line commission-title-style phrase (~10 words, no trailing punctuation). */
  title: string;
  /** Tactical markdown — file paths, symbols, preconditions, etc. */
  body: string;
}
```

Each `Observation` names one concern — a refactoring opportunity, risk, convention drift, or bug — that the sage noticed but that sits outside the originating mandate's scope. The `astrolabe.observation-lift` engine lifts each record into a draft top-level `mandate` writ (never a child of the originating mandate), attaching an `astrolabe.lifted-from` provenance edge back to the originating mandate so the lineage is filterable and auditable. When a plan yields two or more observations, the engine also creates a top-level `observation-set` container that parents the draft mandates and carries the `astrolabe.lifted-from` edge on behalf of the batch. A curator (human or automated) promotes each draft to open status before the Spider picks it up.

### `PlanFilters`

```typescript
interface PlanFilters {
  status?: PlanStatus;  // Filter by planning status
  codex?: string;       // Filter by codex name
  limit?: number;       // Max results (default: 20)
  offset?: number;      // Skip N results
}
```

## Configuration

Add an `astrolabe` section to `guild.json` to configure behaviour:

```json
{
  "astrolabe": {
    "patronRole": "my-plugin.patron",
    "predictedFilesThreshold": 15
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `patronRole` | `string` | `""` (unset) | Qualified role name of the Patron Anima consulted before decision-review. When set (non-empty string), the `astrolabe.reader-analyst` engine selects the `sage-primer-attended` role (every decision is pre-filled so the patron-anima principle-checks them all) and the `patron-anima` engine launches an anima in the configured role under a tailored operational prompt (see `patron-anima-prompt.md`) that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration (`high`/`med`/`low`-confirm), narrow abstention reserved for irresolvable principle conflict or broken decision frame, and an out-of-lane prohibition on codebase audit work. When unset, empty, or whitespace-only, `astrolabe.reader-analyst` selects the `sage-primer-solo` role (the primer carries the razor itself) and the `patron-anima` engine no-ops; `decision-review` behaves exactly as it did before the engine existed. |
| `predictedFilesThreshold` | `number` | `15` | Soft-warn threshold for the predicted-files cost signal. The `astrolabe.plan-finalize` engine emits the `astrolabe.plan.files-over-threshold` Clockworks event (payload `{ planId, count, threshold }`) when a plan's `manifestFilesCount` strictly exceeds this value. The framework does **not** halt the pipeline; subscribers (sanctum-side instrumentation, future auto-decompose) decide what to do. Must be a positive integer when supplied — the resolver fails loud on malformed values (wrong type, NaN, negative, zero, non-integer) so a typo cannot silently mask the operator's intent. The default of 15 was chosen empirically: post-Apr-16 implement-engine sessions show a 3.2× cost cliff at 20+ files; 15 is the soft-warn level a few steps below the cliff. |

### Events

The Astrolabe emits the following Clockworks event from `plan-finalize`:

| Event | Payload | Trigger |
|---|---|---|
| `astrolabe.plan.files-over-threshold` | `{ planId, count, threshold }` | The `astrolabe.plan-finalize` engine emits this exactly once per plan when `manifestFilesCount` strictly exceeds the configured `predictedFilesThreshold`. The patch transitioning the plan to `completed` has already landed by the time the emit is attempted, and emission is best-effort: a Clockworks failure is logged as a `[astrolabe]` `console.warn` breadcrumb and does not fail the engine. The event is **not** declared in any framework-shipped `guild.json` — declaring a subscriber is the wiring guild's job. |

This is a measurement layer, not a gate. The framework records the signal; the pipeline does not halt. See `docs/reference/event-catalog.md` for the catalog entry.

## Support Kit

### Books

The Astrolabe declares one book in Stacks:

| Book | Owner | Indexes |
|---|---|---|
| `plans` | `astrolabe` | `status`, `codex`, `createdAt` |

### Writ Types (contributed to Clerk)

| Name | Description |
|---|---|
| `step` | An atomic step within a mandate, executed sequentially. |
| `observation-set` | A non-dispatchable container grouping writs lifted from a single planning run. Spider never dispatches this type (no `rigTemplateMappings` entry); it exists so curators can triage related lifted observations as a batch. Created by `astrolabe.observation-lift` when a plan yields two or more observations. |

### Link Kinds (contributed to Clerk)

| ID | Description |
|---|---|
| `astrolabe.lifted-from` | The source writ was lifted from the planning run of the target writ. Provenance edge: marks the originating mandate whose plan-and-ship rig produced this writ via the `observation-lift` engine. Created on the lifted `mandate` itself in flat mode, and on the `observation-set` container in grouped mode. |

### Roles (contributed to Loom)

| Role | Qualified Name | Permissions | Strict | Used In |
|---|---|---|---|---|
| `sage-primer-reader` | `astrolabe.sage-primer-reader` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | reserved — no current rig template summons this role |
| `sage-primer-scoping` | `astrolabe.sage-primer-scoping` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | reserved — no current rig template summons this role |
| `sage-writer` | `astrolabe.sage-writer` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | spec-writer stage |
| `sage-primer-solo` | `astrolabe.sage-primer-solo` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | `reader-analyst` slot, when `astrolabe.patronRole` is unset — primer carries the razor itself |
| `sage-primer-attended` | `astrolabe.sage-primer-attended` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | `reader-analyst` slot, when `astrolabe.patronRole` is non-empty — primer pre-fills every decision, patron-anima principle-checks them all |

### Engines (contributed to Fabricator)

| Engine ID | Description |
|---|---|
| `astrolabe.plan-init` | Creates a PlanDoc from the originating mandate writ; validates codex presence |
| `astrolabe.inventory-check` | Validates that the reader produced a non-empty inventory |
| `astrolabe.reader-analyst` | Selects the primer role at engine-run time from live guild config: `sage-primer-attended` when `astrolabe.patronRole` is non-empty (every decision gets pre-filled so the downstream patron-anima principle-checks them all), `sage-primer-solo` otherwise (the primer carries the razor itself and only leaves razor-matched decisions unset for the patron). Mirrors the `anima-session` surface — same givens (`prompt`, `cwd`, `writ`, `metadata`) minus the `role` given, which the engine chooses. Run-time selection (per writ, not per guild startup) means the patron can reconfigure `astrolabe.patronRole` mid-experiment and the next brief behaves according to the live config. |
| `astrolabe.patron-anima` | Consults a configured Patron Anima to principle-check every decision the primer produced, under a tailored operational prompt that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration (`high` = one principle fires cleanly; `med` = multiple principles conflict and the anima resolves; `low` = no principle speaks, confirm the primer), narrow abstention by omission reserved for *irresolvable principle conflict* and *broken decision frame* only, and an explicit out-of-lane prohibition on codebase audit work. In attended mode the primer contractually pre-fills `selected` on every decision; this engine reviews them all, launches the configured `patronRole` via a single-pass anima session, parses a single structured emission, and applies each valid verdict to `Decision.selected` (plus records the full verdict — confirm / override / fill-in with selection, confidence, rationale — on `Decision.patron`). No-ops when `astrolabe.patronRole` is unset or empty, or when the plan has no decisions. Unparseable output, invalid verdicts, and abstained decisions have `Decision.selected` and `Decision.patronOverride` cleared — decision-review's `selected === undefined` filter surfaces the remainder to the patron in the normal flow. |
| `astrolabe.decision-review` | Two-pass engine: blocks for patron review, then reconciles answers. Decisions with `selected` already pre-set by the primer or the patron anima are auto-accepted — they are excluded from the InputRequestDoc, and if nothing remains reviewable the engine fast-paths to `writing` without opening the gate. |
| `astrolabe.plan-finalize` | Transitions the plan to `completed` and yields the written `spec` downstream. Does not post any writ. Used inside `plan-and-ship` to hand the spec off to the implement engine on the same mandate rig. As part of the same single atomic patch that flips status to `completed`, also records the predicted-files cost signal — the count of distinct path tokens predicted by the spec's `<task-manifest>` `<files>` elements — onto `PlanDoc.manifestFilesCount` (set on every completed plan; 0 when no manifest is present). When the count strictly exceeds the configured `astrolabe.predictedFilesThreshold` (default 15), emits exactly one `astrolabe.plan.files-over-threshold` Clockworks event with payload `{ planId, count, threshold }` after the patch lands. Emission is best-effort: a Clockworks failure logs a `[astrolabe]` `console.warn` breadcrumb and does not fail the engine. When Clockworks is not installed, the count still lands on the PlanDoc and the engine succeeds silently. |
| `astrolabe.observation-lift` | Walks `plan.observations` after `plan-finalize` has transitioned the plan to `completed` and creates draft writs at the top level (never as children of the originating mandate — a parent-child edge would require the children to complete before the parent, which inverts the intended relationship). Provenance instead rides on the kit-registered `astrolabe.lifted-from` link kind (source = lifted writ, target = originating mandate). The engine selects one of two modes by a fixed threshold of two records. **Flat mode** (single observation): posts a top-level draft `mandate` and installs two outbound edges to the originating mandate — `astrolabe.lifted-from` (provenance) and `depends-on` (the framework-level dependency edge contributed by Clerk's substrate; Spider's dispatch gate reads it but does not own it). **Grouped mode** (two or more observations): first posts a top-level draft `observation-set` container carrying only `astrolabe.lifted-from`, then posts each observation record as a draft `mandate` with `parentId` set to the container, each carrying only `depends-on`. The `depends-on` edges enlist the Spider's `trySpawn` gate to hold each lifted writ until the originating mandate reaches a terminal state (release on `completed`/`cancelled`, cascade to `stuck` on `failed`); the `observation-set` container is non-dispatchable by type and therefore carries no `depends-on` edge. Each created writ enters `new` (draft) phase, invisible to the Spider until a curator publishes it. Silently no-ops when `observations` is empty, absent, or a legacy string; fails fast on the first `clerk.post` or `clerk.link` error — already-created writs and links persist, leaving a coherent prefix for curator reconciliation. Does not mutate the plan — the two link kinds together form the audit trail. Yields `{ writIds }` — one id per observation record, in record order; the `observation-set` container id (when one exists) is *not* included. Wired unconditionally into the plan-and-ship rig template. |

### Rig Templates (contributed to Spider)

| Template | Mapped Writ Type | Engines |
|---|---|---|
| `astrolabe.plan-and-ship` | `mandate` (default) | plan-init → draft → reader-analyst → inventory-check → patron-anima → decision-review → spec-writer → plan-finalize → observation-lift → implement → review → revise → seal |

The `resolutionEngine` is `seal` — the originating `mandate` writ reaches `completed` only after the final seal engine completes.

#### Rig Template Selection

The `mandate` writ type maps to `astrolabe.plan-and-ship` by default whenever Astrolabe is installed alongside Spider. This single combined rig carries the mandate through planning and implementation on one writ — the `plan-finalize` engine hands the written spec directly to the downstream `implement` engine via `${yields.plan-finalize.spec}`, and no separate implementation-target writ is posted. The `reader-analyst` slot is driven by the astrolabe-owned `astrolabe.reader-analyst` engine, which selects between the `sage-primer-attended` and `sage-primer-solo` roles at engine-run time from live guild config. The optional `patron-anima` stage between `inventory-check` and `decision-review` consults the configured `patronRole` under a tailored operational prompt (see `patron-anima-prompt.md` packaged with the plugin) whenever `astrolabe.patronRole` is set. The anima principle-checks every decision the primer produced and confirms (including first-class `low`-confidence confirms when no principle speaks), overrides, fills in, or abstains. Abstention is narrow — reserved for *irresolvable principle conflict* and *broken decision frame* only. Abstained decisions are left unfilled and flow through to decision-review in the normal path.

### Tools

| Tool | Permission | Description |
|---|---|---|
| `plan-show` | `astrolabe:read` | Show full detail for a plan by ID |
| `plan-list` | `astrolabe:read` | List plans with optional status/codex filters |
| `inventory-write` | `astrolabe:write` | Write or replace the codebase inventory |
| `scope-write` | `astrolabe:write` | Write or replace the scope items array |
| `decisions-write` | `astrolabe:write` | Write or replace the decisions array |
| `observations-write` | `astrolabe:write` | Write or replace primer observations (strict `Observation[]` array — `{ id, title, body }` records with non-empty strings; legacy prose-string payloads are rejected at zod validation) |
| `spec-write` | `astrolabe:write` | Write or replace the generated specification |

Write tools only update their artifact field plus `updatedAt`. Status transitions are the exclusive responsibility of the clockwork engines.

### Pages (contributed to Oculus)

| Page ID | Title | Directory |
|---|---|---|
| `astrolabe` | Astrolabe | `pages/astrolabe` |

The Astrolabe page provides a list/detail dashboard for PlanDoc records:

- **List view** — filterable by status, paginated (20 per page), showing status badge, codex, originating mandate writ title, plan ID, and creation date.
- **Detail view** — metadata card with plan ID, status, codex, a cross-link to the originating mandate writ (linking to the Clerk writs page via `?writ=ID`), per-step AI cost breakdowns (input/output tokens and USD cost for each anima-session engine), and tabbed content sections for Inventory, Scope, Decisions, Observations, and Spec.
- **Observations tab** — renders the `Observation[]` array as a card-per-record list (id, title, markdown body). Card bodies flow through the same markdown renderer used by inventory and spec. An empty or absent array renders as an empty tab. A legacy prose-string payload renders as empty rather than corrupting the tab.
- **Deep linking** — supports `?plan=ID` query parameter to open directly to a plan's detail view.

Markdown fields (inventory, spec, and each observation body) are rendered client-side with a minimal renderer supporting headings, bold, italic, inline code, fenced code blocks, and lists. All content is HTML-escaped before rendering to prevent XSS.

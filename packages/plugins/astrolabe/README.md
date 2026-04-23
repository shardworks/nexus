# `@shardworks/astrolabe-apparatus`

The Astrolabe transforms patron briefs into structured work specifications and carries them through implementation. A single combined rig (`astrolabe.plan-and-ship`) runs the planning pipeline — inventory, analysis, optional Patron Anima pre-fill, patron review, specification writing — and then continues into draft → implement → review → revise → seal on the same brief writ. The brief reaches `completed` only after the final seal engine finishes. It sits between the Clerk (writ lifecycle) and the Spider (rig execution), contributing kit pieces to both.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/astrolabe-apparatus": "workspace:*"
  }
}
```

The Astrolabe requires `stacks` and `clerk` and recommends `spider`, `loom`, `fabricator`, and `oculus`.

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

A `PlanDoc` is keyed by the brief writ ID and tracks the full planning lifecycle:

```typescript
interface PlanDoc {
  id: string;               // Brief writ ID
  codex: string;            // Target codex
  status: PlanStatus;       // 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed'
  inventory?: string;       // Markdown: affected files, types, interfaces, patterns
  observations?: Observation[]; // Atomic, commissionable concerns (see Observation below)
  scope?: ScopeItem[];      // What's in and what's out
  decisions?: Decision[];   // Architectural/design decisions with options
  spec?: string;            // The generated specification (implementation brief + task manifest)
  generatedWritId?: string; // ID of a mandate produced by the retired spec-publish engine — may be present on historic plans; current rigs do not set this
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

Each `Observation` names one concern — a refactoring opportunity, risk, convention drift, or bug — that the sage noticed but that sits outside the brief's scope. The `astrolabe.observation-lift` engine lifts each record into a draft child `brief` writ under the originating brief so a curator (human or automated) can promote it.

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
    "patronRole": "my-plugin.patron"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `patronRole` | `string` | `""` (unset) | Qualified role name of the Patron Anima consulted before decision-review. When set (non-empty string), the `astrolabe.reader-analyst` engine selects the `sage-primer-attended` role (every decision is pre-filled so the patron-anima principle-checks them all) and the `patron-anima` engine launches an anima in the configured role under a tailored operational prompt (see `patron-anima-prompt.md`) that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration (`high`/`med`/`low`-confirm), narrow abstention reserved for irresolvable principle conflict or broken decision frame, and an out-of-lane prohibition on codebase audit work. When unset, empty, or whitespace-only, `astrolabe.reader-analyst` selects the `sage-primer-solo` role (the primer carries the razor itself) and the `patron-anima` engine no-ops; `decision-review` behaves exactly as it did before the engine existed. |

## Support Kit

### Books

The Astrolabe declares one book in Stacks:

| Book | Owner | Indexes |
|---|---|---|
| `plans` | `astrolabe` | `status`, `codex`, `createdAt` |

### Writ Types (contributed to Clerk)

| Name | Description |
|---|---|
| `brief` | A patron brief triggering the planning pipeline |

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
| `astrolabe.plan-init` | Creates a PlanDoc from the brief writ; validates codex presence |
| `astrolabe.inventory-check` | Validates that the reader produced a non-empty inventory |
| `astrolabe.reader-analyst` | Selects the primer role at engine-run time from live guild config: `sage-primer-attended` when `astrolabe.patronRole` is non-empty (every decision gets pre-filled so the downstream patron-anima principle-checks them all), `sage-primer-solo` otherwise (the primer carries the razor itself and only leaves razor-matched decisions unset for the patron). Mirrors the `anima-session` surface — same givens (`prompt`, `cwd`, `writ`, `metadata`) minus the `role` given, which the engine chooses. Run-time selection (per writ, not per guild startup) means the patron can reconfigure `astrolabe.patronRole` mid-experiment and the next brief behaves according to the live config. |
| `astrolabe.patron-anima` | Consults a configured Patron Anima to principle-check every decision the primer produced, under a tailored operational prompt that encodes the engine's mode discipline — one option per decision, principle-structural confidence calibration (`high` = one principle fires cleanly; `med` = multiple principles conflict and the anima resolves; `low` = no principle speaks, confirm the primer), narrow abstention by omission reserved for *irresolvable principle conflict* and *broken decision frame* only, and an explicit out-of-lane prohibition on codebase audit work. Reads the plan's reviewable decisions (those without `selected` already set — empty when the attended primer ran, non-empty when the solo primer surfaced razor matches), launches the configured `patronRole` via a single-pass anima session, parses a single structured emission, and applies each valid verdict to `Decision.selected` (plus records the full verdict — confirm / override / fill-in with selection, confidence, rationale — on `Decision.patron`). No-ops when `astrolabe.patronRole` is unset or empty, or when no reviewable decisions remain. Unparseable output, invalid verdicts, and abstained decisions are left unfilled — decision-review surfaces the remainder to the patron in the normal flow. |
| `astrolabe.decision-review` | Two-pass engine: blocks for patron review, then reconciles answers. Decisions with `selected` already pre-set by the primer or the patron anima are auto-accepted — they are excluded from the InputRequestDoc, and if nothing remains reviewable the engine fast-paths to `writing` without opening the gate. |
| `astrolabe.plan-finalize` | Transitions the plan to `completed` and yields the written `spec` downstream. Does not post any writ. Used inside `plan-and-ship` to hand the spec off to the implement engine on the same brief rig. |
| `astrolabe.observation-lift` | Walks `plan.observations` after `plan-finalize` has transitioned the plan to `completed` and calls `clerk.post({ type: 'brief', title, body, codex, parentId, draft: true })` once per record. Each created writ enters `new` (draft) phase, invisible to the Spider until a curator publishes it. Silently no-ops when `observations` is empty, absent, or a legacy string; fails fast on the first `clerk.post` error. Does not mutate the plan — the parent-child relationship on the Clerk side is the sole audit trail. Wired unconditionally into the plan-and-ship rig template. |

### Rig Templates (contributed to Spider)

| Template | Mapped Writ Type | Engines |
|---|---|---|
| `astrolabe.plan-and-ship` | `brief` (default) | plan-init → draft → reader-analyst → inventory-check → patron-anima → decision-review → spec-writer → plan-finalize → observation-lift → implement → review → revise → seal |

The `resolutionEngine` is `seal` — the brief writ reaches `completed` only after the final seal engine completes.

#### Rig Template Selection

The `brief` writ type maps to `astrolabe.plan-and-ship` by default. This single combined rig carries the brief through planning and implementation on one writ — the `plan-finalize` engine hands the written spec directly to the downstream `implement` engine via `${yields.plan-finalize.spec}`, and no separate mandate writ is posted. The `reader-analyst` slot is driven by the astrolabe-owned `astrolabe.reader-analyst` engine, which selects between the `sage-primer-attended` and `sage-primer-solo` roles at engine-run time from live guild config. The optional `patron-anima` stage between `inventory-check` and `decision-review` consults the configured `patronRole` under a tailored operational prompt (see `patron-anima-prompt.md` packaged with the plugin) whenever `astrolabe.patronRole` is set. The anima principle-checks every decision the primer produced and confirms (including first-class `low`-confidence confirms when no principle speaks), overrides, fills in, or abstains. Abstention is narrow — reserved for *irresolvable principle conflict* and *broken decision frame* only. Abstained decisions are left unfilled and flow through to decision-review in the normal path.

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

- **List view** — filterable by status, paginated (20 per page), showing status badge, codex, brief writ title, plan ID, and creation date.
- **Detail view** — metadata card with plan ID, status, codex, cross-links to brief and mandate writs (linking to the Clerk writs page via `?writ=ID`), per-step AI cost breakdowns (input/output tokens and USD cost for each anima-session engine), and tabbed content sections for Inventory, Scope, Decisions, Observations, and Spec.
- **Observations tab** — renders the `Observation[]` array as a card-per-record list (id, title, markdown body). Card bodies flow through the same markdown renderer used by inventory and spec. An empty or absent array renders as an empty tab. A legacy prose-string payload renders as empty rather than corrupting the tab.
- **Deep linking** — supports `?plan=ID` query parameter to open directly to a plan's detail view.

Markdown fields (inventory, spec, and each observation body) are rendered client-side with a minimal renderer supporting headings, bold, italic, inline code, fenced code blocks, and lists. All content is HTML-escaped before rendering to prevent XSS.

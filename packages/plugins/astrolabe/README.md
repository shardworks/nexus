# `@shardworks/astrolabe-apparatus`

The Astrolabe transforms patron briefs into structured work specifications and carries them through implementation. A single combined rig (`astrolabe.plan-and-ship`) runs the planning pipeline — inventory, analysis, optional Patron Anima pre-review, patron review, specification writing — and then continues into draft → implement → review → revise → seal on the same brief writ. The brief reaches `completed` only after the final seal engine finishes. It sits between the Clerk (writ lifecycle) and the Spider (rig execution), contributing kit pieces to both.

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
  id: string;           // Brief writ ID
  codex: string;        // Target codex
  status: PlanStatus;   // 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed'
  inventory?: string;   // Markdown: affected files, types, interfaces, patterns
  observations?: string; // Markdown: refactoring opportunities, risks, conventions
  scope?: ScopeItem[];  // What's in and what's out
  decisions?: Decision[]; // Architectural/design decisions with options
  spec?: string;        // The generated specification (implementation brief + task manifest)
  generatedWritId?: string; // ID of the generated mandate/configured writ type
  createdAt: string;
  updatedAt: string;
}
```

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
    "generatedWritType": "mandate",
    "patronRole": "my-plugin.patron"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `generatedWritType` | `string` | `"mandate"` | Writ type posted by the spec-writer engine |
| `patronRole` | `string` | `""` (unset) | Qualified role name of the Patron Anima consulted before decision-review. When unset or empty, the `patron-anima` engine no-ops and decision-review behaves exactly as it did before the engine existed. |

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
| `sage-reader` | `astrolabe.sage-reader` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | three-phase reader stage |
| `sage-analyst` | `astrolabe.sage-analyst` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | three-phase analyst stage |
| `sage-writer` | `astrolabe.sage-writer` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | spec-writer stage (both templates) |
| `sage-reading-analyst` | `astrolabe.sage-reading-analyst` | `astrolabe:read`, `astrolabe:write`, `clerk:read`, `ratchet:read` | `true` | two-phase reader-analyst stage |

### Engines (contributed to Fabricator)

| Engine ID | Description |
|---|---|
| `astrolabe.plan-init` | Creates a PlanDoc from the brief writ; validates codex presence |
| `astrolabe.inventory-check` | Validates that the reader produced a non-empty inventory |
| `astrolabe.patron-anima` | Consults a configured Patron Anima to pre-fill decisions on behalf of the patron. Reads the plan's reviewable decisions (those without `selected` already set), launches the configured `patronRole` via an anima session, parses a single structured emission, and applies each valid verdict to `Decision.selected` (plus records the full verdict — confirm/override/fill-in with selection, confidence, rationale — on `Decision.patron`). No-ops when `astrolabe.patronRole` is unset or empty, or when no reviewable decisions remain. Unparseable output or invalid verdicts are silently skipped — decision-review surfaces the remainder to the patron. |
| `astrolabe.decision-review` | Two-pass engine: blocks for patron review, then reconciles answers. Decisions with `selected` already pre-set by the analyst or the patron anima are auto-accepted — they are excluded from the InputRequestDoc, and if nothing remains reviewable the engine fast-paths to `writing` without opening the gate. |
| `astrolabe.plan-finalize` | Transitions the plan to `completed` and yields the written `spec` downstream. Does not post any writ. Used inside `plan-and-ship` to hand the spec off to the implement engine on the same brief rig. |
| `astrolabe.spec-publish` | Publishes the generated specification as a new mandate writ. Used only by the legacy two-phase / three-phase rigs that split planning from implementation across two writs. |

### Rig Templates (contributed to Spider)

| Template | Mapped Writ Type | Engines |
|---|---|---|
| `astrolabe.plan-and-ship` | `brief` (default) | plan-init → draft → reader-analyst → inventory-check → patron-anima → decision-review → spec-writer → plan-finalize → implement → review → revise → seal |
| `astrolabe.two-phase-planning` | — (opt-in) | plan-init → draft → reader-analyst → inventory-check → decision-review → spec-writer → spec-publish → seal |
| `astrolabe.three-phase-planning` | — (opt-in) | plan-init → draft → reader → inventory-check → analyst → decision-review → spec-writer → spec-publish → seal |

The `resolutionEngine` is `seal` for `plan-and-ship` (brief completes when implementation seals) and `spec-writer` for the two legacy planning-only templates (where the brief's rig terminates at spec-writer and a follow-up mandate writ carries the implementation separately).

#### Rig Template Selection

The `brief` writ type maps to `astrolabe.plan-and-ship` by default. This single combined rig carries the brief through planning and implementation on one writ — the `plan-finalize` engine hands the written spec directly to the downstream `implement` engine via `${yields.plan-finalize.spec}`, and no separate mandate writ is posted. The optional `patron-anima` stage between `inventory-check` and `decision-review` can pre-fill decisions on the patron's behalf when `astrolabe.patronRole` is configured, letting decision-review fast-path past any pre-decided items. The brief reaches `completed` only when the final seal engine completes.

To use a legacy planning-only template (which posts a separate mandate writ and ends the brief's lifecycle at spec-writer), add a rig template mapping override in `guild.json`:

```json
{
  "spider": {
    "rigTemplateMappings": {
      "brief": "astrolabe.two-phase-planning"
    }
  }
}
```

Substitute `astrolabe.three-phase-planning` for the split reader / analyst variant.

### Tools

| Tool | Permission | Description |
|---|---|---|
| `plan-show` | `astrolabe:read` | Show full detail for a plan by ID |
| `plan-list` | `astrolabe:read` | List plans with optional status/codex filters |
| `inventory-write` | `astrolabe:write` | Write or replace the codebase inventory |
| `scope-write` | `astrolabe:write` | Write or replace the scope items array |
| `decisions-write` | `astrolabe:write` | Write or replace the decisions array |
| `observations-write` | `astrolabe:write` | Write or replace analyst observations |
| `spec-write` | `astrolabe:write` | Write or replace the generated specification |

Write tools only update their artifact field plus `updatedAt`. Status transitions are the exclusive responsibility of the clockwork engines.

### Pages (contributed to Oculus)

| Page ID | Title | Directory |
|---|---|---|
| `astrolabe` | Astrolabe | `pages/astrolabe` |

The Astrolabe page provides a list/detail dashboard for PlanDoc records:

- **List view** — filterable by status, paginated (20 per page), showing status badge, codex, brief writ title, plan ID, and creation date.
- **Detail view** — metadata card with plan ID, status, codex, cross-links to brief and mandate writs (linking to the Clerk writs page via `?writ=ID`), per-step AI cost breakdowns (input/output tokens and USD cost for each anima-session engine), and tabbed content sections for Inventory, Scope, Decisions, Observations, and Spec.
- **Deep linking** — supports `?plan=ID` query parameter to open directly to a plan's detail view.

Markdown fields (inventory, observations, spec) are rendered client-side with a minimal renderer supporting headings, bold, italic, inline code, fenced code blocks, and lists. All content is HTML-escaped before rendering to prevent XSS.

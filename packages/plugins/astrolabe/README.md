# `@shardworks/astrolabe-apparatus`

The Astrolabe transforms patron briefs into structured work specifications. It drives a multi-stage planning pipeline — inventory, analysis, patron review, and specification writing — using a sequence of clockwork engines and anima sessions. It sits between the Clerk (writ lifecycle) and the Spider (rig execution), contributing kit pieces to both.

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
  spec?: string;        // The generated specification (markdown)
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

### `Decision` and `DecisionAnalysis`

Each `Decision` may carry an optional `analysis` field with classification metadata used for patron review UX (filtering, prioritization):

```typescript
interface DecisionAnalysis {
  category?: 'product' | 'api' | 'implementation';
  observable?: boolean;
  confidence?: 'low' | 'medium' | 'high';
  stakes?: 'low' | 'high';
}
```

When the `decision-review` engine builds `ChoiceQuestionSpec` entries for patron review, analysis fields are mapped to `tags` on each question:

| Field | Value | Tag |
|---|---|---|
| `confidence` | `'low'` | `low-confidence` |
| `confidence` | `'medium'` | `medium-confidence` |
| `confidence` | `'high'` | `high-confidence` |
| `stakes` | `'low'` | `low-stakes` |
| `stakes` | `'high'` | `high-stakes` |
| `category` | `'product'` | `product` |
| `category` | `'api'` | `api` |
| `category` | `'implementation'` | `implementation` |
| `observable` | `true` | `observable` |
| `observable` | `false` | `internal` |

Tags are sorted alphabetically. When analysis is absent or all fields are empty, the `tags` property is omitted. Scope-derived boolean questions never receive tags.

## Configuration

Add an `astrolabe` section to `guild.json` to configure behaviour:

```json
{
  "astrolabe": {
    "generatedWritType": "mandate"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `generatedWritType` | `string` | `"mandate"` | Writ type posted by the spec-writer engine |

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
| `brief-ssr` | A patron brief triggering the single-shot reader planning pipeline (experimental) |

### Roles (contributed to Loom)

| Role | Qualified Name | Permissions | Strict |
|---|---|---|---|
| `sage` | `astrolabe.sage` | `astrolabe:read`, `astrolabe:write`, `clerk:read` | `true` |

### Engines (contributed to Fabricator)

| Engine ID | Description |
|---|---|
| `astrolabe.plan-init` | Creates a PlanDoc from the brief writ; validates codex presence |
| `astrolabe.inventory-check` | Validates that the reader produced a non-empty inventory |
| `astrolabe.decision-review` | Two-pass engine: blocks for patron review, then reconciles answers |

### Rig Templates (contributed to Spider)

| Template | Mapped Writ Type | Engines |
|---|---|---|
| `astrolabe.planning` | `brief` | plan-init → draft → reader → inventory-check → analyst → decision-review → spec-writer → spec-publish → seal |
| `astrolabe.planning-ssr` | `brief-ssr` | Same pipeline as `planning`; reader engine uses a single-shot prompt (experimental) |

The `resolutionEngine` is `spec-writer` for both templates — the rig's completion summary comes from the specification writer session.

#### `planning-ssr` (experimental)

The `planning-ssr` template is an A/B experiment testing whether the reader stage can produce its inventory in 1–2 turns instead of ~25. The only difference from `planning` is the reader engine's prompt, which instructs the agent to batch all filesystem exploration into parallel tool calls and produce the inventory immediately. All other engines, wiring, and givens are identical. The reader engine retains `engineId: 'reader'` so session profiling is directly comparable between control and experiment.

Post a `brief-ssr` writ to route through this template:

```
nsg commission-post --type brief-ssr --title "..." --body "..."
```

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

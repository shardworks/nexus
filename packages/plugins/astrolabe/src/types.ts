/**
 * Astrolabe — public types.
 *
 * PlanDoc, ScopeItem, Decision, and supporting types for the brief-to-spec
 * planning pipeline.
 */

// ── Plan status ──────────────────────────────────────────────────────

export type PlanStatus = 'reading' | 'analyzing' | 'reviewing' | 'writing' | 'completed' | 'failed';

// ── Documents ────────────────────────────────────────────────────────

export interface PlanDoc {
  [key: string]: unknown;
  /** The brief writ ID — primary key. */
  id: string;
  /** The codex this plan targets. */
  codex: string;
  /** Planning status. */
  status: PlanStatus;

  // ── Reader output ───────────────────────────────────────────
  /** Codebase inventory: affected files, types, interfaces, patterns. */
  inventory?: string;

  // ── Primer output ───────────────────────────────────────────
  /**
   * Primer observations: refactoring opportunities, risks, conventions.
   *
   * Each entry is an atomic, commissionable concern — the
   * `astrolabe.observation-lift` engine lifts each record into a draft
   * top-level `mandate` writ (never a child of the originating mandate),
   * attaching an `astrolabe.lifted-from` provenance edge back to the
   * originating mandate. When the plan yields two or more observations,
   * the engine additionally groups the drafts under a top-level
   * `observation-set` container. A curator (human or automated) then
   * promotes each draft to open status.
   */
  observations?: Observation[];
  /** Scope items: what's in and what's out. */
  scope?: ScopeItem[];
  /** Architectural/design decisions with options. */
  decisions?: Decision[];

  // ── Spec-writer output ──────────────────────────────────────
  /** The generated specification. */
  spec?: string;
  /**
   * Legacy: writ id of a mandate produced by the retired `spec-publish`
   * engine. Current rig templates do not set this field — it survives
   * solely so historic plandocs stored from before the retirement
   * continue to deserialise and render correctly in the Astrolabe page.
   */
  generatedWritId?: string;
  /**
   * Count of distinct path tokens predicted by the spec's task-manifest
   * `<files>` elements at planning time — recorded by the
   * `astrolabe.plan-finalize` engine on every completed plan as the
   * predicted-files-touched cost signal. Set to 0 when the spec contains
   * no `<task-manifest>` block (or no recognisable path tokens). This is
   * a measurement layer only — the framework records the signal; downstream
   * subscribers (sanctum-side instrumentation, future auto-decompose) decide
   * what to do with it.
   */
  manifestFilesCount?: number;

  createdAt: string;
  updatedAt: string;
}

export interface ScopeItem {
  id: string;
  description: string;
  rationale: string;
  included: boolean;
}

/**
 * A single observation recorded by a sage during the planning pass.
 *
 * Each observation names one concern — a refactoring opportunity,
 * risk, convention drift, or bug — that the sage noticed but that
 * is outside the brief's scope. Observations flow downstream into
 * the `astrolabe.observation-lift` engine, which lifts each record
 * into a draft top-level `mandate` writ (never a child of the
 * originating mandate). The provenance relationship rides on the
 * kit-registered `astrolabe.lifted-from` link kind. When a plan
 * yields two or more observations, the engine additionally groups
 * the drafts under a top-level `observation-set` container.
 *
 * Fields are deliberately minimal (D1 in the commission spec):
 * - `id` — plandoc-local identifier assigned by the sage (e.g. `obs-1`).
 * - `title` — one-line commission-title style (imperative or noun
 *   phrase, ~10 words, no trailing punctuation). Becomes the title of
 *   the lifted draft writ.
 * - `body` — tactical detail (file paths, symbols, preconditions)
 *   rendered as markdown. Becomes the body of the lifted draft writ.
 */
export interface Observation {
  id: string;
  title: string;
  body: string;
}

export interface Decision {
  id: string;
  scope: string[];
  question: string;
  context?: string;
  options: Record<string, string>;
  recommendation?: string;
  rationale?: string;
  selected?: string;
  patronOverride?: string;
  /**
   * Patron Anima emission for this decision, if the patron-anima engine
   * touched it. Records the anima's verdict, selection, confidence, and
   * short rationale. Kept distinct from primer fields so override-rate ×
   * confidence can be measured as a first-class planner-quality signal.
   */
  patron?: PatronEmission;
}

/**
 * A Patron Anima's emission for a single decision.
 *
 * - `verdict: 'confirm'` — the anima accepts the primer's recommendation.
 * - `verdict: 'override'` — the anima picks a different option than the
 *   recommendation.
 * - `verdict: 'fill-in'` — no primer recommendation existed; the anima
 *   supplies one.
 *
 * `selection` must be one of the decision's offered option keys — the
 * anima cannot emit custom / free-text selections. (The human patron
 * retains that escape hatch via `decision-review`'s `allowCustom` input.)
 *
 * `confidence` is calibrated structurally against the patron role's
 * principles list: one principle applies cleanly → `'high'`; multiple
 * principles conflict (and the anima resolves the conflict) → `'med'`;
 * no principle applies → `'low'`. A `'low'` verdict is always `'confirm'`
 * — principle-absence is the first-class signal for "no principled basis
 * to differ from the primer." Abstention (narrow: irresolvable principle
 * conflict or broken decision frame) is encoded as absence from the
 * emission array, not as a `PatronEmission`.
 *
 * `rationale` is a short free-text note — which principle (or conflict)
 * produced the verdict. Optional so the engine can accept minimal well-
 * formed emissions.
 */
export interface PatronEmission {
  verdict: 'confirm' | 'override' | 'fill-in';
  selection: string;
  confidence: 'low' | 'med' | 'high';
  rationale?: string;
}

// ── Filters ──────────────────────────────────────────────────────────

export interface PlanFilters {
  /** Filter by status. */
  status?: PlanStatus;
  /** Filter by codex name. */
  codex?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Configuration ────────────────────────────────────────────────────

export interface AstrolabeConfig {
  /**
   * Qualified role name of the Patron Anima consulted by the
   * `astrolabe.patron-anima` engine before `decision-review`. When unset
   * or empty, the engine no-ops and `decision-review` proceeds as it
   * does without the anima stage. There is no framework default — every
   * patron's taste is unique, so a shared default would represent no
   * patron's taste.
   */
  patronRole?: string;
  /**
   * Soft-warn threshold for the predicted-files cost signal. The
   * `astrolabe.plan-finalize` engine emits the
   * `astrolabe.plan.files-over-threshold` Clockworks event when a plan's
   * `manifestFilesCount` strictly exceeds this value. Defaults to 15
   * when unset. Must be a positive integer when supplied — the resolver
   * fails loud on malformed values (wrong type, NaN, negative, zero,
   * non-integer) so a typo cannot silently mask the operator's intent.
   * The framework does not gate the pipeline on this signal; subscribers
   * decide how to react.
   */
  predictedFilesThreshold?: number;
}

declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    astrolabe?: AstrolabeConfig;
  }
}

// ── API ──────────────────────────────────────────────────────────────

export interface AstrolabeApi {
  /** Show a plan by id. Throws if not found. */
  show(planId: string): Promise<PlanDoc>;
  /** List plans with optional filters, ordered by createdAt descending. */
  list(filters?: PlanFilters): Promise<PlanDoc[]>;
  /** Partially update a plan. Returns the updated document. Throws if not found. */
  patch(planId: string, fields: Partial<Omit<PlanDoc, 'id'>>): Promise<PlanDoc>;
}

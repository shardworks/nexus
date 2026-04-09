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

  // ── Analyst output ──────────────────────────────────────────
  /** Analyst observations: refactoring opportunities, risks, conventions. */
  observations?: string;
  /** Scope items: what's in and what's out. */
  scope?: ScopeItem[];
  /** Architectural/design decisions with options and analysis. */
  decisions?: Decision[];

  // ── Spec-writer output ──────────────────────────────────────
  /** The generated specification. */
  spec?: string;
  /** The writ ID of the generated mandate (or configured type). */
  generatedWritId?: string;

  createdAt: string;
  updatedAt: string;
}

export interface ScopeItem {
  id: string;
  description: string;
  rationale: string;
  included: boolean;
}

export interface DecisionAnalysis {
  /** How clearly the codebase + brief dictate the answer. */
  confidence: 'high' | 'medium' | 'low';
  /** How much a consumer would notice or care if a different option were picked. */
  stakes: 'high' | 'low';
  /** What the decision is about. */
  category: 'product' | 'api' | 'implementation';
  /** Would someone in this category's audience notice which option was picked? */
  observable: boolean;
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
  /** Analyst classification metadata — used for patron review UX (filtering, prioritization). */
  analysis?: DecisionAnalysis;
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
  /** The writ type posted by the spec-writer engine. Default: 'mandate'. */
  generatedWritType?: string;
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

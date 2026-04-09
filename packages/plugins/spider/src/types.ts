/**
 * The Spider — public types.
 *
 * Rig and engine data model, CrawlResult, SpiderApi, and configuration.
 * Engine yield shapes (DraftYields, SealYields) live here too so downstream
 * packages can import them without depending on the engine implementation files.
 */

import type { ZodSchema } from 'zod';

// ── Engine instance status ────────────────────────────────────────────

export type EngineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'skipped';

// ── Block record ──────────────────────────────────────────────────────

/**
 * Persisted record of an active engine block.
 * Present on an EngineInstance when status === 'blocked'.
 * Cleared when the block is resolved.
 */
export interface BlockRecord {
  /** Block type identifier (matches a registered BlockType.id). */
  type: string;
  /** Structured condition payload — shape validated by the block type's conditionSchema. */
  condition: unknown;
  /** ISO timestamp when the engine was blocked. */
  blockedAt: string;
  /** Optional human-readable message from the engine. */
  message?: string;
  /** ISO timestamp of the last checker evaluation. Updated on every check cycle. */
  lastCheckedAt?: string;
}

// ── Engine instance ───────────────────────────────────────────────────

/**
 * A single engine slot within a rig.
 *
 * `id` is the engine's position identifier (e.g. 'draft', 'implement').
 * For the static pipeline it matches `designId`.
 *
 * `givensSpec` holds values set at spawn time (writ, role, commands) and
 * may contain unresolved yield expression strings (`${yields.<id>.<path>}`)
 * that the Spider resolves at run time from upstream engine yields.
 */
export interface EngineInstance {
  /** Unique identifier within the rig (e.g. 'draft', 'implement'). */
  id: string;
  /** The engine design to look up in the Fabricator. */
  designId: string;
  /** Current execution status. */
  status: EngineStatus;
  /** Engine IDs that must be completed before this engine can run. */
  upstream: string[];
  /**
   * Givens values. Spawn-time expressions (`${writ}`, `${writ.*}`, `${vars.*}`)
   * are resolved to their values. Yield expressions (`${yields.*}`) remain as
   * literal `${yields.*}` strings and are resolved at run time when the engine
   * is executed.
   */
  givensSpec: Record<string, unknown>;
  /**
   * Conditional activation expression, copied from the template.
   * Evaluated at runtime when upstream is all done. Absent means unconditional.
   */
  when?: string;
  /** Yields from a completed engine run (JSON-serializable). */
  yields?: unknown;
  /** Error message if this engine failed. */
  error?: string;
  /** Session ID from a launched quick engine, used by the collect step. */
  sessionId?: string;
  /** ISO timestamp when execution started. */
  startedAt?: string;
  /** ISO timestamp when execution completed (or failed). */
  completedAt?: string;
  /** Present when status === 'blocked'. Cleared when the block is resolved. */
  block?: BlockRecord;
}

// ── Rig ──────────────────────────────────────────────────────────────

export type RigStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';

/**
 * A rig — the execution context for a single writ.
 *
 * Stored in The Stacks (`spider/rigs` book). The `engines` array is the
 * ordered pipeline of engine instances. The Spider updates this document
 * in-place as engines run and complete.
 */
export interface RigDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Unique rig id. */
  id: string;
  /** The writ this rig is executing. */
  writId: string;
  /** Current rig status. */
  status: RigStatus;
  /** Ordered engine pipeline. */
  engines: EngineInstance[];
  /** ISO timestamp when the rig was created. */
  createdAt: string;
  /** Engine id whose yields provide the resolution summary. Set at spawn time. */
  resolutionEngineId?: string;
}

// ── Rig filters ───────────────────────────────────────────────────────

/**
 * Filters for listing rigs.
 */
export interface RigFilters {
  /** Filter by rig status. */
  status?: RigStatus;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Rig templates ─────────────────────────────────────────────────────

/**
 * A single engine slot declared in a rig template.
 */
export interface RigTemplateEngine {
  /** Engine id unique within this template. */
  id: string;
  /** Engine design id to look up in the Fabricator. */
  designId: string;
  /** Engine ids within this template whose completion is required first. Defaults to []. */
  upstream?: string[];
  /**
   * Givens to pass to the engine.
   *
   * String values may contain `${...}` template expressions:
   *   `${writ}` — the full WritDoc for this rig's writ
   *   `${writ.<path>}` — a field of the WritDoc (dot-path traversal)
   *   `${vars.<path>}` — value from spider.variables config (dot-path traversal)
   *   `${yields.<engine_id>.<path>}` — a property from an upstream engine's
   *       yields (resolved at run time, dot-path traversal)
   *
   * When a string is exactly one expression (e.g. `${writ}`), the resolved
   * value preserves its original type. When expressions are embedded in a
   * larger string, the result is always a string.
   *
   * Non-string values are passed through literally.
   * Whole-value expressions that resolve to undefined cause the key to be omitted.
   * Inline expressions that resolve to undefined are replaced with empty string.
   *
   * Use `\${` to produce a literal `${` in the output without interpolation.
   */
  givens?: Record<string, unknown>;
  /**
   * Conditional activation expression. A `${yields.<engine_id>.<property>}` reference
   * (with optional `!` negation prefix) evaluated at runtime when the engine's upstream
   * is all done. When the condition is falsy, the engine is set to `skipped` status.
   * When absent, the engine is unconditional (always runs).
   *
   * Examples:
   *   '${yields.review.passed}'  — run this engine when review.passed is truthy
   *   '!${yields.review.passed}' — run this engine when review.passed is falsy
   */
  when?: string;
}

/**
 * A complete rig template.
 */
export interface RigTemplate {
  /** Ordered list of engine slot declarations. */
  engines: RigTemplateEngine[];
  /**
   * Engine id whose yields provide the writ resolution summary.
   * Falls back to seal engine, then last completed engine in array order.
   */
  resolutionEngine?: string;
}

// ── CrawlResult ────────────────────────────────────────────────────────

/**
 * The result of a single crawl() call.
 *
 * Variants, ordered by priority:
 * - 'engine-completed'  — an engine finished (collected or ran inline); rig still running
 * - 'engine-started'    — launched a quick engine's session
 * - 'engine-blocked'    — engine entered blocked status; rig is still running (other engines active)
 * - 'engine-unblocked'  — a blocked engine's condition cleared; engine returned to pending
 * - 'rig-spawned'       — created a new rig for a ready writ
 * - 'rig-completed'     — the crawl step caused a rig to reach a terminal state
 * - 'rig-blocked'       — all forward progress stalled; rig entered blocked status
 *
 * null means no work was available.
 */
export type CrawlResult =
  | { action: 'engine-completed'; rigId: string; engineId: string }
  | { action: 'engine-started'; rigId: string; engineId: string }
  | { action: 'engine-blocked'; rigId: string; engineId: string; blockType: string }
  | { action: 'engine-unblocked'; rigId: string; engineId: string }
  | { action: 'engine-skipped'; rigId: string; engineId: string; cascadeSkipped?: string[] }
  | { action: 'engine-grafted'; rigId: string; engineId: string; graftedEngineIds: string[] }
  | { action: 'rig-spawned'; rigId: string; writId: string }
  | { action: 'rig-completed'; rigId: string; writId: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { action: 'rig-blocked'; rigId: string; writId: string };

// ── Block type ────────────────────────────────────────────────────────

/**
 * Result of a block type check.
 *
 * 'cleared' — condition met, unblock the engine.
 * 'pending' — condition not yet met, keep polling.
 * 'failed'  — condition is permanently unresolvable, fail the engine.
 *
 * When status is 'failed', an optional reason provides a human-readable
 * explanation that the Spider includes in the engine error message.
 */
export interface CheckResult {
  status: 'cleared' | 'pending' | 'failed';
  reason?: string;
}

/** Summary info for a registered block type. */
export interface BlockTypeInfo {
  /** Block type id. */
  id: string;
  /** Plugin id that contributed this block type. */
  pluginId: string;
  /** Suggested poll interval in milliseconds, if set. */
  pollIntervalMs?: number;
}

/** Summary info for a registered rig template. */
export interface RigTemplateInfo {
  /** Template name (plain for config, qualified pluginId.name for kit). */
  name: string;
  /** 'config' for guild.json templates, or the pluginId for kit-contributed templates. */
  source: string;
  /** The template definition. */
  template: RigTemplate;
}

/**
 * A registered block type — defines how to check whether a blocking
 * condition has cleared. Contributed via kit/supportKit `blockTypes`.
 */
export interface BlockType {
  /** Unique identifier (e.g. 'writ-status', 'scheduled-time'). */
  id: string;
  /**
   * Check whether the blocking condition has been resolved.
   *
   * Return { status: 'cleared' } when the condition is met.
   * Return { status: 'pending' } when the condition is not yet met.
   * Return { status: 'failed' } or { status: 'failed', reason: '...' }
   * when the condition is permanently unresolvable.
   *
   * Throwing is reserved for transient errors (network failures, etc.)
   * — the engine stays blocked and the checker is retried next cycle.
   */
  check: (condition: unknown) => Promise<CheckResult>;
  /** Zod schema for validating the condition payload at block time. */
  conditionSchema: ZodSchema;
  /** Suggested poll interval in milliseconds. If absent, check every crawl cycle. */
  pollIntervalMs?: number;
}

// ── SpiderApi ─────────────────────────────────────────────────────────

/**
 * The Spider's public API — retrieved via guild().apparatus<SpiderApi>('spider').
 */
export interface SpiderApi {
  /**
   * Execute one step of the crawl loop.
   *
   * Priority ordering: collect > checkBlocked > run > spawn.
   * Returns null when no work is available.
   */
  crawl(): Promise<CrawlResult | null>;

  /**
   * Show a rig by id. Throws if not found.
   */
  show(id: string): Promise<RigDoc>;

  /**
   * List rigs with optional filters, ordered by createdAt descending.
   */
  list(filters?: RigFilters): Promise<RigDoc[]>;

  /**
   * Find the rig for a given writ. Returns null if no rig exists.
   */
  forWrit(writId: string): Promise<RigDoc | null>;

  /**
   * Manually clear a block on a specific engine, regardless of checker result.
   * Throws if the engine is not blocked.
   */
  resume(rigId: string, engineId: string): Promise<void>;

  /**
   * Cancel a running or blocked rig. Cancels the active session (if any),
   * marks all non-terminal engines as cancelled, rejects pending input
   * requests, and transitions the rig to cancelled status.
   *
   * Idempotent: returns the rig unchanged if it is already in a terminal state.
   * Throws if the rig is not found.
   */
  cancel(rigId: string, options?: { reason?: string }): Promise<RigDoc>;

  /**
   * Look up a registered block type by ID.
   */
  getBlockType(id: string): BlockType | undefined;

  /**
   * List all registered block types with summary info.
   */
  listBlockTypes(): BlockTypeInfo[];

  /**
   * List all registered rig templates with provenance info.
   */
  listTemplates(): RigTemplateInfo[];

  /**
   * Return the merged effective writ-type → template-name mapping.
   * Config mappings override kit mappings for the same writ type.
   */
  listTemplateMappings(): Record<string, string>;
}

// ── Configuration ─────────────────────────────────────────────────────

/**
 * Spider apparatus configuration — lives under the `spider` key in guild.json.
 */
export interface SpiderConfig {
  /**
   * Polling interval for crawlContinual tool (milliseconds).
   * Default: 5000.
   */
  pollIntervalMs?: number;
  /**
   * Build command to pass to quick engines.
   */
  buildCommand?: string;
  /**
   * Test command to pass to quick engines.
   */
  testCommand?: string;
  /**
   * Named rig templates. Keys are template names (not writ types).
   * Templates are looked up by name via rigTemplateMappings.
   * A template named 'default' is used as the fallback when no mapping matches.
   */
  rigTemplates?: Record<string, RigTemplate>;
  /**
   * Writ type → rig template name mappings.
   * 'default' key is the fallback for unmatched writ types.
   * Config mappings override kit-contributed mappings for the same writ type.
   */
  rigTemplateMappings?: Record<string, string>;
  /**
   * User-defined variables available in rig template givens via `${vars.<path>}`.
   * Values are passed through literally (string, number, boolean, object).
   * Variables resolving to undefined (key absent) cause the givens key to be omitted.
   */
  variables?: Record<string, unknown>;
  /**
   * Maximum number of engines allowed in a single rig.
   * Grafts that would exceed this limit fail the originating engine.
   * Default: 50.
   */
  maxEnginesPerRig?: number;
}

// ── Engine yield shapes ───────────────────────────────────────────────

/**
 * Yields from the `draft` clockwork engine.
 * The Spider stores these in the engine instance and passes them
 * to downstream engines via context.upstream['draft'].
 */
export interface DraftYields {
  /** The draft's unique id. */
  draftId: string;
  /** Codex this draft belongs to. */
  codexName: string;
  /** Git branch name for the draft. */
  branch: string;
  /** Absolute filesystem path to the draft's worktree. */
  path: string;
  /** HEAD commit SHA at the time the draft was opened. Used by review engine to compute diffs. */
  baseSha: string;
}

/**
 * Yields from the `seal` clockwork engine.
 */
export interface SealYields {
  /** The commit SHA at head of the target branch after sealing. */
  sealedCommit: string;
  /** Git strategy used. */
  strategy: 'fast-forward' | 'rebase';
  /** Number of retry attempts. */
  retries: number;
  /** Number of inscriptions (commits) sealed. */
  inscriptionsSealed: number;
}

/**
 * Yields from the `implement` quick engine.
 * Set by the Spider's collect step when the Animator session completes.
 */
export interface ImplementYields {
  /** The Animator session id. */
  sessionId: string;
  /** Terminal status of the session. */
  sessionStatus: 'completed' | 'failed';
}

/**
 * A single mechanical check (build or test) run by the review engine
 * before launching the reviewer session.
 */
export interface MechanicalCheck {
  /** Check name. */
  name: 'build' | 'test';
  /** Whether the command exited with code 0. */
  passed: boolean;
  /** Combined stdout+stderr, truncated to 4KB. */
  output: string;
  /** Wall-clock duration of the check in milliseconds. */
  durationMs: number;
}

/**
 * Yields from the `review` quick engine.
 * Assembled by the Spider's collect step from session.output and session.metadata.
 */
export interface ReviewYields {
  /** The Animator session id. */
  sessionId: string;
  /** Reviewer's overall assessment — true if the review passed. */
  passed: boolean;
  /** Structured markdown findings from the reviewer's final message. */
  findings: string;
  /** Mechanical check results run before the reviewer session. */
  mechanicalChecks: MechanicalCheck[];
}

/**
 * Yields from the `revise` quick engine.
 * Set by the Spider's collect step when the Animator session completes.
 */
export interface ReviseYields {
  /** The Animator session id. */
  sessionId: string;
  /** Terminal status of the session. */
  sessionStatus: 'completed' | 'failed';
}

// ── Input request types ──────────────────────────────────────────────

export type InputRequestStatus = 'pending' | 'completed' | 'rejected';

export interface ChoiceQuestionSpec {
  type: 'choice';
  /** Human-readable question text. */
  label: string;
  /** Optional long-form context, explanation, or instructions for this question. */
  details?: string;
  /** Optional classification tags for filtering and grouping in the UI. */
  tags?: string[];
  /** Key → display label options map. */
  options: Record<string, string>;
  /** When true, the patron can supply a freeform answer instead of selecting. */
  allowCustom: boolean;
}

export interface BooleanQuestionSpec {
  type: 'boolean';
  /** Human-readable question text. */
  label: string;
  /** Optional long-form context, explanation, or instructions for this question. */
  details?: string;
  /** Optional classification tags for filtering and grouping in the UI. */
  tags?: string[];
}

export interface TextQuestionSpec {
  type: 'text';
  /** Human-readable question text. */
  label: string;
  /** Optional long-form context, explanation, or instructions for this question. */
  details?: string;
  /** Optional classification tags for filtering and grouping in the UI. */
  tags?: string[];
}

export type QuestionSpec = ChoiceQuestionSpec | BooleanQuestionSpec | TextQuestionSpec;

/** Discriminated choice answer — selected from options or freeform custom. */
export type ChoiceAnswer = { selected: string } | { custom: string };

/**
 * Answer value union. Runtime type is determined by the corresponding QuestionSpec:
 * - choice → ChoiceAnswer (object with 'selected' or 'custom' key)
 * - boolean → boolean
 * - text → string
 */
export type AnswerValue = ChoiceAnswer | boolean | string;

/**
 * An input request document stored in the spider/input-requests book.
 * Created by engines before blocking; answered by patrons via CLI tools.
 */
export interface InputRequestDoc {
  [key: string]: unknown;
  /** Unique ID via generateId('ir', 4). */
  id: string;
  /** Rig this request belongs to. */
  rigId: string;
  /** Engine that created this request. */
  engineId: string;
  /** Request lifecycle status. */
  status: InputRequestStatus;
  /** Optional human-readable context from the engine. */
  message?: string;
  /** Question key → question spec. */
  questions: Record<string, QuestionSpec>;
  /** Question key → answer value. Partially filled until completion. */
  answers: Record<string, AnswerValue>;
  /** Set when status transitions to 'rejected'. */
  rejectionReason?: string;
  /** ISO timestamp when the request was created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

// ── Spider-extended engine run / collect result types ─────────────────

/**
 * Spider-extended engine run result. Adds an optional `graft` field
 * to the `completed` variant, allowing engines to dynamically append
 * new engines to the rig alongside their yields.
 *
 * Engines that want to graft import this type from @shardworks/spider-apparatus.
 * Engines that don't graft use the base EngineRunResult from @shardworks/fabricator-apparatus.
 *
 * The Spider internally checks for the `graft` property on any completed result
 * (duck-typing — the Fabricator type is not modified).
 */
export type SpiderEngineRunResult =
  | { status: 'completed'; yields: unknown; graft?: RigTemplateEngine[] }
  | { status: 'launched'; sessionId: string }
  | { status: 'blocked'; blockType: string; condition: unknown; message?: string };

/**
 * Spider-extended collect result. When a quick engine's collect() method
 * returns an object with a `graft` property (an array), the Spider extracts
 * it as a graft request and uses the `yields` property as the engine's yields.
 *
 * When collect() returns a value without a `graft` array property, the entire
 * return value is treated as yields (backward compatible).
 */
export interface SpiderCollectResult {
  yields: unknown;
  graft?: RigTemplateEngine[];
}

// Augment GuildConfig so `guild().guildConfig().spider` is typed.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    spider?: SpiderConfig;
  }
}

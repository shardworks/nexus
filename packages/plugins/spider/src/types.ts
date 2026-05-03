/**
 * The Spider — public types.
 *
 * Rig and engine data model, CrawlResult, SpiderApi, and configuration.
 * Engine yield shapes (DraftYields, SealYields) live here too so downstream
 * packages can import them without depending on the engine implementation files.
 */

import type { ZodSchema } from 'zod';

// ── Engine instance status ────────────────────────────────────────────

/**
 * Engine status — the full lifecycle of a single engine slot within a rig.
 *
 * 'pending'   — awaiting dispatch. Covers both "not yet tried" and "held"
 *               engines; a hold is represented as `pending` + `holdReason`
 *               / `holdUntil` metadata on the engine instance. The
 *               dispatch predicate is the sole arbiter of when a pending
 *               engine actually runs.
 * 'running'   — currently executing (either a clockwork run in progress
 *               or a launched anima session being polled by tryCollect).
 * 'completed' — finished successfully. `attempts[-1]` carries the yields.
 * 'failed'    — terminally failed (retry budget exhausted or the failure
 *               was definitional).
 * 'cancelled' — cancelled by operator action or by cascade from a failed
 *               upstream engine.
 * 'skipped'   — `when` condition evaluated false; the engine was never
 *               run and its downstream has cascade-skipped any conditionals.
 *
 * There is no `'blocked'` value: holds are `'pending'` with hold metadata.
 */
export type EngineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

// ── Engine attempt history ────────────────────────────────────────────

/**
 * A single engine attempt — one dispatch of the engine's run(), from
 * the moment the dispatcher picks it up through its terminal outcome.
 *
 * Entries are append-on-start: tryRun pushes a row with `startedAt` when
 * dispatching, and the terminal handler (or the success path) patches the
 * tail row with `endedAt`, `status`, and `error`/`yields` at completion.
 *
 * Scalar engine-level `startedAt`/`completedAt`/`error`/`sessionId`/`yields`
 * fields do not exist — `attempts[-1]` is authoritative.
 */
export interface EngineAttempt {
  /** ISO timestamp when the attempt started. */
  startedAt: string;
  /** ISO timestamp when the attempt terminated; absent while in-flight. */
  endedAt?: string;
  /**
   * Terminal attempt status — only the two terminal outcomes a single
   * attempt can reach. `'completed'` means the attempt produced yields;
   * `'failed'` means the attempt threw or observed a non-rate-limit
   * session terminal. Absent while the attempt is still in-flight.
   */
  status?: 'completed' | 'failed';
  /** Error message if the attempt terminated in `'failed'`. */
  error?: string;
  /** Animator session id associated with this attempt, if any. */
  sessionId?: string;
  /** Yields produced by this attempt, if `status === 'completed'`. */
  yields?: unknown;
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
 *
 * Hold metadata (`holdUntil`, `holdReason`, `holdCondition`, `lastCheckedAt`)
 * is present while the engine is in `'pending'` due to a retry back-off
 * window or an external-gate BlockType. It is cleared when the hold is
 * resolved (by poll-clear, by window expiration, or by operator resume).
 *
 * `attempts[]` is the append-only per-dispatch history for this engine.
 * The latest entry carries the in-flight or most recently completed
 * attempt's timestamps, session id, yields, and error.
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
  /**
   * Per-dispatch history. Each entry records one attempt's lifecycle.
   * Downstream code reads `attempts[attempts.length - 1]` for the latest
   * state (sessionId, yields, error). An empty array means the engine
   * has never been dispatched.
   */
  attempts?: EngineAttempt[];
  /**
   * Retry-budget counter. Incremented only when the failure handler
   * routes a terminal attempt to the retryable-within-budget branch. A
   * rate-limit hold does not increment; a terminal-failed outcome does
   * not increment (it records the final consumed attempt via attempts[]).
   */
  attemptCount?: number;
  /**
   * ISO timestamp this engine may not dispatch before. Set by the retry
   * back-off path; also set by BlockTypes whose hold carries a natural
   * deadline. When undefined, the hold is purely gate-driven (the
   * BlockType's `check()` result decides readiness).
   */
  holdUntil?: string;
  /**
   * BlockType id describing why the engine is being held. When set to a
   * value registered in the block type registry, the dispatch predicate
   * delegates to that BlockType's `check()` for external-gate
   * evaluation. The internal sentinel `'retry-backoff'` is purely
   * timer-driven and is not registered in the registry — the predicate
   * relies on `holdUntil` alone to clear it. Well-known registered
   * values include `'animator-paused'` (the rate-limit gate — the
   * engine-failure path writes this id when a session reports a
   * rate-limit terminal), `'writ-phase'`, `'scheduled-time'`,
   * `'patron-input'`, and `'book-updated'`.
   */
  holdReason?: string;
  /**
   * Structured payload validated by the BlockType's `conditionSchema`.
   * Carries the specifics needed by `check()` (e.g. `{ sessionId }` for
   * `animator-paused`). Shape is opaque to the Spider.
   */
  holdCondition?: unknown;
  /**
   * ISO timestamp of the last dispatch-predicate check on this hold.
   * The predicate honours the BlockType's `pollIntervalMs` against this
   * stamp — `check()` only re-runs after the interval elapses.
   */
  lastCheckedAt?: string;
}

// ── Rig ──────────────────────────────────────────────────────────────

/**
 * Rig status — the full lifecycle of a rig. Computed as a pure projection
 * of the rig's engine states plus the operator-cancel marker; never
 * written independently.
 *
 * 'running'   — at least one engine is non-terminal.
 * 'completed' — every engine is terminal and at least one completed.
 * 'failed'    — some engine terminally failed and no engine is running
 *               (i.e. the rig reached a dead end via engine failure).
 * 'cancelled' — operator cancel (signalled by a `cancelledAt` stamp).
 *
 * Legacy rig docs persisted with `'stuck'` or `'blocked'` predate this
 * commission; readers must tolerate those string values without crashing.
 */
export type RigStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  /**
   * ISO timestamp recorded the first time the rig enters a terminal status
   * (`completed`, `failed`, `cancelled`). Keep-first semantics:
   * subsequent terminal transitions do NOT overwrite this value — it
   * pins the moment the rig first stopped making forward progress.
   * Absent on rigs that predate this field; the dashboard falls back to
   * the latest `attempts[-1].endedAt` for those.
   */
  terminalAt?: string;
  /**
   * ISO timestamp recorded when the rig is cancelled by explicit operator
   * action (via `SpiderApi.cancel`). The rig-status rollup short-circuits
   * to `'cancelled'` when this is set, distinguishing operator-cancel
   * from cascade-by-upstream cancel.
   */
  cancelledAt?: string;
  /** Engine id whose yields provide the resolution summary. Set at spawn time. */
  resolutionEngineId?: string;
}

// ── Rig view (UI-facing read shape) ───────────────────────────────────

/**
 * Aggregated cost summary for a rig — sum across all engines that have a
 * sessionId. Absent when no engines have reported any cost data yet.
 *
 * Token counts are optional because not every provider/session reports
 * token usage. When tokenUsage is absent on every contributing session,
 * `inputTokens` / `outputTokens` will be undefined; the UI uses this to
 * decide whether to render the `(N input, M output)` parenthetical.
 */
export interface RigCostSummary {
  /** Total cost in USD across all sessions. */
  costUsd: number;
  /** Sum of input tokens across all sessions that reported tokenUsage. Undefined if no session reported. */
  inputTokens?: number;
  /** Sum of output tokens across all sessions that reported tokenUsage. Undefined if no session reported. */
  outputTokens?: number;
}

/**
 * Per-engine cost snapshot. Same shape as the rig-level `RigCostSummary`.
 * Present in the `engineCosts` map for every engine that has a sessionId
 * (regardless of engine status) — the value may be all-zero when the
 * session has not reported cost yet.
 */
export interface EngineCostSummary {
  /** Cost in USD from the engine's session, or 0 if not reported. */
  costUsd: number;
  /** Input tokens if reported. */
  inputTokens?: number;
  /** Output tokens if reported. */
  outputTokens?: number;
}

/**
 * UI-facing rig view — the persisted `RigDoc` enriched with derived fields
 * that the Spider dashboard needs. Returned from the rig API read path
 * (rig-list / rig-show). The persisted `RigDoc` shape is unchanged.
 *
 * - `costSummary` is the rig-level aggregate (sum across all engines with
 *   a sessionId). Omitted when no engine has a sessionId.
 * - `engineCosts` maps engineId → per-engine cost snapshot. Contains an
 *   entry for every engine with a sessionId. Omitted when no engine has
 *   a sessionId.
 * - `writTitle` is the current title of this rig's writ, joined from the
 *   `clerk/writs` book. Omitted when the writ cannot be resolved (e.g.
 *   deleted). Derived-only — never persisted on `RigDoc`; recomputed on
 *   every read so `writ-edit` title changes are reflected on the next
 *   dashboard poll.
 *
 * All derived fields are read-only reports — they are never persisted.
 */
export interface RigView extends RigDoc {
  /** Rig-level cost aggregate (sum across all engine sessions). */
  costSummary?: RigCostSummary;
  /** Per-engine cost snapshot keyed by engine id. */
  engineCosts?: Record<string, EngineCostSummary>;
  /** Current title of this rig's writ, joined from `clerk/writs`. */
  writTitle?: string;
}

// ── Rig filters ───────────────────────────────────────────────────────

/**
 * Filters for listing rigs.
 *
 * `status` accepts the current four-value `RigStatus` plus the legacy
 * `'stuck'` and `'blocked'` strings so operators can still filter for
 * rigs persisted before the engine-level retry reshape. New rigs never
 * write the legacy values, but the filter tolerates them.
 */
export interface RigFilters {
  /** Filter by rig status. */
  status?: RigStatus | 'stuck' | 'blocked';
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

// ── Retry policy on engine designs ────────────────────────────────────

/**
 * Back-off config for an engine's retry policy. Matches the shape of
 * `AnimatorRateLimitBackoffConfig`: `initialMs` is the first attempt's
 * hold; each subsequent attempt multiplies by `factor`, capped at `maxMs`.
 */
export interface EngineRetryBackoffConfig {
  /** First attempt's hold window in milliseconds. */
  initialMs: number;
  /** Cap on the hold window in milliseconds. */
  maxMs: number;
  /** Back-off growth factor. Must be > 1. */
  factor: number;
}

/**
 * Opt-in retry policy for an engine design. When absent, the effective
 * policy is `maxAttempts: 0` — the engine fails terminally on the first
 * transient error with no retry. Explicit config enables retry.
 *
 * Validated at engine-design registration time (see
 * `validateEngineRetryConfig`); malformed values throw at startup.
 */
export interface EngineRetryConfig {
  /**
   * Total retry budget. `0` means fail fast (never retry — same as
   * absent). `1` means one retry (so up to two attempts total). Matches
   * the "attempts consumed from budget" semantics in the commission brief.
   */
  maxAttempts: number;
  /** Back-off growth parameters. Optional; defaults applied when omitted. */
  backoff?: Partial<EngineRetryBackoffConfig>;
}

// ── CrawlResult ────────────────────────────────────────────────────────

/**
 * The result of a single crawl() call.
 *
 * Variants, ordered by priority:
 * - 'engine-completed'  — an engine finished (collected or ran inline); rig still running
 * - 'engine-started'    — launched a quick engine's session
 * - 'engine-held'       — engine entered pending+hold status (rate-limit or
 *                         block type gate); rig is still running (other
 *                         engines may be active)
 * - 'engine-retrying'   — an engine observed a retryable terminal failure
 *                         and is pending a back-off window before the
 *                         next attempt dispatches
 * - 'engine-skipped'    — engine's `when` evaluated false; optional
 *                         cascadeSkipped list when downstream conditionals
 *                         cascade-skipped
 * - 'engine-grafted'    — a graft was applied; downstream engines added
 * - 'rig-spawned'       — created a new rig for a ready writ
 * - 'rig-completed'     — the crawl step caused a rig to reach a terminal state
 * - 'writ-unstuck'      — a writ that Spider previously stuck via the gating
 *                         path returned to `open` because its recorded causes
 *                         resolved (all failed blockers reached success, or
 *                         a cycle was broken by external action).
 *
 * null means no work was available this tick. This includes the case where
 * every candidate open writ was gated on non-terminal follows-blockers —
 * the crawl loop skips gated candidates internally and returns null if
 * no dispatchable writ was found. Gate state lives on the writ substrate
 * (phase + status.spider), not in the CrawlResult.
 */
export type CrawlResult =
  | { action: 'engine-completed'; rigId: string; engineId: string }
  | { action: 'engine-started'; rigId: string; engineId: string }
  | { action: 'engine-held'; rigId: string; engineId: string; holdReason: string }
  | { action: 'engine-retrying'; rigId: string; engineId: string; attemptCount: number }
  | { action: 'engine-skipped'; rigId: string; engineId: string; cascadeSkipped?: string[] }
  | { action: 'engine-grafted'; rigId: string; engineId: string; graftedEngineIds: string[] }
  | { action: 'rig-spawned'; rigId: string; writId: string }
  | { action: 'rig-completed'; rigId: string; writId: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { action: 'writ-unstuck'; writId: string };

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
  /** Unique identifier (e.g. 'writ-phase', 'scheduled-time'). */
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
   * — the engine stays held and the checker is retried next cycle.
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
   * Priority ordering: collect > graft > run > spawn.
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
   * Clear a hold on a specific pending engine, forcing the dispatch
   * predicate to re-evaluate it on the next crawl tick. Throws if the
   * engine is not pending or has no hold set.
   */
  resume(rigId: string, engineId: string): Promise<void>;

  /**
   * Cancel a running rig. Cancels the active session (if any), marks
   * all non-terminal engines as cancelled, rejects pending input
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
   * Polling interval (milliseconds) for the daemon's inline crawl loop.
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
  /**
   * Maximum number of engines that may be running concurrently across all rigs.
   * Engines beyond this limit stay in `pending` until a slot frees.
   * Default: 3.
   */
  maxConcurrentEngines?: number;
  /**
   * Maximum number of engines that may be running concurrently within a single rig.
   * Engines beyond this limit stay in `pending` until a slot frees.
   * Default: 1.
   */
  maxConcurrentEnginesPerRig?: number;
  /**
   * Per-design overrides for engine retry policy. Keyed by `EngineDesign.id`.
   *
   * The override layers on top of the design's declared `retry`, which in
   * turn layers on top of the kit's built-in defaults
   * (`DEFAULT_ENGINE_RETRY_BACKOFF`). Effective resolution order is:
   *
   *     override > design.retry > built-in defaults
   *
   * Operators name only the fields they want to change. An override may
   * change `maxAttempts`, any subset of `backoff` fields, or both. An
   * override on a design that declares no `retry` is permitted — the
   * absent design retry is treated as `{ maxAttempts: 0, backoff: DEFAULT }`,
   * so the override's `maxAttempts` enables retry on a previously
   * fail-fast design.
   *
   * Validated fail-loud at Spider startup: an unknown `designId` (one that
   * does not appear in `fabricator.listEngineDesigns()`) or any malformed
   * field (`maxAttempts < 0`, `maxMs < initialMs`, `factor <= 1`, etc.)
   * throws before any engines are scheduled. The override map is re-read
   * live from guild config on each retry decision, so guild.json edits
   * take effect on the next retry without restarting the daemon.
   */
  engineRetryOverrides?: Record<string, Partial<EngineRetryConfig>>;
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
 * Yields from the `seal` clockwork engine when it catches a rebase-conflict
 * failure from Scriptorium and grafts a manual-merge recovery tail instead
 * of failing the rig. The original rig still has a terminal `seal` engine
 * holding these yields; the retry seal that runs after the grafted
 * manual-merge anima produces standard SealYields under a new engine id.
 */
export interface SealRecoveryYields {
  /** Always false — the initial seal attempt did not succeed. */
  ok: false;
  /** The Scriptorium error message that triggered recovery. */
  reason: string;
  /** Always true — flags this record as a recovery handoff. */
  grafted: true;
}

/**
 * Yields from the `manual-merge` quick engine when the mender anima
 * reconciles the draft branch against the target. A `SUCCESS` marker
 * produces these yields; any other outcome throws in `collect()` and
 * fails the engine.
 */
export interface ManualMergeYields {
  /** The Animator session id. */
  sessionId: string;
  /** Always true — the mender emitted `### Merge: SUCCESS`. */
  merged: true;
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
 * Yields from the `verify` clockwork engine.
 *
 * Verify re-runs the same mechanical build/test checks `review` performs,
 * but after `revise` and before `seal` — its job is to surface any
 * regression introduced during revise loud and clear, before merge. On
 * any failed check the engine throws (with all check outputs embedded in
 * the error message); the success-path yields carry the per-check
 * results for the historical record.
 */
export interface VerifyYields {
  /**
   * Mechanical check results. Contains one entry per check that ran
   * (skipped checks — those whose given is missing — produce no entry).
   * Always non-empty when verify completes successfully: a totally-vacuous
   * configuration (both `buildCommand` and `testCommand` absent) is a
   * configuration error and throws.
   */
  checks: MechanicalCheck[];
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
  | { status: 'completed'; yields: unknown; graft?: RigTemplateEngine[]; graftTail?: string }
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
  graftTail?: string;
}

// ── status.spider sub-slot shape ────────────────────────────────────────

/**
 * The reason a writ is stuck as recorded in its `status.spider` sub-slot.
 *
 * - 'failed-blocker' — at least one outbound `depends-on` blocker
 *                      reached `failed`; the dependent was cascaded to
 *                      `stuck` directly (not transitively).
 * - 'cycle'          — a back-edge was discovered in the `depends-on`
 *                      graph during gate evaluation; every cycle member is
 *                      stuck with this cause.
 *
 * The historical `'engine-failure'` value is no longer written by this
 * Spider: the engine-failure path now retries in-place within the rig
 * (up to the engine design's `maxAttempts` budget) and, on exhaustion,
 * transitions the writ directly to `phase='failed'` without writing
 * `status.spider.stuckCause`. Readers must tolerate the absent slot.
 */
export type SpiderStuckCause = 'failed-blocker' | 'cycle';

/**
 * Shape of the plugin-owned `status.spider` sub-slot as written by the
 * Spider's dependency-gating paths.
 *
 * The slot is absent (not the empty object) on writs Spider has never
 * touched. For dependency-recovery stucks (`failed-blocker` / `cycle`),
 * the slot carries `stuckCause`, `blockerIds`, and `observedAt`.
 *
 * The slot is written only on stuck transitions via the dependency
 * gating paths and cleared on auto-unstick. Nothing is written while a
 * writ is gated-but-not-stuck or during engine-failure retry — the
 * engine-failure path transitions rigs straight to `failed` and writs
 * straight to `phase='failed'` without writing this slot.
 */
export interface SpiderWritStatus {
  /** Present only while the writ is stuck for a reason Spider recorded. */
  stuckCause?: SpiderStuckCause;
  /**
   * For gating-path stucks, the blockers responsible for the transition.
   * For `failed-blocker`, these are the outbound `depends-on` targets
   * that reached `failed`. For `cycle`, these are the members of the
   * detected cycle (typically including the dependent itself).
   */
  blockerIds?: string[];
  /** ISO timestamp recorded at the moment the stuck transition was taken. */
  observedAt?: string;
}

// Augment GuildConfig so `guild().guildConfig().spider` is typed.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    spider?: SpiderConfig;
  }
}

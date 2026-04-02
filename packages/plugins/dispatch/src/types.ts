/**
 * The Dispatch — public types.
 *
 * These types form the contract between The Dispatch apparatus and all
 * callers (CLI, clockworks). No implementation details.
 *
 * See: docs/architecture/apparatus/dispatch.md
 */

// ── DispatchApi (the `provides` interface) ───────────────────────────

export interface DispatchApi {
  /**
   * Find the oldest ready writ and execute it.
   *
   * The full dispatch lifecycle:
   *   1. Query the Clerk for the oldest ready writ
   *   2. Transition the writ to active
   *   3. Open a draft binding on the writ's codex (if specified)
   *   4. Summon an anima session with the writ context as prompt
   *   5. Wait for session completion
   *   6. On success: seal the draft, push, transition writ to completed
   *   7. On failure: abandon the draft, transition writ to failed
   *
   * Returns null if no ready writs exist.
   *
   * If the writ has no codex, steps 3/6/7 (draft lifecycle) are
   * skipped — the session runs in the guild home directory with
   * no codex binding.
   */
  next(request?: DispatchRequest): Promise<DispatchResult | null>;
}

// ── Request / Result ─────────────────────────────────────────────────

export interface DispatchRequest {
  /** Role to summon. Default: 'artificer'. */
  role?: string;
  /** If true, find and report the writ but don't dispatch. */
  dryRun?: boolean;
}

export interface DispatchResult {
  /** The writ that was dispatched. */
  writId: string;
  /** The session id (from the Animator). Absent if dryRun. */
  sessionId?: string;
  /** Terminal writ status after dispatch. Absent if dryRun. */
  outcome?: 'completed' | 'failed';
  /** Resolution text set on the writ. Absent if dryRun. */
  resolution?: string;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

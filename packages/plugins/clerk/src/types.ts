/**
 * Clerk public types.
 *
 * All types exported from @shardworks/clerk-apparatus.
 */

// ── Writ status ──────────────────────────────────────────────────────

/**
 * A writ's position in its lifecycle.
 *
 * Transitions:
 *   ready → active (accept)
 *   active → completed (complete)
 *   active → failed (fail)
 *   ready | active → cancelled (cancel)
 *
 * completed, failed, cancelled are terminal — no further transitions.
 */
export type WritStatus = 'ready' | 'active' | 'completed' | 'failed' | 'cancelled';

// ── Documents ────────────────────────────────────────────────────────

/**
 * A writ document as stored in The Stacks.
 */
export interface WritDoc {
  /** Unique writ id (ULID-like, prefixed "writ-"). */
  id: string;
  /** Writ type — must be a type declared in guild config, or a built-in type. */
  type: string;
  /** Short human-readable title. */
  title: string;
  /** Optional body / detail text. */
  body: string | null;
  /** Current lifecycle status. */
  status: WritStatus;
  /** Assignee name or id — the party responsible for executing the writ. */
  assignee: string | null;
  /** ISO timestamp when the writ was posted. */
  postedAt: string;
  /** ISO timestamp when the writ was accepted (transitioned to active). */
  acceptedAt: string | null;
  /** ISO timestamp when the writ was closed (completed, failed, or cancelled). */
  closedAt: string | null;
  /** Optional failure reason — populated when status transitions to failed. */
  failReason: string | null;
  [key: string]: unknown;
}

// ── Requests ─────────────────────────────────────────────────────────

/**
 * Request to post a new commission (create a writ).
 */
export interface PostCommissionRequest {
  /**
   * Writ type. Defaults to the guild's configured defaultType, or "mandate"
   * if no default is configured. Must be a valid declared type.
   */
  type?: string;
  /** Short human-readable title describing the work. */
  title: string;
  /** Optional body / detail text. */
  body?: string;
  /** Optional assignee name or id. */
  assignee?: string;
}

// ── Filters ──────────────────────────────────────────────────────────

/**
 * Filters for listing writs.
 */
export interface WritFilters {
  /** Filter by status. */
  status?: WritStatus;
  /** Filter by writ type. */
  type?: string;
  /** Filter by assignee. */
  assignee?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
}

// ── Clerk config ─────────────────────────────────────────────────────

/**
 * Plugin-level configuration for The Clerk (under "clerk" key in guild config).
 */
export interface ClerkConfig {
  /**
   * Default writ type used when commission-post omits the type.
   * Falls back to "mandate" if not set.
   */
  defaultType?: string;
}

// ── API ──────────────────────────────────────────────────────────────

/**
 * The Clerk's runtime API — retrieved via guild().apparatus<ClerkApi>('clerk').
 */
export interface ClerkApi {
  /**
   * Post a new commission, creating a writ in 'ready' status.
   * Validates the writ type against declared types in guild config.
   */
  postCommission(request: PostCommissionRequest): Promise<WritDoc>;

  /**
   * Show a writ by id. Returns null if not found.
   */
  show(writId: string): Promise<WritDoc | null>;

  /**
   * List writs with optional filters, ordered by postedAt descending.
   */
  list(filters?: WritFilters): Promise<WritDoc[]>;

  /**
   * Accept a writ — transitions ready → active.
   */
  accept(writId: string): Promise<WritDoc>;

  /**
   * Complete a writ — transitions active → completed.
   */
  complete(writId: string): Promise<WritDoc>;

  /**
   * Fail a writ — transitions active → failed.
   */
  fail(writId: string, reason?: string): Promise<WritDoc>;

  /**
   * Cancel a writ — transitions ready|active → cancelled.
   */
  cancel(writId: string): Promise<WritDoc>;
}

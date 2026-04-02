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
  /** Unique writ id (`w-{base36_timestamp}{hex_random}`). Sortable by creation time. */
  id: string;
  /** Writ type — must be a type declared in guild config, or a built-in type. */
  type: string;
  /** Current lifecycle status. */
  status: WritStatus;
  /** Short human-readable title. */
  title: string;
  /** Detail text. */
  body: string;
  /** Target codex name. */
  codex?: string;
  /** ISO timestamp when the writ was created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
  /** ISO timestamp when the writ was accepted (transitioned to active). */
  acceptedAt?: string;
  /** ISO timestamp when the writ reached a terminal state. */
  resolvedAt?: string;
  /** Summary of how the writ resolved (set on any terminal transition). */
  resolution?: string;
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
  /** Detail text. */
  body: string;
  /** Optional target codex name. */
  codex?: string;
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
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Configuration ───────────────────────────────────────────────

/**
 * A writ type entry declared in clerk config.
 */
export interface WritTypeEntry {
  /** The writ type name (e.g. "mandate", "task", "bug"). */
  name: string;
  /** Optional human-readable description of this writ type. */
  description?: string;
}

/**
 * Clerk apparatus configuration — lives under the `clerk` key in guild.json.
 */
export interface ClerkConfig {
  /** Additional writ type declarations. The built-in type "mandate" is always valid. */
  writTypes?: WritTypeEntry[];
  /** Default writ type when commission-post is called without a type (default: "mandate"). */
  defaultType?: string;
}

// Augment GuildConfig so `guild().guildConfig().clerk` is typed without
// requiring a manual type parameter at the call site.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    clerk?: ClerkConfig;
  }
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
  post(request: PostCommissionRequest): Promise<WritDoc>;

  /**
   * Show a writ by id. Throws if not found.
   */
  show(id: string): Promise<WritDoc>;

  /**
   * List writs with optional filters, ordered by createdAt descending.
   */
  list(filters?: WritFilters): Promise<WritDoc[]>;

  /**
   * Count writs matching optional filters.
   */
  count(filters?: WritFilters): Promise<number>;

  /**
   * Transition a writ to a new status, optionally setting additional fields.
   * Validates that the transition is legal.
   */
  transition(id: string, to: WritStatus, fields?: Partial<WritDoc>): Promise<WritDoc>;
}

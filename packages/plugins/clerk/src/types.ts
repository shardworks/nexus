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
 *   new   → ready     (publish)   — draft held for review before entering the queue
 *   new   → cancelled (cancel)
 *   new   → waiting   (child added)
 *   ready → active    (accept)
 *   ready → waiting   (child added)
 *   waiting → ready   (all children terminal, none failed)
 *   waiting → failed  (child failed)
 *   ready → completed  (complete) — undispatched writ types, e.g. quest
 *   active → completed (complete)
 *   active → failed    (fail)
 *   ready | active | waiting → cancelled (cancel)
 *
 * completed, failed, cancelled are terminal — no further transitions.
 * waiting is non-terminal — parents wait for children to resolve.
 */
export type WritStatus = 'new' | 'ready' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';

// ── Documents ────────────────────────────────────────────────────────

/**
 * A writ document as stored in The Stacks.
 */
export interface WritDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
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
  /** Parent writ id. Absent on root writs. Immutable after creation. */
  parentId?: string;
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
/**
 * Request to edit a writ. Title and body can be edited in any status.
 * Type and codex can only be changed while the writ is in 'new' status.
 * All fields are optional — only provided fields are updated.
 */
export interface EditWritRequest {
  /** Writ id. */
  id: string;
  /** New title. */
  title?: string;
  /** New body text. */
  body?: string;
  /** New writ type. Must be a valid declared type. */
  type?: string;
  /** New target codex name. Pass empty string to clear. */
  codex?: string;
}

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
  /**
   * When true, the writ is created in 'new' (draft) status instead of 'ready'.
   * Draft writs are invisible to the Spider and must be explicitly published
   * (new → ready) before they can be picked up for execution.
   * Defaults to false (writ enters the queue immediately).
   */
  draft?: boolean;
  /**
   * Create this writ as a child of the specified parent writ.
   * The parent must be in new, ready, or waiting status.
   * If the parent is in new or ready, it will be transitioned to waiting.
   */
  parentId?: string;
}

// ── Filters ──────────────────────────────────────────────────────────

/**
 * Filters for listing writs.
 */
export interface WritFilters {
  /** Filter by status. Accepts a single status or an array of statuses (OR). */
  status?: WritStatus | WritStatus[];
  /** Filter by writ type. */
  type?: string;
  /** Filter to children of this parent writ. */
  parentId?: string;
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

// ── Link documents ───────────────────────────────────────────────────

/**
 * A link document as stored in The Stacks (clerk/links book).
 */
export interface WritLinkDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Deterministic composite key: `{sourceId}:{targetId}:{type}`. */
  id: string;
  /** The writ that is the origin of this relationship. */
  sourceId: string;
  /** The writ that is the target of this relationship. */
  targetId: string;
  /** Relationship type — an open string (e.g. "fixes", "retries", "supersedes", "duplicates"). */
  type: string;
  /** ISO timestamp when the link was created. */
  createdAt: string;
}

/**
 * Result of querying links for a writ — both directions in one response.
 */
export interface WritLinks {
  /** Links where this writ is the source (this writ → other writ). */
  outbound: WritLinkDoc[];
  /** Links where this writ is the target (other writ → this writ). */
  inbound: WritLinkDoc[];
}

// ── Writ type metadata ──────────────────────────────────────────────

/**
 * Metadata for a registered writ type, returned by listWritTypes().
 */
export interface WritTypeInfo {
  /** The writ type name. */
  name: string;
  /** Human-readable description, or null if none was provided. */
  description: string | null;
  /** Origin of this type: "builtin", "guild", or the contributing plugin id. */
  source: string;
  /** Whether this is the guild's default writ type. */
  isDefault: boolean;
}

// ── API ──────────────────────────────────────────────────────────────

/**
 * The Clerk's runtime API — retrieved via guild().apparatus<ClerkApi>('clerk').
 */
export interface ClerkApi {
  /**
   * Post a new commission, creating a writ in 'ready' status by default.
   * If `request.draft` is true, the writ is created in 'new' status instead
   * and will not be picked up by the Spider until explicitly published.
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

  /**
   * Create a typed directional link from one writ to another.
   * Both writs must exist. Self-links are rejected. Idempotent — returns
   * the existing link if the (sourceId, targetId, type) triple already exists.
   */
  link(sourceId: string, targetId: string, type: string): Promise<WritLinkDoc>;

  /**
   * Query all links for a writ — both outbound (this writ is the source)
   * and inbound (this writ is the target).
   */
  links(writId: string): Promise<WritLinks>;

  /**
   * Remove a link. Idempotent — no error if the link does not exist.
   */
  unlink(sourceId: string, targetId: string, type: string): Promise<void>;

  /**
   * Edit a writ. Title and body can be edited in any status.
   * Type and codex can only be changed while the writ is in 'new' status.
   * Only the provided fields are updated. Validates type against
   * declared writ types if provided.
   */
  edit(request: EditWritRequest): Promise<WritDoc>;

  /**
   * List all registered writ types with metadata.
   * Returns builtin types, guild-configured types, and kit-contributed types.
   * Each entry includes the type name, optional description, source, and
   * whether it is the default type.
   */
  listWritTypes(): WritTypeInfo[];
}

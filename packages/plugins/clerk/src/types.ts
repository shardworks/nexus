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
 *   new    → open       (publish)   — draft enters the queue
 *   new    → cancelled  (cancel)
 *   open   → completed  (complete)
 *   open   → failed     (fail)
 *   open   → cancelled  (cancel)
 *   open   → stuck      (engine failure cascade)
 *   stuck  → open       (recovery/retry resumes execution)
 *   stuck  → failed     (obligation abandoned)
 *   stuck  → cancelled  (obligation withdrawn)
 *
 * completed, failed, cancelled are terminal — no further transitions.
 * stuck is non-terminal — it represents a "needs attention" state.
 */
export type WritStatus = 'new' | 'open' | 'stuck' | 'completed' | 'failed' | 'cancelled';

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
   * When true, the writ is created in 'new' (draft) status instead of 'open'.
   * Draft writs are invisible to the Spider and must be explicitly published
   * (new → open) before they can be picked up for execution.
   * Defaults to false (writ enters the queue immediately).
   */
  draft?: boolean;
  /**
   * Create this writ as a child of the specified parent writ.
   * The parent must be in new or open status.
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
  /** Filter by writ type. Accepts a single type or an array of types (OR). */
  type?: string | string[];
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
 *
 * A writ link has two complementary identifiers for its relationship:
 *
 *   - `type` is a casual, human-facing label. It is an open string, normalized
 *     at write time via the link-type normalization pipeline (lowercase,
 *     trim, camelCase split, snake_case/kebab-case split, whitespace
 *     collapse). Variant spellings of the same label collapse to a single
 *     canonical form; distinct labels remain distinct. Normalization is
 *     purely syntactic — it is NOT synonymy. `requires` and `depends on`
 *     normalize to different strings; callers that want to treat them as the
 *     same relationship should attach the same `semanticMeaning` to both.
 *
 *   - `semanticMeaning` is the load-bearing identifier. It is a stable,
 *     plugin-owned id drawn from the kit-contributed meaning registry, and
 *     identifies the specific relationship a downstream consumer wants to
 *     react to (rendering parent/child, gating publish on `refines`, etc.).
 *     `null` when the caller treated this link as a casual label.
 */
export interface WritLinkDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Deterministic composite key: `{sourceId}:{targetId}:{normalized type}`. */
  id: string;
  /** The writ that is the origin of this relationship. */
  sourceId: string;
  /** The writ that is the target of this relationship. */
  targetId: string;
  /**
   * Casual relationship label — an open string normalized syntactically at
   * write time (e.g. "fixes", "retries", "supersedes", "duplicates",
   * "depends on"). NOT a synonymy layer. For load-bearing identity, use
   * `semanticMeaning`.
   */
  type: string;
  /**
   * Load-bearing identifier for this relationship. When non-null, references
   * a registered meaning id from the `linkMeanings` kit registry and is the
   * field downstream consumers key on. Always present on each row (`null`
   * when the caller did not attach a meaning).
   */
  semanticMeaning: string | null;
  /** ISO timestamp when the link was created. */
  createdAt: string;
}

// ── Link meaning registry ────────────────────────────────────────────

/**
 * A link-meaning contribution declared by a kit's `linkMeanings` array.
 *
 * Kit authors use this shape when populating `ClerkKit.linkMeanings`. Meaning
 * ids must be prefixed with the contributing plugin's id followed by `:` and
 * a kebab-case suffix — e.g. kit `astrolabe` contributing `astrolabe:refines`.
 * The registry-projection view (returned by `listMeanings()`) is `MeaningDoc`,
 * which embeds the resolved owner plugin id; kit authors do not repeat their
 * plugin id on each entry.
 */
export interface MeaningEntry {
  /**
   * Fully-qualified meaning id. Must begin with `{pluginId}:` and be followed
   * by a non-empty kebab-case suffix (lowercase letters, digits, and hyphens,
   * not starting or ending with a hyphen).
   */
  id: string;
  /** Human-readable description of the relationship this meaning denotes. */
  description: string;
}

/**
 * A link-meaning record as projected by `listMeanings()`.
 *
 * Unlike `MeaningEntry`, this shape embeds the resolved owner plugin id so
 * consumers of the registry do not need to parse it back out of `id`.
 */
export interface MeaningDoc {
  /** Fully-qualified meaning id. */
  id: string;
  /** Plugin id of the kit that contributed this meaning. */
  ownerPlugin: string;
  /** Human-readable description of this meaning. */
  description: string;
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
   * Post a new commission, creating a writ in 'open' status by default.
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
   * Both writs must exist. Self-links are rejected. The `type` argument is
   * normalized before the composite id is constructed, so variant spellings
   * of the same label collapse to a single link. When a link with the same
   * canonical composite id already exists, the existing row is returned;
   * if `semanticMeaning` is supplied, it is written onto the existing row
   * (upsert). The optional `semanticMeaning` must reference an id registered
   * in the kit-contributed meaning registry; unknown ids are rejected.
   */
  link(
    sourceId: string,
    targetId: string,
    type: string,
    semanticMeaning?: string,
  ): Promise<WritLinkDoc>;

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

  /**
   * List all registered link meanings contributed by kits.
   * Returns the registry-projection view of each meaning, including its
   * owner plugin id. Returns an empty array when no meanings have been
   * registered.
   */
  listMeanings(): Promise<MeaningDoc[]>;
}

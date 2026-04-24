/**
 * Clerk public types.
 *
 * All types exported from @shardworks/clerk-apparatus.
 */

// ── Writ phase ───────────────────────────────────────────────────────

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
export type WritPhase = 'new' | 'open' | 'stuck' | 'completed' | 'failed' | 'cancelled';

// ── Documents ────────────────────────────────────────────────────────

/**
 * A writ document as stored in The Stacks.
 */
export interface WritDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Unique writ id (`w-{base36_timestamp}-{hex_random}`). Sortable by creation time. */
  id: string;
  /** Writ type — must be a type declared in guild config, or a built-in type. */
  type: string;
  /** Current lifecycle phase (Clerk-owned; spec side of the spec/status split). */
  phase: WritPhase;
  /**
   * Plugin-owned observation slot (status side of the spec/status split).
   *
   * The observation slot is a plugin-keyed map (`Record<PluginId,
   * unknown>`): each top-level key is a plugin id, and the value is an
   * arbitrary shape that plugin publishes for post-hoc observation.
   * Ownership is convention-only — plugin `X` writes only to `status[X]`.
   *
   * There is exactly one sanctioned slot-write path:
   * `ClerkApi.setWritStatus(writId, pluginId, value)`, which performs a
   * transactional read-modify-write on the sub-slot keyed by `pluginId`
   * so sibling sub-slots are preserved under concurrent writers.
   * `transition()` silently strips `status` from its body, and the
   * generic `put()` / `patch()` paths on the writs book are not
   * supported slot-write mechanisms — every route other than
   * `setWritStatus()` would wholesale-replace the slot and clobber
   * sibling sub-slots. Readers access `writ.status?.[pluginId]` directly.
   *
   * The slot survives terminal phase transitions.
   */
  status?: Record<string, unknown>;
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
  /** Filter by phase. Accepts a single phase or an array of phases (OR). */
  phase?: WritPhase | WritPhase[];
  /** Filter by writ type. Accepts a single type or an array of types (OR). */
  type?: string | string[];
  /** Filter to children of this parent writ. */
  parentId?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Tree shapes ──────────────────────────────────────────────────────

/**
 * A nested writ-and-children tree node, returned by `ClerkApi.tree()`.
 *
 * The shape is the writ document plus a recursively-typed `children` array
 * of further `WritTree` nodes. Mirrors ratchet's `ClickTree` so the same
 * mental model and rendering idioms apply across apparatus.
 */
export interface WritTree {
  /** The writ document at this node. */
  writ: WritDoc;
  /** Direct children, each shaped as a `WritTree`. */
  children: WritTree[];
}

/**
 * Parameters for `ClerkApi.tree()`.
 *
 * - `rootId` switches between forest mode (omit) and subtree mode
 *   (single root). In subtree mode the returned array always has at most
 *   one element.
 * - `phase` and `type` apply prune semantics: any node failing the filter
 *   is dropped along with its entire subtree.
 * - `depth` caps recursion. The node at depth = `depth` is included but its
 *   children are not. `depth: 0` returns roots only.
 * - `rootLimit` and `rootOffset` page across the *root* layer of forest
 *   mode (preserves the page's `Load more` UX). They are ignored when
 *   `rootId` is supplied.
 *
 * In forest mode roots are returned in `createdAt desc` order (newest
 * first) to match `list()` and the existing writs-page UX. Children
 * within each subtree stay in `createdAt asc` order (oldest first) so the
 * visual shape of the tree is stable across sort/filter changes.
 */
export interface WritTreeParams {
  /** Restrict to the subtree rooted at this writ id. */
  rootId?: string;
  /** Filter by writ phase (single or OR-list); prunes non-matching subtrees. */
  phase?: WritPhase | WritPhase[];
  /** Filter by writ type (single or OR-list); prunes non-matching subtrees. */
  type?: string | string[];
  /** Maximum recursion depth (0 = roots only). Node at the cap is included. */
  depth?: number;
  /** Root-slice limit for forest mode (default: unbounded). */
  rootLimit?: number;
  /** Root-slice offset for forest mode (default: 0). */
  rootOffset?: number;
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
 *   - `label` is a casual, human-facing string. It is open-ended, normalized
 *     at write time via the link-label normalization pipeline (lowercase,
 *     trim, camelCase split, snake_case/kebab-case split, whitespace
 *     collapse). Variant spellings of the same label collapse to a single
 *     canonical form; distinct labels remain distinct. Normalization is
 *     purely syntactic — it is NOT synonymy. `requires` and `depends on`
 *     normalize to different strings; callers that want to treat them as the
 *     same relationship should attach the same `kind` to both.
 *
 *   - `kind` is the load-bearing identifier. It is a stable, plugin-owned id
 *     drawn from the kit-contributed link-kind registry, and identifies the
 *     specific relationship a downstream consumer wants to react to
 *     (rendering parent/child, gating publish on `refines`, etc.). `null`
 *     when the caller treated this link as a casual label.
 */
export interface WritLinkDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Deterministic composite key: `{sourceId}:{targetId}:{normalized label}`. */
  id: string;
  /** The writ that is the origin of this relationship. */
  sourceId: string;
  /** The writ that is the target of this relationship. */
  targetId: string;
  /**
   * Casual relationship label — an open string normalized syntactically at
   * write time (e.g. "fixes", "retries", "supersedes", "duplicates",
   * "depends on"). NOT a synonymy layer. For load-bearing identity, use
   * `kind`.
   */
  label: string;
  /**
   * Load-bearing identifier for this relationship. When non-null, references
   * a registered kind id from the `linkKinds` kit registry and is the field
   * downstream consumers key on. Always present on each row (`null` when
   * the caller did not attach a kind).
   */
  kind: string | null;
  /** ISO timestamp when the link was created. */
  createdAt: string;
}

// ── Link kind registry ───────────────────────────────────────────────

/**
 * A link-kind contribution declared by a kit's `linkKinds` array.
 *
 * Kit authors use this shape when populating `ClerkKit.linkKinds`. Kind ids
 * must be prefixed with the contributing plugin's id followed by `.` and a
 * kebab-case suffix — e.g. kit `astrolabe` contributing `astrolabe.refines`.
 * The registry-projection view (returned by `listKinds()`) is `LinkKindDoc`,
 * which embeds the resolved owner plugin id; kit authors do not repeat their
 * plugin id on each entry.
 */
export interface KindEntry {
  /**
   * Fully-qualified kind id. Must begin with `{pluginId}.` and be followed
   * by a non-empty kebab-case suffix (lowercase letters, digits, and hyphens,
   * not starting or ending with a hyphen).
   */
  id: string;
  /** Human-readable description of the relationship this kind denotes. */
  description: string;
}

/**
 * A link-kind record as projected by `listKinds()`.
 *
 * Unlike `KindEntry`, this shape embeds the resolved owner plugin id so
 * consumers of the registry do not need to parse it back out of `id`.
 */
export interface LinkKindDoc {
  /** Fully-qualified kind id. */
  id: string;
  /** Plugin id of the kit that contributed this kind. */
  ownerPlugin: string;
  /** Human-readable description of this kind. */
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
   * Resolve a writ id prefix to the full id. Mirrors ratchet's resolveId
   * for clicks — callers may pass the short display form (e.g. `w-mo2xi6pt`)
   * and receive the full id back. Throws when no writ matches or when the
   * prefix is ambiguous.
   */
  resolveId(prefix: string): Promise<string>;

  /**
   * List writs with optional filters, ordered by createdAt descending.
   */
  list(filters?: WritFilters): Promise<WritDoc[]>;

  /**
   * Count writs matching optional filters.
   */
  count(filters?: WritFilters): Promise<number>;

  /**
   * Walk the writ hierarchy and return a forest (or a single subtree when
   * `rootId` is provided). Mirrors ratchet's `tree()` precedent.
   *
   * Filters apply with prune semantics: a node failing `phase` or `type`
   * is excluded together with its entire subtree. The `depth` cap halts
   * recursion below — the node at the cap is still included, but no
   * descendants of it are walked. `rootLimit` / `rootOffset` page across
   * the root layer of forest mode and are ignored when `rootId` is given.
   */
  tree(params?: WritTreeParams): Promise<WritTree[]>;

  /**
   * Count all descendants of a writ grouped by phase.
   *
   * Walks the parent/child tree recursively beneath `writId`, tallying each
   * descendant's phase. The root writ (the writ identified by `writId`) is
   * excluded from the count — only its descendants contribute. The result is
   * a plain object keyed by `WritPhase` with numeric values; phases with no
   * matching descendants are simply absent.
   *
   * This is the traversal primitive behind `writ-show`'s `children.summary`
   * field, and is also reusable by any future subtree-oriented tooling (e.g.
   * a `writ-tree` apparatus). Throws if the writ does not exist.
   */
  countDescendantsByPhase(writId: string): Promise<Record<WritPhase, number>>;

  /**
   * Transition a writ to a new phase, optionally setting additional fields.
   * Validates that the transition is legal.
   *
   * Managed fields supplied in `fields` are silently dropped before the
   * patch is applied: `id`, `phase`, `status`, `createdAt`, `updatedAt`,
   * `resolvedAt`, and `parentId`. `phase` is managed by the state machine;
   * the plugin-owned observation slot `status` is writable only via
   * `setWritStatus()` (the one sanctioned slot-write path) so that
   * sibling sub-slots are preserved under concurrent writers. The generic
   * `put()` / `patch()` paths are not supported slot-write mechanisms.
   */
  transition(id: string, to: WritPhase, fields?: Partial<WritDoc>): Promise<WritDoc>;

  /**
   * Write a plugin-owned sub-slot of the writ's observation `status` map.
   *
   * The slot is the "status" side of the spec/status split: plugins publish
   * post-hoc observations here (stuck causes, gate state, provenance, …)
   * without polluting the Clerk-owned `phase` state machine.
   *
   * The call is a transactional read-modify-write — the sub-slot keyed by
   * `pluginId` is replaced with `value`, but sibling sub-slots owned by
   * other plugins are preserved. Writes emit CDC update events like any
   * other field change, and survive terminal phase transitions.
   *
   * Ownership is convention-only: plugin `X` writes only `status[X]`.
   * There is no runtime guard.
   *
   * Returns the updated writ document.
   */
  setWritStatus(writId: string, pluginId: string, value: unknown): Promise<WritDoc>;

  /**
   * Create a typed directional link from one writ to another.
   * Both writs must exist. Self-links are rejected. The `label` argument is
   * normalized before the composite id is constructed, so variant spellings
   * of the same label collapse to a single link. When a link with the same
   * canonical composite id already exists, the existing row is returned;
   * if `kind` is supplied, it is written onto the existing row (upsert). The
   * optional `kind` must reference an id registered in the kit-contributed
   * link-kind registry; unknown ids are rejected.
   */
  link(
    sourceId: string,
    targetId: string,
    label: string,
    kind?: string,
  ): Promise<WritLinkDoc>;

  /**
   * Query all links for a writ — both outbound (this writ is the source)
   * and inbound (this writ is the target).
   */
  links(writId: string): Promise<WritLinks>;

  /**
   * Remove a link. Idempotent — no error if the link does not exist.
   */
  unlink(sourceId: string, targetId: string, label: string): Promise<void>;

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
   * List all registered link kinds contributed by kits.
   * Returns the registry-projection view of each kind, including its owner
   * plugin id. Returns an empty array when no kinds have been registered.
   */
  listKinds(): Promise<LinkKindDoc[]>;
}

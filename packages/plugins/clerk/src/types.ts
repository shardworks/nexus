/**
 * Clerk public types.
 *
 * All types exported from @shardworks/clerk-apparatus.
 */

import type {
  WritTypeConfig,
  WritTypeStateAttr,
  WritTypeStateClassification,
} from './writ-type-config.ts';

// ── Writ phase ───────────────────────────────────────────────────────

/**
 * The mandate writ type's lifecycle states.
 *
 * This union is mandate-specific — it enumerates the six states the built-in
 * mandate `WritTypeConfig` declares and is preserved for callers that
 * knowingly work exclusively with mandate writs. The structural type of
 * `WritDoc.phase` is `string` so any plugin-registered writ type's state
 * name can round-trip through the book; callers that need a mandate-phase
 * typed value should downcast explicitly.
 *
 * Mandate transitions:
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
  /**
   * Current lifecycle state name (Clerk-owned; spec side of the spec/status
   * split). Structurally typed as `string` so any plugin-registered writ
   * type's state name can round-trip through the book. For mandate-typed
   * writs the value is constrained to a `WritPhase` literal at runtime, but
   * callers that need a narrower static type should downcast explicitly.
   */
  phase: string;
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
   * if no default is configured. Must be a registered writ type.
   */
  type?: string;
  /** Short human-readable title describing the work. */
  title: string;
  /** Detail text. */
  body: string;
  /** Optional target codex name. */
  codex?: string;
  /**
   * Create this writ as a child of the specified parent writ.
   * The parent must not be in a terminal state.
   */
  parentId?: string;
}

// ── Filters ──────────────────────────────────────────────────────────

/**
 * Filters for listing writs.
 */
export interface WritFilters {
  /**
   * Filter by phase. Accepts a single phase or an array of phases (OR).
   *
   * `phase` is mandate-scoped at the WHERE-clause level: when `phase` is
   * supplied without `type`, the implementation implicitly adds
   * `type = 'mandate'` so a non-mandate writ that happens to declare an
   * `open` state cannot match a `phase: 'open'` filter unscoped to its
   * type. To query a non-mandate type's same-named state, pass both
   * `type` and `phase` together (D7).
   */
  phase?: WritPhase | WritPhase[];
  /** Filter by writ type. Accepts a single type or an array of types (OR). */
  type?: string | string[];
  /**
   * Filter by state classification. Accepts a single classification or an
   * array (OR). Type-agnostic: applies across every registered writ type.
   * The closed three-value enum mirrors `WritTypeStateClassification`.
   */
  classification?:
    | WritTypeStateClassification
    | WritTypeStateClassification[];
  /** Filter to children of this parent writ. */
  parentId?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Presentation projections ─────────────────────────────────────────

/**
 * Classification value as embedded on writ-bearing tool responses.
 *
 * Domain-side classifier helpers (`ClerkApi.isInitial`/`isActive`/
 * `isTerminal`) throw on an unregistered type or undeclared state — the
 * classifier preserves its fail-loud contract. The presentation projection
 * is tolerant and surfaces `'unknown'` for the same conditions so a single
 * legacy row cannot crash a list/tree/show response.
 */
export type WritPresentationClassification = 'initial' | 'active' | 'terminal' | 'unknown';

/**
 * Per-row presentation projection. `writ-list` returns rows of this
 * shape; `writ-tree`'s `WritTree.writ` and `writ-show`'s top-level writ
 * extend `WritDoc` with the same two derived fields.
 */
export interface WritWithPresentation extends WritDoc {
  /**
   * Classification of the writ's current state in its type config.
   * `'unknown'` indicates the writ's type is unregistered or its phase
   * is not declared in the registered config (presentation tolerance).
   */
  classification: WritPresentationClassification;
  /**
   * Outbound transition names declared on the writ's current state in
   * its type config. Empty for terminal states and for unknown
   * classifications.
   */
  allowedTransitions: string[];
}

/**
 * Compact parent/child reference shape used on `writ-show`'s `parent`
 * field and `children.items` entries. Carries the same `classification`
 * and `allowedTransitions` derivations as a full row so a renderer can
 * pick badge classes and action affordances uniformly.
 */
export interface WritReferenceWithPresentation {
  /** Writ id. */
  id: string;
  /** Writ title. */
  title: string;
  /** Writ type. */
  type: string;
  /** Current lifecycle state name. */
  phase: string;
  /** Classification of the writ's current state in its type config. */
  classification: WritPresentationClassification;
  /** Outbound transitions from the writ's current state. */
  allowedTransitions: string[];
}

// ── Tree shapes ──────────────────────────────────────────────────────

/**
 * A nested writ-and-children tree node, returned by `ClerkApi.tree()`.
 *
 * The shape is the writ document plus a recursively-typed `children` array
 * of further `WritTree` nodes. Mirrors ratchet's `ClickTree` so the same
 * mental model and rendering idioms apply across apparatus.
 *
 * Each node's `writ` carries the standard `WritDoc` fields plus the
 * presentation projection (`classification`, `allowedTransitions`) so
 * tree renderers can pick glyphs and action affordances per node without
 * reaching back into the type-config registry.
 */
export interface WritTree {
  /** The writ document at this node, with embedded presentation fields. */
  writ: WritWithPresentation;
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
  /**
   * Filter by writ phase (single or OR-list); prunes non-matching
   * subtrees. Mandate-scoped at the same level as `WritFilters.phase` —
   * see that field's docstring (D7).
   */
  phase?: WritPhase | WritPhase[];
  /** Filter by writ type (single or OR-list); prunes non-matching subtrees. */
  type?: string | string[];
  /**
   * Filter by state classification (single or OR-list); prunes
   * non-matching subtrees. Type-agnostic — applies across every
   * registered writ type.
   */
  classification?:
    | WritTypeStateClassification
    | WritTypeStateClassification[];
  /** Maximum recursion depth (0 = roots only). Node at the cap is included. */
  depth?: number;
  /** Root-slice limit for forest mode (default: unbounded). */
  rootLimit?: number;
  /** Root-slice offset for forest mode (default: 0). */
  rootOffset?: number;
}

// ── Configuration ───────────────────────────────────────────────

/**
 * Clerk apparatus configuration — lives under the `clerk` key in guild.json.
 *
 * Writ types are now contributed exclusively via
 * `ClerkApi.registerWritType` from a plugin's own `start()`. There is no
 * guild-config `writTypes` field; the operator's only handle on the writ-
 * type registry from guild config is the `defaultType` selection (which is
 * validated against the registry once startup seals).
 */
export interface ClerkConfig {
  /** Default writ type when commission-post is called without a type (default: "mandate"). Validated against the writ-type registry at startup; an unregistered name fails fast. */
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
 * Per-state metadata projected from a `WritTypeStateDefinition` for the
 * `/api/writ/types` and `nsg writ types` surfaces. Carries everything a
 * presentation layer needs to derive vocabulary, badges, and action
 * affordances without consulting the type-config registry per row.
 */
export interface WritTypeStateInfo {
  /** State name. */
  name: string;
  /** State's role in the lifecycle. */
  classification: WritTypeStateClassification;
  /** Per-state attribute tags (e.g. `success`, `failure`, `cancelled`). */
  attrs: WritTypeStateAttr[];
  /** Outbound transitions declared on this state. */
  allowedTransitions: string[];
}

/**
 * Metadata for a registered writ type, returned by listWritTypes().
 */
export interface WritTypeInfo {
  /** The writ type name. */
  name: string;
  /**
   * Reserved for a future config-carried description field. Always `null`
   * today — `WritTypeConfig` does not currently model a description, and
   * the legacy guild-config / kit-channel description fields are gone.
   */
  description: string | null;
  /**
   * Origin of this type. `"builtin"` is reserved for `mandate`, which the
   * Clerk plugin registers from its own `start()`; every other registered
   * type carries `"plugin"`. The Clerk does not track the calling plugin's
   * id — there is no implicit hand-off of caller identity into
   * `registerWritType`.
   */
  source: 'builtin' | 'plugin';
  /** Whether this is the guild's default writ type. */
  isDefault: boolean;
  /**
   * The full state catalogue for this type — one entry per state declared
   * in the type's registered `WritTypeConfig`, in the order it was
   * declared. Each entry projects the state's name, classification, attrs,
   * and outbound transitions so a presentation layer can derive vocabulary
   * (badges, indicators, action labels) without a separate registry
   * lookup.
   */
  states: WritTypeStateInfo[];
}

// ── API ──────────────────────────────────────────────────────────────

/**
 * The Clerk's runtime API — retrieved via guild().apparatus<ClerkApi>('clerk').
 */
export interface ClerkApi {
  /**
   * Post a new commission, creating a writ in its registered type's
   * declared `initial` state. The writ type must be registered with
   * `registerWritType`; an unknown type is rejected. The caller decides
   * whether to advance the writ further (e.g. `commission-post` auto-
   * publishes mandate writs to `open` by default — see that tool); the
   * `post()` API itself is type-agnostic and never auto-advances.
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
   * Count writs currently in any `active`-classified state across every
   * registered writ type.
   *
   * Walks the writ-type registry on each call (no caching) and composes a
   * per-type OR-form query of the shape `[type, phase IN [active-states-of-type]]`.
   * Returns `0` when the registry is empty, when no registered type
   * declares any `active` state, or when no rows match.
   *
   * This is the classification-driven primitive behind the Reckoner's
   * drain detector and any future apparatus that needs a multi-type
   * "is anything in flight?" count. Existing per-phase counts (e.g.
   * `count({ phase: 'open' })`) remain available for type-specific reads.
   */
  countActive(): Promise<number>;

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
   * List the writ types registered with the Clerk via `registerWritType`,
   * including the Clerk's own built-in `mandate`. Each entry reports the
   * name, the (currently-always-null) description, source (`builtin` or
   * `plugin`), and whether it is the default type.
   */
  listWritTypes(): WritTypeInfo[];

  /**
   * List all registered link kinds contributed by kits.
   * Returns the registry-projection view of each kind, including its owner
   * plugin id. Returns an empty array when no kinds have been registered.
   */
  listKinds(): Promise<LinkKindDoc[]>;

  /**
   * Register a writ type's state machine with the Clerk.
   *
   * The supplied config is validated via `validateWritTypeConfig` before the
   * registry is updated; validator errors propagate verbatim. Registration-
   * specific failures (duplicate name, late call after the startup window has
   * sealed) are wrapped with a `[clerk] registerWritType:` prefix.
   *
   * Callable only while the startup window is open — Clerk seals the
   * registry on the framework's global `phase:started` signal, after which
   * further calls throw. This is the single-surface entry point for plugins
   * contributing writ types; there is no parallel kit-channel or guild-config
   * registration path.
   */
  registerWritType(config: WritTypeConfig): void;

  /**
   * Return the registered `WritTypeConfig` for a writ type.
   *
   * Returns `undefined` when the name is not registered. Callers that need
   * to work with a writ type abstractly (inspect states, render UI labels,
   * compose higher-level predicates) should use this accessor instead of
   * reaching into the predicate surface with synthetic `WritDoc`s.
   */
  getWritTypeConfig(name: string): WritTypeConfig | undefined;

  /**
   * Return `true` when the writ's current state is classified `initial`
   * in its type's registered config.
   *
   * Throws when the writ's stored state is not declared in its type config
   * (fail-loud on unknown-state), or when the writ's type is not registered.
   */
  isInitial(writ: WritDoc): boolean;

  /**
   * Return `true` when the writ's current state is classified `active`
   * in its type's registered config.
   *
   * Throws when the writ's stored state is not declared in its type config
   * (fail-loud on unknown-state), or when the writ's type is not registered.
   */
  isActive(writ: WritDoc): boolean;

  /**
   * Return `true` when the writ's current state is classified `terminal`
   * in its type's registered config.
   *
   * Throws when the writ's stored state is not declared in its type config
   * (fail-loud on unknown-state), or when the writ's type is not registered.
   */
  isTerminal(writ: WritDoc): boolean;
}

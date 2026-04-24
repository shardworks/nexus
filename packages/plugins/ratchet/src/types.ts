export type ClickStatus = 'live' | 'parked' | 'concluded' | 'dropped';

export type LinkType = 'related' | 'commissioned' | 'supersedes' | 'depends-on';

/**
 * A single entry in a click's `goalHistory`. Each entry captures the prior
 * goal text at the moment an amend supplanted it, the ISO timestamp of that
 * amend, and — when supplied — the session that performed it. Entries are
 * appended chronologically; the newest entry is always last in the array.
 */
export interface GoalHistoryEntry {
  /** The goal text that was replaced by this amend. */
  goal: string;
  /** ISO timestamp at which the amend occurred. */
  amendedAt: string;
  /** Session id that performed the amend, when supplied. */
  sessionId?: string;
}

export interface ClickDoc {
  [key: string]: unknown;
  id: string;
  parentId?: string;
  goal: string;
  /**
   * Prior goal values preserved by `amend()`, oldest-first. Absent on records
   * created before the amend affordance was introduced; readers must treat
   * missing and empty as "no amends yet."
   */
  goalHistory?: GoalHistoryEntry[];
  status: ClickStatus;
  conclusion?: string;
  createdSessionId?: string;
  resolvedSessionId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ClickLinkDoc {
  [key: string]: unknown;
  id: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  createdAt: string;
}

export interface ClickLinks {
  outbound: ClickLinkDoc[];
  inbound: ClickLinkDoc[];
}

export interface CreateClickRequest {
  goal: string;
  parentId?: string;
  createdSessionId?: string;
}

export interface ConcludeClickRequest {
  conclusion: string;
  resolvedSessionId?: string;
}

export interface DropClickRequest {
  conclusion: string;
  resolvedSessionId?: string;
}

export interface ReparentClickRequest {
  parentId?: string | null;
}

export interface AmendClickRequest {
  /** The new goal text. Empty or whitespace-only text is rejected. */
  goal: string;
  /** Session id performing the amend, recorded on the history entry. */
  sessionId?: string;
}

export interface SupersedeClickRequest {
  /**
   * Goal text for the newly created click. Empty or whitespace-only text is
   * rejected, matching `create()`.
   */
  goal: string;
  /** Optional parent for the new click. When omitted the new click is a root. */
  parentId?: string;
  /** Session id that created the new click. */
  createdSessionId?: string;
}

export interface LinkClickRequest {
  sourceId: string;
  targetId: string;
  linkType: LinkType;
}

export interface UnlinkClickRequest {
  sourceId: string;
  targetId: string;
  linkType: LinkType;
}

export interface ExtractClickRequest {
  format: 'md' | 'json';
  full?: boolean;
  depth?: number;
}

export interface ClickFilters {
  status?: ClickStatus | ClickStatus[];
  parentId?: string;
  rootId?: string;
  limit?: number;
  offset?: number;
}

/**
 * A single entry in a `ClickTree` supersede reference array. Each entry
 * names the referenced click by id and carries a `goal` snippet to let
 * downstream renderers (markdown, text tree) format a link line without
 * a second fetch.
 *
 * When the referenced click cannot be fetched (e.g. deleted, stale link),
 * `goal` is `null` and renderers should emit a `<missing>` placeholder.
 *
 * Inbound (`supersededBy`) entries may carry an optional `chain` of
 * intermediate short-ids walked between the host node and the terminal
 * superseder — populated only when the inbound supersede chain is longer
 * than one hop. `id` and `goal` always describe the *terminal* superseder
 * for the chain; `chain` (when present) lists the short-ids of the
 * intermediate hops in walk order (excluding the host and the terminal).
 */
export interface SupersedeRef {
  id: string;
  goal: string | null;
  chain?: string[];
}

export interface ClickTree {
  click: ClickDoc;
  children: ClickTree[];
  /**
   * Inbound `supersedes` links — i.e. clicks that supersede *this* click.
   * Populated by `ratchet.tree()` / `ratchet.extract()` enrichment; each
   * entry represents one immediate inbound superseder, with its chain
   * walked to the terminal (cycle-safe, branch-terminating). Absent when
   * the click has no inbound supersedes.
   */
  supersededBy?: SupersedeRef[];
  /**
   * Outbound `supersedes` links — i.e. clicks that *this* click supersedes.
   * Populated by `ratchet.tree()` / `ratchet.extract()` enrichment as one
   * immediate predecessor per edge (one hop). Absent when the click has
   * no outbound supersedes.
   */
  supersedes?: SupersedeRef[];
}

export interface TreeParams {
  rootId?: string;
  status?: ClickStatus | ClickStatus[];
  depth?: number;
}

export interface RatchetApi {
  create(params: CreateClickRequest): Promise<ClickDoc>;
  get(id: string): Promise<ClickDoc>;
  list(filters?: ClickFilters): Promise<ClickDoc[]>;
  park(id: string): Promise<ClickDoc>;
  resume(id: string): Promise<ClickDoc>;
  conclude(id: string, params: ConcludeClickRequest): Promise<ClickDoc>;
  drop(id: string, params: DropClickRequest): Promise<ClickDoc>;
  reparent(id: string, params: ReparentClickRequest): Promise<ClickDoc>;
  amend(id: string, params: AmendClickRequest): Promise<ClickDoc>;
  /**
   * Atomically create a new click and a `supersedes` link from the new click
   * to `targetId`. Both writes land inside a single Stacks transaction; if
   * either fails, neither is persisted. The target may be in any status —
   * `live`, `parked`, `concluded`, or `dropped` — and is not reparented. The
   * new click's default parent is unset (root); pass `params.parentId` to
   * nest it. Returns both documents.
   */
  supersede(
    targetId: string,
    params: SupersedeClickRequest,
  ): Promise<{ click: ClickDoc; link: ClickLinkDoc }>;
  link(params: LinkClickRequest): Promise<ClickLinkDoc>;
  unlink(params: UnlinkClickRequest): Promise<void>;
  extract(rootId: string, params: ExtractClickRequest): Promise<string | ClickTree>;
  tree(params?: TreeParams): Promise<ClickTree[]>;
  resolveId(prefix: string): Promise<string>;
  links(clickId: string): Promise<ClickLinks>;

  /**
   * Count all descendants of a click grouped by status.
   *
   * Walks the parent/child tree recursively beneath `clickId`, tallying each
   * descendant's status. The root click (the click identified by `clickId`)
   * is excluded from the count — only its descendants contribute. The result
   * is a plain object keyed by `ClickStatus` with numeric values; statuses
   * with no matching descendants are simply absent.
   *
   * This is the traversal primitive behind `click-show`'s `children.summary`
   * field. Mirrors the shape of `ClerkApi.countDescendantsByPhase`.
   * Throws if the click does not exist.
   */
  countDescendantsByStatus(clickId: string): Promise<Record<ClickStatus, number>>;
}

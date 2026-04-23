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
}

export interface ClickFilters {
  status?: ClickStatus | ClickStatus[];
  parentId?: string;
  rootId?: string;
  limit?: number;
  offset?: number;
}

export interface ClickTree {
  click: ClickDoc;
  children: ClickTree[];
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
  link(params: LinkClickRequest): Promise<ClickLinkDoc>;
  unlink(params: UnlinkClickRequest): Promise<void>;
  extract(rootId: string, params: ExtractClickRequest): Promise<string | ClickTree>;
  tree(params?: TreeParams): Promise<ClickTree[]>;
  resolveId(prefix: string): Promise<string>;
  links(clickId: string): Promise<ClickLinks>;
}

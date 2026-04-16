export type ClickStatus = 'live' | 'parked' | 'concluded' | 'dropped';

export type LinkType = 'related' | 'commissioned' | 'supersedes' | 'depends-on';

export interface ClickDoc {
  [key: string]: unknown;
  id: string;
  parentId?: string;
  goal: string;
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
  link(params: LinkClickRequest): Promise<ClickLinkDoc>;
  unlink(params: UnlinkClickRequest): Promise<void>;
  extract(rootId: string, params: ExtractClickRequest): Promise<string | ClickTree>;
  tree(params?: TreeParams): Promise<ClickTree[]>;
  resolveId(prefix: string): Promise<string>;
  links(clickId: string): Promise<ClickLinks>;
}

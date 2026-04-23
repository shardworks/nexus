import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type { StacksApi, Book, WhereClause } from '@shardworks/stacks-apparatus';

import type {
  ClickDoc,
  ClickLinkDoc,
  ClickLinks,
  ClickStatus,
  ClickFilters,
  ClickTree,
  GoalHistoryEntry,
  LinkType,
  RatchetApi,
  CreateClickRequest,
  ConcludeClickRequest,
  DropClickRequest,
  ReparentClickRequest,
  AmendClickRequest,
  LinkClickRequest,
  UnlinkClickRequest,
  ExtractClickRequest,
  TreeParams,
} from './types.ts';

import {
  clickCreate,
  clickShow,
  clickList,
  clickPark,
  clickResume,
  clickConclude,
  clickDrop,
  clickAmend,
  clickReparent,
  clickLink,
  clickUnlink,
  clickExtract,
  clickTree,
} from './tools/index.ts';

// ── Status machine ──────────────────────────────────────────────────

const ALLOWED_FROM: Record<ClickStatus, ClickStatus[]> = {
  live:      ['parked'],
  parked:    ['live'],
  concluded: ['live', 'parked'],
  dropped:   ['live', 'parked'],
};

const TERMINAL_STATUSES = new Set<ClickStatus>(['concluded', 'dropped']);

const VALID_LINK_TYPES = new Set<string>(['related', 'commissioned', 'supersedes', 'depends-on']);

// ── Factory ─────────────────────────────────────────────────────────

export function createRatchet(): Plugin {
  let stacks: StacksApi;
  let clicks: Book<ClickDoc>;
  let clickLinks: Book<ClickLinkDoc>;

  // ── Helpers ─────────────────────────────────────────────────────

  function validateTransition(click: ClickDoc, target: ClickStatus): void {
    const allowed = ALLOWED_FROM[target];
    if (!allowed || !allowed.includes(click.status)) {
      throw new Error(
        `Cannot transition click "${click.id}" to "${target}": status is "${click.status}", expected one of: ${allowed?.join(', ') ?? 'none'}.`,
      );
    }
  }

  function buildWhereClause(filters?: ClickFilters): WhereClause | { or: WhereClause[] } | undefined {
    if (!filters) return undefined;
    const clauses: WhereClause = [];

    if (filters.status !== undefined) {
      if (Array.isArray(filters.status)) {
        if (filters.status.length === 1) {
          clauses.push(['status', '=', filters.status[0]]);
        } else if (filters.status.length > 1) {
          return {
            or: filters.status.map((s) => {
              const c: WhereClause = [['status', '=', s]];
              if (filters.parentId !== undefined) c.push(['parentId', '=', filters.parentId]);
              return c;
            }),
          };
        }
      } else {
        clauses.push(['status', '=', filters.status]);
      }
    }

    if (filters.parentId !== undefined) {
      clauses.push(['parentId', '=', filters.parentId]);
    }

    return clauses.length > 0 ? clauses : undefined;
  }

  /**
   * Build a ClickTree recursively. Supports optional status filtering
   * (prune semantics — filtered nodes and their subtrees are removed)
   * and depth limiting.
   */
  async function buildTree(
    clickId: string,
    options?: { statusSet?: Set<ClickStatus>; depth?: number; currentDepth?: number },
  ): Promise<ClickTree | null> {
    const click = await api.get(clickId);
    const statusSet = options?.statusSet;
    const maxDepth = options?.depth;
    const currentDepth = options?.currentDepth ?? 0;

    // Prune: if this node doesn't match the status filter, drop it and its subtree
    if (statusSet && !statusSet.has(click.status)) {
      return null;
    }

    // Depth limit: include this node but don't recurse into children
    if (maxDepth !== undefined && currentDepth >= maxDepth) {
      return { click, children: [] };
    }

    const children = await clicks.find({ where: [['parentId', '=', clickId]] });
    const childTrees: ClickTree[] = [];
    // Sort children by createdAt ascending
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const child of children) {
      const childTree = await buildTree(child.id, {
        statusSet,
        depth: maxDepth,
        currentDepth: currentDepth + 1,
      });
      if (childTree) childTrees.push(childTree);
    }
    return { click, children: childTrees };
  }

  /**
   * Recursively collect all descendant IDs of a given click.
   */
  async function collectDescendantIds(clickId: string): Promise<string[]> {
    const children = await clicks.find({ where: [['parentId', '=', clickId]] });
    const ids: string[] = [clickId];
    for (const child of children) {
      const childIds = await collectDescendantIds(child.id);
      ids.push(...childIds);
    }
    return ids;
  }

  function renderMarkdown(tree: ClickTree, depth: number = 0, full: boolean = true): string {
    const lines: string[] = [];
    const click = tree.click;

    // Heading or bold
    if (depth <= 5) {
      const prefix = '#'.repeat(depth + 1);
      lines.push(`${prefix} ${click.id} [${click.status}]`);
    } else {
      lines.push(`**${click.id} [${click.status}]**`);
    }

    lines.push(`> ${click.goal}`);
    lines.push(`Status: ${click.status}`);
    if (full && click.conclusion !== undefined) lines.push(`Conclusion: ${click.conclusion}`);
    if (click.createdSessionId !== undefined) lines.push(`Created by: ${click.createdSessionId}`);
    if (click.resolvedSessionId !== undefined) lines.push(`Resolved by: ${click.resolvedSessionId}`);
    lines.push(`Created: ${click.createdAt}`);
    if (click.resolvedAt !== undefined) lines.push(`Resolved: ${click.resolvedAt}`);

    for (const child of tree.children) {
      lines.push('');
      lines.push(renderMarkdown(child, depth + 1, full));
    }

    return lines.join('\n');
  }

  /**
   * Strip conclusion fields from a ClickTree for goals-only JSON output.
   */
  function stripConclusions(tree: ClickTree): ClickTree {
    const { conclusion: _, ...clickWithout } = tree.click;
    return {
      click: clickWithout as ClickDoc,
      children: tree.children.map(stripConclusions),
    };
  }

  // ── API ─────────────────────────────────────────────────────────

  const api: RatchetApi = {
    async create(params: CreateClickRequest): Promise<ClickDoc> {
      const id = generateId('c', 6);
      const doc: ClickDoc = {
        id,
        goal: params.goal,
        status: 'live',
        createdAt: new Date().toISOString(),
        parentId: params.parentId,
        createdSessionId: params.createdSessionId,
      };

      if (params.parentId) {
        await stacks.transaction(async (tx) => {
          const txClicks = tx.book<ClickDoc>('ratchet', 'clicks');
          const parent = await txClicks.get(params.parentId!);
          if (!parent) throw new Error(`Click "${params.parentId}" not found.`);
          await txClicks.put(doc);
        });
      } else {
        await clicks.put(doc);
      }

      return doc;
    },

    async get(id: string): Promise<ClickDoc> {
      const click = await clicks.get(id);
      if (!click) throw new Error(`Click "${id}" not found.`);
      return click;
    },

    async list(filters?: ClickFilters): Promise<ClickDoc[]> {
      // rootId: recursively collect descendants, then apply remaining filters
      if (filters?.rootId) {
        const allDescendantIds = await collectDescendantIds(filters.rootId);
        // Remove the root itself — rootId means "descendants of", not "including"
        const descendantIds = allDescendantIds.slice(1);
        if (descendantIds.length === 0) return [];

        // Fetch all descendants, then filter in-memory
        const allDescendants: ClickDoc[] = [];
        for (const did of descendantIds) {
          try {
            const doc = await clicks.get(did);
            if (doc) allDescendants.push(doc);
          } catch {
            // skip missing
          }
        }

        // Apply status filter
        let filtered = allDescendants;
        if (filters.status) {
          const statusArr = Array.isArray(filters.status) ? filters.status : [filters.status];
          const statusSet = new Set(statusArr);
          filtered = filtered.filter((c) => statusSet.has(c.status));
        }

        // Sort by createdAt descending
        filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        // Apply offset and limit
        const offset = filters.offset ?? 0;
        const limit = filters.limit ?? 20;
        return filtered.slice(offset, offset + limit);
      }

      const limit = filters?.limit ?? 20;
      const offset = filters?.offset;
      const where = buildWhereClause(filters);

      return clicks.find({
        where: where as WhereClause,
        limit,
        offset,
        orderBy: [['createdAt', 'desc']],
      });
    },

    async park(id: string): Promise<ClickDoc> {
      const click = await api.get(id);
      validateTransition(click, 'parked');
      return clicks.patch(id, { status: 'parked' });
    },

    async resume(id: string): Promise<ClickDoc> {
      const click = await api.get(id);
      validateTransition(click, 'live');
      return clicks.patch(id, { status: 'live' });
    },

    async conclude(id: string, params: ConcludeClickRequest): Promise<ClickDoc> {
      if (!params.conclusion || params.conclusion.trim() === '') {
        throw new Error('Conclusion must be a non-empty string.');
      }
      const click = await api.get(id);
      validateTransition(click, 'concluded');
      if (click.conclusion !== undefined) {
        throw new Error(`Click "${id}" already has a conclusion set.`);
      }
      const patch: Partial<ClickDoc> = {
        status: 'concluded',
        conclusion: params.conclusion,
        resolvedAt: new Date().toISOString(),
      };
      if (params.resolvedSessionId) {
        patch.resolvedSessionId = params.resolvedSessionId;
      }
      return clicks.patch(id, patch);
    },

    async drop(id: string, params: DropClickRequest): Promise<ClickDoc> {
      if (!params.conclusion || params.conclusion.trim() === '') {
        throw new Error('Conclusion must be a non-empty string.');
      }
      const click = await api.get(id);
      validateTransition(click, 'dropped');
      if (click.conclusion !== undefined) {
        throw new Error(`Click "${id}" already has a conclusion set.`);
      }
      const patch: Partial<ClickDoc> = {
        status: 'dropped',
        conclusion: params.conclusion,
        resolvedAt: new Date().toISOString(),
      };
      if (params.resolvedSessionId) {
        patch.resolvedSessionId = params.resolvedSessionId;
      }
      return clicks.patch(id, patch);
    },

    async amend(id: string, params: AmendClickRequest): Promise<ClickDoc> {
      return stacks.transaction(async (tx) => {
        const txClicks = tx.book<ClickDoc>('ratchet', 'clicks');

        const click = await txClicks.get(id);
        if (!click) throw new Error(`Click "${id}" not found.`);

        if (click.status !== 'live') {
          throw new Error(
            `Cannot amend click "${id}": status is "${click.status}", expected "live". ` +
            `Amend is only permitted while the click is live.`,
          );
        }

        if (params.goal === undefined || params.goal === null || params.goal.trim() === '') {
          throw new Error('Amended goal must be a non-empty string.');
        }

        // Strict-equality no-op: no history entry, no patch, return as-is.
        if (params.goal === click.goal) {
          return click;
        }

        const entry: GoalHistoryEntry = {
          goal: click.goal,
          amendedAt: new Date().toISOString(),
        };
        if (params.sessionId) {
          entry.sessionId = params.sessionId;
        }

        const existingHistory = Array.isArray(click.goalHistory) ? click.goalHistory : [];
        const nextHistory: GoalHistoryEntry[] = [...existingHistory, entry];

        await txClicks.patch(id, {
          goal: params.goal,
          goalHistory: nextHistory,
        });
        const updated = await txClicks.get(id);
        return updated!;
      });
    },

    async reparent(id: string, params: ReparentClickRequest): Promise<ClickDoc> {
      if (params.parentId === null || params.parentId === undefined) {
        // Move to root
        return clicks.patch(id, { parentId: undefined });
      }

      const newParentId = params.parentId;
      return stacks.transaction(async (tx) => {
        const txClicks = tx.book<ClickDoc>('ratchet', 'clicks');

        const click = await txClicks.get(id);
        if (!click) throw new Error(`Click "${id}" not found.`);

        const parent = await txClicks.get(newParentId);
        if (!parent) throw new Error(`Click "${newParentId}" not found.`);

        // Walk ancestor chain to detect circular parentage
        let current: ClickDoc | null = parent;
        while (current && current.parentId) {
          if (current.parentId === id) {
            throw new Error(`Cannot reparent click "${id}" under "${newParentId}": circular parentage detected.`);
          }
          current = await txClicks.get(current.parentId);
        }

        // Also check if the new parent IS the click being reparented
        if (newParentId === id) {
          throw new Error(`Cannot reparent click "${id}" under "${newParentId}": circular parentage detected.`);
        }

        await txClicks.patch(id, { parentId: newParentId });
        const updated = await txClicks.get(id);
        return updated!;
      });
    },

    async link(params: LinkClickRequest): Promise<ClickLinkDoc> {
      if (!VALID_LINK_TYPES.has(params.linkType)) {
        throw new Error(`Invalid link type "${params.linkType}". Must be one of: related, commissioned, supersedes, depends-on.`);
      }
      if (params.sourceId === params.targetId) {
        throw new Error(`Cannot link a click to itself: "${params.sourceId}".`);
      }

      const sourceIsClick = params.sourceId.startsWith('c-');
      const targetIsClick = params.targetId.startsWith('c-');

      // Same-substrate: validate both exist
      if (sourceIsClick && targetIsClick) {
        const [source, target] = await Promise.all([
          clicks.get(params.sourceId),
          clicks.get(params.targetId),
        ]);
        if (!source) throw new Error(`Click "${params.sourceId}" not found.`);
        if (!target) throw new Error(`Click "${params.targetId}" not found.`);
      } else if (sourceIsClick) {
        // Cross-substrate: validate source click exists
        const source = await clicks.get(params.sourceId);
        if (!source) throw new Error(`Click "${params.sourceId}" not found.`);
      }

      const compositeId = `${params.sourceId}:${params.targetId}:${params.linkType}`;

      // Idempotent check
      const existing = await clickLinks.get(compositeId);
      if (existing) return existing;

      const doc: ClickLinkDoc = {
        id: compositeId,
        sourceId: params.sourceId,
        targetId: params.targetId,
        linkType: params.linkType as ClickLinkDoc['linkType'],
        createdAt: new Date().toISOString(),
      };
      await clickLinks.put(doc);
      return doc;
    },

    async unlink(params: UnlinkClickRequest): Promise<void> {
      const compositeId = `${params.sourceId}:${params.targetId}:${params.linkType}`;
      const existing = await clickLinks.get(compositeId);
      if (!existing) throw new Error(`Link "${compositeId}" not found.`);
      await clickLinks.delete(compositeId);
    },

    async extract(rootId: string, params: ExtractClickRequest): Promise<string | ClickTree> {
      const tree = await buildTree(rootId);
      if (tree === null) throw new Error(`Click "${rootId}" not found.`);
      const full = params.full ?? false;
      if (params.format === 'json') {
        return full ? tree : stripConclusions(tree);
      }
      return renderMarkdown(tree, 0, full);
    },

    async tree(params?: TreeParams): Promise<ClickTree[]> {
      const statusSet = params?.status
        ? new Set(Array.isArray(params.status) ? params.status : [params.status])
        : undefined;
      const opts = { statusSet, depth: params?.depth };

      if (params?.rootId) {
        const tree = await buildTree(params.rootId, opts);
        return tree ? [tree] : [];
      }

      // Forest mode: find all root clicks (no parentId).
      // Fetch all and filter — querying parentId = undefined is unreliable
      // across backends (SQLite stores absent fields differently from
      // MemoryBackend).
      const all = await clicks.find({
        orderBy: [['createdAt', 'asc']],
        limit: 10000,
      });
      const rootDocs = all.filter((c) => !c.parentId);

      const forest: ClickTree[] = [];
      for (const root of rootDocs) {
        const tree = await buildTree(root.id, opts);
        if (tree) forest.push(tree);
      }
      return forest;
    },

    async resolveId(prefix: string): Promise<string> {
      const results = await clicks.find({ where: [['id', 'LIKE', prefix + '%']] });
      if (results.length === 0) {
        throw new Error(`No click found matching prefix "${prefix}".`);
      }
      if (results.length > 1) {
        throw new Error(`Ambiguous prefix "${prefix}": matches ${results.length} clicks.`);
      }
      return results[0].id;
    },

    async links(clickId: string): Promise<ClickLinks> {
      const [outbound, inbound] = await Promise.all([
        clickLinks.find({ where: [['sourceId', '=', clickId]] }),
        clickLinks.find({ where: [['targetId', '=', clickId]] }),
      ]);
      return { outbound, inbound };
    },
  };

  // ── Plugin ────────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['oculus'],

      supportKit: {
        books: {
          clicks: {
            indexes: ['status', 'createdAt', 'parentId', ['status', 'createdAt'], ['parentId', 'status']],
          },
          click_links: {
            indexes: ['sourceId', 'targetId', 'linkType', ['sourceId', 'linkType'], ['targetId', 'linkType']],
          },
        },
        tools: [
          clickCreate,
          clickShow,
          clickList,
          clickPark,
          clickResume,
          clickConclude,
          clickDrop,
          clickAmend,
          clickReparent,
          clickLink,
          clickUnlink,
          clickExtract,
          clickTree,
        ],
        pages: [
          { id: 'clicks', title: 'Clicks', dir: 'pages/clicks' },
        ],
      },

      provides: api,

      async start(_ctx: StartupContext): Promise<void> {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        clicks = stacks.book<ClickDoc>('ratchet', 'clicks');
        clickLinks = stacks.book<ClickLinkDoc>('ratchet', 'click_links');
      },
    },
  };
}

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type { StacksApi, Book, WhereClause } from '@shardworks/stacks-apparatus';

import { shortId } from '@shardworks/nexus-core';

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
  SupersedeRef,
  CreateClickRequest,
  ConcludeClickRequest,
  DropClickRequest,
  ReparentClickRequest,
  AmendClickRequest,
  SupersedeClickRequest,
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
  clickSupersede,
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
   * and depth limiting. Every returned node is enriched with supersede
   * refs (`supersededBy` / `supersedes`) derived from the `click_links`
   * book — these are parentage-independent, so a superseder living
   * outside the rendered scope still appears on the host node.
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

    // Build the node (with or without recursion into children).
    let childTrees: ClickTree[] = [];
    if (maxDepth === undefined || currentDepth < maxDepth) {
      const children = await clicks.find({ where: [['parentId', '=', clickId]] });
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
    }

    const node: ClickTree = { click, children: childTrees };
    await attachSupersedeRefs(node);
    return node;
  }

  /**
   * Attach supersede-link enrichment to a ClickTree node. Reads from
   * `click_links` directly (not `api.links()`), filtered to `supersedes`,
   * so this runs without needing a broader fetch. Populates fields only
   * when the corresponding edges exist — absence is the signal to the
   * renderer that no supersede lines should be emitted.
   *
   * Outbound (`supersedes`) is one hop per edge: each ref names the
   * immediate predecessor the host supersedes. Inbound (`supersededBy`)
   * is chain-walked per D7 — one ref per immediate inbound superseder,
   * each with its own visited-set traversal to the terminal (cycle
   * re-entry and multi-inbound branches both halt the walk).
   *
   * Missing refs (target or mid-chain node unfetchable) surface as
   * `{ id, goal: null }` so the renderer can emit a `<missing>` marker
   * without aborting the whole command (D8).
   */
  async function attachSupersedeRefs(node: ClickTree): Promise<void> {
    const clickId = node.click.id;

    const [outboundLinks, inboundLinks] = await Promise.all([
      clickLinks.find({
        where: [['sourceId', '=', clickId], ['linkType', '=', 'supersedes']],
        orderBy: [['createdAt', 'asc']],
      }),
      clickLinks.find({
        where: [['targetId', '=', clickId], ['linkType', '=', 'supersedes']],
        orderBy: [['createdAt', 'asc']],
      }),
    ]);

    if (outboundLinks.length > 0) {
      const out: SupersedeRef[] = [];
      for (const link of outboundLinks) {
        const target = await tryGetClick(link.targetId);
        out.push({ id: link.targetId, goal: target ? target.goal : null });
      }
      node.supersedes = out;
    }

    if (inboundLinks.length > 0) {
      const inb: SupersedeRef[] = [];
      for (const link of inboundLinks) {
        const ref = await walkInboundSupersedeChain(link.sourceId, clickId);
        inb.push(ref);
      }
      node.supersededBy = inb;
    }
  }

  /**
   * Walk the inbound supersede chain starting at `startId` (the immediate
   * superseder of `hostId`). Returns a `SupersedeRef` whose `id` is the
   * terminal superseder, `goal` is the terminal's goal text (or `null` if
   * unfetchable), and `chain` lists the intermediate full-ids passed
   * through between `startId` (exclusive of terminal) and the terminal
   * itself. An empty `chain` means `startId` is the terminal (1-hop).
   *
   * Halts per D7:
   *   - current node has zero inbound supersedes (natural terminal)
   *   - current node has multiple inbound supersedes (branch — stop and
   *     let the reader drill in)
   *   - the single inbound's source is already visited (cycle)
   *
   * The visited set is seeded with `hostId` so a direct A ← B ← A cycle
   * halts immediately without infinite loop (matching `reparent()`'s
   * ancestor-walk pattern).
   */
  async function walkInboundSupersedeChain(startId: string, hostId: string): Promise<SupersedeRef> {
    const visited = new Set<string>([hostId, startId]);
    const chain: string[] = [];
    let currentId = startId;

    // Bound defensively against any pathological data — the visited-set
    // already breaks cycles, but a very long legitimate chain shouldn't
    // run unbounded either. In practice supersede chains are short.
    const MAX_HOPS = 1000;
    for (let i = 0; i < MAX_HOPS; i++) {
      const inbounds = await clickLinks.find({
        where: [['targetId', '=', currentId], ['linkType', '=', 'supersedes']],
      });
      if (inbounds.length !== 1) break;
      const nextId = inbounds[0].sourceId;
      if (visited.has(nextId)) break;
      chain.push(currentId);
      currentId = nextId;
      visited.add(currentId);
    }

    const terminal = await tryGetClick(currentId);
    return {
      id: currentId,
      goal: terminal ? terminal.goal : null,
      chain,
    };
  }

  /**
   * Fetch a click by id without throwing. Used by supersede enrichment
   * so a broken link (target deleted, cross-substrate reference, etc.)
   * surfaces as a `<missing>` placeholder rather than aborting the
   * tree/extract command.
   */
  async function tryGetClick(id: string): Promise<ClickDoc | null> {
    try {
      return await clicks.get(id);
    } catch {
      return null;
    }
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

  /**
   * Format one inbound `supersededBy` ref as the right-hand side of a
   * `Superseded by:` line — the walked chain of intermediate short-ids,
   * an arrow into the terminal short-id, and the terminal's quoted goal
   * snippet (or a `<missing>` marker when the terminal's goal is
   * unavailable — D8).
   */
  function formatInboundSupersedeRef(ref: SupersedeRef): string {
    const chain = ref.chain ?? [];
    const intermediateShorts = chain.map((id) => shortId(id));
    const terminalShort = shortId(ref.id);
    const idChain = [...intermediateShorts, terminalShort].join(' → ');
    if (ref.goal === null) {
      return `${idChain} <missing>`;
    }
    return `${idChain} "${ref.goal}"`;
  }

  /**
   * Format one outbound `supersedes` ref as the right-hand side of a
   * `Supersedes:` line — short-id and quoted goal snippet (or a
   * `<missing>` marker when the target is unfetchable — D8).
   */
  function formatOutboundSupersedeRef(ref: SupersedeRef): string {
    const short = shortId(ref.id);
    if (ref.goal === null) {
      return `${short} <missing>`;
    }
    return `${short} "${ref.goal}"`;
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

    // Supersede lines (D4) sit immediately after Conclusion (when present)
    // or Status (when no conclusion), before the Created/Resolved metadata
    // tail. Inbound first (what supersedes this click — the forward
    // pointer most readers need), then outbound (what this click
    // supersedes). Absence of supersede edges produces no lines, so
    // output stays byte-identical for unaffected clicks.
    if (tree.supersededBy && tree.supersededBy.length > 0) {
      for (const ref of tree.supersededBy) {
        lines.push(`Superseded by: ${formatInboundSupersedeRef(ref)}`);
      }
    }
    if (tree.supersedes && tree.supersedes.length > 0) {
      for (const ref of tree.supersedes) {
        lines.push(`Supersedes: ${formatOutboundSupersedeRef(ref)}`);
      }
    }

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
   * Supersede enrichment fields (`supersededBy`, `supersedes`) are
   * computed container fields and carry through untouched — per D9 both
   * JSON surfaces expose them.
   */
  function stripConclusions(tree: ClickTree): ClickTree {
    const { conclusion: _, ...clickWithout } = tree.click;
    const stripped: ClickTree = {
      click: clickWithout as ClickDoc,
      children: tree.children.map(stripConclusions),
    };
    if (tree.supersededBy !== undefined) stripped.supersededBy = tree.supersededBy;
    if (tree.supersedes !== undefined) stripped.supersedes = tree.supersedes;
    return stripped;
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
          const base = `Cannot amend click "${id}": status is "${click.status}", expected "live".`;
          // Terminal-status targets (concluded / dropped) point at the canonical
          // post-conclusion correction tool. Parked clicks resume → amend, so
          // their message stays focused on the live-only rule.
          const suffix = TERMINAL_STATUSES.has(click.status)
            ? ` Amend is sealed once a click is concluded or dropped. ` +
              `Use \`nsg click supersede\` to create a replacement click and link it to this one.`
            : ` Amend is only permitted while the click is live.`;
          throw new Error(base + suffix);
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

    async supersede(
      targetId: string,
      params: SupersedeClickRequest,
    ): Promise<{ click: ClickDoc; link: ClickLinkDoc }> {
      // Target-id validation (D9): reject non-`c-` ids at the sugar boundary.
      if (!targetId.startsWith('c-')) {
        throw new Error(
          `Cannot supersede "${targetId}": target must be a click id (must start with "c-").`,
        );
      }

      if (params.goal === undefined || params.goal === null || params.goal.trim() === '') {
        throw new Error('Goal must be a non-empty string.');
      }

      return stacks.transaction(async (tx) => {
        const txClicks = tx.book<ClickDoc>('ratchet', 'clicks');
        const txClickLinks = tx.book<ClickLinkDoc>('ratchet', 'click_links');

        // Validate target exists. Status is deliberately not checked (D6).
        const target = await txClicks.get(targetId);
        if (!target) throw new Error(`Click "${targetId}" not found.`);

        // Validate parent, if supplied. Mirrors `create()`'s behavior.
        if (params.parentId) {
          const parent = await txClicks.get(params.parentId);
          if (!parent) throw new Error(`Click "${params.parentId}" not found.`);
        }

        const newId = generateId('c', 6);
        const clickDoc: ClickDoc = {
          id: newId,
          goal: params.goal,
          status: 'live',
          createdAt: new Date().toISOString(),
          parentId: params.parentId,
          createdSessionId: params.createdSessionId,
        };
        await txClicks.put(clickDoc);

        const linkType: LinkType = 'supersedes';
        const compositeId = `${newId}:${targetId}:${linkType}`;
        const linkDoc: ClickLinkDoc = {
          id: compositeId,
          sourceId: newId,
          targetId,
          linkType,
          createdAt: new Date().toISOString(),
        };
        await txClickLinks.put(linkDoc);

        return { click: clickDoc, link: linkDoc };
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

    async countDescendantsByStatus(clickId: string): Promise<Record<ClickStatus, number>> {
      // Validate the root exists up front for a clear error on unknown ids.
      const root = await clicks.get(clickId);
      if (!root) throw new Error(`Click "${clickId}" not found.`);

      // Reuse the existing collectDescendantIds traversal machinery rather
      // than writing a third walker — one fetch path per apparatus. The
      // helper's first element is the root itself (by convention — see
      // ClickFilters.rootId), so slice(1) drops it to return descendants only.
      const allIds = await collectDescendantIds(clickId);
      const descendantIds = allIds.slice(1);

      const counts: Record<ClickStatus, number> = {} as Record<ClickStatus, number>;
      for (const id of descendantIds) {
        const doc = await clicks.get(id);
        if (!doc) continue;
        counts[doc.status] = (counts[doc.status] ?? 0) + 1;
      }
      return counts;
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
          clickSupersede,
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

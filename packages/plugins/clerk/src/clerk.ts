/**
 * The Clerk — writ lifecycle management apparatus.
 *
 * The Clerk manages the lifecycle of writs: lightweight work orders that flow
 * through a fixed status machine (new → open → completed/failed/cancelled,
 * with stuck as a non-terminal "needs attention" state off open).
 * Each writ has a type, a title, a body, and optional codex and resolution
 * fields.
 *
 * Writ types are validated against the guild config's writTypes field plus the
 * built-in type ('mandate'). An unknown type is rejected at post time.
 * Kits may also contribute writ types via their writTypes field.
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi, Book, WhereClause } from '@shardworks/stacks-apparatus';

import type {
  ClerkApi,
  ClerkConfig,
  WritDoc,
  WritLinkDoc,
  WritLinks,
  WritStatus,
  WritTypeInfo,
  PostCommissionRequest,
  EditWritRequest,
  WritFilters,
  WritTypeEntry,
  MeaningEntry,
  MeaningDoc,
} from './types.ts';

import {
  commissionPost,
  pieceAdd,
  writShow,
  writList,
  writEdit,
  writComplete,
  writFail,
  writCancel,
  writPublish,
  writLink,
  writUnlink,
  writLinkMeanings,
  writLinkMeaningsShow,
} from './tools/index.ts';

import { normalizeLinkType } from './link-normalize.ts';

// ── Kit contribution interface ────────────────────────────────────────

/** Kit contribution interface for the Clerk's writ type system. */
export interface ClerkKit {
  /** Writ type descriptors to register with the Clerk. Names are unqualified. */
  writTypes?: WritTypeEntry[];
  /**
   * Link-meaning descriptors to register with the Clerk. Meaning ids must be
   * prefixed with the contributing plugin id (e.g. `astrolabe:refines`).
   * Kit authors supply `{ id, description }`; the registry-projection view
   * (returned by `listMeanings()`) embeds the resolved owner plugin id on
   * each record as `ownerPlugin`.
   */
  linkMeanings?: MeaningEntry[];
}

// ── Built-in writ types ──────────────────────────────────────────────

const BUILTIN_TYPES = new Set(['mandate']);

// ── Cascade resolution constants ─────────────────────────────────────

/**
 * Resolution string applied to non-terminal children that are cancelled by
 * the downward cascade when their parent transitions to a terminal failure
 * or cancellation status. Single source of truth — referenced by code,
 * tests, and documentation. Modeled on `PIECE_EXECUTION_EPILOGUE` in the
 * Spider plugin.
 */
export const CASCADE_PARENT_TERMINATION_RESOLUTION =
  'Automatically cancelled due to parent termination';

// ── Status machine ───────────────────────────────────────────────────

const ALLOWED_FROM: Record<WritStatus, WritStatus[]> = {
  open: ['new', 'stuck'],
  stuck: ['open'],
  completed: ['open'],
  failed: ['open', 'stuck'],
  cancelled: ['new', 'open', 'stuck'],
  new: [],
};

const TERMINAL_STATUSES = new Set<WritStatus>(['completed', 'failed', 'cancelled']);

// ── Factory ──────────────────────────────────────────────────────────

/** Parent statuses that allow adding children. */
const CHILD_ALLOWED_PARENT_STATUSES = new Set<WritStatus>(['new', 'open', 'stuck']);

export function createClerk(): Plugin {
  let stacks: StacksApi;
  let writs: Book<WritDoc>;
  let links: Book<WritLinkDoc>;

  /** Internal metadata stored per writ type. */
  interface WritTypeMeta {
    description?: string;
    source: string;
  }

  /** Merged map of valid writ type names to metadata: builtins + config + kit contributions. */
  let mergedWritTypes: Map<string, WritTypeMeta> = new Map(
    [...BUILTIN_TYPES].map((name) => [name, { source: 'builtin' }]),
  );

  /** Config-declared writ type names, for override checking during kit registration. */
  let configWritTypeNames: Set<string> = new Set();

  /** Internal metadata stored per registered link meaning. */
  interface MeaningMeta {
    ownerPlugin: string;
    description: string;
  }

  /** Registry of kit-contributed link meanings, keyed by meaning id. */
  let linkMeaningRegistry: Map<string, MeaningMeta> = new Map();

  /**
   * Grammar for meaning-id suffixes after the `{pluginId}:` prefix.
   *
   * Kebab-case only: lowercase letters, digits, and hyphens. Must not start
   * or end with a hyphen and must have at least one character.
   */
  const MEANING_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  // ── Helpers ──────────────────────────────────────────────────────

  function resolveClerkConfig(): ClerkConfig {
    return guild().guildConfig().clerk ?? {};
  }

  function resolveWritTypes(): Map<string, WritTypeMeta> {
    return mergedWritTypes;
  }

  function resolveDefaultType(): string {
    const config = resolveClerkConfig();
    return config.defaultType ?? 'mandate';
  }

  function buildWhereClause(filters?: WritFilters): WhereClause | undefined {
    const conditions: WhereClause = [];
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length === 1) {
        conditions.push(['status', '=', statuses[0]!]);
      } else if (statuses.length > 1) {
        conditions.push(['status', 'IN', statuses]);
      }
    }
    if (filters?.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      if (types.length === 1) {
        conditions.push(['type', '=', types[0]!]);
      } else if (types.length > 1) {
        conditions.push(['type', 'IN', types]);
      }
    }
    if (filters?.parentId) {
      conditions.push(['parentId', '=', filters.parentId]);
    }
    return conditions.length > 0 ? conditions : undefined;
  }

  function registerKitWritTypes(kitEntry: { pluginId: string; value: unknown }): void {
    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) return;

    for (const entry of raw) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>).name !== 'string'
      ) {
        console.warn(
          `[clerk] Kit "${pluginId}" writTypes: entry is missing required "name" field — skipped`
        );
        continue;
      }
      const name = (entry as WritTypeEntry).name;

      // Config override: skip silently
      if (configWritTypeNames.has(name)) continue;

      // Duplicate kit contribution: first wins, warn
      if (mergedWritTypes.has(name)) {
        console.warn(
          `[clerk] Kit "${pluginId}" writTypes: type "${name}" already registered by another kit — skipped`
        );
        continue;
      }

      mergedWritTypes.set(name, {
        description: (entry as WritTypeEntry).description,
        source: pluginId,
      });
    }
  }

  function registerKitLinkMeanings(kitEntry: { pluginId: string; value: unknown }): void {
    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[clerk] Kit "${pluginId}" linkMeanings: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      const description = rec.description;

      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry is missing a non-empty string "id" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry "${id}" is missing a non-empty string "description" field.`,
        );
      }

      const colonIdx = id.indexOf(':');
      if (colonIdx <= 0 || colonIdx === id.length - 1) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry "${id}" must be of the form "{pluginId}:{kebab-suffix}".`,
        );
      }
      const prefix = id.slice(0, colonIdx);
      const suffix = id.slice(colonIdx + 1);

      if (prefix !== pluginId) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry "${id}" has prefix "${prefix}" but must match the contributing plugin id "${pluginId}".`,
        );
      }

      if (!MEANING_SUFFIX_RE.test(suffix)) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: entry "${id}" suffix "${suffix}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      if (linkMeaningRegistry.has(id)) {
        const existing = linkMeaningRegistry.get(id)!;
        throw new Error(
          `[clerk] Kit "${pluginId}" linkMeanings: duplicate meaning id "${id}" — already registered by kit "${existing.ownerPlugin}".`,
        );
      }

      linkMeaningRegistry.set(id, {
        ownerPlugin: pluginId,
        description,
      });
    }
  }

  // ── API ──────────────────────────────────────────────────────────

  const api: ClerkApi = {
    async post(request: PostCommissionRequest): Promise<WritDoc> {
      const type = request.type ?? resolveDefaultType();
      const validTypes = resolveWritTypes();

      if (!validTypes.has(type)) {
        throw new Error(
          `Unknown writ type "${type}". Declared types: ${[...validTypes.keys()].join(', ')}.`,
        );
      }

      const now = new Date().toISOString();
      const childId = generateId('w', 6);

      // Determine codex: explicit request > parent inheritance > undefined
      let codex = request.codex;

      if (request.parentId) {
        // Wrap in a transaction for atomicity
        return stacks.transaction(async (tx) => {
          const txWrits = tx.book<WritDoc>('clerk', 'writs');

          // Validate parent exists and is in an allowed status
          const parent = await txWrits.get(request.parentId!);
          if (!parent) {
            throw new Error(`Parent writ "${request.parentId}" not found.`);
          }
          if (!CHILD_ALLOWED_PARENT_STATUSES.has(parent.status)) {
            throw new Error(
              `Cannot add children to writ "${request.parentId}": status is "${parent.status}", expected one of: ${[...CHILD_ALLOWED_PARENT_STATUSES].join(', ')}.`,
            );
          }

          // Defensive self-parenting check
          if (request.parentId === childId) {
            throw new Error(`Cannot create a writ as its own parent.`);
          }

          // Inherit codex from parent if not specified
          if (codex === undefined && parent.codex !== undefined) {
            codex = parent.codex;
          }

          const writ: WritDoc = {
            id: childId,
            type,
            status: request.draft === true ? 'new' : 'open',
            title: request.title,
            body: request.body,
            ...(codex !== undefined ? { codex } : {}),
            parentId: request.parentId,
            createdAt: now,
            updatedAt: now,
          };

          await txWrits.put(writ);

          return writ;
        });
      }

      const writ: WritDoc = {
        id: childId,
        type,
        status: request.draft === true ? 'new' : 'open',
        title: request.title,
        body: request.body,
        ...(codex !== undefined ? { codex } : {}),
        createdAt: now,
        updatedAt: now,
      };

      await writs.put(writ);
      return writ;
    },

    async show(id: string): Promise<WritDoc> {
      const writ = await writs.get(id);
      if (!writ) {
        throw new Error(`Writ "${id}" not found.`);
      }
      return writ;
    },

    async resolveId(prefix: string): Promise<string> {
      // Exact-match fast path — avoids LIKE scans for full ids.
      const exact = await writs.get(prefix);
      if (exact) return exact.id;

      const results = await writs.find({ where: [['id', 'LIKE', prefix + '%']] });
      if (results.length === 0) {
        throw new Error(`No writ found matching prefix "${prefix}".`);
      }
      if (results.length > 1) {
        throw new Error(`Ambiguous prefix "${prefix}": matches ${results.length} writs.`);
      }
      return results[0].id;
    },

    async list(filters?: WritFilters): Promise<WritDoc[]> {
      const where = buildWhereClause(filters);
      const limit = filters?.limit ?? 20;
      const offset = filters?.offset;

      return writs.find({
        where,
        orderBy: ['createdAt', 'desc'],
        limit,
        ...(offset !== undefined ? { offset } : {}),
      });
    },

    async count(filters?: WritFilters): Promise<number> {
      const where = buildWhereClause(filters);
      return writs.count(where);
    },

    async link(
      sourceId: string,
      targetId: string,
      type: string,
      semanticMeaning?: string,
    ): Promise<WritLinkDoc> {
      if (sourceId === targetId) {
        throw new Error(`Cannot link a writ to itself: "${sourceId}".`);
      }

      // D2: normalize first, then reject empty canonical form. An all-
      // whitespace input canonicalizes to '' and is rejected here.
      const normalizedType = normalizeLinkType(type);
      if (!normalizedType) {
        throw new Error('Link type must be a non-empty string.');
      }

      // If a semanticMeaning was supplied, validate it against the registry
      // before touching the store.
      if (semanticMeaning !== undefined) {
        if (!linkMeaningRegistry.has(semanticMeaning)) {
          throw new Error(
            `Unknown semanticMeaning "${semanticMeaning}". Registered meanings: ${
              linkMeaningRegistry.size === 0
                ? '(none)'
                : [...linkMeaningRegistry.keys()].join(', ')
            }.`,
          );
        }
      }

      const source = await writs.get(sourceId);
      if (!source) {
        throw new Error(`Writ "${sourceId}" not found.`);
      }
      const target = await writs.get(targetId);
      if (!target) {
        throw new Error(`Writ "${targetId}" not found.`);
      }

      const id = `${sourceId}:${targetId}:${normalizedType}`;
      const existing = await links.get(id);
      if (existing) {
        // Upsert: when the caller supplied a semanticMeaning, update the
        // existing row's meaning. When no meaning was supplied, leave the
        // existing row untouched (preserves prior meaning assignments made
        // by earlier callers).
        if (semanticMeaning !== undefined && existing.semanticMeaning !== semanticMeaning) {
          return links.patch(id, { semanticMeaning });
        }
        return existing;
      }

      const doc: WritLinkDoc = {
        id,
        sourceId,
        targetId,
        type: normalizedType,
        semanticMeaning: semanticMeaning ?? null,
        createdAt: new Date().toISOString(),
      };
      await links.put(doc);
      return doc;
    },

    async links(writId: string): Promise<WritLinks> {
      const [outbound, inbound] = await Promise.all([
        links.find({ where: [['sourceId', '=', writId]] }),
        links.find({ where: [['targetId', '=', writId]] }),
      ]);
      return { outbound, inbound };
    },

    async unlink(sourceId: string, targetId: string, type: string): Promise<void> {
      // Normalize first so variant spellings of the same type resolve to the
      // same composite id as link() used.
      const normalizedType = normalizeLinkType(type);
      if (!normalizedType) {
        // No-op when the canonical form is empty — unlink() is idempotent, so
        // returning silently is correct even for an unreachable composite id.
        return;
      }
      const id = `${sourceId}:${targetId}:${normalizedType}`;
      await links.delete(id);
    },

    listWritTypes(): WritTypeInfo[] {
      const defaultType = resolveDefaultType();
      return [...mergedWritTypes.entries()].map(([name, meta]) => ({
        name,
        description: meta.description ?? null,
        source: meta.source,
        isDefault: name === defaultType,
      }));
    },

    async listMeanings(): Promise<MeaningDoc[]> {
      return [...linkMeaningRegistry.entries()].map(([id, meta]) => ({
        id,
        ownerPlugin: meta.ownerPlugin,
        description: meta.description,
      }));
    },

    async edit(request: EditWritRequest): Promise<WritDoc> {
      const writ = await writs.get(request.id);
      if (!writ) {
        throw new Error(`Writ "${request.id}" not found.`);
      }
      // Type and codex can only be changed while the writ is still a draft
      if (writ.status !== 'new') {
        if (request.type !== undefined) {
          throw new Error(
            `Cannot change type on writ "${request.id}": status is "${writ.status}". Type can only be changed while the writ is in "new" status.`,
          );
        }
        if (request.codex !== undefined) {
          throw new Error(
            `Cannot change codex on writ "${request.id}": status is "${writ.status}". Codex can only be changed while the writ is in "new" status.`,
          );
        }
      }

      // Validate type if provided
      if (request.type !== undefined) {
        const validTypes = resolveWritTypes();
        if (!validTypes.has(request.type)) {
          throw new Error(
            `Unknown writ type "${request.type}". Declared types: ${[...validTypes.keys()].join(', ')}.`,
          );
        }
      }

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        updatedAt: new Date().toISOString(),
      };
      if (request.title !== undefined) patch.title = request.title;
      if (request.body !== undefined) patch.body = request.body;
      if (request.type !== undefined) patch.type = request.type;
      if (request.codex !== undefined) {
        // Empty string clears the codex
        if (request.codex === '') {
          patch.codex = undefined;
        } else {
          patch.codex = request.codex;
        }
      }

      return writs.patch(request.id, patch);
    },

    async transition(id: string, to: WritStatus, fields?: Partial<WritDoc>): Promise<WritDoc> {
      const writ = await writs.get(id);
      if (!writ) {
        throw new Error(`Writ "${id}" not found.`);
      }

      const allowedFrom = ALLOWED_FROM[to];
      if (!allowedFrom.includes(writ.status)) {
        throw new Error(
          `Cannot transition writ "${id}" to "${to}": status is "${writ.status}", expected one of: ${allowedFrom.join(', ')}.`,
        );
      }

      const now = new Date().toISOString();
      const isTerminal = TERMINAL_STATUSES.has(to);

      // Strip managed fields — callers cannot override id, status, or timestamps
      // controlled by the status machine.
      const { id: _id, status: _status, createdAt: _c, updatedAt: _u,
        resolvedAt: _r, parentId: _p, ...safeFields } = (fields ?? {}) as WritDoc;

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        status: to,
        updatedAt: now,
        ...(isTerminal ? { resolvedAt: now } : {}),
        ...safeFields,
      };

      return writs.patch(id, patch);
    },
  };

  // ── CDC cascade handlers ─────────────────────────────────────────

  async function handleChildTerminal(child: WritDoc): Promise<void> {
    if (!child.parentId) return;

    const parent = await writs.get(child.parentId);
    if (!parent || (parent.status !== 'open' && parent.status !== 'stuck')) return;

    if (child.status === 'failed') {
      const childResolution = child.resolution ?? 'unknown';
      await api.transition(parent.id, 'failed', {
        resolution: `Child "${child.id}" failed: ${childResolution}`,
      });
    }
  }

  async function handleParentTerminal(parent: WritDoc): Promise<void> {
    const children = await writs.find({ where: [['parentId', '=', parent.id]] });
    if (children.length === 0) return;

    const nonTerminalChildren = children.filter((c) => !TERMINAL_STATUSES.has(c.status));
    if (nonTerminalChildren.length === 0) return;

    // When the parent reached `completed`, non-terminal children shouldn't
    // exist — their presence indicates an upstream bookkeeping gap (e.g. a
    // child-writ transition lost a race). Warn loudly rather than masking
    // the discrepancy by cancelling.
    if (parent.status === 'completed') {
      for (const child of nonTerminalChildren) {
        console.warn(
          `[clerk] Parent writ "${parent.id}" transitioned to "completed" but ` +
            `child writ "${child.id}" is still in non-terminal status ` +
            `"${child.status}". Leaving the child as-is; this indicates an ` +
            `upstream bookkeeping gap that should be investigated.`,
        );
      }
      return;
    }

    // Parent reached `failed` or `cancelled` — cancel all non-terminal children
    // with the single canonical resolution string.
    for (const child of nonTerminalChildren) {
      await api.transition(child.id, 'cancelled', {
        resolution: CASCADE_PARENT_TERMINATION_RESOLUTION,
      });
    }
  }

  // ── writ-types tool ──────────────────────────────────────────────

  const writTypesTool = tool({
    name: 'writ-types',
    description: 'List available writ types for this guild',
    instructions:
      'Returns the available writ types including built-in types, types declared ' +
      'in guild config, and types contributed by kits. Each entry includes the ' +
      'type name, optional description, and whether it is the default type.',
    params: {},
    permission: 'read',
    handler: async () => api.listWritTypes(),
  });

  // ── Apparatus ────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['oculus'],
      consumes: ['writTypes', 'linkMeanings'],

      supportKit: {
        books: {
          writs: {
            indexes: ['status', 'type', 'createdAt', 'parentId', ['status', 'type'], ['status', 'createdAt'], ['parentId', 'status']],
          },
          links: {
            indexes: ['sourceId', 'targetId', 'type', ['sourceId', 'type'], ['targetId', 'type']],
          },
        },
        tools: [
          commissionPost,
          pieceAdd,
          writShow,
          writList,
          writEdit,
          writComplete,
          writFail,
          writCancel,
          writPublish,
          writLink,
          writUnlink,
          writLinkMeanings,
          writLinkMeaningsShow,
          writTypesTool,
        ],
        pages: [
          { id: 'writs', title: 'Writs', dir: 'pages/writs' },
        ],
      },

      provides: api,

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        writs = stacks.book<WritDoc>('clerk', 'writs');
        links = stacks.book<WritLinkDoc>('clerk', 'links');

        // Initialize merged writ types from builtins + config
        const config = resolveClerkConfig();
        const configEntries = config.writTypes ?? [];
        configWritTypeNames = new Set(configEntries.map((e) => e.name));
        mergedWritTypes = new Map([
          ...[...BUILTIN_TYPES].map((name) => [name, { source: 'builtin' }] as [string, WritTypeMeta]),
          ...configEntries.map((e) => [e.name, { description: e.description, source: 'guild' }] as [string, WritTypeMeta]),
        ]);

        // Scan all kit-contributed writ types via the Wire-phase snapshot.
        for (const entry of ctx.kits('writTypes')) {
          registerKitWritTypes(entry);
        }

        // Scan all kit-contributed link meanings via the Wire-phase snapshot.
        // Unlike writTypes, malformed entries here hard-fail the start() call
        // — a reserved meaning id that silently disappears would be worse
        // than a startup failure, because downstream consumers key on it.
        linkMeaningRegistry = new Map();
        for (const entry of ctx.kits('linkMeanings')) {
          registerKitLinkMeanings(entry);
        }

        // ── CDC: parent/child cascade ───────────────────────────────
        stacks.watch<WritDoc>('clerk', 'writs', async (event) => {
          if (event.type !== 'update') return;

          const writ = event.entry as WritDoc;
          const prev = event.prev as WritDoc;

          // Only act on status changes
          if (writ.status === prev.status) return;

          // ── Upward cascade: child → parent ──
          if (writ.parentId && TERMINAL_STATUSES.has(writ.status)) {
            await handleChildTerminal(writ);
          }

          // ── Downward cascade: parent → children ──
          if (TERMINAL_STATUSES.has(writ.status)) {
            await handleParentTerminal(writ);
          }
        }, { failOnError: true });

        // ── One-shot migration: collapse legacy statuses to 'open' ──
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start().
        const legacyStatuses = ['ready', 'active', 'waiting'];
        for (const oldStatus of legacyStatuses) {
          const found = await writs.find({ where: [['status', '=', oldStatus]] });
          for (const writ of found) {
            await writs.patch(writ.id, {
              status: 'open' as WritStatus,
              updatedAt: new Date().toISOString(),
            });
          }
        }

        // ── One-shot migration: normalize link rows ──────────────────
        // Two-pass flow per D7:
        //   Pass 1 — scan every link row, group by (sourceId, targetId,
        //     normalizedType). A group with multiple rows is a collision:
        //     variant spellings that collapse to the same canonical form.
        //   Pass 2 — per group, keep the row with the earliest createdAt;
        //     warn and delete the younger siblings (older wins,
        //     deterministic regardless of iteration order). Rewrite the
        //     survivor's id and type to the canonical form and set
        //     `semanticMeaning = null` when absent.
        //
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start(). Writes here fire no links-book
        // watcher today but could in the future.
        const allLinks = await links.find({});
        const groups = new Map<string, WritLinkDoc[]>();
        for (const row of allLinks) {
          const normalized = normalizeLinkType(row.type);
          const key = `${row.sourceId}:${row.targetId}:${normalized}`;
          const bucket = groups.get(key) ?? [];
          bucket.push(row);
          groups.set(key, bucket);
        }

        for (const [canonicalId, bucket] of groups) {
          // Sort by createdAt ascending — the first element is the oldest.
          bucket.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
          const [survivor, ...losers] = bucket;
          if (!survivor) continue;

          for (const loser of losers) {
            console.warn(
              `[clerk] Link migration: collapsing duplicate link ` +
                `"${loser.id}" into canonical "${canonicalId}" ` +
                `(source="${loser.sourceId}", target="${loser.targetId}"); ` +
                `older row kept, this one discarded.`,
            );
            await links.delete(loser.id);
          }

          const normalizedType = canonicalId.slice(
            (survivor.sourceId.length + 1) + (survivor.targetId.length + 1),
          );
          const needsRewrite =
            survivor.id !== canonicalId ||
            survivor.type !== normalizedType ||
            survivor.semanticMeaning === undefined;

          if (!needsRewrite) continue;

          // The composite id is immutable — delete-then-put the survivor to
          // replace it with the canonical document.
          const migrated: WritLinkDoc = {
            id: canonicalId,
            sourceId: survivor.sourceId,
            targetId: survivor.targetId,
            type: normalizedType,
            semanticMeaning: survivor.semanticMeaning ?? null,
            createdAt: survivor.createdAt,
          };
          if (survivor.id !== canonicalId) {
            await links.delete(survivor.id);
          }
          await links.put(migrated);
        }
      },
    },
  };
}

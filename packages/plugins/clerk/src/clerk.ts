/**
 * The Clerk — writ lifecycle management apparatus.
 *
 * The Clerk manages the lifecycle of writs: lightweight work orders that flow
 * through a fixed phase machine (new → open → completed/failed/cancelled,
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
  WritPhase,
  WritTypeInfo,
  PostCommissionRequest,
  EditWritRequest,
  WritFilters,
  WritTypeEntry,
  KindEntry,
  LinkKindDoc,
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
  writLinkKinds,
  writLinkKindsShow,
} from './tools/index.ts';

import { normalizeLinkLabel } from './link-normalize.ts';

// ── Kit contribution interface ────────────────────────────────────────

/** Kit contribution interface for the Clerk's writ type system. */
export interface ClerkKit {
  /** Writ type descriptors to register with the Clerk. Names are unqualified. */
  writTypes?: WritTypeEntry[];
  /**
   * Link-kind descriptors to register with the Clerk. Kind ids must be
   * prefixed with the contributing plugin id (e.g. `astrolabe.refines`).
   * Kit authors supply `{ id, description }`; the registry-projection view
   * (returned by `listKinds()`) embeds the resolved owner plugin id on each
   * record as `ownerPlugin`.
   */
  linkKinds?: KindEntry[];
}

// ── Built-in writ types ──────────────────────────────────────────────

/**
 * Name of the one built-in writ type. Single source of truth — this value
 * serves both as the sole member of `BUILTIN_TYPES` (the set of always-
 * valid writ type names) and as the fallback returned by
 * `resolveDefaultType()` when the guild config declares no `defaultType`.
 * A future rename of the built-in type lands here in one place.
 */
export const BUILTIN_WRIT_TYPE = 'mandate';

const BUILTIN_TYPES = new Set(['mandate']);

// ── Cascade resolution constants ─────────────────────────────────────

/**
 * Resolution string applied to non-terminal children that are cancelled by
 * the downward cascade when their parent transitions to a terminal failure
 * or cancellation phase. Single source of truth — referenced by code,
 * tests, and documentation. Modeled on `PIECE_EXECUTION_EPILOGUE` in the
 * Spider plugin.
 */
export const CASCADE_PARENT_TERMINATION_RESOLUTION =
  'Automatically cancelled due to parent termination';

// ── Phase machine ────────────────────────────────────────────────────

const ALLOWED_FROM: Record<WritPhase, WritPhase[]> = {
  open: ['new', 'stuck'],
  stuck: ['open'],
  completed: ['open'],
  failed: ['open', 'stuck'],
  cancelled: ['new', 'open', 'stuck'],
  new: [],
};

const TERMINAL_PHASES = new Set<WritPhase>(['completed', 'failed', 'cancelled']);

// ── Factory ──────────────────────────────────────────────────────────

/** Parent phases that allow adding children. */
const CHILD_ALLOWED_PARENT_PHASES = new Set<WritPhase>(['new', 'open', 'stuck']);

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

  /** Internal metadata stored per registered link kind. */
  interface KindMeta {
    ownerPlugin: string;
    description: string;
  }

  /** Registry of kit-contributed link kinds, keyed by kind id. */
  let linkKindRegistry: Map<string, KindMeta> = new Map();

  /**
   * Grammar for kind-id suffixes after the `{pluginId}.` prefix.
   *
   * Kebab-case only: lowercase letters, digits, and hyphens. Must not start
   * or end with a hyphen and must have at least one character.
   */
  const KIND_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    if (filters?.phase) {
      const phases = Array.isArray(filters.phase) ? filters.phase : [filters.phase];
      if (phases.length === 1) {
        conditions.push(['phase', '=', phases[0]!]);
      } else if (phases.length > 1) {
        conditions.push(['phase', 'IN', phases]);
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

  function registerKitLinkKinds(kitEntry: { pluginId: string; value: unknown }): void {
    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[clerk] Kit "${pluginId}" linkKinds: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      const description = rec.description;

      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry is missing a non-empty string "id" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" is missing a non-empty string "description" field.`,
        );
      }

      const dotIdx = id.indexOf('.');
      if (dotIdx <= 0 || dotIdx === id.length - 1) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" must be of the form "{pluginId}.{kebab-suffix}".`,
        );
      }
      const prefix = id.slice(0, dotIdx);
      const suffix = id.slice(dotIdx + 1);

      if (prefix !== pluginId) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" has prefix "${prefix}" but must match the contributing plugin id "${pluginId}".`,
        );
      }

      if (!KIND_SUFFIX_RE.test(suffix)) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" suffix "${suffix}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      if (linkKindRegistry.has(id)) {
        const existing = linkKindRegistry.get(id)!;
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: duplicate kind id "${id}" — already registered by kit "${existing.ownerPlugin}".`,
        );
      }

      linkKindRegistry.set(id, {
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

          // Validate parent exists and is in an allowed phase
          const parent = await txWrits.get(request.parentId!);
          if (!parent) {
            throw new Error(`Parent writ "${request.parentId}" not found.`);
          }
          if (!CHILD_ALLOWED_PARENT_PHASES.has(parent.phase)) {
            throw new Error(
              `Cannot add children to writ "${request.parentId}": phase is "${parent.phase}", expected one of: ${[...CHILD_ALLOWED_PARENT_PHASES].join(', ')}.`,
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
            phase: request.draft === true ? 'new' : 'open',
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
        phase: request.draft === true ? 'new' : 'open',
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
      label: string,
      kind?: string,
    ): Promise<WritLinkDoc> {
      if (sourceId === targetId) {
        throw new Error(`Cannot link a writ to itself: "${sourceId}".`);
      }

      // D2: normalize first, then reject empty canonical form. An all-
      // whitespace input canonicalizes to '' and is rejected here.
      const normalizedLabel = normalizeLinkLabel(label);
      if (!normalizedLabel) {
        throw new Error('Link label must be a non-empty string.');
      }

      // If a kind was supplied, validate it against the registry before
      // touching the store.
      if (kind !== undefined) {
        if (!linkKindRegistry.has(kind)) {
          throw new Error(
            `Unknown link kind "${kind}". Registered link kinds: ${
              linkKindRegistry.size === 0
                ? '(none)'
                : [...linkKindRegistry.keys()].join(', ')
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

      const id = `${sourceId}:${targetId}:${normalizedLabel}`;
      const existing = await links.get(id);
      if (existing) {
        // Upsert: when the caller supplied a kind, update the existing row's
        // kind. When no kind was supplied, leave the existing row untouched
        // (preserves prior kind assignments made by earlier callers).
        if (kind !== undefined && existing.kind !== kind) {
          return links.patch(id, { kind });
        }
        return existing;
      }

      const doc: WritLinkDoc = {
        id,
        sourceId,
        targetId,
        label: normalizedLabel,
        kind: kind ?? null,
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

    async unlink(sourceId: string, targetId: string, label: string): Promise<void> {
      // Normalize first so variant spellings of the same label resolve to the
      // same composite id as link() used.
      const normalizedLabel = normalizeLinkLabel(label);
      if (!normalizedLabel) {
        // No-op when the canonical form is empty — unlink() is idempotent, so
        // returning silently is correct even for an unreachable composite id.
        return;
      }
      const id = `${sourceId}:${targetId}:${normalizedLabel}`;
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

    async listKinds(): Promise<LinkKindDoc[]> {
      return [...linkKindRegistry.entries()].map(([id, meta]) => ({
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
      if (writ.phase !== 'new') {
        if (request.type !== undefined) {
          throw new Error(
            `Cannot change type on writ "${request.id}": phase is "${writ.phase}". Type can only be changed while the writ is in "new" phase.`,
          );
        }
        if (request.codex !== undefined) {
          throw new Error(
            `Cannot change codex on writ "${request.id}": phase is "${writ.phase}". Codex can only be changed while the writ is in "new" phase.`,
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

    async transition(id: string, to: WritPhase, fields?: Partial<WritDoc>): Promise<WritDoc> {
      const writ = await writs.get(id);
      if (!writ) {
        throw new Error(`Writ "${id}" not found.`);
      }

      const allowedFrom = ALLOWED_FROM[to];
      if (!allowedFrom.includes(writ.phase)) {
        throw new Error(
          `Cannot transition writ "${id}" to "${to}": phase is "${writ.phase}", expected one of: ${allowedFrom.join(', ')}.`,
        );
      }

      const now = new Date().toISOString();
      const isTerminal = TERMINAL_PHASES.has(to);

      // Strip managed fields — callers cannot override id, phase, the
      // plugin-owned observation slot `status`, or timestamps controlled
      // by the phase machine.
      //
      // The observation slot is a plugin-keyed map (`Record<PluginId,
      // unknown>`) whose sub-slots are owned by different plugins. The
      // only slot-write path that preserves sibling sub-slots under
      // concurrent writers is ClerkApi.setWritStatus(writId, pluginId,
      // value), which performs a transactional read-modify-write on the
      // sub-slot keyed by pluginId. Because patch() is a top-level
      // shallow merge, a `status` value smuggled through transition()
      // would wholesale-replace the slot and silently clobber sibling
      // sub-slots — so `status` is silently dropped here alongside the
      // other managed fields. There is exactly one sanctioned slot-write
      // path, and it is setWritStatus().
      const { id: _id, phase: _phase, status: _status,
        createdAt: _c, updatedAt: _u,
        resolvedAt: _r, parentId: _p,
        ...safeFields } = (fields ?? {}) as WritDoc;

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        phase: to,
        updatedAt: now,
        ...(isTerminal ? { resolvedAt: now } : {}),
        ...safeFields,
      };

      return writs.patch(id, patch);
    },

    async setWritStatus(writId: string, pluginId: string, value: unknown): Promise<WritDoc> {
      if (!writId) {
        throw new Error('setWritStatus: writId is required.');
      }
      if (!pluginId) {
        throw new Error('setWritStatus: pluginId is required.');
      }

      // Read-modify-write in a single transaction so we do not clobber
      // sibling sub-slots written concurrently by other plugins.
      return stacks.transaction(async (tx) => {
        const txWrits = tx.book<WritDoc>('clerk', 'writs');
        const existing = await txWrits.get(writId);
        if (!existing) {
          throw new Error(`Writ "${writId}" not found.`);
        }

        const prevStatus = (existing.status ?? {}) as Record<string, unknown>;
        const nextStatus: Record<string, unknown> = { ...prevStatus, [pluginId]: value };

        return txWrits.patch(writId, {
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        });
      });
    },
  };

  // ── CDC cascade handlers ─────────────────────────────────────────

  async function handleChildTerminal(child: WritDoc): Promise<void> {
    if (!child.parentId) return;

    const parent = await writs.get(child.parentId);
    if (!parent || (parent.phase !== 'open' && parent.phase !== 'stuck')) return;

    if (child.phase === 'failed') {
      const childResolution = child.resolution ?? 'unknown';
      await api.transition(parent.id, 'failed', {
        resolution: `Child "${child.id}" failed: ${childResolution}`,
      });
    }
  }

  async function handleParentTerminal(parent: WritDoc): Promise<void> {
    const children = await writs.find({ where: [['parentId', '=', parent.id]] });
    if (children.length === 0) return;

    const nonTerminalChildren = children.filter((c) => !TERMINAL_PHASES.has(c.phase));
    if (nonTerminalChildren.length === 0) return;

    // When the parent reached `completed`, non-terminal children shouldn't
    // exist — their presence indicates an upstream bookkeeping gap (e.g. a
    // child-writ transition lost a race). Warn loudly rather than masking
    // the discrepancy by cancelling.
    if (parent.phase === 'completed') {
      for (const child of nonTerminalChildren) {
        console.warn(
          `[clerk] Parent writ "${parent.id}" transitioned to "completed" but ` +
            `child writ "${child.id}" is still in non-terminal phase ` +
            `"${child.phase}". Leaving the child as-is; this indicates an ` +
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
      consumes: ['writTypes', 'linkKinds'],

      supportKit: {
        books: {
          writs: {
            indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
          },
          links: {
            indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
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
          writLinkKinds,
          writLinkKindsShow,
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

        // Scan all kit-contributed link kinds via the Wire-phase snapshot.
        // Unlike writTypes, malformed entries here hard-fail the start() call
        // — a reserved kind id that silently disappears would be worse than
        // a startup failure, because downstream consumers key on it.
        linkKindRegistry = new Map();
        for (const entry of ctx.kits('linkKinds')) {
          registerKitLinkKinds(entry);
        }

        // ── CDC: parent/child cascade ───────────────────────────────
        stacks.watch<WritDoc>('clerk', 'writs', async (event) => {
          if (event.type !== 'update') return;

          const writ = event.entry as WritDoc;
          const prev = event.prev as WritDoc;

          // Only act on phase changes
          if (writ.phase === prev.phase) return;

          // ── Upward cascade: child → parent ──
          if (writ.parentId && TERMINAL_PHASES.has(writ.phase)) {
            await handleChildTerminal(writ);
          }

          // ── Downward cascade: parent → children ──
          if (TERMINAL_PHASES.has(writ.phase)) {
            await handleParentTerminal(writ);
          }
        }, { failOnError: true });

        // ── One-shot migration: rename `status` → `phase`, subsume legacy values ──
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start().
        //
        // Every pre-rename row carries its lifecycle value in `status`.
        // Post-rename rows carry `phase` instead, and `status` becomes the
        // plugin-owned observation slot. We iterate every row, compute a
        // clean post-rename document, and `put()` it back — `patch()` can't
        // remove a field, so the full rewrite is required.
        //
        // Legacy lifecycle values (`ready`, `active`, `waiting`) are
        // collapsed into `open` along the way (this subsumes the older
        // `legacyStatuses` migration). Any unrecognized value aborts
        // startup — unknown phase is a data-integrity issue.
        const LEGACY_COLLAPSE: Record<string, WritPhase> = {
          ready: 'open',
          active: 'open',
          waiting: 'open',
        };
        const VALID_PHASES = new Set<WritPhase>([
          'new', 'open', 'stuck', 'completed', 'failed', 'cancelled',
        ]);

        const allWrits = await writs.find({});
        for (const row of allWrits) {
          // Already migrated — skip (idempotent).
          if (typeof (row as { phase?: unknown }).phase === 'string') continue;

          const legacyStatus = (row as { status?: unknown }).status;
          if (typeof legacyStatus !== 'string') {
            throw new Error(
              `[clerk] Migration: writ "${row.id}" has neither \`phase\` nor a string \`status\` field; cannot migrate (got ${legacyStatus === undefined ? 'undefined' : typeof legacyStatus}).`,
            );
          }

          let nextPhase: WritPhase;
          if (LEGACY_COLLAPSE[legacyStatus]) {
            nextPhase = LEGACY_COLLAPSE[legacyStatus];
          } else if (VALID_PHASES.has(legacyStatus as WritPhase)) {
            nextPhase = legacyStatus as WritPhase;
          } else {
            throw new Error(
              `[clerk] Migration: writ "${row.id}" has unrecognized status value "${legacyStatus}". Expected one of: ${[...VALID_PHASES].join(', ')} (or legacy: ${Object.keys(LEGACY_COLLAPSE).join(', ')}).`,
            );
          }

          // Build a clean post-rename document — no `status` key, `phase`
          // set. `updatedAt` is preserved exactly as stored (this is a
          // storage-format change, not a logical edit).
          const migrated: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            if (k === 'status') continue;
            migrated[k] = v;
          }
          migrated.phase = nextPhase;
          await writs.put(migrated as WritDoc);
        }

        // ── One-shot migration: normalize link rows ──────────────────
        // Two-pass flow per D7:
        //   Pass 1 — scan every link row, group by (sourceId, targetId,
        //     normalizedLabel). A group with multiple rows is a collision:
        //     variant spellings that collapse to the same canonical form.
        //   Pass 2 — per group, keep the row with the earliest createdAt;
        //     warn and delete the younger siblings (older wins,
        //     deterministic regardless of iteration order). Rewrite the
        //     survivor's id and label to the canonical form and set
        //     `kind = null` when absent.
        //
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start(). Writes here fire no links-book
        // watcher today but could in the future.
        const allLinks = await links.find({});
        const groups = new Map<string, WritLinkDoc[]>();
        for (const row of allLinks) {
          const normalized = normalizeLinkLabel(row.label);
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

          const normalizedLabel = canonicalId.slice(
            (survivor.sourceId.length + 1) + (survivor.targetId.length + 1),
          );
          const needsRewrite =
            survivor.id !== canonicalId ||
            survivor.label !== normalizedLabel ||
            survivor.kind === undefined;

          if (!needsRewrite) continue;

          // The composite id is immutable — delete-then-put the survivor to
          // replace it with the canonical document.
          const migrated: WritLinkDoc = {
            id: canonicalId,
            sourceId: survivor.sourceId,
            targetId: survivor.targetId,
            label: normalizedLabel,
            kind: survivor.kind ?? null,
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

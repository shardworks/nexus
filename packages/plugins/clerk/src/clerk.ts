/**
 * The Clerk — writ lifecycle management apparatus.
 *
 * The Clerk manages the lifecycle of writs: lightweight work orders that flow
 * through a fixed status machine (ready → active → completed/failed, or
 * ready/active → cancelled). Each writ has a type, a title, a body, and
 * optional codex and resolution fields.
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
  PostCommissionRequest,
  WritFilters,
  WritTypeEntry,
} from './types.ts';

import {
  commissionPost,
  writShow,
  writList,
  writAccept,
  writComplete,
  writFail,
  writCancel,
  writPublish,
  writLink,
  writUnlink,
} from './tools/index.ts';

// ── Kit contribution interface ────────────────────────────────────────

/** Kit contribution interface for the Clerk's writ type system. */
export interface ClerkKit {
  /** Writ type descriptors to register with the Clerk. Names are unqualified. */
  writTypes?: WritTypeEntry[];
}

// ── Built-in writ types ──────────────────────────────────────────────

const BUILTIN_TYPES = new Set(['mandate']);

// ── Status machine ───────────────────────────────────────────────────

const ALLOWED_FROM: Record<WritStatus, WritStatus[]> = {
  ready: ['new', 'waiting'],
  active: ['ready'],
  completed: ['active'],
  failed: ['active', 'waiting'],
  cancelled: ['new', 'ready', 'active', 'waiting'],
  waiting: ['new', 'ready'],
  new: [],
};

const TERMINAL_STATUSES = new Set<WritStatus>(['completed', 'failed', 'cancelled']);

// ── Factory ──────────────────────────────────────────────────────────

/** Parent statuses that allow adding children. */
const CHILD_ALLOWED_PARENT_STATUSES = new Set<WritStatus>(['new', 'ready', 'waiting']);

export function createClerk(): Plugin {
  let stacks: StacksApi;
  let writs: Book<WritDoc>;
  let links: Book<WritLinkDoc>;

  /** Merged set of valid writ type names: builtins + config + kit contributions. */
  let mergedWritTypes: Set<string> = new Set(BUILTIN_TYPES);

  /** Config-declared writ type names, for override checking during kit registration. */
  let configWritTypeNames: Set<string> = new Set();

  // ── Helpers ──────────────────────────────────────────────────────

  function resolveClerkConfig(): ClerkConfig {
    return guild().guildConfig().clerk ?? {};
  }

  function resolveWritTypes(): Set<string> {
    return mergedWritTypes;
  }

  function resolveDefaultType(): string {
    const config = resolveClerkConfig();
    return config.defaultType ?? 'mandate';
  }

  function buildWhereClause(filters?: WritFilters): WhereClause | undefined {
    const conditions: WhereClause = [];
    if (filters?.status) {
      conditions.push(['status', '=', filters.status]);
    }
    if (filters?.type) {
      conditions.push(['type', '=', filters.type]);
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

      mergedWritTypes.add(name);
    }
  }

  // ── API ──────────────────────────────────────────────────────────

  const api: ClerkApi = {
    async post(request: PostCommissionRequest): Promise<WritDoc> {
      const type = request.type ?? resolveDefaultType();
      const validTypes = resolveWritTypes();

      if (!validTypes.has(type)) {
        throw new Error(
          `Unknown writ type "${type}". Declared types: ${[...validTypes].join(', ')}.`,
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
            status: request.draft === true ? 'new' : 'ready',
            title: request.title,
            body: request.body,
            ...(codex !== undefined ? { codex } : {}),
            parentId: request.parentId,
            createdAt: now,
            updatedAt: now,
          };

          await txWrits.put(writ);

          // Transition parent to waiting if it's in new or ready
          if (parent.status === 'new' || parent.status === 'ready') {
            await txWrits.patch(parent.id, {
              status: 'waiting' as WritStatus,
              updatedAt: new Date().toISOString(),
            });
          }

          return writ;
        });
      }

      const writ: WritDoc = {
        id: childId,
        type,
        status: request.draft === true ? 'new' : 'ready',
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

    async link(sourceId: string, targetId: string, type: string): Promise<WritLinkDoc> {
      if (sourceId === targetId) {
        throw new Error(`Cannot link a writ to itself: "${sourceId}".`);
      }
      if (!type || !type.trim()) {
        throw new Error('Link type must be a non-empty string.');
      }

      const source = await writs.get(sourceId);
      if (!source) {
        throw new Error(`Writ "${sourceId}" not found.`);
      }
      const target = await writs.get(targetId);
      if (!target) {
        throw new Error(`Writ "${targetId}" not found.`);
      }

      const id = `${sourceId}:${targetId}:${type}`;
      const existing = await links.get(id);
      if (existing) {
        return existing;
      }

      const doc: WritLinkDoc = {
        id,
        sourceId,
        targetId,
        type,
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
      const id = `${sourceId}:${targetId}:${type}`;
      await links.delete(id);
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
        acceptedAt: _a, resolvedAt: _r, parentId: _p, ...safeFields } = (fields ?? {}) as WritDoc;

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        status: to,
        updatedAt: now,
        ...(to === 'active' ? { acceptedAt: now } : {}),
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
    if (!parent || parent.status !== 'waiting') return;

    if (child.status === 'failed') {
      const childResolution = child.resolution ?? 'unknown';
      await api.transition(parent.id, 'failed', {
        resolution: `Child "${child.id}" failed: ${childResolution}`,
      });
      return;
    }

    // completed or cancelled — check if all siblings are terminal
    const children = await writs.find({ where: [['parentId', '=', parent.id]] });
    const allTerminal = children.every((c) => TERMINAL_STATUSES.has(c.status));
    const noneFailed = !children.some((c) => c.status === 'failed');

    if (allTerminal && noneFailed) {
      await api.transition(parent.id, 'ready');
    }
  }

  async function handleParentTerminal(parent: WritDoc): Promise<void> {
    const children = await writs.find({ where: [['parentId', '=', parent.id]] });
    if (children.length === 0) return;

    for (const child of children) {
      if (!TERMINAL_STATUSES.has(child.status)) {
        await api.transition(child.id, 'cancelled', {
          resolution: 'Automatically cancelled due to sibling failure',
        });
      }
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
    permission: 'clerk:read',
    handler: async () => {
      const config = resolveClerkConfig();
      const defaultType = resolveDefaultType();
      const configEntries = config.writTypes ?? [];

      return [...mergedWritTypes].map((name) => {
        const entry = configEntries.find((e) => e.name === name);
        return {
          name,
          description: entry?.description ?? null,
          default: name === defaultType,
        };
      });
    },
  });

  // ── Apparatus ────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['oculus'],
      consumes: ['writTypes'],

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
          writShow,
          writList,
          writAccept,
          writComplete,
          writFail,
          writCancel,
          writPublish,
          writLink,
          writUnlink,
          writTypesTool,
        ],
        pages: [
          { id: 'writs', title: 'Writs', dir: 'pages/writs' },
        ],
      },

      provides: api,

      start(ctx: StartupContext): void {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        writs = stacks.book<WritDoc>('clerk', 'writs');
        links = stacks.book<WritLinkDoc>('clerk', 'links');

        // Initialize merged writ types from builtins + config
        const config = resolveClerkConfig();
        configWritTypeNames = new Set((config.writTypes ?? []).map((e) => e.name));
        mergedWritTypes = new Set([...BUILTIN_TYPES, ...configWritTypeNames]);

        // Scan all kit-contributed writ types via the Wire-phase snapshot.
        for (const entry of ctx.kits('writTypes')) {
          registerKitWritTypes(entry);
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
      },
    },
  };
}

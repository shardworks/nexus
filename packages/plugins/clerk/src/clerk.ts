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
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
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
} from './types.ts';

import {
  commissionPost,
  writShow,
  writList,
  writAccept,
  writComplete,
  writFail,
  writCancel,
  writLink,
  writUnlink,
} from './tools/index.ts';

// ── Built-in writ types ──────────────────────────────────────────────

const BUILTIN_TYPES = new Set(['mandate']);

// ── Status machine ───────────────────────────────────────────────────

const ALLOWED_FROM: Record<WritStatus, WritStatus[]> = {
  active: ['ready'],
  completed: ['active'],
  failed: ['active'],
  cancelled: ['ready', 'active'],
  ready: [],
};

const TERMINAL_STATUSES = new Set<WritStatus>(['completed', 'failed', 'cancelled']);

// ── Factory ──────────────────────────────────────────────────────────

export function createClerk(): Plugin {
  let writs: Book<WritDoc>;
  let links: Book<WritLinkDoc>;

  // ── Helpers ──────────────────────────────────────────────────────

  function resolveClerkConfig(): ClerkConfig {
    return guild().guildConfig().clerk ?? {};
  }

  function resolveWritTypes(): Set<string> {
    const config = resolveClerkConfig();
    const declared = (config.writTypes ?? []).map((entry) => entry.name);
    return new Set([...BUILTIN_TYPES, ...declared]);
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
    return conditions.length > 0 ? conditions : undefined;
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
      const writ: WritDoc = {
        id: generateId('w', 6),
        type,
        status: 'ready',
        title: request.title,
        body: request.body,
        ...(request.codex !== undefined ? { codex: request.codex } : {}),
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
        acceptedAt: _a, resolvedAt: _r, ...safeFields } = (fields ?? {}) as WritDoc;

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

  // ── Apparatus ────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],

      supportKit: {
        books: {
          writs: {
            indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
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
          writLink,
          writUnlink,
        ],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const stacks = guild().apparatus<StacksApi>('stacks');
        writs = stacks.book<WritDoc>('clerk', 'writs');
        links = stacks.book<WritLinkDoc>('clerk', 'links');
      },
    },
  };
}

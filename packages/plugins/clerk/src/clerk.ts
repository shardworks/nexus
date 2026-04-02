/**
 * The Clerk — writ lifecycle management apparatus.
 *
 * The Clerk manages the lifecycle of writs: lightweight work orders that flow
 * through a fixed status machine (ready → active → completed/failed, or
 * ready/active → cancelled). Each writ has a type, a title, an optional body,
 * and an optional assignee.
 *
 * Writ types are validated against the guild config's writTypes field plus the
 * built-in types ('mandate', 'summon'). An unknown type is rejected at post time.
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import crypto from 'node:crypto';

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi, Book, WhereCondition, OrderBy } from '@shardworks/stacks-apparatus';

import type {
  ClerkApi,
  ClerkConfig,
  WritDoc,
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
} from './tools/index.ts';

// ── Built-in writ types ──────────────────────────────────────────────

const BUILTIN_TYPES = new Set(['mandate', 'summon']);

// ── ID generation (ULID-like) ────────────────────────────────────────

function generateWritId(): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `writ-${ts}${rand}`;
}

// ── Status machine ───────────────────────────────────────────────────

type Transition = 'accept' | 'complete' | 'fail' | 'cancel';

const ALLOWED_TRANSITIONS: Record<Transition, WritStatus[]> = {
  accept: ['ready'],
  complete: ['active'],
  fail: ['active'],
  cancel: ['ready', 'active'],
};

const TRANSITION_TARGET: Record<Transition, WritStatus> = {
  accept: 'active',
  complete: 'completed',
  fail: 'failed',
  cancel: 'cancelled',
};

// ── Factory ──────────────────────────────────────────────────────────

export function createClerk(): Plugin {
  let writs: Book<WritDoc>;

  // ── Helpers ──────────────────────────────────────────────────────

  function resolveWritTypes(): Set<string> {
    const guildConfig = guild().guildConfig();
    const declared = Object.keys(guildConfig.writTypes ?? {});
    return new Set([...BUILTIN_TYPES, ...declared]);
  }

  function resolveDefaultType(): string {
    const config = guild().config<ClerkConfig>('clerk');
    return config?.defaultType ?? 'mandate';
  }

  async function transition(writId: string, op: Transition, extra?: Partial<WritDoc>): Promise<WritDoc> {
    const writ = await writs.get(writId);
    if (!writ) {
      throw new Error(`Writ "${writId}" not found.`);
    }

    const allowed = ALLOWED_TRANSITIONS[op];
    if (!allowed.includes(writ.status)) {
      throw new Error(
        `Cannot ${op} writ "${writId}": status is "${writ.status}", expected one of: ${allowed.join(', ')}.`,
      );
    }

    const now = new Date().toISOString();
    const targetStatus = TRANSITION_TARGET[op];
    const isClosing = targetStatus === 'completed' || targetStatus === 'failed' || targetStatus === 'cancelled';

    const patch: Partial<Omit<WritDoc, 'id'>> = {
      status: targetStatus,
      ...(op === 'accept' ? { acceptedAt: now } : {}),
      ...(isClosing ? { closedAt: now } : {}),
      ...extra,
    };

    return writs.patch(writId, patch);
  }

  // ── API ──────────────────────────────────────────────────────────

  const api: ClerkApi = {
    async postCommission(request: PostCommissionRequest): Promise<WritDoc> {
      const type = request.type ?? resolveDefaultType();
      const validTypes = resolveWritTypes();

      if (!validTypes.has(type)) {
        throw new Error(
          `Unknown writ type "${type}". Declared types: ${[...validTypes].join(', ')}.`,
        );
      }

      const now = new Date().toISOString();
      const writ: WritDoc = {
        id: generateWritId(),
        type,
        title: request.title,
        body: request.body ?? null,
        status: 'ready',
        assignee: request.assignee ?? null,
        postedAt: now,
        acceptedAt: null,
        closedAt: null,
        failReason: null,
      };

      await writs.put(writ);
      return writ;
    },

    async show(writId: string): Promise<WritDoc | null> {
      return writs.get(writId);
    },

    async list(filters?: WritFilters): Promise<WritDoc[]> {
      const where: WhereCondition[] = [];

      if (filters?.status) {
        where.push(['status', '=', filters.status]);
      }
      if (filters?.type) {
        where.push(['type', '=', filters.type]);
      }
      if (filters?.assignee) {
        where.push(['assignee', '=', filters.assignee]);
      }

      const limit = filters?.limit ?? 20;

      return writs.find({
        where: where.length > 0 ? where : undefined,
        orderBy: ['postedAt', 'desc'] as OrderBy,
        limit,
      });
    },

    async accept(writId: string): Promise<WritDoc> {
      return transition(writId, 'accept');
    },

    async complete(writId: string): Promise<WritDoc> {
      return transition(writId, 'complete');
    },

    async fail(writId: string, reason?: string): Promise<WritDoc> {
      return transition(writId, 'fail', reason ? { failReason: reason } : undefined);
    },

    async cancel(writId: string): Promise<WritDoc> {
      return transition(writId, 'cancel');
    },
  };

  // ── Apparatus ────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],

      supportKit: {
        books: {
          writs: {
            indexes: ['status', 'type', 'assignee', 'postedAt'],
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
        ],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const stacks = guild().apparatus<StacksApi>('stacks');
        writs = stacks.book<WritDoc>('clerk', 'writs');
      },
    },
  };
}

/**
 * Stacks core — shared implementation logic for both the production
 * apparatus (stacks.ts) and the testable harness (testable-stacks.ts).
 *
 * This module contains ALL read/write/transaction/CDC logic. The two
 * consumer modules only add their own wiring: the apparatus adds guild()
 * startup and plugin schema reconciliation; the testable harness adds
 * nothing (just exposes createApi() directly).
 *
 * This ensures behavioral identity by construction, not by copy-paste.
 */

import type {
  BackendTransaction,
  BookRef,
  InternalQuery,
  StacksBackend,
} from './backend.ts';

import type {
  Book,
  BookEntry,
  BookQuery,
  ListOptions,
  ReadOnlyBook,
  StacksApi,
  TransactionContext,
  WatchOptions,
  WhereClause,
  ChangeHandler,
} from './types.ts';

import {
  CdcRegistry,
  coalesceEvents,
  Phase2DepthExceededError,
  type BufferedEvent,
} from './cdc.ts';
import { translateQuery, translateWhereClause } from './query.ts';
import { normalizeOrderBy, compareByOrderEntries } from './field-utils.ts';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Phase-1 cascade-depth bound — caps in-transaction handler nesting so
 * a Phase-1 watcher that re-triggers itself cannot pin the CPU. Counted
 * per-transaction inside `ActiveTransaction.depth`.
 */
const MAX_CASCADE_DEPTH = 16;

/**
 * Phase-2 cross-transaction re-entry depth bound — caps the number of
 * post-commit handler hops in a single Phase-2 chain. The Phase-1 guard
 * resets when each Phase-2 handler opens its own transaction, so a
 * separate counter is required to bound Phase-2 cycles. Counted at the
 * `firePhase2` boundary inside `phase2Depth` (D3, D4, D5).
 *
 * The two bounds are intentionally orthogonal: Phase-1 measures handler
 * nesting within one transaction; Phase-2 measures post-commit hops
 * across transactions. Sharing a single budget would false-positive
 * deep cascade graphs.
 */
const MAX_PHASE2_REENTRY_DEPTH = 16;

// ── Active transaction state ──────────────────────────────────────────

interface ActiveTransaction {
  backendTx: BackendTransaction;
  eventBuffer: BufferedEvent[];
  depth: number;
}

// ── Book handle implementation ────────────────────────────────────────

function createBookHandle<T extends BookEntry>(
  ref: BookRef,
  core: StacksCore,
  writable: boolean,
): Book<T> {
  const readMethods: ReadOnlyBook<T> = {
    async get(id: string): Promise<T | null> {
      return core.doGet(ref, id) as T | null;
    },

    async find(query: BookQuery): Promise<T[]> {
      return core.doFind(ref, query) as Promise<T[]>;
    },

    async list(options?: ListOptions): Promise<T[]> {
      // Cast needed: ListOptions spreads into BookQuery but the Pagination
      // discriminated union can't be inferred from optional fields.
      return core.doFind(ref, {
        orderBy: options?.orderBy,
        limit: options?.limit,
        offset: options?.offset,
      } as BookQuery) as Promise<T[]>;
    },

    async count(where?: WhereClause | { or: WhereClause[] }): Promise<number> {
      return core.doCount(ref, where);
    },
  };

  if (!writable) {
    return readMethods as Book<T>;
  }

  return {
    ...readMethods,

    async put(entry: T): Promise<void> {
      await core.doPut(ref, entry);
    },

    async patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<T> {
      return (await core.doPatch(ref, id, fields as Record<string, unknown>)) as T;
    },

    async delete(id: string): Promise<void> {
      await core.doDelete(ref, id);
    },
  };
}

// ── Stacks core implementation ───────────────────────────────────────

export class StacksCore {
  private readonly cdc = new CdcRegistry();
  private activeTx: ActiveTransaction | null = null;

  /**
   * Phase-2 cross-transaction re-entry depth (D2). Mirrors the
   * `activeTx` instance-field pattern — single-flight per apparatus
   * instance, no AsyncLocalStorage. Incremented when entering a
   * `firePhase2` invocation and decremented on exit; gate-checked at
   * the next `runTransaction` entry so a runaway Phase-2 self-write
   * chain fails loud rather than pinning the CPU. See `runTransaction`
   * for the gate check (D6) and the firePhase2 wrapper (D5).
   */
  private phase2Depth = 0;

  constructor(readonly backend: StacksBackend) {}

  /**
   * Seal the CDC registry. After this is called, any further `watch()`
   * calls throw. Invoked by the guild runtime (arbor) via the
   * `phase:started` event, after all apparatus start() methods complete,
   * so startup-time writes in one apparatus don't lock out watcher
   * registration in a dependent apparatus that starts later.
   */
  sealCdc(): void {
    this.cdc.lock();
  }

  // ── API surface ───────────────────────────────────────────────────

  createApi(): StacksApi {
    const self = this;

    return {
      book<T extends BookEntry>(ownerId: string, name: string): Book<T> {
        return createBookHandle<T>({ ownerId, book: name }, self, true);
      },

      readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T> {
        return createBookHandle<T>({ ownerId, book: name }, self, false) as ReadOnlyBook<T>;
      },

      watch<T extends BookEntry>(
        ownerId: string,
        bookName: string,
        handler: ChangeHandler<T>,
        options?: WatchOptions,
      ): void {
        self.cdc.watch(
          ownerId,
          bookName,
          handler as ChangeHandler,
          options,
        );
      },

      async transaction<R>(fn: (tx: TransactionContext) => Promise<R>): Promise<R> {
        return self.runTransaction(fn);
      },
    };
  }

  // ── Transaction management ────────────────────────────────────────

  async runTransaction<R>(fn: (tx: TransactionContext) => Promise<R>): Promise<R> {
    // If already in a transaction, just run (no nesting — flattened)
    if (this.activeTx) {
      const txCtx = this.createTransactionContext();
      return fn(txCtx);
    }

    // Phase-2 cross-transaction re-entry bound (gate-entry, D5/D6).
    // If we're being entered from within a Phase-2 handler chain that
    // has already accumulated MAX_PHASE2_REENTRY_DEPTH hops, refuse to
    // open a new backend transaction so the offending handler write is
    // rejected (D10 partial-commit) and the chain terminates loud.
    // The throw fires before the try/catch below so the existing
    // rollback path — which only handles tx-level failures — is not
    // engaged for a transaction that was never opened.
    if (this.phase2Depth >= MAX_PHASE2_REENTRY_DEPTH) {
      throw new Phase2DepthExceededError(MAX_PHASE2_REENTRY_DEPTH);
    }

    // Create new transaction
    const backendTx = this.backend.beginTransaction();
    const eventBuffer: BufferedEvent[] = [];
    this.activeTx = { backendTx, eventBuffer, depth: 0 };

    try {
      const txCtx = this.createTransactionContext();
      const result = await fn(txCtx);

      backendTx.commit();
      const coalesced = coalesceEvents(eventBuffer);
      this.activeTx = null;

      // Fire Phase 2 handlers (after commit). Wrap with depth tracking
      // so the substrate-level cross-transaction re-entry bound (D5)
      // sees the correct hop count when a handler triggers another
      // Phase-2 chain. The increment must happen even though the gate
      // check fires in the *next* runTransaction call — that next call
      // reads `phase2Depth` to decide whether to refuse the write.
      this.phase2Depth++;
      try {
        await this.cdc.firePhase2(coalesced);
      } finally {
        this.phase2Depth--;
      }

      return result;
    } catch (err) {
      try { backendTx.rollback(); } catch { /* already rolled back */ }
      this.activeTx = null;
      throw err;
    }
  }

  private createTransactionContext(): TransactionContext {
    const self = this;
    return {
      book<T extends BookEntry>(ownerId: string, name: string): Book<T> {
        return createBookHandle<T>({ ownerId, book: name }, self, true);
      },
      readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T> {
        return createBookHandle<T>({ ownerId, book: name }, self, false) as ReadOnlyBook<T>;
      },
    };
  }

  // ── Write operations (called by book handles) ─────────────────────

  async doPut(ref: BookRef, entry: BookEntry): Promise<void> {
    if (!this.activeTx) {
      return this.runTransaction(async () => this.doPutInTx(ref, entry));
    }
    return this.doPutInTx(ref, entry);
  }

  private async doPutInTx(ref: BookRef, entry: BookEntry): Promise<void> {
    const tx = this.requireTx();

    // Check cascade depth
    tx.depth++;
    if (tx.depth > MAX_CASCADE_DEPTH) {
      throw new Error(
        `[stacks] Maximum cascade depth (${MAX_CASCADE_DEPTH}) exceeded. ` +
        `This usually means a CDC handler is triggering itself recursively.`,
      );
    }

    const needPrev = this.cdc.hasWatchers(ref.ownerId, ref.book);
    const result = tx.backendTx.put(ref, entry, { withPrev: needPrev });

    const event: BufferedEvent = {
      ref: `${ref.ownerId}/${ref.book}`,
      ownerId: ref.ownerId,
      book: ref.book,
      docId: entry.id,
      type: result.created ? 'create' : 'update',
      entry,
      prev: result.prev,
    };
    tx.eventBuffer.push(event);

    // Fire Phase 1 handlers (inside the transaction)
    if (result.created) {
      await this.cdc.firePhase1(ref.ownerId, ref.book, {
        type: 'create', ownerId: ref.ownerId, book: ref.book, entry,
      });
    } else {
      await this.cdc.firePhase1(ref.ownerId, ref.book, {
        type: 'update', ownerId: ref.ownerId, book: ref.book, entry, prev: result.prev!,
      });
    }

    tx.depth--;
  }

  async doPatch(ref: BookRef, id: string, fields: Record<string, unknown>): Promise<BookEntry> {
    if (!this.activeTx) {
      let result!: BookEntry;
      await this.runTransaction(async () => {
        result = await this.doPatchInTx(ref, id, fields);
      });
      return result;
    }
    return this.doPatchInTx(ref, id, fields);
  }

  private async doPatchInTx(
    ref: BookRef,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<BookEntry> {
    const tx = this.requireTx();

    tx.depth++;
    if (tx.depth > MAX_CASCADE_DEPTH) {
      throw new Error(
        `[stacks] Maximum cascade depth (${MAX_CASCADE_DEPTH}) exceeded.`,
      );
    }

    const result = tx.backendTx.patch(ref, id, fields);

    const event: BufferedEvent = {
      ref: `${ref.ownerId}/${ref.book}`,
      ownerId: ref.ownerId,
      book: ref.book,
      docId: id,
      type: 'update',
      entry: result.entry,
      prev: result.prev,
    };
    tx.eventBuffer.push(event);

    await this.cdc.firePhase1(ref.ownerId, ref.book, {
      type: 'update', ownerId: ref.ownerId, book: ref.book,
      entry: result.entry, prev: result.prev,
    });

    tx.depth--;

    return result.entry;
  }

  async doDelete(ref: BookRef, id: string): Promise<void> {
    if (!this.activeTx) {
      return this.runTransaction(async () => this.doDeleteInTx(ref, id));
    }
    return this.doDeleteInTx(ref, id);
  }

  private async doDeleteInTx(ref: BookRef, id: string): Promise<void> {
    const tx = this.requireTx();

    tx.depth++;
    if (tx.depth > MAX_CASCADE_DEPTH) {
      throw new Error(
        `[stacks] Maximum cascade depth (${MAX_CASCADE_DEPTH}) exceeded.`,
      );
    }

    const needPrev = this.cdc.hasWatchers(ref.ownerId, ref.book);
    const result = tx.backendTx.delete(ref, id, { withPrev: needPrev });

    if (!result.found) {
      tx.depth--;
      return; // Silent no-op
    }

    const event: BufferedEvent = {
      ref: `${ref.ownerId}/${ref.book}`,
      ownerId: ref.ownerId,
      book: ref.book,
      docId: id,
      type: 'delete',
      prev: result.prev,
    };
    tx.eventBuffer.push(event);

    await this.cdc.firePhase1(ref.ownerId, ref.book, {
      type: 'delete', ownerId: ref.ownerId, book: ref.book, id, prev: result.prev!,
    });

    tx.depth--;
  }

  // ── Read operations ───────────────────────────────────────────────

  doGet(ref: BookRef, id: string): BookEntry | null {
    if (this.activeTx) {
      return this.activeTx.backendTx.get(ref, id);
    }
    // Outside a transaction — use a throwaway read transaction
    const tx = this.backend.beginTransaction();
    try {
      const result = tx.get(ref, id);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  async doFind(ref: BookRef, query: BookQuery): Promise<BookEntry[]> {
    // Handle OR queries at the apparatus level
    if (query.where && !Array.isArray(query.where) && 'or' in query.where) {
      return this.doFindOr(ref, query);
    }

    const internal = translateQuery(query as BookQuery & { where?: WhereClause });
    if (this.activeTx) {
      return this.activeTx.backendTx.find(ref, internal);
    }
    const tx = this.backend.beginTransaction();
    try {
      const result = tx.find(ref, internal);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  /**
   * OR queries: run each branch as a separate backend query, deduplicate
   * by id, re-sort, and paginate the merged result set.
   *
   * V1 trade-off: when called outside an active transaction, each branch
   * opens its own throwaway read transaction. For synchronous backends
   * like better-sqlite3, the data can't change between branches so this
   * is safe. A hypothetical async backend could see different snapshots
   * per branch, producing inconsistent results — a known limitation
   * documented in the spec's implementation notes.
   *
   * Performance note: each branch is a separate backend query. count()
   * with OR cannot use the backend's efficient count path since
   * deduplication requires knowing which IDs overlap. Acceptable for v1.
   */
  private async doFindOr(ref: BookRef, query: BookQuery): Promise<BookEntry[]> {
    const orClauses = (query.where as { or: WhereClause[] }).or;

    if (orClauses.length === 0) return [];

    const seen = new Set<string>();
    const merged: BookEntry[] = [];

    const runBranch = (branch: WhereClause): BookEntry[] => {
      const branchQuery = translateQuery({ where: branch } as BookQuery & { where?: WhereClause });
      if (this.activeTx) {
        return this.activeTx.backendTx.find(ref, branchQuery);
      }
      const tx = this.backend.beginTransaction();
      try {
        const result = tx.find(ref, branchQuery);
        tx.commit();
        return result;
      } catch (err) {
        tx.rollback();
        throw err;
      }
    };

    for (const branch of orClauses) {
      const results = runBranch(branch);
      for (const entry of results) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
    }

    // Apply sorting
    if (query.orderBy) {
      const orderEntries = normalizeOrderBy(query.orderBy);
      merged.sort((a, b) => compareByOrderEntries(a, b, orderEntries));
    }

    // Apply pagination
    let result = merged;
    if (query.offset !== undefined) {
      result = result.slice(query.offset);
    }
    if (query.limit !== undefined) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  async doCount(ref: BookRef, where?: WhereClause | { or: WhereClause[] }): Promise<number> {
    // Handle OR queries — must deduplicate, so use doFindOr
    if (where && !Array.isArray(where) && 'or' in where) {
      const results = await this.doFindOr(ref, { where } as BookQuery);
      return results.length;
    }

    const internal = translateWhereClause(where as WhereClause | undefined);
    if (this.activeTx) {
      return this.activeTx.backendTx.count(ref, internal);
    }
    const tx = this.backend.beginTransaction();
    try {
      const result = tx.count(ref, internal);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  private requireTx(): ActiveTransaction {
    if (!this.activeTx) {
      throw new Error('[stacks] Write operation outside transaction — this is a bug');
    }
    return this.activeTx;
  }
}

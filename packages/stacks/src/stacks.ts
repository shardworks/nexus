/**
 * The Stacks — apparatus implementation.
 *
 * Wires together the backend, CDC registry, and transaction model
 * to provide the StacksApi `provides` object.
 *
 * See: docs/architecture/apparatus/stacks.md
 */

import type {
  StartupContext,
  LoadedPlugin,
  Plugin,
} from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';

import type {
  Book,
  BookEntry,
  BookQuery,
  BookSchema,
  ChangeHandler,
  ListOptions,
  OrderBy,
  ReadOnlyBook,
  StacksApi,
  TransactionContext,
  WatchOptions,
  WhereClause,
} from './types.ts';

import type {
  BackendTransaction,
  BookRef,
  InternalQuery,
  StacksBackend,
} from './backend.ts';

import { CdcRegistry, coalesceEvents, type BufferedEvent } from './cdc.ts';
import { translateListOptions, translateQuery, translateWhereClause } from './query.ts';
import { SqliteBackend } from './sqlite-backend.ts';

// ── Constants ────────────────────────────────────────────────────────

const MAX_CASCADE_DEPTH = 16;

// ── Active transaction state ──────────────────────────────────────────

interface ActiveTransaction {
  backendTx: BackendTransaction;
  eventBuffer: BufferedEvent[];
  depth: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeOrderBy(
  orderBy: OrderBy,
): Array<{ field: string; dir: 'asc' | 'desc' }> {
  if (typeof orderBy[0] === 'string') {
    const [field, dir] = orderBy as [string, 'asc' | 'desc'];
    return [{ field, dir }];
  }
  return (orderBy as Array<[string, 'asc' | 'desc']>).map(([field, dir]) => ({
    field,
    dir,
  }));
}

function getNestedField(entry: BookEntry, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = entry;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Book handle implementation ────────────────────────────────────────

function createBookHandle<T extends BookEntry>(
  ref: BookRef,
  stacks: StacksImpl,
  writable: boolean,
): Book<T> {
  const readMethods: ReadOnlyBook<T> = {
    async get(id: string): Promise<T | null> {
      return stacks.doGet(ref, id) as T | null;
    },

    async find(query: BookQuery): Promise<T[]> {
      return stacks.doFind(ref, query) as Promise<T[]>;
    },

    async list(options?: ListOptions): Promise<T[]> {
      return stacks.doFind(ref, { ...options } as BookQuery) as Promise<T[]>;
    },

    async count(where?: WhereClause | { or: WhereClause[] }): Promise<number> {
      return stacks.doCount(ref, where);
    },
  };

  if (!writable) {
    return readMethods as Book<T>;
  }

  return {
    ...readMethods,

    async put(entry: T): Promise<void> {
      await stacks.doPut(ref, entry);
    },

    async patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<T> {
      return (await stacks.doPatch(ref, id, fields as Record<string, unknown>)) as T;
    },

    async delete(id: string): Promise<void> {
      await stacks.doDelete(ref, id);
    },
  };
}

// ── Stacks implementation ─────────────────────────────────────────────

class StacksImpl {
  private readonly cdc = new CdcRegistry();
  private activeTx: ActiveTransaction | null = null;

  constructor(private readonly backend: StacksBackend) {}

  // ── Startup ───────────────────────────────────────────────────────

  start(_: StartupContext): void {
    const g = guild();
    const config = g.config<{ autoMigrate?: boolean }>('stacks');
    const autoMigrate = config.autoMigrate ?? true;

    this.backend.open({ home: g.home });

    if (autoMigrate) {
      const allPlugins = [...g.kits(), ...g.apparatuses()];
      this.reconcileSchemas(allPlugins);
    }
  }

  stop(): void {
    this.backend.close();
  }

  private reconcileSchemas(plugins: LoadedPlugin[]): void {
    for (const plugin of plugins) {
      const books = this.extractBooks(plugin);
      for (const [bookName, schema] of Object.entries(books)) {
        this.backend.ensureBook({ ownerId: plugin.id, book: bookName }, schema);
      }
    }
  }

  private extractBooks(
    plugin: LoadedPlugin,
  ): Record<string, BookSchema> {
    // Kits have a `kit` property, apparatuses have an `apparatus` property
    const source = 'kit' in plugin
      ? plugin.kit
      : 'apparatus' in plugin && plugin.apparatus.supportKit
        ? plugin.apparatus.supportKit
        : null;

    if (!source) return {};
    return ((source as Record<string, unknown>).books ?? {}) as Record<string, BookSchema>;
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

      // Fire Phase 2 handlers (after commit)
      await this.cdc.firePhase2(coalesced);

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
    this.cdc.lock();

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
    this.cdc.lock();

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
    this.cdc.lock();

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
      merged.sort((a, b) => {
        for (const { field, dir } of orderEntries) {
          const va = getNestedField(a, field);
          const vb = getNestedField(b, field);
          if (va === vb) continue;
          if (va == null) return dir === 'asc' ? -1 : 1;
          if (vb == null) return dir === 'asc' ? 1 : -1;
          const cmp = va < vb ? -1 : 1;
          return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
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

// ── Apparatus export ──────────────────────────────────────────────────

export function createStacksApparatus(
  backend?: StacksBackend,
): Plugin {
  const impl = new StacksImpl(backend ?? new SqliteBackend());
  // Placeholder api — populated during start()
  let api: StacksApi;

  return {
    apparatus: {
      requires: [],
      consumes: ['books'],

      get provides() { return api; },

      start(ctx: StartupContext): void {
        impl.start(ctx);
        api = impl.createApi();
      },

      stop(): void {
        impl.stop();
      },
    },
  };
}

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
  ReadOnlyBook,
  StacksApi,
  TransactionContext,
  WatchOptions,
  WhereClause,
} from './types.ts';

import type {
  BackendTransaction,
  BookRef,
  StacksBackend,
} from './backend.ts';

import { CdcRegistry, coalesceEvents, type BufferedEvent } from './cdc.ts';
import { translateListOptions, translateQuery, translateWhereClause } from './query.ts';
import { SqliteBackend } from './sqlite-backend.ts';

// ── Active transaction state ──────────────────────────────────────────

interface ActiveTransaction {
  backendTx: BackendTransaction;
  eventBuffer: BufferedEvent[];
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
      return stacks.doFind(ref, translateQuery(query)) as T[];
    },

    async list(options?: ListOptions): Promise<T[]> {
      return stacks.doFind(ref, translateListOptions(options)) as T[];
    },

    async count(where?: WhereClause): Promise<number> {
      return stacks.doCount(ref, translateWhereClause(where));
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
    // If already in a transaction, just run (no nesting)
    if (this.activeTx) {
      const txCtx = this.createTransactionContext();
      return fn(txCtx);
    }

    // Create new transaction
    const backendTx = this.backend.beginTransaction();
    const eventBuffer: BufferedEvent[] = [];
    this.activeTx = { backendTx, eventBuffer };

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

    const needPrev = this.cdc.hasWatchers(ref.ownerId, ref.book);
    const result = tx.backendTx.delete(ref, id, { withPrev: needPrev });

    if (!result.found) return; // Silent no-op

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

  doFind(ref: BookRef, query: import('./backend.ts').InternalQuery): BookEntry[] {
    if (this.activeTx) {
      return this.activeTx.backendTx.find(ref, query);
    }
    const tx = this.backend.beginTransaction();
    try {
      const result = tx.find(ref, query);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  doCount(ref: BookRef, query: import('./backend.ts').InternalQuery): number {
    if (this.activeTx) {
      return this.activeTx.backendTx.count(ref, query);
    }
    const tx = this.backend.beginTransaction();
    try {
      const result = tx.count(ref, query);
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

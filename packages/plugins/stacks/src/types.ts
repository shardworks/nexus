/**
 * The Stacks — public API types.
 *
 * These types form the contract between The Stacks apparatus and all
 * consuming plugins. No SQLite types, no implementation details.
 *
 * See: docs/specification.md
 */

// ── Plugin config ────────────────────────────────────────────────────

/** Plugin configuration stored at guild.json["stacks"]. */
export interface StacksConfig {
  /**
   * Automatically apply pending database migrations when the Books are opened.
   * Defaults to `true` when not specified.
   */
  autoMigrate?: boolean;
}

// Augment GuildConfig so `guild().config('stacks')` returns StacksConfig
// without requiring a manual type parameter at the call site.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    stacks?: StacksConfig;
  }
}

// ── Document model ────────────────────────────────────────────────────

/** Every document stored in a book must satisfy this constraint. */
export type BookEntry = { id: string } & Record<string, unknown>;

// ── Book schema declaration ───────────────────────────────────────────

/**
 * Schema declaration for a single book in a kit's `books` contribution.
 *
 * `indexes` is a list of fields to create efficient query indexes for.
 * Field names use plain notation ('status') or dot-notation for nested
 * fields ('parent.id'). The Stacks translates internally.
 */
export interface BookSchema {
  indexes?: (string | string[])[];
}

// ── Query language ────────────────────────────────────────────────────

export type Scalar = string | number | boolean | null;

export type WhereCondition =
  | [field: string, op: '=' | '!=', value: Scalar]
  | [field: string, op: '>' | '>=' | '<' | '<=', value: number | string]
  | [field: string, op: 'LIKE', value: string]
  | [field: string, op: 'IN', value: Scalar[]]
  | [field: string, op: 'IS NULL' | 'IS NOT NULL'];

export type WhereClause = WhereCondition[];

export type OrderEntry = [field: string, direction: 'asc' | 'desc'];
export type OrderBy = OrderEntry | OrderEntry[];

export type Pagination =
  | { limit: number; offset?: number }
  | { limit?: never; offset?: never };

export type BookQuery = {
  where?: WhereClause | { or: WhereClause[] };
  orderBy?: OrderBy;
} & Pagination;

export type ListOptions = {
  orderBy?: OrderBy;
} & Pagination;

// ── Book handles ──────────────────────────────────────────────────────

/** Read-only view of a book — returned by `readBook()` for cross-plugin access. */
export interface ReadOnlyBook<T extends BookEntry> {
  get(id: string): Promise<T | null>;
  find(query: BookQuery): Promise<T[]>;
  list(options?: ListOptions): Promise<T[]>;
  count(where?: WhereClause | { or: WhereClause[] }): Promise<number>;
}

/** Writable book handle — returned by `book()` for own-plugin access. */
export interface Book<T extends BookEntry> extends ReadOnlyBook<T> {
  /**
   * Upsert a document. Creates if `entry.id` is new; replaces entirely
   * if it already exists. Fires a `create` or `update` CDC event.
   */
  put(entry: T): Promise<void>;

  /**
   * Partially update a document. Merges top-level fields into the existing
   * document. Throws if the document does not exist. Returns the updated
   * document. Fires an `update` CDC event.
   */
  patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<T>;

  /**
   * Delete a document by id. Silent no-op if it does not exist.
   * Fires a `delete` CDC event only if the document existed.
   */
  delete(id: string): Promise<void>;
}

// ── Change Data Capture (CDC) ─────────────────────────────────────────

export interface CreateEvent<T extends BookEntry> {
  type: 'create';
  ownerId: string;
  book: string;
  entry: T;
}

export interface UpdateEvent<T extends BookEntry> {
  type: 'update';
  ownerId: string;
  book: string;
  entry: T;
  prev: T;
}

export interface DeleteEvent<T extends BookEntry> {
  type: 'delete';
  ownerId: string;
  book: string;
  id: string;
  prev: T;
}

export type ChangeEvent<T extends BookEntry> =
  | CreateEvent<T>
  | UpdateEvent<T>
  | DeleteEvent<T>;

export type ChangeHandler<T extends BookEntry = BookEntry> = (
  event: ChangeEvent<T>,
) => Promise<void> | void;

export interface WatchOptions {
  /**
   * Controls when the handler runs relative to the transaction commit.
   *
   * true  (default) — Phase 1: runs INSIDE the transaction. Handler writes
   *   join the same transaction. If the handler throws, everything rolls back.
   *
   * false — Phase 2: runs AFTER the transaction commits. Errors are logged
   *   as warnings but do not affect committed data.
   *
   * @default true
   */
  failOnError?: boolean;
}

// ── StacksApi — the `provides` interface ──────────────────────────────

export interface TransactionContext {
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>;
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>;
}

export interface StacksApi {
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>;
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>;

  watch<T extends BookEntry>(
    ownerId: string,
    bookName: string,
    handler: ChangeHandler<T>,
    options?: WatchOptions,
  ): void;

  transaction<R>(fn: (tx: TransactionContext) => Promise<R>): Promise<R>;
}

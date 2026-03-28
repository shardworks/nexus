/**
 * Book — the NoSQL document store primitive for rig authors.
 *
 * A Book is a named, schemaless collection of JSON documents. Content types
 * must include `id: string` — rig authors own ID generation and include it
 * as part of their domain type. No framework-managed envelope or timestamps.
 *
 * Books are declared in the rig's `Rig` export via `books?: Record<string, BookOptions>`.
 * Mainspring creates the backing SQLite tables and indexes at startup.
 *
 * Rig authors access books through `RigContext.book()` and `RigContext.rigBook()`.
 * The storage backend (SQLite) is an implementation detail — field names in
 * indexes and queries use plain dot-notation, not JSONPath syntax.
 */

/**
 * Pagination options for `Book.find()` and `Book.list()`.
 *
 * `offset` requires `limit` — passing offset alone is a type error.
 * This mirrors SQLite's requirement and makes the constraint explicit at
 * the call site rather than silently patching it in the adapter.
 */
export type Pagination =
  | { limit: number; offset?: number }
  | { limit?: never; offset?: never };

/**
 * Query options for `Book.find()`.
 */
export type BookQuery = {
  /**
   * Field equality filters, ANDed together.
   *
   * Use plain field names or dot notation for nested fields.
   * The storage adapter handles translation internally.
   *
   * @example { status: 'active', anima: 'vera' }
   * @example { 'parent.id': '123' }
   */
  where?: Record<string, unknown>;

  /**
   * Field to sort by. Plain name or dot notation for nested fields.
   * @example 'createdAt'
   * @example 'parent.id'
   */
  orderBy?: string;

  /** Sort direction. Defaults to 'asc'. */
  order?: 'asc' | 'desc';
} & Pagination;

/** Options for `Book.list()` — pagination and sorting without a where clause. */
export type ListOptions = {
  orderBy?: string;
  order?: 'asc' | 'desc';
} & Pagination;

/**
 * A document collection — the primary Books API surface for rig authors.
 *
 * `T` must extend `{ id: string }` — the id is part of the content type,
 * not a framework-managed wrapper. Rig authors generate IDs (e.g. ULIDs)
 * and include them in the content passed to `put()`.
 *
 * Obtained via `RigContext.book<T>(name)` for own-rig books or
 * `RigContext.rigBook<T>(rigId, name)` for cross-rig read access.
 */
export interface Book<T extends { id: string }> {
  /**
   * Upsert a document. Creates if `content.id` is new; replaces the stored
   * document entirely if it already exists.
   */
  put(content: T): Promise<void>;

  /**
   * Get a document by id. Returns null if not found.
   */
  get(id: string): Promise<T | null>;

  /**
   * Delete a document by id. Silent no-op if the document does not exist.
   */
  delete(id: string): Promise<void>;

  /**
   * Find documents matching a query.
   *
   * All `where` conditions are ANDed. Results are returned as `T[]` — no
   * envelope, no metadata wrapper.
   */
  find(query: BookQuery): Promise<T[]>;

  /**
   * List all documents, optionally paginated and sorted.
   * Equivalent to `find()` with no `where` clause.
   */
  list(options?: ListOptions): Promise<T[]>;

  /**
   * Count documents matching an optional where clause.
   * Efficient — does not fetch payloads.
   */
  count(where?: BookQuery['where']): Promise<number>;
}

/**
 * Read-only view of a Book — returned by `RigContext.rigBook()` for cross-rig access.
 *
 * Omits write operations (`put`, `delete`). Rig authors should not write to
 * another rig's books.
 */
export type ReadOnlyBook<T extends { id: string }> = Pick<
  Book<T>,
  'get' | 'find' | 'list' | 'count'
>;

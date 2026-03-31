/**
 * BooksDatabase — the framework's SQL abstraction layer.
 *
 * Defines the interface and the initial SQLite adapter backed by better-sqlite3.
 * Future adapters (libsql, pg) keyed to URL scheme are not yet in scope.
 *
 * ## Usage
 *
 * Framework internals access the database through `Arbor.getDatabase()`.
 * The returned `BooksDatabase` instance is cached for the process lifetime.
 *
 * The higher-level Books (NoSQL document store) API will be exposed to
 * rig/tool authors via `ToolContext`. Raw SQL access via `BooksDatabase`
 * is internal to the framework.
 */

import path from 'node:path';
import Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A row returned from a SELECT query.
 * Column names are the keys; values are SQLite primitives.
 */
export type SqlRow = Record<string, unknown>;

/**
 * Result of executing a SQL statement.
 *
 * Shaped after libsql's `ResultSet` for future adapter familiarity:
 * - SELECT: `rows` populated, `rowsAffected = 0`, `lastInsertRowid = undefined`
 * - INSERT/UPDATE/DELETE: `rows = []`, `rowsAffected` and `lastInsertRowid` populated
 */
export interface SqlResult {
  /** Returned rows. Non-empty for SELECT; empty for mutations. */
  rows: SqlRow[];
  /** Column names in declaration order. Populated for SELECT; empty for mutations. */
  columns: string[];
  /** Number of rows affected by an INSERT/UPDATE/DELETE. Zero for SELECT. */
  rowsAffected: number;
  /**
   * Last insert row ID as reported by SQLite after a mutation or DDL statement.
   * For INSERT, this is the rowid of the inserted row. For UPDATE, DELETE, and
   * DDL, SQLite returns the last INSERT rowid on the connection (which may be 0n
   * if no INSERT has occurred). Always `undefined` for SELECT.
   */
  lastInsertRowid: bigint | undefined;
}

/**
 * Abstract database interface for the guild's Books (`.nexus/nexus.db`).
 *
 * A single `execute()` method handles both queries and mutations.
 * Returns a Promise for async-compatibility; the SQLite adapter resolves
 * synchronously. Future adapters (libsql, pg) are truly async.
 */
export interface BooksDatabase {
  /**
   * Execute a SQL statement with optional positional arguments.
   *
   * Works for both queries (SELECT) and mutations (INSERT/UPDATE/DELETE).
   * Parameters are bound positionally via `?` placeholders.
   */
  execute(sql: string, args?: unknown[]): Promise<SqlResult>;
}

// ── SQLite adapter ─────────────────────────────────────────────────────

/**
 * SQLite adapter for BooksDatabase backed by better-sqlite3.
 *
 * Wraps better-sqlite3's synchronous API in resolved Promises.
 * One instance per process — share via `Arbor.getDatabase()`.
 *
 * Connection settings applied at open time:
 * - `foreign_keys = ON`  — enforce referential integrity
 * - `journal_mode = WAL` — allow concurrent reads during writes
 */
export class SqliteAdapter implements BooksDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
  }

  execute(sql: string, args: unknown[] = []): Promise<SqlResult> {
    const stmt = this.db.prepare(sql);

    // `stmt.reader` is true for SELECT-like statements (returns rows) and false
    // for mutations and DDL. We use it to branch without parsing the SQL text.
    // Note: `stmt.columns()` cannot be used here — it throws for DDL statements
    // like CREATE TABLE / CREATE INDEX, not just for mutations.
    const columns = stmt.reader ? stmt.columns().map((c) => c.name) : [];

    if (stmt.reader) {
      // Query — return rows
      const rows = stmt.all(...(args as Parameters<typeof stmt.all>)) as SqlRow[];
      return Promise.resolve({
        rows,
        columns,
        rowsAffected: 0,
        lastInsertRowid: undefined,
      });
    } else {
      // Mutation — return affected count and last insert ID
      const result = stmt.run(...(args as Parameters<typeof stmt.run>));
      return Promise.resolve({
        rows: [],
        columns: [],
        rowsAffected: result.changes,
        lastInsertRowid: BigInt(result.lastInsertRowid),
      });
    }
  }
}

// ── Path helpers ───────────────────────────────────────────────────────

/**
 * Absolute path to the guild's Books SQLite database.
 *
 * Canonical definition lives here — this is an internal arbor detail.
 * Do not re-export from the core public barrel; consumers should go through
 * the Books abstraction (RigContext.book()), not the raw path.
 */
export function booksPath(home: string): string {
  return path.join(home, '.nexus', 'nexus.db');
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Open the guild's Books database for the given guild root.
 *
 * Creates a `SqliteAdapter` pointed at `.nexus/nexus.db` with standard
 * connection pragmas applied. The Arbor caches the returned instance
 * for the process lifetime.
 */
export function openBooksDatabase(home: string): BooksDatabase {
  return new SqliteAdapter(booksPath(home));
}

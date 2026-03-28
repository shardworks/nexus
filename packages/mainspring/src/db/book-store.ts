/**
 * BookStore — SQLite-backed implementation of the `Book<T>` interface.
 *
 * One BookStore per (rig, book-name) pair. Table names are scoped by rig key:
 *   books_<rig-key>_<book-name>
 *
 * Field names in queries and indexes use plain dot-notation ('status',
 * 'parent.id'). This module translates them to JSONPath for json_extract()
 * internally — callers never see $.field syntax.
 *
 * Tables are created by `reconcileBooks()` before any BookStore is used.
 */

import type { Book, BookQuery, ListOptions } from '@shardworks/nexus-core';
import type { BooksDatabase } from './sqlite-adapter.ts';

// ── Field → JSONPath translation ───────────────────────────────────────

/**
 * Allowlist pattern for field names / dot-notation paths.
 *
 * Permits alphanumeric characters, underscores, hyphens, and dots (for
 * nested paths like 'parent.id'). Anything else is rejected before it can
 * reach a SQL string interpolation site.
 */
const SAFE_FIELD_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate a field name or dot-notation path against the allowlist.
 * Throws immediately if the value contains characters outside the safe set,
 * preventing injection through json_extract() path interpolation.
 *
 * Exported for use by other db-layer modules (e.g. reconcile-books) that also
 * interpolate field names into SQL strings. Not part of the public API barrel.
 */
export function validateFieldName(field: string): string {
  if (!SAFE_FIELD_RE.test(field)) {
    throw new Error(`BookStore: unsafe field name rejected: "${field}"`);
  }
  return field;
}

/**
 * Translate a plain field name or dot-notation path to a JSONPath expression.
 *
 * 'status'    → '$.status'
 * 'parent.id' → '$.parent.id'
 *
 * This is the sole place where the SQLite json_extract() path format leaks
 * from storage into application logic. Callers use plain field names only.
 *
 * The field is validated against SAFE_FIELD_RE before interpolation to
 * prevent SQL injection through the json_extract() path argument.
 */
function toJsonPath(field: string): string {
  return '$.' + validateFieldName(field);
}

// ── Query builder ──────────────────────────────────────────────────────

interface QueryParts {
  sql: string;
  args: unknown[];
}

function buildWhereClause(where: Record<string, unknown>): QueryParts {
  const conditions: string[] = [];
  const args: unknown[] = [];

  for (const [field, value] of Object.entries(where)) {
    conditions.push(`json_extract(content, '${toJsonPath(field)}') = ?`);
    args.push(value);
  }

  return {
    sql: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    args,
  };
}

// ── BookStore ──────────────────────────────────────────────────────────

/**
 * SQLite-backed Book<T> implementation.
 *
 * Constructed by `Mainspring.createRigContext()` — not instantiated directly
 * by rig authors.
 */
export class BookStore<T extends { id: string }> implements Book<T> {
  constructor(
    private readonly db: BooksDatabase,
    private readonly tableName: string,
  ) {}

  async put(content: T): Promise<void> {
    const json = JSON.stringify(content);
    await this.db.execute(
      `INSERT INTO "${this.tableName}" (id, content) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
      [content.id, json],
    );
  }

  async get(id: string): Promise<T | null> {
    const result = await this.db.execute(
      `SELECT content FROM "${this.tableName}" WHERE id = ?`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return JSON.parse(result.rows[0]!.content as string) as T;
  }

  async delete(id: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM "${this.tableName}" WHERE id = ?`,
      [id],
    );
  }

  async find(query: BookQuery): Promise<T[]> {
    const args: unknown[] = [];
    let sql = `SELECT content FROM "${this.tableName}"`;

    if (query.where && Object.keys(query.where).length > 0) {
      const where = buildWhereClause(query.where);
      sql += where.sql;
      args.push(...where.args);
    }

    if (query.orderBy) {
      const dir = query.order === 'desc' ? 'DESC' : 'ASC';
      // toJsonPath() validates query.orderBy against SAFE_FIELD_RE before interpolation.
      sql += ` ORDER BY json_extract(content, '${toJsonPath(query.orderBy)}') ${dir}`;
    }

    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(query.limit);
    } else if (query.offset !== undefined) {
      // SQLite requires LIMIT when OFFSET is present. Use -1 to mean "no limit".
      sql += ' LIMIT -1';
    }

    if (query.offset !== undefined) {
      sql += ' OFFSET ?';
      args.push(query.offset);
    }

    const result = await this.db.execute(sql, args);
    return result.rows.map((row) => JSON.parse(row.content as string) as T);
  }

  async list(options?: ListOptions): Promise<T[]> {
    return this.find({ ...options });
  }

  async count(where?: BookQuery['where']): Promise<number> {
    const args: unknown[] = [];
    let sql = `SELECT COUNT(*) AS n FROM "${this.tableName}"`;

    if (where && Object.keys(where).length > 0) {
      const clause = buildWhereClause(where);
      sql += clause.sql;
      args.push(...clause.args);
    }

    const result = await this.db.execute(sql, args);
    return Number(result.rows[0]?.n ?? 0);
  }
}

// ── Table name utilities ───────────────────────────────────────────────

/**
 * Allowlist pattern for book names.
 *
 * Book names are framework-controlled identifiers (declared in rig manifests)
 * and should always be safe. We validate rather than normalize so that a
 * malformed book name surfaces as a loud error rather than a silent mutation.
 */
const SAFE_BOOK_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Normalize a rig key into a string safe for use as a SQLite table-name segment.
 *
 * Rig keys are derived from npm package names by `deriveRigKey()` and may
 * contain characters that are awkward in SQL identifiers:
 *   - `/`  — scope separator in third-party keys  (e.g. 'acme/my-rig')
 *   - `-`  — standard in npm package names
 *   - `.`  — rare but valid in npm package names
 *
 * `/` is mapped to `__` (double underscore) to preserve the structural
 * distinction between the scope separator and ordinary hyphens/underscores.
 * All remaining characters outside `[a-z0-9_]` are replaced with `_`.
 * The result is safe as either a plain or double-quoted SQL identifier.
 *
 * @example normalizeRigKey('nexus-ledger') → 'nexus_ledger'
 * @example normalizeRigKey('acme/my-rig')  → 'acme__my_rig'
 */
function normalizeRigKey(rigKey: string): string {
  return rigKey.replace(/\//g, '__').replace(/[^a-z0-9_]/g, '_');
}

/**
 * Derive the SQLite table name for a rig book.
 *
 * Format: books_<normalized-rig-key>_<book-name>
 *
 * The rig key is normalized via `normalizeRigKey()` — slashes, hyphens, and
 * other non-identifier characters become underscores. Book names are validated
 * against SAFE_BOOK_NAME_RE and must already be safe identifiers.
 *
 * @example booksTableName('nexus-ledger', 'writs') → 'books_nexus_ledger_writs'
 * @example booksTableName('acme/my-rig', 'data')   → 'books_acme__my_rig_data'
 */
export function booksTableName(rigKey: string, bookName: string): string {
  if (!SAFE_BOOK_NAME_RE.test(bookName)) {
    throw new Error(`BookStore: unsafe book name rejected: "${bookName}"`);
  }
  return `books_${normalizeRigKey(rigKey)}_${bookName}`;
}

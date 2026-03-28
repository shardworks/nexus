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
 * Translate a plain field name or dot-notation path to a JSONPath expression.
 *
 * 'status'    → '$.status'
 * 'parent.id' → '$.parent.id'
 *
 * This is the sole place where the SQLite json_extract() path format leaks
 * from storage into application logic. Callers use plain field names only.
 */
function toJsonPath(field: string): string {
  return '$.' + field;
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
      sql += ` ORDER BY json_extract(content, '${toJsonPath(query.orderBy)}') ${dir}`;
    }

    if (query.limit !== undefined) {
      sql += ' LIMIT ?';
      args.push(query.limit);
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
 * Derive the SQLite table name for a rig book.
 *
 * Format: books_<rig-key>_<book-name>
 *
 * The table name is always used quoted ("tableName") in SQL, so hyphens and
 * slashes in rig keys are safe. No sanitization needed.
 *
 * @example booksTableName('nexus-ledger', 'writs') → 'books_nexus-ledger_writs'
 * @example booksTableName('acme/my-rig', 'data')  → 'books_acme/my-rig_data'
 */
export function booksTableName(rigKey: string, bookName: string): string {
  return `books_${rigKey}_${bookName}`;
}

/**
 * SQLite backend for The Stacks — backed by better-sqlite3.
 *
 * Implements the StacksBackend interface. All SQLite-specific details
 * (json_extract, table naming, WAL mode) are encapsulated here.
 *
 * Documents are stored as JSON blobs in a `content` TEXT column.
 * Field queries use json_extract() against declared indexes.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

import type {
  BackendOptions,
  BackendTransaction,
  BookRef,
  CountQuery,
  DeleteResult,
  InternalCondition,
  InternalQuery,
  PatchResult,
  PutResult,
  StacksBackend,
} from './backend.ts';
import type { BookEntry, BookSchema } from './types.ts';
import { validateFieldName } from './query.ts';

// ── Table naming ──────────────────────────────────────────────────────

const SAFE_BOOK_NAME_RE = /^[A-Za-z0-9_-]+$/;

function normalizeOwnerId(ownerId: string): string {
  return ownerId.replace(/\//g, '__').replace(/[^a-z0-9_]/g, '_');
}

function tableName(ref: BookRef): string {
  if (!SAFE_BOOK_NAME_RE.test(ref.book)) {
    throw new Error(`[stacks/sqlite] Unsafe book name rejected: "${ref.book}"`);
  }
  return `books_${normalizeOwnerId(ref.ownerId)}_${ref.book}`;
}

// ── JSON path helpers ─────────────────────────────────────────────────

function toJsonPath(field: string): string {
  return '$.' + validateFieldName(field);
}

function jsonExtract(field: string): string {
  return `json_extract(content, '${toJsonPath(field)}')`;
}

// ── Query builder ─────────────────────────────────────────────────────

interface SqlParts {
  sql: string;
  args: unknown[];
}

/**
 * Coerce a public `Scalar` value to a type that better-sqlite3 accepts.
 *
 * better-sqlite3 accepts: string | number | bigint | Buffer | null.
 * The public Scalar contract also includes `boolean`, so we map:
 *   true  → 1  (matches json_extract's integer return for JSON booleans)
 *   false → 0
 *
 * Any value that is not a recognised Scalar type is a caller error;
 * we surface a Stacks-attributed message that names the offending field
 * so the developer can diagnose without spelunking into better-sqlite3.
 *
 * Exported for unit testing only — not part of the public API.
 */
export function bindScalar(field: string, value: unknown): string | number | bigint | Buffer | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(
    `[stacks/sqlite] Unsupported bind value for field "${field}": ${typeof value}`,
  );
}

function buildWhere(conditions?: InternalCondition[]): SqlParts {
  if (!conditions || conditions.length === 0) {
    return { sql: '', args: [] };
  }

  const clauses: string[] = [];
  const args: unknown[] = [];

  for (const cond of conditions) {
    const extract = jsonExtract(cond.field);

    switch (cond.op) {
      case 'eq':
        clauses.push(`${extract} = ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'neq':
        clauses.push(`${extract} != ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'gt':
        clauses.push(`${extract} > ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'gte':
        clauses.push(`${extract} >= ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'lt':
        clauses.push(`${extract} < ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'lte':
        clauses.push(`${extract} <= ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'like':
        clauses.push(`${extract} LIKE ?`);
        args.push(bindScalar(cond.field, cond.value));
        break;
      case 'in': {
        if (cond.values.length === 0) {
          // Empty IN always returns false
          clauses.push('0');
        } else {
          const placeholders = cond.values.map(() => '?').join(', ');
          clauses.push(`${extract} IN (${placeholders})`);
          args.push(...cond.values.map(v => bindScalar(cond.field, v)));
        }
        break;
      }
      case 'isNull':
        clauses.push(`${extract} IS NULL`);
        break;
      case 'isNotNull':
        clauses.push(`${extract} IS NOT NULL`);
        break;
    }
  }

  return {
    sql: ` WHERE ${clauses.join(' AND ')}`,
    args,
  };
}

function buildOrderBy(
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>,
): string {
  if (!orderBy || orderBy.length === 0) return '';
  const parts = orderBy.map(
    ({ field, dir }) => `${jsonExtract(field)} ${dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return ` ORDER BY ${parts.join(', ')}`;
}

function buildLimit(limit?: number, offset?: number): SqlParts {
  const args: unknown[] = [];
  let sql = '';
  if (limit !== undefined) {
    sql += ' LIMIT ?';
    args.push(limit);
  }
  if (offset !== undefined) {
    sql += ' OFFSET ?';
    args.push(offset);
  }
  return { sql, args };
}

// ── Parse helpers ─────────────────────────────────────────────────────

function parseRow(row: Record<string, unknown>): BookEntry {
  return JSON.parse(row.content as string) as BookEntry;
}

// ── SQLite Transaction ────────────────────────────────────────────────

class SqliteTransaction implements BackendTransaction {
  constructor(private readonly db: DB) {
    this.db.exec('BEGIN');
  }

  put(ref: BookRef, entry: BookEntry, opts?: { withPrev: boolean }): PutResult {
    const table = tableName(ref);
    const json = JSON.stringify(entry);

    let prev: BookEntry | undefined;
    let created = true;

    if (opts?.withPrev) {
      const existing = this.db
        .prepare(`SELECT content FROM "${table}" WHERE id = ?`)
        .get(entry.id) as { content: string } | undefined;

      if (existing) {
        prev = JSON.parse(existing.content) as BookEntry;
        created = false;
      }
    } else {
      // Still need to know if it's a create or update for CDC
      const exists = this.db
        .prepare(`SELECT 1 FROM "${table}" WHERE id = ?`)
        .get(entry.id);
      created = !exists;
    }

    this.db
      .prepare(
        `INSERT INTO "${table}" (id, content) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
      )
      .run(entry.id, json);

    return { created, prev };
  }

  patch(ref: BookRef, id: string, fields: Record<string, unknown>): PatchResult {
    const table = tableName(ref);

    const existing = this.db
      .prepare(`SELECT content FROM "${table}" WHERE id = ?`)
      .get(id) as { content: string } | undefined;

    if (!existing) {
      throw new Error(
        `[stacks] patch() failed: document "${id}" not found in ${ref.ownerId}/${ref.book}`,
      );
    }

    const prev = JSON.parse(existing.content) as BookEntry;
    const updated = { ...prev, ...fields, id } as BookEntry;
    const json = JSON.stringify(updated);

    this.db
      .prepare(`UPDATE "${table}" SET content = ? WHERE id = ?`)
      .run(json, id);

    return { entry: updated, prev };
  }

  delete(ref: BookRef, id: string, opts?: { withPrev: boolean }): DeleteResult {
    const table = tableName(ref);

    if (opts?.withPrev) {
      // Fetch-then-delete in one logical step. Safe because we're
      // inside an explicit transaction (synchronous better-sqlite3).
      const existing = this.db
        .prepare(`SELECT content FROM "${table}" WHERE id = ?`)
        .get(id) as { content: string } | undefined;

      if (!existing) return { found: false };

      this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
      return { found: true, prev: JSON.parse(existing.content) as BookEntry };
    }

    // No prev needed — just delete and check changes
    const result = this.db
      .prepare(`DELETE FROM "${table}" WHERE id = ?`)
      .run(id);

    return { found: result.changes > 0 };
  }

  get(ref: BookRef, id: string): BookEntry | null {
    const table = tableName(ref);
    const row = this.db
      .prepare(`SELECT content FROM "${table}" WHERE id = ?`)
      .get(id) as { content: string } | undefined;

    return row ? parseRow(row) : null;
  }

  find(ref: BookRef, query: InternalQuery): BookEntry[] {
    const table = tableName(ref);
    const where = buildWhere(query.where);
    const order = buildOrderBy(query.orderBy);
    const limit = buildLimit(query.limit, query.offset);

    const sql = `SELECT content FROM "${table}"${where.sql}${order}${limit.sql}`;
    const args = [...where.args, ...limit.args];

    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(parseRow);
  }

  count(ref: BookRef, query: CountQuery): number {
    const table = tableName(ref);
    const where = buildWhere(query.where);

    const sql = `SELECT COUNT(*) AS n FROM "${table}"${where.sql}`;
    const row = this.db.prepare(sql).get(...where.args) as { n: number };
    return row.n;
  }

  commit(): void {
    this.db.exec('COMMIT');
  }

  rollback(): void {
    this.db.exec('ROLLBACK');
  }
}

// ── SQLite Backend ────────────────────────────────────────────────────

export class SqliteBackend implements StacksBackend {
  private db: DB | null = null;

  open(options: BackendOptions): void {
    const dbPath = path.join(options.home, '.nexus', 'nexus.db');
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  ensureBook(ref: BookRef, schema: BookSchema): void {
    const db = this.requireDb();
    const table = tableName(ref);

    db.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (
        id      TEXT PRIMARY KEY,
        content TEXT NOT NULL
      )`,
    );

    for (const indexDef of schema.indexes ?? []) {
      if (Array.isArray(indexDef)) {
        // Compound index: ['status', 'createdAt'] or ['status', 'parent.id']
        const fields = indexDef.map(f => validateFieldName(f));
        const idxName = `idx_${table}_${fields.map(f => f.replace(/\./g, '_')).join('_')}`;
        const columns = fields.map(f => `json_extract(content, '${toJsonPath(f)}')`).join(', ');
        db.exec(
          `CREATE INDEX IF NOT EXISTS "${idxName}"
           ON "${table}"(${columns})`,
        );
      } else {
        // Single-field index
        const field = validateFieldName(indexDef);
        const idx = `idx_${table}_${field.replace(/\./g, '_')}`;
        const jsonPath = toJsonPath(field);
        db.exec(
          `CREATE INDEX IF NOT EXISTS "${idx}"
           ON "${table}"(json_extract(content, '${jsonPath}'))`,
        );
      }
    }
  }

  beginTransaction(): BackendTransaction {
    return new SqliteTransaction(this.requireDb());
  }

  async dropBook(ref: BookRef): Promise<void> {
    // Validate the book name through tableName() so a malformed ref
    // raises the same error here as it would on ensureBook/put/etc.,
    // rather than silently no-op'ing on an invalid identifier.
    const table = tableName(ref);
    const db = this.requireDb();
    // SQLite's DROP TABLE cascades indexes attached to the table, so
    // an explicit DROP INDEX loop would be unearned structure (D7).
    // IF EXISTS makes the call idempotent (D2).
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }

  private requireDb(): DB {
    if (!this.db) {
      throw new Error('[stacks/sqlite] Backend not open — call open() first');
    }
    return this.db;
  }
}

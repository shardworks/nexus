/**
 * reconcileBooks — ensure SQLite tables and indexes exist for all declared books.
 *
 * Called by the Mainspring after rigs are loaded. Additive only:
 * - Creates tables that don't yet exist (IF NOT EXISTS).
 * - Creates indexes that don't yet exist (IF NOT EXISTS).
 * - Never drops or modifies existing tables or indexes.
 *
 * Rig authors add books and indexes in new versions; they'll be created on
 * the next startup without any migration ceremony.
 */

import type { BooksDatabase } from './sqlite-adapter.ts';
import type { LoadedRig } from '../mainspring.ts';
import { booksTableName } from './book-store.ts';

/**
 * Translate a plain field name or dot-notation path to a JSONPath expression.
 * Kept local — reconciliation is the only place that writes index DDL.
 */
function toJsonPath(field: string): string {
  return '$.' + field;
}

/**
 * Derive a safe index name from a table name and field path.
 * Dots in field names (nested paths) are replaced with underscores.
 *
 * @example indexName('books_nexus-ledger_writs', 'parent.id') → 'idx_books_nexus-ledger_writs_parent_id'
 */
function indexName(tableName: string, field: string): string {
  return `idx_${tableName}_${field.replace(/\./g, '_')}`;
}

/**
 * Ensure all tables and indexes declared by the given rigs exist in the database.
 *
 * Safe to call on every startup — all DDL uses IF NOT EXISTS.
 */
export async function reconcileBooks(
  db: BooksDatabase,
  rigs: LoadedRig[],
): Promise<void> {
  for (const rig of rigs) {
    const books = rig.instance.books ?? {};

    for (const [bookName, schema] of Object.entries(books)) {
      const table = booksTableName(rig.key, bookName);

      // Create the table if it doesn't exist.
      // `id` is extracted from content and stored as the primary key.
      // `content` holds the full JSON document (including id).
      await db.execute(
        `CREATE TABLE IF NOT EXISTS "${table}" (
          id      TEXT PRIMARY KEY,
          content TEXT NOT NULL
        )`,
      );

      // Create each declared index if it doesn't exist.
      for (const field of schema.indexes ?? []) {
        const idx = indexName(table, field);
        const path = toJsonPath(field);
        await db.execute(
          `CREATE INDEX IF NOT EXISTS "${idx}"
           ON "${table}"(json_extract(content, '${path}'))`,
        );
      }
    }
  }
}

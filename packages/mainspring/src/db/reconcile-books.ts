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
import { booksTableName, validateFieldName } from './book-store.ts';

/**
 * Translate a plain field name or dot-notation path to a JSONPath expression.
 * Kept local — reconciliation is the only place that writes index DDL.
 *
 * Validates the field against the shared allowlist before interpolation to
 * prevent SQL injection through the json_extract() path argument.
 */
function toJsonPath(field: string): string {
  return '$.' + validateFieldName(field);
}

/**
 * Derive a safe index name from a table name and field path.
 * Dots in field names (nested paths) are replaced with underscores.
 *
 * Field names are validated by toJsonPath() before this is called, so the
 * field segment is guaranteed to contain only [A-Za-z0-9_.-] — no characters
 * that could escape the double-quoted identifier.
 *
 * @example indexName('books_nexus_ledger_writs', 'parent.id') → 'idx_books_nexus_ledger_writs_parent_id'
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

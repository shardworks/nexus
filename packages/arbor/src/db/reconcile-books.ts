/**
 * reconcileBooks — ensure SQLite tables and indexes exist for all declared books.
 *
 * Transitional: scans kit `books` contribution fields and creates the backing
 * SQLite tables and indexes if they don't exist. Will move to the nexus-books
 * apparatus when that ships. See: docs/architecture/apparatus/books.md
 *
 * Called by the Arbor after plugins are loaded and started. Additive only:
 * - Creates tables that don't yet exist (IF NOT EXISTS).
 * - Creates indexes that don't yet exist (IF NOT EXISTS).
 * - Never drops or modifies existing tables or indexes.
 */

import type { BooksDatabase } from './sqlite-adapter.ts';
import type { LoadedKit } from '@shardworks/nexus-core';
import type { BookOptions } from '@shardworks/nexus-core';
import { booksTableName, validateFieldName } from './book-store.ts';

/**
 * Translate a plain field name or dot-notation path to a JSONPath expression.
 */
function toJsonPath(field: string): string {
  return '$.' + validateFieldName(field);
}

/**
 * Derive a safe index name from a table name and field path.
 */
function indexName(tableName: string, field: string): string {
  return `idx_${tableName}_${field.replace(/\./g, '_')}`;
}

/**
 * Ensure all tables and indexes declared in kit `books` contributions exist.
 *
 * Scans each kit's `books` contribution field (open record — typed as
 * `Record<string, BookOptions>` by convention). Safe to call on every startup.
 */
export async function reconcileBooks(
  db:   BooksDatabase,
  kits: LoadedKit[],
): Promise<void> {
  for (const loadedKit of kits) {
    const books = (loadedKit.kit as Record<string, unknown>).books as
      Record<string, BookOptions> | undefined ?? {};

    for (const [bookName, schema] of Object.entries(books)) {
      const table = booksTableName(loadedKit.id, bookName);

      await db.execute(
        `CREATE TABLE IF NOT EXISTS "${table}" (
          id      TEXT PRIMARY KEY,
          content TEXT NOT NULL
        )`,
      );

      for (const field of schema.indexes ?? []) {
        const idx  = indexName(table, field);
        const path = toJsonPath(field);
        await db.execute(
          `CREATE INDEX IF NOT EXISTS "${idx}"
           ON "${table}"(json_extract(content, '${path}'))`,
        );
      }
    }
  }
}

/**
 * Database utilities for the nexus-clockworks rig.
 *
 * Library functions in this rig use raw SQLite access against the Books
 * tables — they own these tables and need direct SQL for operations that
 * the Books API doesn't support (e.g. partial updates for markEventProcessed,
 * LIKE filters for listEvents).
 *
 * The table names are deterministic from the rig ID and book name:
 *   booksTableName('nexus-clockworks', 'events')    → books_nexus_clockworks_events
 *   booksTableName('nexus-clockworks', 'dispatches') → books_nexus_clockworks_dispatches
 *
 * This matches the convention in packages/arbor/src/db/book-store.ts.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

/** SQLite file path — matches arbor's booksPath convention. */
export function booksPath(home: string): string {
  return path.join(home, '.nexus', 'nexus.db');
}

/** Books table name for the events book. */
export const EVENTS_TABLE = 'books_nexus_clockworks_events';

/** Books table name for the dispatches book. */
export const DISPATCHES_TABLE = 'books_nexus_clockworks_dispatches';

/**
 * Open the guild's SQLite database.
 *
 * Callers are responsible for calling db.close() after use (use try/finally).
 */
export function openDb(home: string): DB {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  return db;
}

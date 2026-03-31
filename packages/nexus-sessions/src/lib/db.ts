/**
 * Database utilities for the nexus-sessions rig.
 *
 * Library functions in this rig use raw SQLite access against the Books
 * tables — they own these tables and need direct SQL for operations that
 * the Books API doesn't support (complex multi-field filters, aggregate
 * queries for conversation metrics, and reliable partial updates).
 *
 * The table names are deterministic from the rig ID and book name:
 *   booksTableName('nexus-sessions', 'sessions')      → books_nexus_sessions_sessions
 *   booksTableName('nexus-sessions', 'conversations')  → books_nexus_sessions_conversations
 *   booksTableName('nexus-sessions', 'participants')   → books_nexus_sessions_participants
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

/** Books table name for the sessions book. */
export const SESSIONS_TABLE = 'books_nexus_sessions_sessions';

/** Books table name for the conversations book. */
export const CONVERSATIONS_TABLE = 'books_nexus_sessions_conversations';

/** Books table name for the participants book. */
export const PARTICIPANTS_TABLE = 'books_nexus_sessions_participants';

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

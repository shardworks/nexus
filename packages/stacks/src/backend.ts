/**
 * StacksBackend — persistence abstraction for The Stacks.
 *
 * All SQLite-specific types stay behind this interface. The apparatus
 * and all consuming plugins depend only on these types. Backend
 * implementations (SQLite, in-memory) implement this interface.
 *
 * See: docs/architecture/apparatus/stacks.md §8
 */

import type { BookEntry, BookSchema, Scalar } from './types.ts';

// ── References ────────────────────────────────────────────────────────

export interface BookRef {
  ownerId: string;
  book: string;
}

export interface BackendOptions {
  home: string;
}

// ── Write results ─────────────────────────────────────────────────────

export interface PutResult {
  created: boolean;
  prev?: BookEntry;
}

export interface PatchResult {
  entry: BookEntry;
  prev: BookEntry;
}

export interface DeleteResult {
  found: boolean;
  prev?: BookEntry;
}

// ── Internal query types ──────────────────────────────────────────────

export type InternalCondition =
  | { field: string; op: 'eq' | 'neq'; value: Scalar }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { field: string; op: 'like'; value: string }
  | { field: string; op: 'in'; values: Scalar[] }
  | { field: string; op: 'isNull' | 'isNotNull' };

export interface InternalQuery {
  where?: InternalCondition[];
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

/** Narrowed query type for count() — conditions only, no pagination. */
export interface CountQuery {
  where?: InternalCondition[];
}

// ── Transaction handle ────────────────────────────────────────────────

export interface BackendTransaction {
  put(ref: BookRef, entry: BookEntry, opts?: { withPrev: boolean }): PutResult;
  patch(ref: BookRef, id: string, fields: Record<string, unknown>): PatchResult;
  delete(ref: BookRef, id: string, opts?: { withPrev: boolean }): DeleteResult;
  get(ref: BookRef, id: string): BookEntry | null;
  find(ref: BookRef, query: InternalQuery): BookEntry[];
  count(ref: BookRef, query: CountQuery): number;
  commit(): void;
  rollback(): void;
}

// ── Backend interface ─────────────────────────────────────────────────

export interface StacksBackend {
  open(options: BackendOptions): void;
  close(): void;
  ensureBook(ref: BookRef, schema: BookSchema): void;
  beginTransaction(): BackendTransaction;
}

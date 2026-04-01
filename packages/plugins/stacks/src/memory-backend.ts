/**
 * In-memory StacksBackend for tests.
 *
 * Exported via `@shardworks/stacks-apparatus/testing`. No SQLite dependency.
 * Implements the same contract as the SQLite backend.
 */

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
import type { BookEntry, BookSchema, Scalar } from './types.ts';
import { getNestedField, compareByOrderEntries } from './field-utils.ts';

// ── Ref key ───────────────────────────────────────────────────────────

function refKey(ref: BookRef): string {
  return `${ref.ownerId}/${ref.book}`;
}

// ── Condition matching ────────────────────────────────────────────────

function matchesCondition(entry: BookEntry, cond: InternalCondition): boolean {
  const value = getNestedField(entry, cond.field);

  switch (cond.op) {
    case 'eq':       return value === cond.value;
    case 'neq':      return value !== cond.value;
    case 'gt':       return (value as number | string) > cond.value;
    case 'gte':      return (value as number | string) >= cond.value;
    case 'lt':       return (value as number | string) < cond.value;
    case 'lte':      return (value as number | string) <= cond.value;
    case 'like':     return sqlLike(String(value ?? ''), cond.value);
    case 'in':       return cond.values.includes(value as Scalar);
    case 'isNull':   return value == null;
    case 'isNotNull': return value != null;
  }
}

/**
 * SQL LIKE matching — case-insensitive for ASCII only, matching SQLite behavior.
 *
 * SQLite's LIKE is case-insensitive for ASCII A-Z but case-sensitive for
 * Unicode characters. We replicate this by folding ASCII letters in both
 * value and pattern to lowercase before matching, rather than using the
 * regex 'i' flag (which would be case-insensitive for all Unicode).
 */
function sqlLike(value: string, pattern: string): boolean {
  // Fold ASCII letters only (matches SQLite behavior)
  const foldAscii = (s: string) =>
    s.replace(/[A-Z]/g, (c) => c.toLowerCase());

  const foldedValue = foldAscii(value);
  const foldedPattern = foldAscii(pattern);

  // Convert SQL LIKE pattern to regex: % → .*, _ → .
  // The escape class intentionally excludes % and _ so they survive to the
  // replacement step below where they become .* and . respectively.
  const escaped = foldedPattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  const regex = new RegExp(
    '^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$',
  );
  return regex.test(foldedValue);
}

function matchesQuery(entry: BookEntry, query: CountQuery | InternalQuery): boolean {
  if (!query.where) return true;
  return query.where.every((cond) => matchesCondition(entry, cond));
}

// ── Sorting ───────────────────────────────────────────────────────────

function sortEntries(
  entries: BookEntry[],
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>,
): BookEntry[] {
  if (!orderBy || orderBy.length === 0) return entries;
  return [...entries].sort((a, b) => compareByOrderEntries(a, b, orderBy));
}

// ── Pagination ────────────────────────────────────────────────────────

function paginate(entries: BookEntry[], query: InternalQuery): BookEntry[] {
  let result = entries;
  if (query.offset !== undefined) {
    result = result.slice(query.offset);
  }
  if (query.limit !== undefined) {
    result = result.slice(0, query.limit);
  }
  return result;
}

// ── Store ─────────────────────────────────────────────────────────────

type Store = Map<string, Map<string, BookEntry>>;

function cloneStore(store: Store): Store {
  const copy: Store = new Map();
  for (const [key, docs] of store) {
    copy.set(key, new Map(Array.from(docs).map(([id, doc]) => [id, structuredClone(doc)])));
  }
  return copy;
}

function getBook(store: Store, ref: BookRef): Map<string, BookEntry> {
  const key = refKey(ref);
  let book = store.get(key);
  if (!book) {
    book = new Map();
    store.set(key, book);
  }
  return book;
}

// ── Memory Transaction ────────────────────────────────────────────────

class MemoryTransaction implements BackendTransaction {
  private committed = false;
  private rolledBack = false;
  private readonly snapshot: Store;

  constructor(private readonly store: Store) {
    this.snapshot = cloneStore(store);
  }

  private assertActive(): void {
    if (this.committed) {
      throw new Error('[stacks/memory] Cannot operate on a committed transaction');
    }
    if (this.rolledBack) {
      throw new Error('[stacks/memory] Cannot operate on a rolled-back transaction');
    }
  }

  put(ref: BookRef, entry: BookEntry, opts?: { withPrev: boolean }): PutResult {
    this.assertActive();
    const book = getBook(this.store, ref);
    const existing = book.get(entry.id);
    const created = !existing;
    const prev = opts?.withPrev && existing ? structuredClone(existing) : undefined;

    book.set(entry.id, structuredClone(entry));
    return { created, prev };
  }

  patch(ref: BookRef, id: string, fields: Record<string, unknown>): PatchResult {
    this.assertActive();
    const book = getBook(this.store, ref);
    const existing = book.get(id);

    if (!existing) {
      throw new Error(
        `[stacks/memory] patch() failed: document "${id}" not found in ${ref.ownerId}/${ref.book}`,
      );
    }

    const prev = structuredClone(existing);
    const updated = { ...existing, ...fields, id } as BookEntry;
    book.set(id, structuredClone(updated));

    return { entry: updated, prev };
  }

  delete(ref: BookRef, id: string, opts?: { withPrev: boolean }): DeleteResult {
    this.assertActive();
    const book = getBook(this.store, ref);
    const existing = book.get(id);

    if (!existing) return { found: false };

    const prev = opts?.withPrev ? structuredClone(existing) : undefined;
    book.delete(id);
    return { found: true, prev };
  }

  get(ref: BookRef, id: string): BookEntry | null {
    this.assertActive();
    const book = getBook(this.store, ref);
    const entry = book.get(id);
    return entry ? structuredClone(entry) : null;
  }

  find(ref: BookRef, query: InternalQuery): BookEntry[] {
    this.assertActive();
    const book = getBook(this.store, ref);
    let entries = Array.from(book.values()).filter((e) => matchesQuery(e, query));
    entries = sortEntries(entries, query.orderBy);
    entries = paginate(entries, query);
    return entries.map((e) => structuredClone(e));
  }

  count(ref: BookRef, query: CountQuery): number {
    this.assertActive();
    const book = getBook(this.store, ref);
    return Array.from(book.values()).filter((e) => matchesQuery(e, query)).length;
  }

  commit(): void {
    this.committed = true;
  }

  rollback(): void {
    if (this.committed) {
      throw new Error('[stacks/memory] Cannot rollback a committed transaction');
    }
    // Restore snapshot
    this.store.clear();
    for (const [key, docs] of this.snapshot) {
      this.store.set(key, docs);
    }
    this.rolledBack = true;
  }
}

// ── Memory Backend ────────────────────────────────────────────────────

export class MemoryBackend implements StacksBackend {
  private store: Store = new Map();

  open(_options: BackendOptions): void {
    // No-op — memory backend is always ready
  }

  close(): void {
    this.store.clear();
  }

  ensureBook(ref: BookRef, _schema: BookSchema): void {
    // Ensure the book exists in the store (indexes are a no-op for memory)
    getBook(this.store, ref);
  }

  beginTransaction(): BackendTransaction {
    return new MemoryTransaction(this.store);
  }
}

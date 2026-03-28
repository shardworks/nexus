/**
 * RigContext — the single injected context for tool and engine handlers.
 *
 * Replaces the old `ToolContext`. Both tool handlers and engine handlers
 * receive a `RigContext`. Cross-rig capabilities grow directly on this
 * interface as the runtime expands.
 *
 * `ToolContext` is kept as an alias for backward compatibility.
 */

import type { Book, ReadOnlyBook } from './book.ts';

/**
 * The context injected into every tool and engine handler invocation.
 *
 * Scoped to the rig that owns the handler — `book()` returns handles to
 * books declared in that rig's schema. Cross-rig reads go through `rigBook()`.
 */
export interface RigContext {
  /** Absolute path to the guild root. */
  home: string;

  /**
   * Get a typed handle to one of this rig's books.
   *
   * The book must be declared in this rig's `Rig` export under `books`.
   * Returns a writable `Book<T>`.
   *
   * @example
   *   const writs = ctx.book<Writ>('writs');
   *   await writs.put({ id: ulid(), status: 'ready', ... });
   */
  book<T extends { id: string }>(name: string): Book<T>;

  /**
   * Get a read-only handle to a book owned by another rig.
   *
   * Cross-rig access is read-only — use this to read framework or sibling
   * rig data without taking a write dependency on it.
   *
   * @example
   *   const writs = ctx.rigBook<Writ>('nexus-ledger', 'writs');
   *   const active = await writs.find({ where: { status: 'active' } });
   */
  rigBook<T extends { id: string }>(rigKey: string, name: string): ReadOnlyBook<T>;

  // Cross-rig capabilities grow here as the runtime expands.
}

/**
 * BookOptions — book schema declaration type.
 *
 * Transitional: currently exported from core for use by plugin packages
 * declaring their book schemas as a `books` contribution field on their Kit.
 * Will move to the nexus-books apparatus package once that apparatus is
 * implemented.
 *
 * See: docs/architecture/apparatus/books.md
 */

/**
 * Schema declaration for a single Book in a plugin's `books` contribution map.
 *
 * Plugin packages declare which fields they want to query on — the Books
 * apparatus creates the backing SQLite indexes at startup. No SQL, no
 * JSONPath syntax; field names are plain or dot-notation for nested fields.
 *
 * @example
 *   books: {
 *     writs: { indexes: ['status', 'createdAt', 'parent.id'] },
 *   }
 */
export interface BookOptions {
  /**
   * Field names to index for efficient querying.
   *
   * Plain field names ('status') or dot notation for nested fields ('parent.id').
   * The Books apparatus translates these to SQLite json_extract() expressions.
   *
   * @example ['status', 'createdAt', 'anima']
   */
  indexes?: string[]
}

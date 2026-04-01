/**
 * Shared field access and order-by utilities.
 *
 * Used by both the apparatus-level logic (stacks-core.ts) and the
 * memory backend (memory-backend.ts). Kept in a minimal module with
 * no heavy dependencies.
 */

import type { BookEntry, OrderBy } from './types.ts';

/**
 * Access a potentially nested field via dot-notation (e.g. "parent.id").
 */
export function getNestedField(obj: BookEntry | Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Normalize the public OrderBy type into a uniform array of { field, dir }.
 *
 * Does NOT validate field names — callers are responsible for ensuring
 * fields have already been validated (e.g. via translateQuery) before
 * reaching this point. translateQuery calls validateFieldName after
 * normalizing because it sits at the untrusted-input boundary.
 */
export function normalizeOrderBy(
  orderBy: OrderBy,
): Array<{ field: string; dir: 'asc' | 'desc' }> {
  if (typeof orderBy[0] === 'string') {
    const [field, dir] = orderBy as [string, 'asc' | 'desc'];
    return [{ field, dir }];
  }
  return (orderBy as Array<[string, 'asc' | 'desc']>).map(([field, dir]) => ({
    field,
    dir,
  }));
}

/**
 * Compare two entries by a list of order-by entries.
 *
 * Shared by the memory backend's sortEntries and the apparatus-level
 * OR query re-sort in stacks-core.ts. Null values sort before non-null
 * in ascending order, after non-null in descending order.
 */
export function compareByOrderEntries(
  a: BookEntry | Record<string, unknown>,
  b: BookEntry | Record<string, unknown>,
  orderEntries: Array<{ field: string; dir: 'asc' | 'desc' }>,
): number {
  for (const { field, dir } of orderEntries) {
    const va = getNestedField(a, field);
    const vb = getNestedField(b, field);
    if (va === vb) continue;
    if (va == null) return dir === 'asc' ? -1 : 1;
    if (vb == null) return dir === 'asc' ? 1 : -1;
    const cmp = va < vb ? -1 : 1;
    return dir === 'asc' ? cmp : -cmp;
  }
  return 0;
}

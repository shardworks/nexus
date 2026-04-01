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
 * reaching this point. The query.ts normalizeOrderBy variant includes
 * validation because it sits at the untrusted-input boundary.
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

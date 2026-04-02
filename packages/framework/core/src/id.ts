import crypto from 'node:crypto';

/**
 * Generate a sortable, prefixed ID.
 *
 * Format: `{prefix}-{base36_timestamp}{hex_random}`
 *
 * The timestamp component (Date.now() in base36) gives lexicographic sort
 * order by creation time. The random suffix prevents collisions without
 * coordination.
 *
 * @param prefix     Short, type-identifying string (e.g. `w`, `ses`, `turn`)
 * @param randomByteCount  Number of random bytes; produces 2× hex digits (default 6 → 12 hex chars)
 */
export function generateId(prefix: string, randomByteCount: number = 6): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(randomByteCount).toString('hex');
  return `${prefix}-${ts}${rand}`;
}

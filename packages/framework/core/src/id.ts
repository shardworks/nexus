import crypto from 'node:crypto';

/**
 * Generate a sortable, prefixed ID.
 *
 * Format: `{prefix}-{base36_timestamp}-{hex_random}`
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
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Produce the short-id form of a generated ID: the `{prefix}-{base36ts}`
 * segment.
 *
 * This is the inverse-display counterpart to {@link generateId} — it drops
 * the random suffix and surfaces the collision-prone-but-human-readable
 * prefix form. Apparatus `resolveId()` implementations (e.g. `ClerkApi`,
 * `RatchetApi`) accept this form as a unique prefix lookup, so it is the
 * natural shape for CLI output, tree renderings, and pulse-context
 * payloads.
 *
 * @param id  A full ID (typically produced by {@link generateId}).
 */
export function shortId(id: string): string {
  return id.split('-').slice(0, 2).join('-');
}

/**
 * ID generation — prefixed random hex identifiers for all guild entities.
 *
 * Format: `<prefix>-<8 hex chars>` (e.g. `c-a3f7b2c1`, `a-5e6f7a8b`).
 * 8 hex characters = 4 random bytes = ~4.3 billion possibilities per prefix,
 * more than sufficient for a local single-guild system.
 *
 * Prefixes by entity type:
 *   a-     anima
 *   c-     commission
 *   conv-  conversation
 *   cpart- conversation participant
 *   evt-   event
 *   ses-   session
 *   w-     work
 *   p-     piece
 *   j-     job
 *   s-     stroke
 */
import { randomBytes } from 'node:crypto';

/**
 * Generate a prefixed hex ID for a guild entity.
 *
 * @param prefix - Entity type prefix (e.g. 'c', 'a', 'evt', 'ses', 'w', 'p', 'j', 's')
 * @returns A string like `c-a3f7b2c1`
 */
export function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

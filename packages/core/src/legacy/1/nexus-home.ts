export * from '../../nexus-home.ts';

import path from 'node:path';

/**
 * @deprecated Internal use only. Raw DB path — use the Books abstraction instead.
 * Retained here for legacy/1 compatibility only.
 */
export function booksPath(home: string): string {
  return path.join(home, '.nexus', 'nexus.db');
}

/**
 * @deprecated Use booksPath() instead. Retained for legacy/1 compatibility only.
 */
export function ledgerPath(home: string): string {
  return booksPath(home);
}

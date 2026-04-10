/**
 * @shardworks/clerk-apparatus — The Clerk.
 *
 * Writ lifecycle management: post commissions, accept work, complete or fail
 * writs, and cancel them at any pre-terminal stage. Writs flow through a fixed
 * status machine and are persisted in The Stacks.
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import { createClerk } from './clerk.ts';

// ── Clerk API ─────────────────────────────────────────────────────────

export {
  type ClerkApi,
  type ClerkConfig,
  type WritTypeEntry,
  type WritDoc,
  type WritLinkDoc,
  type WritLinks,
  type WritStatus,
  type PostCommissionRequest,
  type EditWritRequest,
  type WritFilters,
} from './types.ts';

export { createClerk } from './clerk.ts';
export type { ClerkKit } from './clerk.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createClerk();

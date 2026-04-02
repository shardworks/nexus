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
  type WritDoc,
  type WritStatus,
  type PostCommissionRequest,
  type WritFilters,
} from './types.ts';

export { createClerk } from './clerk.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createClerk();

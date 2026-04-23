/**
 * @shardworks/clerk-apparatus — The Clerk.
 *
 * Writ lifecycle management: post commissions, complete or fail writs, and
 * cancel them at any pre-terminal stage. Writs flow through a fixed phase
 * machine (new → open → completed/failed/cancelled) and are persisted in
 * The Stacks.
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
  type WritPhase,
  type PostCommissionRequest,
  type EditWritRequest,
  type WritFilters,
  type WritTypeInfo,
  type KindEntry,
  type LinkKindDoc,
  type WritTree,
  type WritTreeParams,
} from './types.ts';

export { createClerk, CASCADE_PARENT_TERMINATION_RESOLUTION, BUILTIN_WRIT_TYPE } from './clerk.ts';
export type { ClerkKit } from './clerk.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createClerk();

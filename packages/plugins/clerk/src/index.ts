/**
 * @shardworks/clerk-apparatus — The Clerk.
 *
 * Writ lifecycle management: post commissions, complete or fail writs, and
 * cancel them at any pre-terminal stage. Each writ's lifecycle is declared
 * by a registered `WritTypeConfig`; the Clerk's own built-in type
 * `mandate` (new → open → completed/failed/cancelled, with `stuck` as a
 * non-terminal "needs attention" state off `open`) is one example.
 * Plugins contribute their own writ types and state machines via
 * `ClerkApi.registerWritType`. Writs are persisted in The Stacks.
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import { createClerk } from './clerk.ts';

// ── Clerk API ─────────────────────────────────────────────────────────

export {
  type ClerkApi,
  type ClerkConfig,
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

export { createClerk } from './clerk.ts';
export type { ClerkKit } from './clerk.ts';

// ── Writ-type configuration (structural shape + validator) ────────────

export { validateWritTypeConfig } from './writ-type-config.ts';
export type {
  WritTypeConfig,
  WritTypeStateDefinition,
  WritTypeStateClassification,
  WritTypeStateAttr,
  KnownWritTypeStateAttr,
  WritTypeChildrenBehavior,
  WritTypeChildrenBehaviorAction,
} from './writ-type-config.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createClerk();

/**
 * @shardworks/stacks-apparatus — The Stacks apparatus.
 *
 * Guild persistence layer: NoSQL document store with CDC, transactions,
 * and swappable backend. Default export is the apparatus plugin.
 *
 * See: docs/architecture/apparatus/stacks.md
 */

import { createStacksApparatus } from './stacks.ts';

// ── Public types ──────────────────────────────────────────────────────

export type {
  // Document model
  BookEntry,
  BookSchema,

  // Book handles
  Book,
  ReadOnlyBook,

  // Query language
  Scalar,
  WhereCondition,
  WhereClause,
  OrderEntry,
  OrderBy,
  Pagination,
  BookQuery,
  ListOptions,

  // CDC
  ChangeEvent,
  CreateEvent,
  UpdateEvent,
  DeleteEvent,
  ChangeHandler,
  WatchOptions,

  // API
  StacksApi,
  TransactionContext,
} from './types.ts';

// ── Backend types (for alternative implementations) ───────────────────

export type {
  StacksBackend,
  BackendTransaction,
  BackendOptions,
  BookRef,
  InternalQuery,
  InternalCondition,
  CountQuery,
  PutResult,
  PatchResult,
  DeleteResult,
} from './backend.ts';

// ── Apparatus factory ─────────────────────────────────────────────────

export { createStacksApparatus } from './stacks.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createStacksApparatus();

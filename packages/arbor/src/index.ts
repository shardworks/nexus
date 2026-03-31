/**
 * @shardworks/nexus-arbor — guild runtime
 *
 * The arbor is the internal guild host: rig management, tool discovery,
 * and the runtime seam between the CLI/MCP surface and installed rigs.
 *
 * Rig authors never import from arbor — they import from @shardworks/nexus-core.
 * The CLI and session provider import from arbor.
 *
 * Package dependency graph:
 *   core   — public SDK, types, tool() factory
 *   arbor  — guild host, createArbor(), Arbor object
 *   cli    — nsg binary, Commander.js, maps Tool[] → commands
 *   rigs   — import from core only
 *
 * Inter-rig API: rig packages export a typed `fromArbor(arbor: Arbor)`
 * factory that returns their public API surface. Callers import the rig package
 * and call `fromArbor(arbor)` to get a typed, initialized reference.
 */

// Re-export guild root discovery from core — consumers can import from one place
export { findGuildRoot } from '@shardworks/nexus-core';

export {
  createArbor,
  deriveRigId,
  type Arbor,
  type LoadedRig,
  type Tool,
  type ListToolsOptions,
} from './arbor.ts';

export {
  type SqlRow,
  type SqlResult,
  type BooksDatabase,
  openBooksDatabase,
} from './db/sqlite-adapter.ts';

export { BookStore, booksTableName } from './db/book-store.ts';
export { reconcileBooks } from './db/reconcile-books.ts';

export { builtinTools } from './tools/index.ts';

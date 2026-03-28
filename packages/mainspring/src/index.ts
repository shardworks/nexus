/**
 * @shardworks/nexus-mainspring — guild runtime
 *
 * The mainspring is the internal guild host: rig management, tool discovery,
 * and the runtime seam between the CLI/MCP surface and installed rigs.
 *
 * Rig authors never import from mainspring — they import from @shardworks/nexus-core.
 * The CLI and session provider import from mainspring.
 *
 * Package dependency graph:
 *   core        — public SDK, types, tool() factory
 *   mainspring  — guild host, createMainspring(), Mainspring object
 *   cli         — nsg binary, Commander.js, maps Tool[] → commands
 *   rigs        — import from core only
 *
 * Inter-rig API: rig packages export a typed `fromMainspring(ms: Mainspring)`
 * factory that returns their public API surface. Callers import the rig package
 * and call `fromMainspring(ms)` to get a typed, initialized reference.
 */

// Re-export guild root discovery from core — consumers can import from one place
export { findGuildRoot } from '@shardworks/nexus-core';

export {
  createMainspring,
  deriveRigId,
  type Mainspring,
  type LoadedRig,
  type Tool,
  type ListToolsOptions,
} from './mainspring.ts';

export {
  type SqlRow,
  type SqlResult,
  type BooksDatabase,
  openBooksDatabase,
} from './db/sqlite-adapter.ts';

export { BookStore, booksTableName } from './db/book-store.ts';
export { reconcileBooks } from './db/reconcile-books.ts';

export { builtinTools } from './tools/index.ts';

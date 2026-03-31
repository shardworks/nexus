/**
 * @shardworks/nexus-arbor — guild runtime
 *
 * The arbor is the internal guild host: plugin management, tool discovery,
 * and the runtime seam between the CLI/MCP surface and installed plugins.
 *
 * Plugin authors never import from arbor — they import from @shardworks/nexus-core.
 * The CLI and session provider import from arbor.
 *
 * Package dependency graph:
 *   core   — public SDK, types, tool() factory
 *   arbor  — guild host, createArbor(), Arbor object
 *   cli    — nsg binary, Commander.js, maps Tool[] → commands
 *   plugins — import from core only
 *
 * Inter-apparatus API: apparatus packages declare a `provides` object on their
 * manifest. Consumers call `ctx.apparatus<T>(name)` in start() or handlers.
 */

// Re-export guild root discovery from core — consumers can import from one place
export { findGuildRoot } from '@shardworks/nexus-core';

export {
  createArbor,
  derivePluginId,
  type Arbor,
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

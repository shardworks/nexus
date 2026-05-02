/**
 * @shardworks/code-lookup-apparatus — code-lookup MCP tool.
 *
 * Contributes a single MCP tool, `code-lookup`, that answers symbol /
 * usages / package queries against a precomputed reverse-usage-index
 * artifact loaded from a configured path. Backs the X019 experiment's
 * substitution of cross-reference Greps with structured tool calls.
 *
 * The plugin is a passive **kit** (no apparatus lifecycle): the tool
 * handler lazy-loads the artifact on first call and caches it. The
 * configured path lives at `guild.json["code-lookup"].indexPath`
 * (default: `<cwd>/.nexus/code-lookup-index.json`).
 *
 * The package additionally ships a role-prompt snippet at
 * `<package>/src/sage-tool-preference.md` that trial manifests can
 * append to the consuming role's prompt to direct tool preference.
 * Role prompts in this branch are NOT modified — composition happens
 * in the trial manifest layer.
 */

import { codeLookup } from './tool.ts';

// ── Public API: types and store class for downstream consumers ───────

export type {
  CodeLookupConfig,
  PackageDetail,
  PackageSymbol,
  RawReferenceEntry,
  RawSymbolEntry,
  Reference,
  ReferenceKind,
  ReverseUsageIndexArtifact,
  SymbolDefinition,
  SymbolKind,
  SymbolUsages,
} from './types.ts';

export {
  CodeLookupIndexError,
  IndexMalformedError,
  IndexNotFoundError,
  IndexStore,
  getStore,
  loadArtifact,
  resetCache,
  resolveIndexPath,
} from './index-store.ts';

export { codeLookup } from './tool.ts';

// ── Default export: the kit plugin ──────────────────────────────────

export default {
  kit: {
    // No apparatus dependencies — guild() and tools-apparatus suffice.
    requires: [],
    tools: [codeLookup],
  },
};

/**
 * The `code-lookup` MCP tool.
 *
 * One tool, three modes via the `mode` parameter:
 *
 * - `symbol <name>` — return every definition record for the named
 *   symbol. Empty array when unknown. Multiple records when the name
 *   collides across packages.
 *
 * - `usages <name>` — return every reference site for the named symbol,
 *   grouped by defining site. References include kind, cross-package,
 *   and in-test flags so the caller can filter.
 *
 * - `package <name>` — return the package's full exported-symbol
 *   detail (kinds, signatures, JSDocs). null when the package is
 *   unknown.
 *
 * Failure to load the underlying artifact (file missing, malformed)
 * is a hard error — the handler raises rather than returning empty
 * results, because silent emptiness would dilute X019's measured
 * substitution rate.
 */

import { z } from 'zod';

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';

import { getStore } from './index-store.ts';
import type {
  CodeLookupConfig,
  PackageDetail,
  SymbolDefinition,
  SymbolUsages,
} from './types.ts';

// GuildConfig augmentation — merged via TS declaration merging so
// `guild.json["code-lookup"]` is a typed slot.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    'code-lookup'?: CodeLookupConfig;
  }
}

/** Tool result discriminated union. */
type CodeLookupResult =
  | { mode: 'symbol'; name: string; results: SymbolDefinition[] }
  | { mode: 'usages'; name: string; results: SymbolUsages[] }
  | { mode: 'package'; name: string; result: PackageDetail | null };

/** Read the configured path from guild config. Undefined → store applies its default. */
function readConfiguredPath(): string | undefined {
  return guild().guildConfig()['code-lookup']?.indexPath;
}

export const codeLookup = tool({
  name: 'code-lookup',
  description:
    'Look up exported symbols, their references, or full package detail in a precomputed reverse usage index. Three modes: symbol (definitions), usages (reference sites), package (full export listing). Use this for cross-reference Greps; reserve Grep for content/text searches.',
  permission: 'read',
  instructions: [
    'Modes:',
    '- `mode: "symbol"` + `name: <symbolName>` → array of definition records (package, kind, file, line, signature, doc, referenceCount). Multiple entries when the symbol name collides across packages.',
    '- `mode: "usages"` + `name: <symbolName>` → array of usages grouped by defining site, each with its `references` array. Each reference has file, line, kind (call/import/type-reference/extends/implements/instantiation/jsx/decorator/typeof/re-export/reference), isCrossPackage, inTest.',
    '- `mode: "package"` + `name: <packageName>` → full package detail with all exported symbols and their signatures + JSDocs. null when the package is unknown.',
    '',
    'Empty result arrays mean the symbol/package is not in the index. The index covers exported symbols across all monorepo packages.',
    '',
    'Use this tool when you would otherwise Grep for a TypeScript symbol name. Reserve Grep for content/text searches (multi-word phrases, comments, prose).',
  ].join('\n'),
  params: {
    mode: z
      .enum(['symbol', 'usages', 'package'])
      .describe(
        'symbol = definition record(s); usages = reference list; package = full package detail.',
      ),
    name: z
      .string()
      .min(1)
      .describe('Symbol name (for symbol/usages) or package name (for package).'),
  },
  handler: async ({ mode, name }): Promise<CodeLookupResult> => {
    const store = getStore(readConfiguredPath());
    switch (mode) {
      case 'symbol':
        return { mode, name, results: store.symbol(name) };
      case 'usages':
        return { mode, name, results: store.usages(name) };
      case 'package':
        return { mode, name, result: store.package(name) };
    }
  },
});

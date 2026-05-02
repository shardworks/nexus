/**
 * Public types for `@shardworks/code-lookup-apparatus`.
 *
 * Two type groups live here:
 *
 * 1. **Artifact schema** — the on-disk JSON shape produced by the
 *    upstream reverse-usage-index generator. Compact-encoded: file
 *    paths are interned in `files[]`, references use short keys
 *    (`f`/`l`/`k`/`x`/`t`) with false flags omitted, and symbols are
 *    arrays to handle cross-package name collisions.
 *
 * 2. **Tool result types** — the externally-facing shapes the
 *    `code-lookup` tool returns. These are decoded forms with file
 *    paths resolved (no interned IDs, no terse keys) so the consuming
 *    role doesn't need to learn the on-disk schema.
 */

// ── Artifact schema (on-disk) ───────────────────────────────────────

export type SymbolKind =
  | 'interface'
  | 'type'
  | 'class'
  | 'function'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'default';

export type ReferenceKind =
  | 'import'
  | 're-export'
  | 'call'
  | 'instantiation'
  | 'type-reference'
  | 'extends'
  | 'implements'
  | 'jsx'
  | 'decorator'
  | 'typeof'
  | 'reference';

/** Compact reference entry as stored on disk. False flags omitted. */
export interface RawReferenceEntry {
  /** File id — index into the artifact's `files[]`. */
  f: number;
  /** 1-based line number. */
  l: number;
  /** Reference kind. */
  k: ReferenceKind;
  /** Cross-package flag. Present and set to 1 when true; omitted otherwise. */
  x?: 1;
  /** In-test-file flag. Present and set to 1 when true; omitted otherwise. */
  t?: 1;
}

/** Compact symbol entry as stored on disk. */
export interface RawSymbolEntry {
  package: string;
  kind: SymbolKind;
  /** [fileId, line] tuple. */
  definedAt: [number, number];
  signature: string;
  doc?: string;
  references: RawReferenceEntry[];
}

/** The full on-disk artifact shape. */
export interface ReverseUsageIndexArtifact {
  generatedFromSha: string;
  generatedAt: string;
  monorepoRoot: string;
  files: string[];
  symbols: Record<string, RawSymbolEntry[]>;
  packages: Record<string, { symbols: string[] }>;
}

// ── Tool result types (decoded, externally-facing) ──────────────────

/** A single reference, with file path resolved. */
export interface Reference {
  file: string;
  line: number;
  kind: ReferenceKind;
  isCrossPackage: boolean;
  inTest: boolean;
}

/** A single symbol definition record returned by the `symbol` mode. */
export interface SymbolDefinition {
  name: string;
  package: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
  doc?: string;
  /** Reference count — full list comes back via `usages` mode. */
  referenceCount: number;
}

/** A single usage record returned by the `usages` mode. */
export interface SymbolUsages {
  name: string;
  /** Repeated per definition entry when the name collides across packages. */
  definedIn: { package: string; file: string; line: number };
  references: Reference[];
}

/** A single symbol-detail record under the `package` mode. */
export interface PackageSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
  doc?: string;
  referenceCount: number;
}

/** The full result returned by the `package` mode. */
export interface PackageDetail {
  name: string;
  symbols: PackageSymbol[];
}

// ── Plugin config ────────────────────────────────────────────────────

/** Plugin configuration stored at `guild.json["code-lookup"]`. */
export interface CodeLookupConfig {
  /**
   * Absolute or guild-cwd-relative path to the reverse-usage-index
   * artifact JSON file.
   *
   * Default: `.nexus/code-lookup-index.json` (resolved against the
   * guild's process cwd).
   */
  indexPath?: string;
}

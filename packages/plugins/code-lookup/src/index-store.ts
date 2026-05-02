/**
 * Index store — load, cache, and query the reverse-usage-index artifact.
 *
 * The store is a process-global lazy singleton: the first tool call
 * loads + parses the artifact, subsequent calls hit the in-memory cache.
 * Failure to load (file missing, malformed JSON, schema mismatch) raises
 * a typed error rather than returning empty results — silent empties
 * would dilute the X019 trial's measured tool-substitution rate.
 *
 * The store decodes interned IDs back to file paths on the way out, so
 * its callers (the tool handler, tests) never see the compact wire form.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  PackageDetail,
  PackageSymbol,
  RawSymbolEntry,
  Reference,
  ReverseUsageIndexArtifact,
  SymbolDefinition,
  SymbolUsages,
} from './types.ts';

// ── Errors ──────────────────────────────────────────────────────────

/** Base error for any code-lookup index failure. */
export class CodeLookupIndexError extends Error {
  override name = 'CodeLookupIndexError';
}

/** Index file is missing at the configured path. */
export class IndexNotFoundError extends CodeLookupIndexError {
  override name = 'IndexNotFoundError';
  constructor(path: string, cause?: unknown) {
    super(`code-lookup index not found at ${path}`);
    if (cause instanceof Error) this.cause = cause;
  }
}

/** Index file content failed to parse or validate. */
export class IndexMalformedError extends CodeLookupIndexError {
  override name = 'IndexMalformedError';
  constructor(path: string, reason: string, cause?: unknown) {
    super(`code-lookup index at ${path} is malformed: ${reason}`);
    if (cause instanceof Error) this.cause = cause;
  }
}

// ── Loading + validation ────────────────────────────────────────────

/**
 * Load and validate the artifact file. Throws on any error.
 *
 * Validation is structural — we check that `files`, `symbols`, and
 * `packages` are present and shaped roughly as expected. We do not
 * deep-validate every reference entry; the generator is the source of
 * truth and we trust its output. Schema mismatches surface as a
 * malformed-index error rather than hidden empty results.
 */
export function loadArtifact(path: string): ReverseUsageIndexArtifact {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new IndexNotFoundError(path, err);
    throw new IndexMalformedError(path, `could not read file: ${(err as Error).message}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IndexMalformedError(path, 'invalid JSON', err);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new IndexMalformedError(path, 'top-level value is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.files)) {
    throw new IndexMalformedError(path, 'missing or non-array `files`');
  }
  if (!obj.symbols || typeof obj.symbols !== 'object') {
    throw new IndexMalformedError(path, 'missing or non-object `symbols`');
  }
  if (!obj.packages || typeof obj.packages !== 'object') {
    throw new IndexMalformedError(path, 'missing or non-object `packages`');
  }

  return parsed as ReverseUsageIndexArtifact;
}

// ── Index store class ───────────────────────────────────────────────

/**
 * Wraps a loaded artifact and exposes typed queries for the three
 * tool modes. Construct via `IndexStore.fromArtifact(...)` for tests
 * or `IndexStore.loadFrom(path)` for the runtime path.
 */
export class IndexStore {
  private constructor(private readonly artifact: ReverseUsageIndexArtifact) {}

  static fromArtifact(artifact: ReverseUsageIndexArtifact): IndexStore {
    return new IndexStore(artifact);
  }

  static loadFrom(path: string): IndexStore {
    return new IndexStore(loadArtifact(path));
  }

  /** Source SHA the artifact was built from. Useful for diagnostics. */
  generatedFromSha(): string {
    return this.artifact.generatedFromSha;
  }

  /** Resolve an interned file id back to its path. */
  private fileFor(id: number): string {
    const f = this.artifact.files[id];
    if (f === undefined) {
      // Interned ID outside table range — should never happen with
      // valid artifacts; surface loudly if it does.
      throw new IndexMalformedError(
        '<loaded artifact>',
        `file id ${id} out of range (files.length=${this.artifact.files.length})`,
      );
    }
    return f;
  }

  /** Decode a raw reference into the externally-facing shape. */
  private decodeReference(r: { f: number; l: number; k: Reference['kind']; x?: 1; t?: 1 }): Reference {
    return {
      file: this.fileFor(r.f),
      line: r.l,
      kind: r.k,
      isCrossPackage: r.x === 1,
      inTest: r.t === 1,
    };
  }

  // ── symbol mode ────────────────────────────────────────────────────

  /**
   * Return all definitions of the named symbol. Returns an empty array
   * when the symbol is unknown — that's a legitimate "not found"
   * response, distinct from a load failure.
   */
  symbol(name: string): SymbolDefinition[] {
    const entries = this.artifact.symbols[name];
    if (!entries) return [];
    return entries.map((e) => this.toDefinition(name, e));
  }

  private toDefinition(name: string, e: RawSymbolEntry): SymbolDefinition {
    const def: SymbolDefinition = {
      name,
      package: e.package,
      kind: e.kind,
      file: this.fileFor(e.definedAt[0]),
      line: e.definedAt[1],
      signature: e.signature,
      referenceCount: e.references.length,
    };
    if (e.doc !== undefined) def.doc = e.doc;
    return def;
  }

  // ── usages mode ────────────────────────────────────────────────────

  /**
   * Return all usages of the named symbol, grouped by defining site
   * when the name collides across packages. The `references` array per
   * group is sorted as the artifact stored it (file/line/kind).
   */
  usages(name: string): SymbolUsages[] {
    const entries = this.artifact.symbols[name];
    if (!entries) return [];
    return entries.map((e) => ({
      name,
      definedIn: {
        package: e.package,
        file: this.fileFor(e.definedAt[0]),
        line: e.definedAt[1],
      },
      references: e.references.map((r) => this.decodeReference(r)),
    }));
  }

  // ── package mode ───────────────────────────────────────────────────

  /**
   * Return the full symbol detail for a package. Returns null when the
   * package is unknown.
   *
   * Symbols are emitted in the order the artifact stored them
   * (alphabetical). For names that collide across packages, only the
   * entries belonging to the queried package are returned.
   */
  package(name: string): PackageDetail | null {
    const meta = this.artifact.packages[name];
    if (!meta) return null;

    const symbols: PackageSymbol[] = [];
    for (const symName of meta.symbols) {
      const entries = this.artifact.symbols[symName] ?? [];
      for (const e of entries) {
        if (e.package !== name) continue;
        const sym: PackageSymbol = {
          name: symName,
          kind: e.kind,
          file: this.fileFor(e.definedAt[0]),
          line: e.definedAt[1],
          signature: e.signature,
          referenceCount: e.references.length,
        };
        if (e.doc !== undefined) sym.doc = e.doc;
        symbols.push(sym);
      }
    }
    return { name, symbols };
  }

  // ── package listing ────────────────────────────────────────────────

  /** All package names known to the index. Useful for diagnostics. */
  listPackages(): string[] {
    return Object.keys(this.artifact.packages).sort();
  }
}

// ── Lazy singleton ──────────────────────────────────────────────────

let cached: { path: string; store: IndexStore } | undefined;

/** Resolve the configured index path against the guild cwd. */
export function resolveIndexPath(configured: string | undefined): string {
  const raw = configured ?? '.nexus/code-lookup-index.json';
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * Get the lazily-loaded store. Loads on first call; subsequent calls
 * return the same instance.
 *
 * Reloads if the configured path changes between calls — supports test
 * fixtures that rotate artifacts. In production the path is stable.
 */
export function getStore(configured: string | undefined): IndexStore {
  const path = resolveIndexPath(configured);
  if (cached?.path === path) return cached.store;
  const store = IndexStore.loadFrom(path);
  cached = { path, store };
  return store;
}

/** Test/diagnostic hook: clear the cached store. */
export function resetCache(): void {
  cached = undefined;
}

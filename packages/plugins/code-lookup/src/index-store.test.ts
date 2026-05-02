/**
 * Tests for the index store: load/parse/validate, plus the three
 * query modes (symbol, usages, package). Uses a small in-memory
 * fixture artifact rather than the real generated one so the tests
 * stay fast and don't depend on the upstream generator.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IndexStore,
  IndexMalformedError,
  IndexNotFoundError,
  loadArtifact,
  resolveIndexPath,
} from './index-store.ts';
import type { ReverseUsageIndexArtifact } from './types.ts';

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * A small, hand-crafted artifact that exercises:
 * - Multiple packages and files
 * - A name collision (`init` exported from two packages)
 * - Reference kinds: call, type-reference, import, extends
 * - Cross-package + same-package, in-test + not-in-test
 * - A symbol with no JSDoc
 * - A package with multiple symbols, in alphabetical order
 */
function makeFixture(): ReverseUsageIndexArtifact {
  return {
    generatedFromSha: 'abc123',
    generatedAt: '2026-05-02T00:00:00.000Z',
    monorepoRoot: '/test',
    files: [
      'packages/alpha/src/index.ts',           // 0
      'packages/alpha/src/init.ts',            // 1
      'packages/beta/src/index.ts',            // 2
      'packages/beta/src/init.ts',             // 3
      'packages/beta/src/init.test.ts',        // 4
    ],
    symbols: {
      // Cross-package collision on `init`.
      init: [
        {
          package: '@scope/alpha',
          kind: 'function',
          definedAt: [1, 10],
          signature: 'export function init(): void',
          doc: 'Alpha init.',
          references: [
            { f: 0, l: 5, k: 'import' },
            { f: 0, l: 12, k: 'call' },
            { f: 2, l: 8, k: 'import', x: 1 },
            { f: 2, l: 14, k: 'call', x: 1 },
            { f: 4, l: 3, k: 'call', x: 1, t: 1 },
          ],
        },
        {
          package: '@scope/beta',
          kind: 'function',
          definedAt: [3, 22],
          signature: 'export function init(name: string): void',
          // No doc — exercises the doc-omitted branch.
          references: [
            { f: 2, l: 11, k: 'call' },
            { f: 4, l: 5, k: 'call', t: 1 },
          ],
        },
      ],
      // Single definition.
      AlphaApi: [
        {
          package: '@scope/alpha',
          kind: 'interface',
          definedAt: [0, 30],
          signature: 'export interface AlphaApi',
          doc: 'Alpha public API.',
          references: [
            { f: 2, l: 1, k: 'import', x: 1 },
            { f: 2, l: 20, k: 'type-reference', x: 1 },
            { f: 4, l: 7, k: 'type-reference', x: 1, t: 1 },
          ],
        },
      ],
      BetaBase: [
        {
          package: '@scope/beta',
          kind: 'class',
          definedAt: [2, 100],
          signature: 'export class BetaBase',
          references: [
            { f: 2, l: 105, k: 'extends' },
          ],
        },
      ],
    },
    packages: {
      '@scope/alpha': { symbols: ['AlphaApi', 'init'] },
      '@scope/beta': { symbols: ['BetaBase', 'init'] },
    },
  };
}

// ── symbol mode ─────────────────────────────────────────────────────

describe('IndexStore.symbol', () => {
  it('returns all definitions for a name (single)', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.symbol('AlphaApi');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      name: 'AlphaApi',
      package: '@scope/alpha',
      kind: 'interface',
      file: 'packages/alpha/src/index.ts',
      line: 30,
      signature: 'export interface AlphaApi',
      doc: 'Alpha public API.',
      referenceCount: 3,
    });
  });

  it('returns all definitions for a name with cross-package collision', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.symbol('init');
    assert.equal(result.length, 2);
    assert.equal(result[0]!.package, '@scope/alpha');
    assert.equal(result[0]!.referenceCount, 5);
    assert.equal(result[1]!.package, '@scope/beta');
    assert.equal(result[1]!.referenceCount, 2);
  });

  it('omits doc field when the artifact has none', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.symbol('init');
    assert.equal(result[0]!.doc, 'Alpha init.');
    assert.equal('doc' in result[1]!, false);
  });

  it('returns empty array for unknown symbol', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    assert.deepEqual(store.symbol('Nonexistent'), []);
  });
});

// ── usages mode ─────────────────────────────────────────────────────

describe('IndexStore.usages', () => {
  it('returns reference list with decoded file paths and flag booleans', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.usages('AlphaApi');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]!.definedIn, {
      package: '@scope/alpha',
      file: 'packages/alpha/src/index.ts',
      line: 30,
    });
    assert.equal(result[0]!.references.length, 3);
    assert.deepEqual(result[0]!.references[0], {
      file: 'packages/beta/src/index.ts',
      line: 1,
      kind: 'import',
      isCrossPackage: true,
      inTest: false,
    });
    assert.deepEqual(result[0]!.references[2], {
      file: 'packages/beta/src/init.test.ts',
      line: 7,
      kind: 'type-reference',
      isCrossPackage: true,
      inTest: true,
    });
  });

  it('groups references by defining site for collisions', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.usages('init');
    assert.equal(result.length, 2);
    assert.equal(result[0]!.definedIn.package, '@scope/alpha');
    assert.equal(result[0]!.references.length, 5);
    assert.equal(result[1]!.definedIn.package, '@scope/beta');
    assert.equal(result[1]!.references.length, 2);
  });

  it('treats omitted x/t flags as false', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.usages('init');
    // Alpha's first ref has no x/t flags.
    const firstAlphaRef = result[0]!.references[0]!;
    assert.equal(firstAlphaRef.isCrossPackage, false);
    assert.equal(firstAlphaRef.inTest, false);
  });

  it('returns empty array for unknown symbol', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    assert.deepEqual(store.usages('Nonexistent'), []);
  });
});

// ── package mode ────────────────────────────────────────────────────

describe('IndexStore.package', () => {
  it('returns symbols belonging only to the queried package', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const result = store.package('@scope/alpha');
    assert.ok(result);
    assert.equal(result.name, '@scope/alpha');
    assert.equal(result.symbols.length, 2);
    // AlphaApi (interface), then init (function from alpha) — not the beta init.
    assert.equal(result.symbols[0]!.name, 'AlphaApi');
    assert.equal(result.symbols[1]!.name, 'init');
    assert.equal(result.symbols[1]!.signature, 'export function init(): void');
  });

  it('filters out collision entries from other packages', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    const beta = store.package('@scope/beta');
    assert.ok(beta);
    // beta has BetaBase + init (the beta one only)
    assert.equal(beta.symbols.length, 2);
    const initEntries = beta.symbols.filter((s) => s.name === 'init');
    assert.equal(initEntries.length, 1);
    assert.equal(initEntries[0]!.signature, 'export function init(name: string): void');
  });

  it('returns null for unknown package', () => {
    const store = IndexStore.fromArtifact(makeFixture());
    assert.equal(store.package('@scope/nope'), null);
  });
});

// ── load + validate ────────────────────────────────────────────────

describe('loadArtifact', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'code-lookup-test-'));
  });

  it('loads and parses a valid artifact file', () => {
    const path = join(tmpDir, 'index.json');
    writeFileSync(path, JSON.stringify(makeFixture()));
    const artifact = loadArtifact(path);
    assert.equal(artifact.generatedFromSha, 'abc123');
    assert.equal(artifact.files.length, 5);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexNotFoundError when file is missing', () => {
    const path = join(tmpDir, 'does-not-exist.json');
    assert.throws(() => loadArtifact(path), IndexNotFoundError);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexMalformedError on invalid JSON', () => {
    const path = join(tmpDir, 'broken.json');
    writeFileSync(path, '{not json');
    assert.throws(() => loadArtifact(path), IndexMalformedError);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexMalformedError when top-level is not an object', () => {
    const path = join(tmpDir, 'array.json');
    writeFileSync(path, '[1, 2, 3]');
    assert.throws(() => loadArtifact(path), IndexMalformedError);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexMalformedError when files is missing', () => {
    const path = join(tmpDir, 'no-files.json');
    writeFileSync(path, JSON.stringify({ symbols: {}, packages: {} }));
    assert.throws(() => loadArtifact(path), IndexMalformedError);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexMalformedError when symbols is missing', () => {
    const path = join(tmpDir, 'no-symbols.json');
    writeFileSync(path, JSON.stringify({ files: [], packages: {} }));
    assert.throws(() => loadArtifact(path), IndexMalformedError);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws IndexMalformedError when packages is missing', () => {
    const path = join(tmpDir, 'no-packages.json');
    writeFileSync(path, JSON.stringify({ files: [], symbols: {} }));
    assert.throws(() => loadArtifact(path), IndexMalformedError);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── path resolution ─────────────────────────────────────────────────

describe('resolveIndexPath', () => {
  it('uses the default when undefined', () => {
    const resolved = resolveIndexPath(undefined);
    assert.match(resolved, /\.nexus\/code-lookup-index\.json$/);
  });

  it('keeps absolute paths unchanged', () => {
    assert.equal(resolveIndexPath('/abs/path.json'), '/abs/path.json');
  });

  it('resolves relative paths against process.cwd()', () => {
    const resolved = resolveIndexPath('foo/bar.json');
    assert.equal(resolved, join(process.cwd(), 'foo/bar.json'));
  });
});

// ── unknown-id surfaces malformed error ─────────────────────────────

describe('IndexStore — defensive decoding', () => {
  it('throws on out-of-range file id', () => {
    // Hand-crafted artifact with an invalid file id 99.
    const broken: ReverseUsageIndexArtifact = {
      generatedFromSha: 'x',
      generatedAt: 'y',
      monorepoRoot: '/z',
      files: ['only-one.ts'],
      symbols: {
        Bad: [
          {
            package: '@scope/x',
            kind: 'function',
            definedAt: [99, 1],
            signature: 'export function Bad(): void',
            references: [],
          },
        ],
      },
      packages: { '@scope/x': { symbols: ['Bad'] } },
    };
    const store = IndexStore.fromArtifact(broken);
    assert.throws(() => store.symbol('Bad'), IndexMalformedError);
  });
});

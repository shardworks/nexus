/**
 * Tests for the cross-package coupling script. Run via:
 *
 *   node --experimental-transform-types --test scripts/cross-package-coupling.test.ts
 *
 * No third-party dependencies — built-in `node:test` and `node:assert/strict`
 * only. The fixtures are synthetic strings so the tests do not depend on any
 * real workspace file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collapseToParent,
  parseImports,
  toPluginId,
  readWorkspaceGlobs,
  scanWorkspace,
  aggregate,
  renderMarkdown,
  type DiscoveredPackage,
} from './cross-package-coupling.ts';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── parseImports: import shapes ────────────────────────────────────────────

test('single-line value import is matched', () => {
  const edges = parseImports(
    `import { foo } from '@shardworks/nexus-core';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/nexus-core');
  assert.equal(edges[0].line, 1);
});

test('single-line type-only import is matched', () => {
  const edges = parseImports(
    `import type { Foo } from '@shardworks/clerk-apparatus';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/clerk-apparatus');
});

test('multi-line import with the from clause on its own line is matched once', () => {
  const edges = parseImports(
    [
      `import {`,
      `  foo,`,
      `  bar,`,
      `  baz,`,
      `} from '@shardworks/loom-apparatus';`,
      ``,
    ].join('\n'),
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/loom-apparatus');
  assert.equal(edges[0].line, 5);
});

test('mixed default + named import is matched', () => {
  const edges = parseImports(
    `import foo, { bar, baz } from '@shardworks/spider-apparatus';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/spider-apparatus');
});

test('export ... from re-export is matched', () => {
  const edges = parseImports(
    `export type { SpiderWritStatus } from '@shardworks/spider-apparatus';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/spider-apparatus');
});

test('export * from re-export is matched', () => {
  const edges = parseImports(
    `export * from '@shardworks/nexus-core';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/nexus-core');
});

test('dynamic await import is matched', () => {
  const edges = parseImports(
    `        const { guild } = await import('@shardworks/nexus-core');\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/nexus-core');
});

test('inline dynamic import inside an expression is matched', () => {
  const edges = parseImports(
    `const x = (await import('@shardworks/nexus-core')).guild();\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, '@shardworks/nexus-core');
});

test('subpath import is collapsed to the parent package', () => {
  const edges = parseImports(
    `import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';\n`,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].rawSpec, '@shardworks/stacks-apparatus/testing');
  assert.equal(edges[0].target, '@shardworks/stacks-apparatus');
});

test('non-@shardworks imports are ignored', () => {
  const edges = parseImports(
    [
      `import * as fs from 'node:fs';`,
      `import { z } from 'zod';`,
      `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
      ``,
    ].join('\n'),
  );
  assert.deepEqual(edges, []);
});

test('multiple distinct edges across a file are reported in line order', () => {
  const edges = parseImports(
    [
      `import { guild } from '@shardworks/nexus-core';`,
      `import type { ClerkApi } from '@shardworks/clerk-apparatus';`,
      `import { tool } from '@shardworks/tools-apparatus';`,
      ``,
    ].join('\n'),
  );
  assert.deepEqual(
    edges.map((e) => [e.line, e.target]),
    [
      [1, '@shardworks/nexus-core'],
      [2, '@shardworks/clerk-apparatus'],
      [3, '@shardworks/tools-apparatus'],
    ],
  );
});

// ── collapseToParent ───────────────────────────────────────────────────────

test('collapseToParent leaves bare specifier untouched', () => {
  assert.equal(
    collapseToParent('@shardworks/nexus-core'),
    '@shardworks/nexus-core',
  );
});

test('collapseToParent strips a single subpath segment', () => {
  assert.equal(
    collapseToParent('@shardworks/stacks-apparatus/testing'),
    '@shardworks/stacks-apparatus',
  );
});

test('collapseToParent strips a deeper subpath', () => {
  assert.equal(
    collapseToParent('@shardworks/foo/bar/baz'),
    '@shardworks/foo',
  );
});

// ── toPluginId ─────────────────────────────────────────────────────────────

test('toPluginId strips @shardworks scope and -apparatus suffix', () => {
  assert.equal(toPluginId('@shardworks/spider-apparatus'), 'spider');
});

test('toPluginId strips -kit suffix', () => {
  assert.equal(toPluginId('@shardworks/lattice-discord-kit'), 'lattice-discord');
});

test('toPluginId leaves framework packages without a strippable suffix alone', () => {
  assert.equal(toPluginId('@shardworks/nexus-core'), 'nexus-core');
  assert.equal(toPluginId('@shardworks/nexus-arbor'), 'nexus-arbor');
  assert.equal(toPluginId('@shardworks/nexus'), 'nexus');
});

test('toPluginId preserves non-shardworks scopes as a prefix without @', () => {
  assert.equal(toPluginId('@acme/cache-kit'), 'acme/cache');
});

// ── readWorkspaceGlobs ─────────────────────────────────────────────────────

test('readWorkspaceGlobs parses pnpm-workspace.yaml shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-'));
  try {
    const yaml = join(dir, 'pnpm-workspace.yaml');
    writeFileSync(
      yaml,
      [
        `packages:`,
        `  - 'packages/framework/*'`,
        `  - 'packages/plugins/*'`,
        ``,
      ].join('\n'),
    );
    const globs = readWorkspaceGlobs(yaml);
    assert.deepEqual(globs, ['packages/framework/*', 'packages/plugins/*']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWorkspaceGlobs throws when no globs are declared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-'));
  try {
    const yaml = join(dir, 'pnpm-workspace.yaml');
    writeFileSync(yaml, `# nothing here\n`);
    assert.throws(() => readWorkspaceGlobs(yaml), /No workspace globs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── scanWorkspace fail-loud behaviour ──────────────────────────────────────

/**
 * Build a synthetic mini-workspace containing two packages and return the
 * matching {@link DiscoveredPackage} list. Helper for the next two tests.
 */
function makeSyntheticWorkspace(
  rootDir: string,
  files: Record<string, string>,
): DiscoveredPackage[] {
  const pkgA = join(rootDir, 'packages', 'plugins', 'a');
  const pkgB = join(rootDir, 'packages', 'plugins', 'b');
  mkdirSync(join(pkgA, 'src'), { recursive: true });
  mkdirSync(join(pkgB, 'src'), { recursive: true });
  writeFileSync(
    join(pkgA, 'package.json'),
    JSON.stringify({ name: '@shardworks/a-apparatus' }),
  );
  writeFileSync(
    join(pkgB, 'package.json'),
    JSON.stringify({ name: '@shardworks/b-apparatus' }),
  );
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(rootDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return [
    {
      dir: pkgA,
      relDir: 'packages/plugins/a',
      npmName: '@shardworks/a-apparatus',
      pluginId: 'a',
    },
    {
      dir: pkgB,
      relDir: 'packages/plugins/b',
      npmName: '@shardworks/b-apparatus',
      pluginId: 'b',
    },
  ];
}

test('scanWorkspace throws when an import targets an unknown @shardworks package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-'));
  try {
    const packages = makeSyntheticWorkspace(dir, {
      'packages/plugins/a/src/x.ts': `import { foo } from '@shardworks/missing-apparatus';\n`,
    });
    assert.throws(
      () => scanWorkspace(dir, packages),
      /Unknown @shardworks\/\* target "@shardworks\/missing-apparatus".*x\.ts/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanWorkspace throws when a source file cannot be read', () => {
  // Skip when running as root (CI containers): chmod 000 would not actually
  // restrict reads, and the test would silently produce a false negative.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cpc-'));
  const target = join(
    dir,
    'packages',
    'plugins',
    'a',
    'src',
    'unreadable.ts',
  );
  try {
    const packages = makeSyntheticWorkspace(dir, {
      'packages/plugins/a/src/unreadable.ts': `// placeholder\n`,
    });
    chmodSync(target, 0o000);
    assert.throws(
      () => scanWorkspace(dir, packages),
      /Failed to read .*unreadable\.ts/,
    );
  } finally {
    try {
      chmodSync(target, 0o644);
    } catch {
      // best-effort restore so cleanup can succeed.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── aggregate / renderMarkdown smoke ───────────────────────────────────────

test('aggregate computes inbound, outbound, and pair totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-'));
  try {
    const packages = makeSyntheticWorkspace(dir, {
      'packages/plugins/a/src/index.ts':
        `import { foo } from '@shardworks/b-apparatus';\nimport type { Bar } from '@shardworks/b-apparatus';\n`,
      'packages/plugins/a/src/index.test.ts':
        `import { foo } from '@shardworks/b-apparatus';\n`,
      'packages/plugins/b/src/index.ts': `export const foo = 1;\n`,
    });
    const files = scanWorkspace(dir, packages);
    const agg = aggregate(packages, files);
    const a = agg.perPackage.find((p) => p.pluginId === 'a')!;
    const b = agg.perPackage.find((p) => p.pluginId === 'b')!;
    assert.equal(a.outboundSrc, 2);
    assert.equal(a.outboundTest, 1);
    assert.equal(b.inboundSrc, 2);
    assert.equal(b.inboundTest, 1);
    assert.equal(agg.totalFiles, 3);
    assert.equal(agg.sourceFiles, 2);
    assert.equal(agg.testFiles, 1);
    assert.deepEqual(agg.topPairs, [
      { fromPluginId: 'a', toPluginId: 'b', count: 3 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMarkdown emits methodology header and three ranking sections', () => {
  const md = renderMarkdown(
    {
      perPackage: [
        {
          pluginId: 'a',
          npmName: '@shardworks/a-apparatus',
          inboundSrc: 0,
          inboundTest: 0,
          outboundSrc: 1,
          outboundTest: 0,
        },
      ],
      topInbound: [{ pluginId: 'b', count: 1 }],
      topOutbound: [{ pluginId: 'a', count: 1 }],
      topPairs: [{ fromPluginId: 'a', toPluginId: 'b', count: 1 }],
      totalFiles: 2,
      sourceFiles: 2,
      testFiles: 0,
    },
    { sha: 'deadbeefcafefeed', dirty: false },
    '2026-04-25T00:00:00.000Z',
  );
  assert.match(md, /# Cross-package coupling snapshot/);
  assert.match(md, /Snapshot date \(UTC\):\*\* 2026-04-25T00:00:00\.000Z/);
  assert.match(md, /Git SHA:\*\* `deadbeefcafefeed`/);
  assert.match(md, /pnpm coupling-audit/);
  assert.match(md, /## Per-package summary/);
  assert.match(md, /## Top 10 inbound/);
  assert.match(md, /## Top 10 outbound/);
  assert.match(md, /## Top 10 pairs/);
});

test('renderMarkdown flags a dirty working tree', () => {
  const md = renderMarkdown(
    {
      perPackage: [],
      topInbound: [],
      topOutbound: [],
      topPairs: [],
      totalFiles: 0,
      sourceFiles: 0,
      testFiles: 0,
    },
    { sha: 'abcd', dirty: true },
    '2026-04-25T00:00:00.000Z',
  );
  assert.match(md, /working tree dirty/);
});

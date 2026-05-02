/**
 * Tool-level integration tests. Mocks the guild via setGuild() so the
 * tool handler reads our fixture path from guild config, then drives
 * the handler and validates the discriminated result shapes.
 *
 * These complement the index-store unit tests — here we only verify
 * the tool plumbing (param parsing, config wiring, error surfacing)
 * since the underlying store logic is covered upstream.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setGuild } from '@shardworks/nexus-core';

import { codeLookup } from './tool.ts';
import { resetCache } from './index-store.ts';
import { IndexNotFoundError, IndexMalformedError } from './index-store.ts';
import type { ReverseUsageIndexArtifact } from './types.ts';

// ── Fixture artifact ───────────────────────────────────────────────

function makeFixture(): ReverseUsageIndexArtifact {
  return {
    generatedFromSha: 'tool-test',
    generatedAt: '2026-05-02T00:00:00.000Z',
    monorepoRoot: '/test',
    files: [
      'packages/foo/src/index.ts',
      'packages/foo/src/util.ts',
      'packages/bar/src/index.ts',
    ],
    symbols: {
      doThing: [
        {
          package: '@scope/foo',
          kind: 'function',
          definedAt: [1, 5],
          signature: 'export function doThing(x: number): number',
          doc: 'Does the thing.',
          references: [
            { f: 0, l: 3, k: 'import' },
            { f: 0, l: 9, k: 'call' },
            { f: 2, l: 7, k: 'import', x: 1 },
          ],
        },
      ],
    },
    packages: {
      '@scope/foo': { symbols: ['doThing'] },
      '@scope/bar': { symbols: [] },
    },
  };
}

// ── Guild mock ──────────────────────────────────────────────────────

function setupGuild(indexPath: string | undefined) {
  setGuild({
    home: '/tmp/test-guild',
    guildConfig: () => ({
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
      'code-lookup': indexPath !== undefined ? { indexPath } : undefined,
    }),
    apparatus: <T>(_name: string): T => {
      throw new Error('not implemented');
    },
    config: <T>(_pluginId: string): T => ({}) as T,
    writeConfig: () => {},
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
  });
}

// ── Setup / teardown ───────────────────────────────────────────────

let tmpDir: string;
let fixturePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'code-lookup-tool-test-'));
  fixturePath = join(tmpDir, 'index.json');
  writeFileSync(fixturePath, JSON.stringify(makeFixture()));
  resetCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetCache();
});

// ── Param schema ───────────────────────────────────────────────────

describe('codeLookup — param schema', () => {
  it('rejects unknown mode', () => {
    const result = codeLookup.params.safeParse({ mode: 'huh', name: 'x' });
    assert.equal(result.success, false);
  });

  it('rejects empty name', () => {
    const result = codeLookup.params.safeParse({ mode: 'symbol', name: '' });
    assert.equal(result.success, false);
  });

  it('accepts each valid mode', () => {
    for (const mode of ['symbol', 'usages', 'package'] as const) {
      const result = codeLookup.params.safeParse({ mode, name: 'x' });
      assert.equal(result.success, true);
    }
  });
});

// ── Mode dispatch ──────────────────────────────────────────────────

describe('codeLookup — mode dispatch', () => {
  it('symbol mode returns definition records', async () => {
    setupGuild(fixturePath);
    const out = await codeLookup.handler({ mode: 'symbol', name: 'doThing' });
    assert.equal(out.mode, 'symbol');
    assert.equal(out.name, 'doThing');
    if (out.mode !== 'symbol') throw new Error('unreachable');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0]!.signature, 'export function doThing(x: number): number');
    assert.equal(out.results[0]!.referenceCount, 3);
  });

  it('symbol mode returns empty array for unknown', async () => {
    setupGuild(fixturePath);
    const out = await codeLookup.handler({ mode: 'symbol', name: 'nope' });
    if (out.mode !== 'symbol') throw new Error('unreachable');
    assert.deepEqual(out.results, []);
  });

  it('usages mode returns reference list with decoded paths', async () => {
    setupGuild(fixturePath);
    const out = await codeLookup.handler({ mode: 'usages', name: 'doThing' });
    if (out.mode !== 'usages') throw new Error('unreachable');
    assert.equal(out.results.length, 1);
    const refs = out.results[0]!.references;
    assert.equal(refs.length, 3);
    // Path resolved, flags decoded.
    assert.equal(refs[0]!.file, 'packages/foo/src/index.ts');
    assert.equal(refs[0]!.isCrossPackage, false);
    assert.equal(refs[2]!.isCrossPackage, true);
  });

  it('package mode returns full package detail', async () => {
    setupGuild(fixturePath);
    const out = await codeLookup.handler({ mode: 'package', name: '@scope/foo' });
    if (out.mode !== 'package') throw new Error('unreachable');
    assert.ok(out.result);
    assert.equal(out.result.name, '@scope/foo');
    assert.equal(out.result.symbols.length, 1);
    assert.equal(out.result.symbols[0]!.name, 'doThing');
    assert.equal(out.result.symbols[0]!.doc, 'Does the thing.');
  });

  it('package mode returns null for unknown package', async () => {
    setupGuild(fixturePath);
    const out = await codeLookup.handler({ mode: 'package', name: '@scope/missing' });
    if (out.mode !== 'package') throw new Error('unreachable');
    assert.equal(out.result, null);
  });
});

// ── Failure modes — fail loud ──────────────────────────────────────

describe('codeLookup — fail loud', () => {
  it('raises IndexNotFoundError when configured path is missing', async () => {
    setupGuild(join(tmpDir, 'missing.json'));
    await assert.rejects(
      () => codeLookup.handler({ mode: 'symbol', name: 'x' }),
      IndexNotFoundError,
    );
  });

  it('raises IndexMalformedError on broken JSON', async () => {
    const badPath = join(tmpDir, 'bad.json');
    writeFileSync(badPath, '{ not json');
    setupGuild(badPath);
    await assert.rejects(
      () => codeLookup.handler({ mode: 'symbol', name: 'x' }),
      IndexMalformedError,
    );
  });
});

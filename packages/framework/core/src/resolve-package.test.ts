import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { derivePluginId, resolvePackageNameForPluginId } from './resolve-package.ts';

describe('derivePluginId', () => {
  it('strips @shardworks scope', () => {
    assert.equal(derivePluginId('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(derivePluginId('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(derivePluginId('@acme/my-tool'), 'acme/my-tool');
    assert.equal(derivePluginId('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(derivePluginId('my-tool'), 'my-tool');
    assert.equal(derivePluginId('nexus-stdlib'), 'nexus-stdlib');
  });

  it('strips -kit suffix', () => {
    assert.equal(derivePluginId('my-relay-kit'), 'my-relay');
    assert.equal(derivePluginId('@shardworks/nexus-relay-kit'), 'nexus-relay');
  });

  it('strips -apparatus suffix', () => {
    assert.equal(derivePluginId('books-apparatus'), 'books');
    assert.equal(derivePluginId('@shardworks/books-apparatus'), 'books');
    assert.equal(derivePluginId('@acme/cache-apparatus'), 'acme/cache');
  });

  it('strips -plugin suffix', () => {
    assert.equal(derivePluginId('my-thing-plugin'), 'my-thing');
    assert.equal(derivePluginId('@shardworks/nexus-thing-plugin'), 'nexus-thing');
  });

  it('does not strip suffix-like substrings in the middle', () => {
    assert.equal(derivePluginId('my-kit-tools'), 'my-kit-tools');
    assert.equal(derivePluginId('apparatus-runner'), 'apparatus-runner');
  });
});

// ── resolvePackageNameForPluginId ────────────────────────────────────

describe('resolvePackageNameForPluginId', () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-pkg-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writePackageJson(dir: string, deps: Record<string, string>): void {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'test-guild', version: '1.0.0', dependencies: deps }),
    );
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('resolves @shardworks-scoped package without suffix', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, { '@shardworks/nexus-stdlib': '^1.0.0' });
    assert.equal(resolvePackageNameForPluginId(tmp, 'nexus-stdlib'), '@shardworks/nexus-stdlib');
  });

  it('resolves unscoped package name', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, { 'my-tool': '^1.0.0' });
    assert.equal(resolvePackageNameForPluginId(tmp, 'my-tool'), 'my-tool');
  });

  it('resolves third-party scoped package', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, { '@acme/my-tool': '^1.0.0' });
    assert.equal(resolvePackageNameForPluginId(tmp, 'acme/my-tool'), '@acme/my-tool');
  });

  it('prefers @shardworks-scoped package when ambiguous', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, {
      'nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-stdlib': '^2.0.0',
    });
    assert.equal(resolvePackageNameForPluginId(tmp, 'nexus-stdlib'), '@shardworks/nexus-stdlib');
  });

  it('returns null when no matching dependency exists', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, { 'other-package': '^1.0.0' });
    assert.equal(resolvePackageNameForPluginId(tmp, 'nonexistent'), null);
  });

  it('returns null when package.json is missing', () => {
    const tmp = makeTmpDir();
    assert.equal(resolvePackageNameForPluginId(tmp, 'anything'), null);
  });

  it('returns null when dependencies is empty', () => {
    const tmp = makeTmpDir();
    writePackageJson(tmp, {});
    assert.equal(resolvePackageNameForPluginId(tmp, 'anything'), null);
  });
});

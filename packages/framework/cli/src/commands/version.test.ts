/**
 * Tests for the `version` framework command.
 *
 * Tests the handler directly — no CLI layer involved.
 * Plugins come from config.plugins; package versions are resolved via
 * the guild's package.json and node_modules.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import versionTool from './version.ts';
import { setupGuildAccessor, makeTmpDir, makeGuild, makeGuildPackageJson, cleanupTestState } from './test-helpers.ts';

/**
 * Create a minimal fake package in node_modules with the given version.
 * Only writes a package.json — no exports needed for version lookups.
 */
function makeFakeNodeModule(guildRoot: string, packageName: string, version: string): void {
  const pkgDir = path.join(guildRoot, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version }, null, 2) + '\n',
  );
}

afterEach(() => {
  cleanupTestState();
});

// ── No guild ──────────────────────────────────────────────────────────────

describe('version handler — no guild', () => {
  it('returns framework version even without a guild', async () => {
    // guild() not set — clearGuild() runs in afterEach
    // version should still work — just shows nexus + node versions
    const result = await versionTool.handler({}) as string;
    assert.ok(result.includes('nexus:'));
    assert.ok(result.includes('node:'));
  });

  it('returns only nexus and node in json mode without a guild', async () => {
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.ok('nexus' in result);
    assert.ok('node' in result);
    assert.equal(Object.keys(result).length, 2);
  });
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('version tool definition', () => {
  it('has the correct name', () => {
    assert.equal(versionTool.name, 'version');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(versionTool.callableBy, ['cli']);
  });
});

// ── Text output ────────────────────────────────────────────────────────────

describe('version handler — text mode', () => {
  it('always includes "nexus:" even with no guild', async () => {
    const tmp = makeTmpDir('version'); // empty dir — no guild.json

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({});
    assert.ok(typeof result === 'string');
    assert.ok((result as string).includes('nexus:'));
  });

  it('always includes "node:" even with no guild', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({});
    assert.ok((result as string).includes('node:'));
  });

  it('reports the current node version', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({});
    assert.ok((result as string).includes(process.version));
  });

  it('uses "key: value" format for all lines', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({}) as string;
    for (const line of result.split('\n')) {
      if (line.trim() === '') continue;
      assert.ok(line.includes(': '), `Expected "key: value" format, got: "${line}"`);
    }
  });

  it('shows plugin id as "not installed" when guild has no package.json', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] }); // no guild package.json — resolvePackageNameForPluginId returns null

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({}) as string;
    assert.ok(result.includes('nexus-stdlib'));
    assert.ok(result.includes('not installed'));
  });

  it('shows the npm package name and version when plugin is resolvable', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });
    makeGuildPackageJson(tmp, { '@shardworks/nexus-stdlib': '^1.2.3' });
    makeFakeNodeModule(tmp, '@shardworks/nexus-stdlib', '1.2.3');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({}) as string;
    assert.ok(result.includes('@shardworks/nexus-stdlib'));
    assert.ok(result.includes('1.2.3'));
  });

  it('shows package versions for multiple installed plugins', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });
    makeGuildPackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-ledger': '^2.0.0',
    });
    makeFakeNodeModule(tmp, '@shardworks/nexus-stdlib', '1.0.0');
    makeFakeNodeModule(tmp, '@shardworks/nexus-ledger', '2.0.0');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({}) as string;
    assert.ok(result.includes('@shardworks/nexus-stdlib'));
    assert.ok(result.includes('@shardworks/nexus-ledger'));
    assert.ok(result.includes('1.0.0'));
    assert.ok(result.includes('2.0.0'));
  });
});

// ── JSON output ────────────────────────────────────────────────────────────

describe('version handler — json mode', () => {
  it('returns an object (not a string)', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true });
    assert.ok(typeof result === 'object' && result !== null);
  });

  it('includes nexus version string', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.ok(typeof result.nexus === 'string');
    assert.ok(result.nexus.length > 0);
  });

  it('includes node version matching process.version', async () => {
    const tmp = makeTmpDir('version');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.equal(result.node, process.version);
  });

  it('succeeds gracefully when guild.json is missing', async () => {
    const tmp = makeTmpDir('version'); // no guild.json

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.ok('nexus' in result);
    assert.ok('node' in result);
    assert.equal(Object.keys(result).length, 2);
  });

  it('marks plugin id as "not installed" when guild has no package.json', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] }); // no guild package.json

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.equal(result['nexus-stdlib'], 'not installed');
  });

  it('includes resolved package name and version for an installed plugin', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });
    makeGuildPackageJson(tmp, { '@shardworks/nexus-stdlib': '^1.2.3' });
    makeFakeNodeModule(tmp, '@shardworks/nexus-stdlib', '1.2.3');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.equal(result['@shardworks/nexus-stdlib'], '1.2.3');
  });

  it('includes both package versions for two installed plugins', async () => {
    const tmp = makeTmpDir('version');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });
    makeGuildPackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-ledger': '^2.0.0',
    });
    makeFakeNodeModule(tmp, '@shardworks/nexus-stdlib', '1.0.0');
    makeFakeNodeModule(tmp, '@shardworks/nexus-ledger', '2.0.0');

    setupGuildAccessor(tmp);
    const result = await versionTool.handler({ json: true }) as Record<string, string>;
    assert.equal(result['@shardworks/nexus-stdlib'], '1.0.0');
    assert.equal(result['@shardworks/nexus-ledger'], '2.0.0');
  });
});

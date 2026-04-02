/**
 * Tests for the plugin framework commands: plugin-list, plugin-install,
 * plugin-remove, plugin-upgrade.
 *
 * Tests the handlers directly — no CLI layer involved.
 * Plugins are tracked as string keys in config.plugins.
 *
 * `plugin-install` (link mode) is tested end-to-end by creating a minimal fake
 * plugin package in a tmp directory and installing it via npm, then checking the
 * resulting guild.json state. Registry mode (npm install from network) is not tested.
 *
 * `plugin-remove` tests manually pre-populate node_modules and guild/package.json so
 * that `resolvePackageNameForPluginId` works without npm.
 *
 * With permission-based access control, plugin-install and plugin-remove are pure
 * npm + guild.json operations — no tool discovery, no baseTools/role writes.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pluginList, pluginInstall, pluginRemove, pluginUpgrade } from './plugin.ts';
import { setupGuildAccessor, makeTmpDir, makeGuild, makeGuildPackageJson, cleanupTestState } from './test-helpers.ts';

/**
 * Create a minimal fake plugin package directory suitable for `plugin-install --type link`.
 * Returns the absolute path to the fake plugin directory.
 */
function makeFakePlugin(parentDir: string, packageName: string): string {
  const dirName = packageName.replace(/^@/, '').replace('/', '-');
  const pluginDir = path.join(parentDir, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });

  const pkgJson = {
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js' },
  };
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'index.js'), `export default { kit: { tools: [] } };\n`);

  return pluginDir;
}

afterEach(() => {
  cleanupTestState();
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('plugin tool definitions', () => {
  it('plugin-list is callable from cli only', () => {
    assert.deepEqual(pluginList.callableBy, ['cli']);
  });

  it('plugin-install is callable from cli only', () => {
    assert.deepEqual(pluginInstall.callableBy, ['cli']);
  });

  it('plugin-remove is callable from cli only', () => {
    assert.deepEqual(pluginRemove.callableBy, ['cli']);
  });

  it('plugin-upgrade is callable from cli only', () => {
    assert.deepEqual(pluginUpgrade.callableBy, ['cli']);
  });
});

// ── plugin-list ──────────────────────────────────────────────────────────

describe('plugin-list handler', () => {
  it('returns "No plugins installed." when plugins array is empty', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({});
    assert.equal(result, 'No plugins installed.');
  });

  it('returns empty array in json mode when no plugins installed', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({ json: true });
    assert.deepEqual(result, []);
  });

  it('shows installed plugin ids in text output', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({}) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('returns sorted plugin ids one per line in text mode', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({}) as string;
    const lines = result.split('\n').filter(Boolean);
    assert.deepEqual(lines, ['nexus-ledger', 'nexus-stdlib']);
  });

  it('returns array of { id } objects in json mode', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({ json: true });
    assert.ok(Array.isArray(result));
    const arr = result as Array<{ id: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.id, 'nexus-stdlib');
  });

  it('json output is sorted by id', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({ json: true });
    const arr = result as Array<{ id: string }>;
    assert.equal(arr.length, 2);
    const ids = arr.map((r) => r.id);
    assert.deepEqual(ids, ['nexus-ledger', 'nexus-stdlib']);
  });
});

// ── plugin-install (link mode) ───────────────────────────────────────────

describe('plugin-install handler — link mode', () => {
  it('adds the plugin id to config.plugins', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin');

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(Array.isArray(config.plugins));
    // derivePluginId strips the -plugin suffix: 'my-fake-plugin' → 'my-fake'
    assert.ok(config.plugins.includes('my-fake'));
  });

  it('does not write baseTools or roles (permission model)', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin');

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.equal(config.baseTools, undefined);
    assert.equal(config.roles, undefined);
  });

  it('does not duplicate plugin id if already in plugins array', async () => {
    const tmp = makeTmpDir('plugin');
    // derivePluginId('my-fake-plugin') → 'my-fake'
    makeGuild(tmp, { plugins: ['my-fake'] });
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin');

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    const occurrences = config.plugins.filter((r: string) => r === 'my-fake').length;
    assert.equal(occurrences, 1);
  });

  it('throws when source directory has no package.json', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const emptyDir = path.join(tmp, 'empty-plugin');
    fs.mkdirSync(emptyDir);

    setupGuildAccessor(tmp);
    await assert.rejects(
      async () => pluginInstall.handler({ source: emptyDir, type: 'link' }),
      /No package\.json/,
    );
  });

  it('returns a success message mentioning the plugin id', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin');

    setupGuildAccessor(tmp);
    const result = await pluginInstall.handler({ source: pluginDir, type: 'link' }) as string;
    assert.ok(result.includes('my-fake'));
  });

  it('auto-detects link mode for absolute directory paths', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'auto-detect-plugin');

    setupGuildAccessor(tmp);
    // No --type flag — should auto-detect that pluginDir is a directory
    await pluginInstall.handler({ source: pluginDir });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.plugins.includes('auto-detect'));
  });

  it('auto-detects link mode for relative directory paths', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'relative-detect-plugin');

    // Compute a relative path from the guild root to the plugin dir
    const relPath = './' + path.relative(process.cwd(), pluginDir);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: relPath });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.plugins.includes('relative-detect'));
  });
});

// ── plugin-remove ─��──────────────���───────────────────────────────────────

describe('plugin-remove handler', () => {
  function makeGuildWithPlugin(dir: string): void {
    makeGuild(dir, { plugins: ['nexus-stdlib'] });
    makeGuildPackageJson(dir, { '@shardworks/nexus-stdlib': '^1.0.0' });
  }

  it('removes the plugin from config.plugins', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('does not affect plugins belonging to a different plugin', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });
    makeGuildPackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-ledger': '^1.0.0',
    });

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.plugins.includes('nexus-ledger'));
  });

  it('accepts full @-scoped package name and normalizes to plugin id', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: '@shardworks/nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('returns a success message with the plugin id', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginRemove.handler({ name: 'nexus-stdlib' }) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('throws when the plugin is not installed', async () => {
    const tmp = makeTmpDir('plugin');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    await assert.rejects(
      async () => pluginRemove.handler({ name: 'nonexistent-plugin' }),
      /not installed/,
    );
  });
});

// ── plugin-upgrade ───────────────────────────────────────────────────────

describe('plugin-upgrade handler', () => {
  it('returns a "not yet implemented" message', async () => {
    setupGuildAccessor('/fake');
    const result = await pluginUpgrade.handler({ name: 'some-plugin' });
    assert.ok(typeof result === 'string');
    assert.ok((result as string).toLowerCase().includes('not yet implemented'));
  });

  it('accepts an optional version param without error', async () => {
    setupGuildAccessor('/fake');
    const result = await pluginUpgrade.handler(
      { name: 'some-plugin', version: '2.0.0' },
    );
    assert.ok(typeof result === 'string');
  });
});

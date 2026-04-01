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
 * that `resolvePackageNameForPluginId` and dynamic tool discovery work without npm.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginList, pluginInstall, pluginRemove, pluginUpgrade } from './plugin.ts';
import { setGuild, clearGuild } from '@shardworks/nexus-core';

/** Set up a minimal guild accessor pointing at the given directory. */
function setupGuildAccessor(home: string): void {
  setGuild({
    home,
    apparatus: () => { throw new Error('not available in test'); },
    config: () => ({}) as never,
    guildConfig: () => ({}) as never,
    kits: () => [],
    apparatuses: () => [],
  });
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-plugin-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write a minimal V2 guild.json to dir, with optional overrides. */
function makeGuild(dir: string, overrides: Record<string, unknown> = {}): void {
  const config = {
    name: 'test-guild',
    nexus: '0.0.0',
    workshops: {},
    roles: {},
    baseTools: [],
    plugins: [],
    settings: { model: 'sonnet' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'guild.json'), JSON.stringify(config, null, 2) + '\n');
}

/** Write a guild-root package.json declaring the given npm dependencies. */
function makeGuildPackageJson(dir: string, deps: Record<string, string>): void {
  const pkg = { name: 'test-guild', version: '1.0.0', dependencies: deps };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Create a minimal fake plugin package directory suitable for `plugin-install --type link`.
 *
 * Exports a valid ToolDefinition (or array of them) so that
 * `resolveAllToolsFromExport` recognises them as tools.
 *
 * Returns the absolute path to the fake plugin directory.
 */
function makeFakePlugin(parentDir: string, packageName: string, toolNames: string[]): string {
  // Use packageName as the directory name, handling scoped names (@scope/pkg → scope-pkg)
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

  const toolObjects = toolNames.map(
    (n) => `{ name: '${n}', description: 'Tool ${n}', params: {}, handler: async () => {} }`,
  );
  const exportExpr = toolObjects.length === 1 ? toolObjects[0] : `[${toolObjects.join(', ')}]`;
  fs.writeFileSync(path.join(pluginDir, 'index.js'), `export default ${exportExpr};\n`);

  return pluginDir;
}

/**
 * Create a fake plugin package directly inside the guild's node_modules.
 * Used to set up pre-installed plugins for plugin-remove tests without going through npm.
 * Supports scoped package names (e.g. "@shardworks/nexus-stdlib").
 */
function makeNodeModulePlugin(guildRoot: string, packageName: string, toolNames: string[]): void {
  const pkgDir = path.join(guildRoot, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });

  const pkgJson = {
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js' },
  };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  const toolObjects = toolNames.map(
    (n) => `{ name: '${n}', description: 'Tool ${n}', params: {}, handler: async () => {} }`,
  );
  const exportExpr = toolObjects.length === 1 ? toolObjects[0] : `[${toolObjects.join(', ')}]`;
  fs.writeFileSync(path.join(pkgDir, 'index.js'), `export default ${exportExpr};\n`);
}

afterEach(() => {
  clearGuild();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('plugin tool definitions', () => {
  it('plugin-list is callable from cli only', () => {
    assert.deepEqual(pluginList.callableFrom, ['cli']);
  });

  it('plugin-install is callable from cli only', () => {
    assert.deepEqual(pluginInstall.callableFrom, ['cli']);
  });

  it('plugin-remove is callable from cli only', () => {
    assert.deepEqual(pluginRemove.callableFrom, ['cli']);
  });

  it('plugin-upgrade is callable from cli only', () => {
    assert.deepEqual(pluginUpgrade.callableFrom, ['cli']);
  });
});

// ── plugin-list ──────────────────────────────────────────────────────────

describe('plugin-list handler', () => {
  it('returns "No plugins installed." when plugins array is empty', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({});
    assert.equal(result, 'No plugins installed.');
  });

  it('returns empty array in json mode when no plugins installed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({ json: true });
    assert.deepEqual(result, []);
  });

  it('shows installed plugin ids in text output', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({}) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('returns sorted plugin ids one per line in text mode', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({}) as string;
    const lines = result.split('\n').filter(Boolean);
    assert.deepEqual(lines, ['nexus-ledger', 'nexus-stdlib']);
  });

  it('returns array of { id } objects in json mode', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await pluginList.handler({ json: true });
    assert.ok(Array.isArray(result));
    const arr = result as Array<{ id: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.id, 'nexus-stdlib');
  });

  it('json output is sorted by id', async () => {
    const tmp = makeTmpDir();
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
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(Array.isArray(config.plugins));
    // derivePluginId strips the -plugin suffix: 'my-fake-plugin' → 'my-fake'
    assert.ok(config.plugins.includes('my-fake'));
  });

  it('adds tools to baseTools when no roles are specified', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('fake-tool'));
  });

  it('assigns tools to specified role instead of baseTools', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: { artificer: { seats: null, tools: [] } },
    });
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link', roles: 'artificer' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.roles.artificer.tools.includes('fake-tool'));
    assert.ok(!config.baseTools.includes('fake-tool'));
  });

  it('assigns tools to multiple roles when comma-separated', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: {
        artificer: { seats: null, tools: [] },
        scribe: { seats: 1, tools: [] },
      },
    });
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link', roles: 'artificer, scribe' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.roles.artificer.tools.includes('fake-tool'));
    assert.ok(config.roles.scribe.tools.includes('fake-tool'));
  });

  it('adds all tools from a multi-tool plugin to baseTools', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'multi-plugin', ['tool-alpha', 'tool-beta', 'tool-gamma']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('tool-alpha'));
    assert.ok(config.baseTools.includes('tool-beta'));
    assert.ok(config.baseTools.includes('tool-gamma'));
  });

  it('does not duplicate plugin id if already in plugins array', async () => {
    const tmp = makeTmpDir();
    // derivePluginId('my-fake-plugin') → 'my-fake'
    makeGuild(tmp, { plugins: ['my-fake'] });
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    await pluginInstall.handler({ source: pluginDir, type: 'link' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    const occurrences = config.plugins.filter((r: string) => r === 'my-fake').length;
    assert.equal(occurrences, 1);
  });

  it('throws when source directory has no package.json', async () => {
    const tmp = makeTmpDir();
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
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    const result = await pluginInstall.handler({ source: pluginDir, type: 'link' }) as string;
    // Message includes the derived plugin id ('my-fake') and the package name
    assert.ok(result.includes('my-fake'));
  });

  it('returns a success message mentioning discovered tool names', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const pluginDir = makeFakePlugin(tmp, 'my-fake-plugin', ['fake-tool']);

    setupGuildAccessor(tmp);
    const result = await pluginInstall.handler({ source: pluginDir, type: 'link' }) as string;
    assert.ok(result.includes('fake-tool'));
  });
});

// ── plugin-remove ────────────────────────────────────────────────────────

describe('plugin-remove handler', () => {
  /**
   * Set up a guild with nexus-stdlib already installed.
   *
   * Manually creates node_modules and guild/package.json so that
   * `resolvePackageNameForPluginId` and dynamic tool discovery work
   * without running npm install.
   */
  function makeGuildWithPlugin(dir: string): void {
    makeGuild(dir, {
      plugins: ['nexus-stdlib'],
      baseTools: ['commission', 'signal'],
      roles: {
        artificer: { seats: null, tools: ['commission'] },
      },
    });
    makeGuildPackageJson(dir, { '@shardworks/nexus-stdlib': '^1.0.0' });
    makeNodeModulePlugin(dir, '@shardworks/nexus-stdlib', ['commission', 'signal']);
  }

  it('removes the plugin from config.plugins', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('removes tools from baseTools', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.baseTools.includes('commission'));
    assert.ok(!config.baseTools.includes('signal'));
  });

  it('removes tools from role tool lists', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.roles.artificer.tools.includes('commission'));
  });

  it('does not affect tools or plugins belonging to a different plugin', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      plugins: ['nexus-stdlib', 'nexus-ledger'],
      baseTools: ['commission', 'create-writ'],
      roles: {},
    });
    makeGuildPackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-ledger': '^1.0.0',
    });
    makeNodeModulePlugin(tmp, '@shardworks/nexus-stdlib', ['commission']);
    makeNodeModulePlugin(tmp, '@shardworks/nexus-ledger', ['create-writ']);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: 'nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('create-writ'));
    assert.ok(config.plugins.includes('nexus-ledger'));
  });

  it('accepts full @-scoped package name and normalizes to plugin id', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    await pluginRemove.handler({ name: '@shardworks/nexus-stdlib' });

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('returns a success message with the plugin id', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp);

    setupGuildAccessor(tmp);
    const result = await pluginRemove.handler({ name: 'nexus-stdlib' }) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('reports the count of unregistered tools (plural)', async () => {
    const tmp = makeTmpDir();
    makeGuildWithPlugin(tmp); // 2 tools: commission, signal

    setupGuildAccessor(tmp);
    const result = await pluginRemove.handler({ name: 'nexus-stdlib' }) as string;
    assert.ok(result.includes('2 tools'));
  });

  it('uses singular "tool" when exactly one tool is removed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      plugins: ['solo-pkg'],
      baseTools: ['only-tool'],
      roles: {},
    });
    makeGuildPackageJson(tmp, { 'solo-pkg': '^1.0.0' });
    makeNodeModulePlugin(tmp, 'solo-pkg', ['only-tool']);

    setupGuildAccessor(tmp);
    const result = await pluginRemove.handler({ name: 'solo-pkg' }) as string;
    assert.ok(result.includes('1 tool '));
    assert.ok(!result.includes('1 tools'));
  });

  it('throws when the plugin is not installed', async () => {
    const tmp = makeTmpDir();
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

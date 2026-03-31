/**
 * Tests for the rig built-in tools: rig-list, rig-install, rig-remove, rig-upgrade.
 *
 * Tests the handlers directly — no CLI layer involved.
 * V2: rigs are tracked as string keys in config.rigs; config.tools is gone.
 *
 * `rig-install` (link mode) is tested end-to-end by creating a minimal fake rig
 * package in a tmp directory and installing it via npm, then checking the resulting
 * guild.json state. Registry mode (npm install from network) is not tested.
 *
 * `rig-remove` tests manually pre-populate node_modules and guild/package.json so
 * that `resolvePackageNameForRigKey` and dynamic tool discovery work without npm.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rigList, rigInstall, rigRemove, rigUpgrade } from './rig.ts';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-rig-test-'));
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
 * Create a minimal fake rig package directory suitable for `rig-install --type link`.
 *
 * Exports a valid ToolDefinition (or array of them) so that
 * `resolveAllToolsFromExport` recognises them as tools.
 *
 * Returns the absolute path to the fake rig directory.
 */
function makeFakeRig(parentDir: string, packageName: string, toolNames: string[]): string {
  // Use packageName as the directory name, handling scoped names (@scope/pkg → scope-pkg)
  const dirName = packageName.replace(/^@/, '').replace('/', '-');
  const rigDir = path.join(parentDir, dirName);
  fs.mkdirSync(rigDir, { recursive: true });

  const pkgJson = {
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js' },
  };
  fs.writeFileSync(path.join(rigDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  const toolObjects = toolNames.map(
    (n) => `{ name: '${n}', description: 'Tool ${n}', params: {}, handler: async () => {} }`,
  );
  const exportExpr = toolObjects.length === 1 ? toolObjects[0] : `[${toolObjects.join(', ')}]`;
  fs.writeFileSync(path.join(rigDir, 'index.js'), `export default ${exportExpr};\n`);

  return rigDir;
}

/**
 * Create a fake rig package directly inside the guild's node_modules.
 * Used to set up pre-installed rigs for rig-remove tests without going through npm.
 * Supports scoped package names (e.g. "@shardworks/nexus-stdlib").
 */
function makeNodeModuleRig(guildRoot: string, packageName: string, toolNames: string[]): void {
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
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('rig tool definitions', () => {
  it('rig-list is callable from cli only', () => {
    assert.deepEqual(rigList.callableFrom, ['cli']);
  });

  it('rig-install is callable from cli only', () => {
    assert.deepEqual(rigInstall.callableFrom, ['cli']);
  });

  it('rig-remove is callable from cli only', () => {
    assert.deepEqual(rigRemove.callableFrom, ['cli']);
  });

  it('rig-upgrade is callable from cli only', () => {
    assert.deepEqual(rigUpgrade.callableFrom, ['cli']);
  });
});

// ── rig-list ───────────────────────────────────────────────────────────────

describe('rig-list handler', () => {
  it('returns "No rigs installed." when rigs array is empty', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await rigList.handler({}, { home: tmp } as never);
    assert.equal(result, 'No plugins installed.');
  });

  it('returns empty array in json mode when no rigs installed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    assert.deepEqual(result, []);
  });

  it('shows installed plugin ids in text output', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('returns sorted plugin ids one per line in text mode', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    const lines = result.split('\n').filter(Boolean);
    assert.deepEqual(lines, ['nexus-ledger', 'nexus-stdlib']);
  });

  it('returns array of { id } objects in json mode', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    assert.ok(Array.isArray(result));
    const arr = result as Array<{ id: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.id, 'nexus-stdlib');
  });

  it('json output is sorted by id', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    const arr = result as Array<{ id: string }>;
    assert.equal(arr.length, 2);
    const ids = arr.map((r) => r.id);
    assert.deepEqual(ids, ['nexus-ledger', 'nexus-stdlib']);
  });
});

// ── rig-install (link mode) ────────────────────────────────────────────────

describe('rig-install handler — link mode', () => {
  it('adds the rig key to config.plugins', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(Array.isArray(config.plugins));
    assert.ok(config.plugins.includes('my-fake-rig'));
  });

  it('adds tools to baseTools when no roles are specified', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('fake-tool'));
  });

  it('assigns tools to specified role instead of baseTools', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: { artificer: { seats: null, tools: [] } },
    });
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link', roles: 'artificer' }, { home: tmp } as never);

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
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler(
      { source: rigDir, type: 'link', roles: 'artificer, scribe' },
      { home: tmp } as never,
    );

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.roles.artificer.tools.includes('fake-tool'));
    assert.ok(config.roles.scribe.tools.includes('fake-tool'));
  });

  it('adds all tools from a multi-tool rig to baseTools', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'multi-rig', ['tool-alpha', 'tool-beta', 'tool-gamma']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('tool-alpha'));
    assert.ok(config.baseTools.includes('tool-beta'));
    assert.ok(config.baseTools.includes('tool-gamma'));
  });

  it('does not duplicate the plugin id if already in plugins array', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['my-fake-rig'] });
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    const occurrences = config.plugins.filter((r: string) => r === 'my-fake-rig').length;
    assert.equal(occurrences, 1);
  });

  it('throws when source directory has no package.json', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const emptyDir = path.join(tmp, 'empty-rig');
    fs.mkdirSync(emptyDir);

    await assert.rejects(
      () => rigInstall.handler({ source: emptyDir, type: 'link' }, { home: tmp } as never),
      /No package\.json/,
    );
  });

  it('returns a success message mentioning the rig id', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    const result = await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never) as string;
    assert.ok(result.includes('my-fake-rig'));
  });

  it('returns a success message mentioning discovered tool names', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    const result = await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never) as string;
    assert.ok(result.includes('fake-tool'));
  });

});

// ── rig-remove ─────────────────────────────────────────────────────────────

describe('rig-remove handler', () => {
  /**
   * Set up a guild with nexus-stdlib already installed.
   *
   * Manually creates node_modules and guild/package.json so that
   * `resolvePackageNameForRigKey` and dynamic tool discovery work
   * without running npm install.
   */
  function makeInstalledGuild(dir: string): void {
    makeGuild(dir, {
      plugins: ['nexus-stdlib'],
      baseTools: ['commission', 'signal'],
      roles: {
        artificer: { seats: null, tools: ['commission'] },
      },
    });
    makeGuildPackageJson(dir, { '@shardworks/nexus-stdlib': '^1.0.0' });
    makeNodeModuleRig(dir, '@shardworks/nexus-stdlib', ['commission', 'signal']);
  }

  it('removes the rig from config.plugins', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('removes tools from baseTools', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.baseTools.includes('commission'));
    assert.ok(!config.baseTools.includes('signal'));
  });

  it('removes tools from role tool lists', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.roles.artificer.tools.includes('commission'));
  });

  it('does not affect tools or plugins belonging to a different rig', async () => {
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
    makeNodeModuleRig(tmp, '@shardworks/nexus-stdlib', ['commission']);
    makeNodeModuleRig(tmp, '@shardworks/nexus-ledger', ['create-writ']);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('create-writ'));
    assert.ok(config.plugins.includes('nexus-ledger'));
  });

  it('accepts full @-scoped package name and normalizes to rig key', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: '@shardworks/nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.plugins.includes('nexus-stdlib'));
  });

  it('returns a success message with the rig key', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    const result = await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('reports the count of unregistered tools (plural)', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp); // 2 tools: commission, signal

    const result = await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never) as string;
    assert.ok(result.includes('2 tools'));
  });

  it('uses singular "tool" when exactly one tool is removed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      plugins: ['solo-rig'],
      baseTools: ['only-tool'],
      roles: {},
    });
    makeGuildPackageJson(tmp, { 'solo-rig': '^1.0.0' });
    makeNodeModuleRig(tmp, 'solo-rig', ['only-tool']);

    const result = await rigRemove.handler({ name: 'solo-rig' }, { home: tmp } as never) as string;
    assert.ok(result.includes('1 tool '));
    assert.ok(!result.includes('1 tools'));
  });

  it('throws when the rig is not installed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    await assert.rejects(
      () => rigRemove.handler({ name: 'nonexistent-rig' }, { home: tmp } as never),
      /not installed/,
    );
  });
});

// ── rig-upgrade ────────────────────────────────────────────────────────────

describe('rig-upgrade handler', () => {
  it('returns a "not yet implemented" message', async () => {
    const result = await rigUpgrade.handler({ name: 'some-rig' }, { home: '/fake' } as never);
    assert.ok(typeof result === 'string');
    assert.ok((result as string).toLowerCase().includes('not yet implemented'));
  });

  it('accepts an optional version param without error', async () => {
    const result = await rigUpgrade.handler(
      { name: 'some-rig', version: '2.0.0' },
      { home: '/fake' } as never,
    );
    assert.ok(typeof result === 'string');
  });
});

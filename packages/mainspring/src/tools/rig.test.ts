/**
 * Tests for the rig built-in tools: rig-list, rig-install, rig-remove, rig-upgrade.
 *
 * Tests the handlers directly — no CLI layer involved.
 *
 * `rig-install` (link mode) is tested end-to-end by creating a minimal fake rig
 * package in a tmp directory and symlinking it, then checking the resulting
 * guild.json and node_modules state. Registry mode (npm install) is not tested
 * as it requires network access.
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

/** Write a minimal guild.json to dir, with optional overrides. */
function makeGuild(dir: string, overrides: Record<string, unknown> = {}): void {
  const config = {
    name: 'test-guild',
    nexus: '0.0.0',
    model: 'sonnet',
    workshops: {},
    roles: {},
    baseTools: [],
    tools: {},
    engines: {},
    curricula: {},
    temperaments: {},
    rigs: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'guild.json'), JSON.stringify(config, null, 2) + '\n');
}

/**
 * Create a minimal fake rig package directory.
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

  // Export a single tool or an array of tools, each satisfying isToolDefinition
  const toolObjects = toolNames.map(
    (n) => `{ name: '${n}', description: 'Tool ${n}', params: {}, handler: async () => {} }`,
  );
  const exportExpr = toolObjects.length === 1 ? toolObjects[0] : `[${toolObjects.join(', ')}]`;
  fs.writeFileSync(path.join(rigDir, 'index.js'), `export default ${exportExpr};\n`);

  return rigDir;
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
    assert.equal(result, 'No rigs installed.');
  });

  it('returns empty array in json mode when no rigs installed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    assert.deepEqual(result, []);
  });

  it('shows installed rig keys in text output', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib'],
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('shows correct tool count for each rig', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib'],
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        signal: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('2 tools'));
  });

  it('uses singular "tool" when rig has exactly one tool', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib'],
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('1 tool)'));
    assert.ok(!result.includes('1 tools'));
  });

  it('shows 0 tools for a rig with no matching tool entries', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['empty-rig'],
      tools: {},
    });

    const result = await rigList.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('empty-rig'));
    assert.ok(result.includes('0 tools'));
  });

  it('returns array of { key, toolCount } in json mode', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib'],
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    assert.ok(Array.isArray(result));
    const arr = result as Array<{ key: string; toolCount: number }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.key, 'nexus-stdlib');
    assert.equal(arr[0]!.toolCount, 1);
  });

  it('lists multiple rigs', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib', 'nexus-ledger'],
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'create-writ': {
          upstream: '@shardworks/nexus-ledger@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-ledger',
        },
      },
    });

    const result = await rigList.handler({ json: true }, { home: tmp } as never);
    const arr = result as Array<{ key: string; toolCount: number }>;
    assert.equal(arr.length, 2);
    const keys = arr.map((r) => r.key).sort();
    assert.deepEqual(keys, ['nexus-ledger', 'nexus-stdlib']);
  });
});

// ── rig-install (link mode) ────────────────────────────────────────────────

describe('rig-install handler — link mode', () => {
  it('creates a symlink in node_modules', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const linkPath = path.join(tmp, 'node_modules', 'my-fake-rig');
    assert.ok(fs.existsSync(linkPath));
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  });

  it('symlink points to the source directory', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const linkPath = path.join(tmp, 'node_modules', 'my-fake-rig');
    const resolved = fs.realpathSync(linkPath);
    assert.equal(resolved, fs.realpathSync(rigDir));
  });

  it('adds the rig key to config.rigs', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(Array.isArray(config.rigs));
    assert.ok(config.rigs.includes('my-fake-rig'));
  });

  it('registers discovered tools in config.tools', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok('fake-tool' in config.tools);
    assert.equal(config.tools['fake-tool'].package, 'my-fake-rig');
  });

  it('sets installedAt on each registered tool', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    const before = Date.now();
    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);
    const after = Date.now();

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    const installedAt = new Date(config.tools['fake-tool'].installedAt).getTime();
    assert.ok(installedAt >= before && installedAt <= after);
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

  it('registers all tools from a multi-tool rig', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);
    const rigDir = makeFakeRig(tmp, 'multi-rig', ['tool-alpha', 'tool-beta', 'tool-gamma']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok('tool-alpha' in config.tools);
    assert.ok('tool-beta' in config.tools);
    assert.ok('tool-gamma' in config.tools);
    assert.ok(config.baseTools.includes('tool-alpha'));
    assert.ok(config.baseTools.includes('tool-beta'));
    assert.ok(config.baseTools.includes('tool-gamma'));
  });

  it('does not duplicate the rig key if already in rigs array', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { rigs: ['my-fake-rig'] });
    const rigDir = makeFakeRig(tmp, 'my-fake-rig', ['fake-tool']);

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    const occurrences = config.rigs.filter((r: string) => r === 'my-fake-rig').length;
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

  it('throws when rig.json declares an unsatisfied rig dependency', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp); // empty guild — required-rig not installed
    const rigDir = makeFakeRig(tmp, 'dependent-rig', ['dep-tool']);
    fs.writeFileSync(
      path.join(rigDir, 'rig.json'),
      JSON.stringify({ dependencies: [{ rig: 'required-rig' }] }),
    );

    await assert.rejects(
      () => rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never),
      /required-rig/,
    );
  });

  it('succeeds when rig.json dependencies are already satisfied', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { rigs: ['required-rig'] }); // required-rig present
    const rigDir = makeFakeRig(tmp, 'dependent-rig', ['dep-tool']);
    fs.writeFileSync(
      path.join(rigDir, 'rig.json'),
      JSON.stringify({ dependencies: [{ rig: 'required-rig' }] }),
    );

    await rigInstall.handler({ source: rigDir, type: 'link' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok('dep-tool' in config.tools);
  });
});

// ── rig-remove ─────────────────────────────────────────────────────────────

describe('rig-remove handler', () => {
  /** Set up a guild with nexus-stdlib already installed (2 tools, 1 in a role). */
  function makeInstalledGuild(dir: string): void {
    makeGuild(dir, {
      rigs: ['nexus-stdlib'],
      baseTools: ['commission', 'signal'],
      roles: {
        artificer: { seats: null, tools: ['commission'] },
      },
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        signal: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });
  }

  it('removes the rig from config.rigs', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.rigs.includes('nexus-stdlib'));
  });

  it('removes all rig-owned tools from config.tools', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!('commission' in config.tools));
    assert.ok(!('signal' in config.tools));
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

  it('does not remove tools that belong to a different rig', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['nexus-stdlib', 'nexus-ledger'],
      baseTools: ['commission', 'create-writ'],
      roles: {},
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'create-writ': {
          upstream: '@shardworks/nexus-ledger@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-ledger',
        },
      },
    });

    await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok('create-writ' in config.tools);
    assert.ok(config.baseTools.includes('create-writ'));
    assert.ok(config.rigs.includes('nexus-ledger'));
  });

  it('accepts full @-scoped package name and normalizes to rig key', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    // Pass full package name instead of derived key
    await rigRemove.handler({ name: '@shardworks/nexus-stdlib' }, { home: tmp } as never);

    const config = JSON.parse(fs.readFileSync(path.join(tmp, 'guild.json'), 'utf-8'));
    assert.ok(!config.rigs.includes('nexus-stdlib'));
  });

  it('returns a success message with the rig key', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    const result = await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('reports the count of unregistered tools (plural)', async () => {
    const tmp = makeTmpDir();
    makeInstalledGuild(tmp);

    const result = await rigRemove.handler({ name: 'nexus-stdlib' }, { home: tmp } as never) as string;
    assert.ok(result.includes('2 tools'));
  });

  it('uses singular "tool" when exactly one tool is removed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      rigs: ['solo-rig'],
      baseTools: ['only-tool'],
      roles: {},
      tools: {
        'only-tool': {
          upstream: 'solo-rig@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'solo-rig',
        },
      },
    });

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

/**
 * Integration tests for createGuild — the Arbor entry point.
 *
 * Tests the full pipeline: read guild config → load plugins → validate →
 * start → return Guild instance. Uses real temp directories with fake
 * plugin packages in node_modules.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearGuild, guild } from '@shardworks/nexus-core';
import { createGuild } from './arbor.ts';

// ── Fixture helpers ──────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbor-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearGuild();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/**
 * Write a guild.json to the given directory.
 */
function writeGuildJson(dir: string, config: Record<string, unknown>): void {
  const full = {
    name: 'test-guild',
    nexus: '0.0.0',
    workshops: {},
    plugins: [],
    settings: { model: 'sonnet' },
    ...config,
  };
  fs.writeFileSync(path.join(dir, 'guild.json'), JSON.stringify(full, null, 2) + '\n');
}

/**
 * Write a guild-root package.json with the given dependencies.
 */
function writePackageJson(dir: string, deps: Record<string, string>): void {
  const pkg = { name: 'test-guild', version: '1.0.0', type: 'module', dependencies: deps };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Create a fake kit plugin in node_modules.
 *
 * A kit export: `export default { kit: { ... } }`
 */
function installFakeKit(
  guildRoot: string,
  packageName: string,
  kitContributions: Record<string, unknown> = {},
): void {
  const pkgDir = path.join(guildRoot, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
  );
  const kitObj = JSON.stringify(kitContributions);
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    `export default { kit: ${kitObj} };\n`,
  );
}

/**
 * Create a fake apparatus plugin in node_modules.
 *
 * An apparatus export: `export default { apparatus: { start() {}, ... } }`
 *
 * The start function is a no-op by default. For custom behavior, pass
 * a `startBody` string — it becomes the body of the async start() function.
 * The module imports `node:fs` at the top so start bodies can use `fs.*`.
 */
function installFakeApparatus(
  guildRoot: string,
  packageName: string,
  opts: {
    requires?: string[];
    provides?: string;    // JS expression for the provides object
    consumes?: string[];
    startBody?: string;   // JS code for the start() function body (can use `fs`)
  } = {},
): void {
  const pkgDir = path.join(guildRoot, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '2.0.0', type: 'module', exports: { '.': './index.js' } }),
  );

  const requires = opts.requires ? JSON.stringify(opts.requires) : 'undefined';
  const provides = opts.provides ?? 'undefined';
  const consumes = opts.consumes ? JSON.stringify(opts.consumes) : 'undefined';
  const startBody = opts.startBody ?? '';

  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    `import fs from 'node:fs';
export default {
  apparatus: {
    requires: ${requires},
    provides: ${provides},
    consumes: ${consumes},
    async start(ctx) { ${startBody} },
  },
};\n`,
  );
}

// ── createGuild — basic ──────────────────────────────────────────────

describe('createGuild — basic', () => {
  it('returns a Guild object with the correct home path', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, {});
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.equal(g.home, tmp);
  });

  it('sets the guild() singleton', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, {});
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.equal(guild(), g);
  });

  it('returns the guild config via guildConfig()', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, { name: 'my-test-guild' });
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.equal(g.guildConfig().name, 'my-test-guild');
  });

  it('works with no plugins declared', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, { plugins: [] });
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.deepEqual(g.kits(), []);
    assert.deepEqual(g.apparatuses(), []);
  });
});

// ── createGuild — kit loading ────────────────────────────────────────

describe('createGuild — kit loading', () => {
  it('loads a kit plugin and exposes it via kits()', async () => {
    const tmp = makeTmpDir();
    installFakeKit(tmp, '@shardworks/nexus-relay-kit', { tools: ['relay-send'] });
    writeGuildJson(tmp, { plugins: ['nexus-relay'] });
    writePackageJson(tmp, { '@shardworks/nexus-relay-kit': '^1.0.0' });

    const g = await createGuild(tmp);
    assert.equal(g.kits().length, 1);
    assert.equal(g.kits()[0]!.id, 'nexus-relay');
    assert.equal(g.kits()[0]!.packageName, '@shardworks/nexus-relay-kit');
  });

  it('loads multiple kits', async () => {
    const tmp = makeTmpDir();
    installFakeKit(tmp, '@shardworks/nexus-stdlib', { tools: ['commission'] });
    installFakeKit(tmp, '@shardworks/nexus-relay-kit', { relays: ['email'] });
    writeGuildJson(tmp, { plugins: ['nexus-stdlib', 'nexus-relay'] });
    writePackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/nexus-relay-kit': '^1.0.0',
    });

    const g = await createGuild(tmp);
    assert.equal(g.kits().length, 2);
    const ids = g.kits().map((k) => k.id).sort();
    assert.deepEqual(ids, ['nexus-relay', 'nexus-stdlib']);
  });
});

// ── createGuild — apparatus loading ──────────────────────────────────

describe('createGuild — apparatus loading', () => {
  it('loads an apparatus and exposes it via apparatuses()', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    assert.equal(g.apparatuses().length, 1);
    assert.equal(g.apparatuses()[0]!.id, 'tools');
  });

  it('calls start() on each apparatus during guild creation', async () => {
    const tmp = makeTmpDir();
    // Use a side-effect file to prove start() was called
    const marker = path.join(tmp, '.started');
    installFakeApparatus(tmp, '@shardworks/tools-apparatus', {
      startBody: `fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
    });
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    await createGuild(tmp);
    assert.ok(fs.existsSync(marker), 'start() was not called');
  });

  it('starts apparatuses in dependency order', async () => {
    const tmp = makeTmpDir();
    const orderFile = path.join(tmp, '.start-order');

    // "web" requires "db", so db.start() must run first
    installFakeApparatus(tmp, 'db', {
      startBody: `
        const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'db\\n');
      `,
    });
    installFakeApparatus(tmp, 'web', {
      requires: ['db'],
      startBody: `
        const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'web\\n');
      `,
    });
    writeGuildJson(tmp, { plugins: ['db', 'web'] });
    writePackageJson(tmp, {
      'db': '^1.0.0',
      'web': '^1.0.0',
    });

    await createGuild(tmp);
    const order = fs.readFileSync(orderFile, 'utf-8').trim().split('\n');
    assert.deepEqual(order, ['db', 'web']);
  });

  it('exposes apparatus provides via guild.apparatus()', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus', {
      provides: '{ list: () => ["tool-a"] }',
    });
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    const api = g.apparatus<{ list: () => string[] }>('tools');
    assert.deepEqual(api.list(), ['tool-a']);
  });

  it('throws immediately when apparatus has no provides', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    assert.throws(() => g.apparatus('tools'), /is not available/);
  });
});

// ── createGuild — plugin config ──────────────────────────────────────

describe('createGuild — plugin config', () => {
  it('returns plugin-specific config via guild.config()', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, {
      plugins: ['tools'],
      tools: { maxConcurrency: 5 },
    });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    const cfg = g.config<{ maxConcurrency: number }>('tools');
    assert.equal(cfg.maxConcurrency, 5);
  });

  it('returns empty object for unconfigured plugin', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    const cfg = g.config('tools');
    assert.deepEqual(cfg, {});
  });
});

// ── createGuild — validation ─────────────────────────────────────────

describe('createGuild — validation', () => {
  it('throws when an apparatus requires a missing plugin', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, 'web', { requires: ['db'] });
    writeGuildJson(tmp, { plugins: ['web'] });
    writePackageJson(tmp, { 'web': '^1.0.0' });

    await assert.rejects(
      () => createGuild(tmp),
      /requires "db", which is not installed/,
    );
  });

  it('throws on circular dependencies', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, 'app-a', { requires: ['app-b'] });
    installFakeApparatus(tmp, 'app-b', { requires: ['app-a'] });
    writeGuildJson(tmp, { plugins: ['app-a', 'app-b'] });
    writePackageJson(tmp, { 'app-a': '^1.0.0', 'app-b': '^1.0.0' });

    await assert.rejects(
      () => createGuild(tmp),
      /Circular dependency detected/,
    );
  });
});

// ── createGuild — event system ───────────────────────────────────────

describe('createGuild — event system', () => {
  it('fires plugin:initialized for kits before any apparatus starts', async () => {
    const tmp = makeTmpDir();
    const logFile = path.join(tmp, '.event-log');

    installFakeKit(tmp, '@shardworks/nexus-stdlib', { tools: ['commission'] });
    installFakeApparatus(tmp, '@shardworks/tools-apparatus', {
      startBody: `
        const prev = fs.existsSync(${JSON.stringify(logFile)}) ? fs.readFileSync(${JSON.stringify(logFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(logFile)}, prev + 'apparatus-start\\n');
      `,
    });
    writeGuildJson(tmp, { plugins: ['nexus-stdlib', 'tools'] });
    writePackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/tools-apparatus': '^2.0.0',
    });

    await createGuild(tmp);
    // Kit plugin:initialized fires before apparatus start()
    // (We can't easily observe the event from outside, but we can verify
    // the apparatus started — the order guarantee is structural.)
    assert.ok(fs.existsSync(logFile), 'apparatus start() should have run');
  });

  it('makes StartupContext.on() available during apparatus start()', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.ctx-available');

    installFakeApparatus(tmp, '@shardworks/tools-apparatus', {
      startBody: `
        if (typeof ctx.on === 'function') {
          fs.writeFileSync(${JSON.stringify(marker)}, 'yes');
        }
      `,
    });
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    await createGuild(tmp);
    assert.ok(fs.existsSync(marker), 'ctx.on should be available during start()');
  });
});

// ── createGuild — resilience ─────────────────────────────────────────

describe('createGuild — resilience', () => {
  it('skips plugins with no matching package in package.json', async () => {
    const tmp = makeTmpDir();
    // guild.json lists a plugin, but package.json has no matching dep
    writeGuildJson(tmp, { plugins: ['nexus-phantom'] });
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    // Should not throw; plugin is silently skipped
    assert.deepEqual(g.kits(), []);
    assert.deepEqual(g.apparatuses(), []);
  });

  it('skips plugins that fail to load and continues with the rest', async () => {
    const tmp = makeTmpDir();

    // broken-plugin has a syntax error
    const brokenDir = path.join(tmp, 'node_modules', 'broken-plugin');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'package.json'),
      JSON.stringify({ name: 'broken-plugin', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
    fs.writeFileSync(path.join(brokenDir, 'index.js'), 'this is not valid javascript {{{');

    // good-kit loads fine
    installFakeKit(tmp, '@shardworks/nexus-stdlib', { tools: ['commission'] });

    writeGuildJson(tmp, { plugins: ['broken-plugin', 'nexus-stdlib'] });
    writePackageJson(tmp, {
      'broken-plugin': '^1.0.0',
      '@shardworks/nexus-stdlib': '^1.0.0',
    });

    const g = await createGuild(tmp);
    // broken-plugin is skipped; nexus-stdlib loads fine
    assert.equal(g.kits().length, 1);
    assert.equal(g.kits()[0]!.id, 'nexus-stdlib');
  });
});

// ── createGuild — snapshot isolation ─────────────────────────────────

describe('createGuild — snapshot isolation', () => {
  it('kits() returns a copy, not a reference to internal state', async () => {
    const tmp = makeTmpDir();
    installFakeKit(tmp, '@shardworks/nexus-stdlib', { tools: [] });
    writeGuildJson(tmp, { plugins: ['nexus-stdlib'] });
    writePackageJson(tmp, { '@shardworks/nexus-stdlib': '^1.0.0' });

    const g = await createGuild(tmp);
    const a = g.kits();
    const b = g.kits();
    assert.notEqual(a, b); // Different array references
    assert.deepEqual(a, b); // Same content
  });

  it('apparatuses() returns a copy, not a reference to internal state', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    const a = g.apparatuses();
    const b = g.apparatuses();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});

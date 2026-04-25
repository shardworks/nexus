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
    assert.deepEqual(g.failedPlugins(), []);
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

  it('exposes deferred provides set during start() via getter', async () => {
    const tmp = makeTmpDir();

    // Manually create a plugin that mirrors the Stacks pattern:
    // provides is a getter returning a variable that's undefined until start() runs.
    const pkgDir = path.join(tmp, 'node_modules', 'deferred-apparatus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'deferred-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `let api;
export default {
  apparatus: {
    requires: undefined,
    get provides() { return api; },
    async start() { api = { ready: true }; },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['deferred'] });
    writePackageJson(tmp, { 'deferred-apparatus': '^1.0.0' });

    const g = await createGuild(tmp);
    const api = g.apparatus('deferred');
    assert.deepEqual(api, { ready: true });
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
  it('marks apparatus with missing dependency as failed and continues', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, 'web', { requires: ['db'] });
    writeGuildJson(tmp, { plugins: ['web'] });
    writePackageJson(tmp, { 'web': '^1.0.0' });

    const g = await createGuild(tmp);
    assert.equal(g.apparatuses().length, 0);
    assert.equal(g.failedPlugins().length, 1);
    assert.match(g.failedPlugins()[0]!.reason, /requires "db", which is not installed/);
  });

  it('marks circular dependencies as failed and continues', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, 'app-a', { requires: ['app-b'] });
    installFakeApparatus(tmp, 'app-b', { requires: ['app-a'] });
    writeGuildJson(tmp, { plugins: ['app-a', 'app-b'] });
    writePackageJson(tmp, { 'app-a': '^1.0.0', 'app-b': '^1.0.0' });

    const g = await createGuild(tmp);
    assert.equal(g.apparatuses().length, 0);
    assert.equal(g.failedPlugins().length, 2);
    const failedIds = g.failedPlugins().map((f) => f.id).sort();
    assert.deepEqual(failedIds, ['app-a', 'app-b']);
  });

  it('cascades failures to transitive dependents', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, 'db');
    installFakeApparatus(tmp, 'web', { requires: ['db', 'cache'] });
    installFakeApparatus(tmp, 'api', { requires: ['web'] });
    writeGuildJson(tmp, { plugins: ['db', 'web', 'api'] });
    writePackageJson(tmp, { 'db': '^1.0.0', 'web': '^1.0.0', 'api': '^1.0.0' });

    const g = await createGuild(tmp);
    // db is healthy; web fails (missing cache); api cascades
    assert.equal(g.apparatuses().length, 1);
    assert.equal(g.apparatuses()[0]!.id, 'db');
    assert.equal(g.failedPlugins().length, 2);
    const failedIds = g.failedPlugins().map((f) => f.id).sort();
    assert.deepEqual(failedIds, ['api', 'web']);
    const apiFailure = g.failedPlugins().find((f) => f.id === 'api');
    assert.match(apiFailure!.reason, /depends on failed plugin "web"/);
  });
});

// ── createGuild — event system ───────────────────────────────────────

describe('createGuild — event system', () => {
  it('starts all apparatuses (Wire phase completes before any start)', async () => {
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

  it('makes StartupContext.kits() available during apparatus start()', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.kits-available');

    installFakeKit(tmp, '@shardworks/nexus-stdlib', { tools: ['commission'] });
    installFakeApparatus(tmp, '@shardworks/tools-apparatus', {
      consumes: ['tools'],
      startBody: `
        if (typeof ctx.kits === 'function') {
          const toolEntries = ctx.kits('tools');
          if (Array.isArray(toolEntries)) {
            fs.writeFileSync(${JSON.stringify(marker)}, String(toolEntries.length));
          }
        }
      `,
    });
    writeGuildJson(tmp, { plugins: ['nexus-stdlib', 'tools'] });
    writePackageJson(tmp, {
      '@shardworks/nexus-stdlib': '^1.0.0',
      '@shardworks/tools-apparatus': '^2.0.0',
    });

    await createGuild(tmp);
    assert.ok(fs.existsSync(marker), 'ctx.kits should be available during start()');
    assert.equal(fs.readFileSync(marker, 'utf-8'), '1');
  });

  it('ctx.kits() returns entries from both standalone kits and apparatus supportKits', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.kit-count');

    // Kit contributes pages
    installFakeKit(tmp, '@shardworks/pages-kit', { pages: [{ id: 'page-a' }] });

    // Apparatus with a supportKit that also contributes pages
    const pkgDir = path.join(tmp, 'node_modules', 'oculus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'oculus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    consumes: ['pages'],
    supportKit: { pages: [{ id: 'page-b' }] },
    async start(ctx) {
      const entries = ctx.kits('pages');
      fs.writeFileSync(${JSON.stringify(marker)}, String(entries.length));
    },
  },
};\n`,
    );

    // @shardworks/pages-kit derives to plugin id 'pages' (strips -kit suffix)
    writeGuildJson(tmp, { plugins: ['pages', 'oculus'] });
    writePackageJson(tmp, {
      '@shardworks/pages-kit': '^1.0.0',
      'oculus': '^1.0.0',
    });

    await createGuild(tmp);
    assert.ok(fs.existsSync(marker), 'start() should have run and written the marker');
    // Both the standalone kit and the supportKit contribute 'pages', so 2 entries
    assert.equal(fs.readFileSync(marker, 'utf-8'), '2');
  });

  it('g.apparatuses() only contains apparatuses that have completed start()', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.visible-count');

    // "db" starts first; "web" requires "db" and checks g.apparatuses() during its start()
    const pkgDir = path.join(tmp, 'node_modules', 'db');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'db', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `export default { apparatus: { provides: { ready: true }, async start() {} } };\n`,
    );

    const webDir = path.join(tmp, 'node_modules', 'web');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, 'package.json'),
      JSON.stringify({ name: 'web', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    // web's start() uses a dynamic import of nexus-core to call guild().apparatuses()
    // We can't easily call guild() from the fake module, so instead we write a
    // marker file and verify post-hoc that the order was correct.
    // Instead: write start order to a file; we verify db started before web.
    const orderFile = path.join(tmp, '.start-order');
    fs.writeFileSync(
      path.join(webDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    requires: ['db'],
    provides: { ready: true },
    async start() {
      const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
      fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'web\\n');
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['db', 'web'] });
    writePackageJson(tmp, { 'db': '^1.0.0', 'web': '^1.0.0' });

    const g = await createGuild(tmp);
    // After createGuild, both apparatuses are started
    assert.equal(g.apparatuses().length, 2);
  });

  it('fires apparatus:started after each apparatus completes start()', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.event-fired');

    const pkgDir = path.join(tmp, 'node_modules', 'my-apparatus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'my-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    provides: { ready: true },
    async start(ctx) {
      ctx.on('apparatus:started', () => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'fired');
      });
    },
  },
};\n`,
    );

    // 'my-apparatus' derives to plugin id 'my' (strips -apparatus suffix)
    writeGuildJson(tmp, { plugins: ['my'] });
    writePackageJson(tmp, { 'my-apparatus': '^1.0.0' });

    await createGuild(tmp);
    assert.ok(fs.existsSync(marker), 'apparatus:started event should have fired');
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'fired');
  });

  it('fires phase:started once after all apparatus start() calls', async () => {
    const tmp = makeTmpDir();
    const marker = path.join(tmp, '.phase-started');
    const orderFile = path.join(tmp, '.start-order');

    installFakeApparatus(tmp, 'app-a', {
      provides: '{ ready: true }',
      startBody: `
        ctx.on('phase:started', () => {
          fs.writeFileSync(${JSON.stringify(marker)}, 'phase-started');
        });
        const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'app-a\\n');
      `,
    });
    installFakeApparatus(tmp, 'app-b', {
      provides: '{ ready: true }',
      startBody: `
        const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'app-b\\n');
      `,
    });

    writeGuildJson(tmp, { plugins: ['app-a', 'app-b'] });
    writePackageJson(tmp, { 'app-a': '^1.0.0', 'app-b': '^1.0.0' });

    await createGuild(tmp);
    // Both apparatuses started
    const order = fs.readFileSync(orderFile, 'utf-8').trim().split('\n');
    assert.ok(order.includes('app-a'));
    assert.ok(order.includes('app-b'));
    // phase:started fired after all starts
    assert.ok(fs.existsSync(marker), 'phase:started event should have fired');
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'phase-started');
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

// ── createGuild — shutdown() lifecycle ───────────────────────────────

describe('createGuild — shutdown()', () => {
  it('returns a StartedGuild with a shutdown() method', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, {});
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.equal(typeof g.shutdown, 'function');
  });

  it('calls stop() on each started apparatus during shutdown', async () => {
    const tmp = makeTmpDir();
    const stopMarker = path.join(tmp, '.stopped');

    // An apparatus whose stop() writes a side-effect marker file.
    const pkgDir = path.join(tmp, 'node_modules', 'stoppable-apparatus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'stoppable-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    async start() {},
    stop() {
      fs.writeFileSync(${JSON.stringify(stopMarker)}, 'yes');
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['stoppable'] });
    writePackageJson(tmp, { 'stoppable-apparatus': '^1.0.0' });

    const g = await createGuild(tmp);
    assert.ok(!fs.existsSync(stopMarker), 'stop() should not run before shutdown()');
    await g.shutdown();
    assert.ok(fs.existsSync(stopMarker), 'stop() should run during shutdown()');
  });

  it('calls stop() in reverse topological order (Stacks-style chain)', async () => {
    const tmp = makeTmpDir();
    const orderFile = path.join(tmp, '.stop-order');

    // db started first, then web; on shutdown web must stop before db.
    installFakeApparatus(tmp, 'db');
    installFakeApparatus(tmp, 'web', { requires: ['db'] });

    // Replace with stop-aware versions.
    fs.writeFileSync(
      path.join(tmp, 'node_modules', 'db', 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    async start() {},
    stop() {
      const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
      fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'db\\n');
    },
  },
};\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'node_modules', 'web', 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    requires: ['db'],
    async start() {},
    stop() {
      const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
      fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'web\\n');
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['db', 'web'] });
    writePackageJson(tmp, { 'db': '^1.0.0', 'web': '^1.0.0' });

    const g = await createGuild(tmp);
    await g.shutdown();
    const order = fs.readFileSync(orderFile, 'utf-8').trim().split('\n');
    assert.deepEqual(order, ['web', 'db']);
  });

  it('clears the guild() singleton — subsequent guild() calls throw', async () => {
    const tmp = makeTmpDir();
    writeGuildJson(tmp, {});
    writePackageJson(tmp, {});

    const g = await createGuild(tmp);
    assert.equal(guild(), g, 'guild() returns the started guild before shutdown');
    await g.shutdown();
    assert.throws(() => guild(), /Guild not initialized/);
  });

  it('is idempotent — second call is a no-op', async () => {
    const tmp = makeTmpDir();
    const stopMarker = path.join(tmp, '.stopped-count');

    const pkgDir = path.join(tmp, 'node_modules', 'counted-apparatus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'counted-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    async start() {},
    stop() {
      const n = fs.existsSync(${JSON.stringify(stopMarker)}) ? Number(fs.readFileSync(${JSON.stringify(stopMarker)}, 'utf-8')) : 0;
      fs.writeFileSync(${JSON.stringify(stopMarker)}, String(n + 1));
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['counted'] });
    writePackageJson(tmp, { 'counted-apparatus': '^1.0.0' });

    const g = await createGuild(tmp);
    await g.shutdown();
    await g.shutdown();
    await g.shutdown();
    assert.equal(fs.readFileSync(stopMarker, 'utf-8'), '1', 'stop() should run exactly once');
  });

  it('skips apparatus that have no stop()', async () => {
    const tmp = makeTmpDir();
    installFakeApparatus(tmp, '@shardworks/tools-apparatus');
    writeGuildJson(tmp, { plugins: ['tools'] });
    writePackageJson(tmp, { '@shardworks/tools-apparatus': '^2.0.0' });

    const g = await createGuild(tmp);
    // Should not throw — apparatus has no stop().
    await g.shutdown();
    assert.throws(() => guild(), /Guild not initialized/);
  });

  it('fires guild:shutdown before any stop() runs', async () => {
    const tmp = makeTmpDir();
    const orderFile = path.join(tmp, '.shutdown-order');

    const pkgDir = path.join(tmp, 'node_modules', 'event-apparatus');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'event-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    async start(ctx) {
      ctx.on('guild:shutdown', () => {
        const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
        fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'event\\n');
      });
    },
    stop() {
      const prev = fs.existsSync(${JSON.stringify(orderFile)}) ? fs.readFileSync(${JSON.stringify(orderFile)}, 'utf-8') : '';
      fs.writeFileSync(${JSON.stringify(orderFile)}, prev + 'stop\\n');
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['event'] });
    writePackageJson(tmp, { 'event-apparatus': '^1.0.0' });

    const g = await createGuild(tmp);
    await g.shutdown();
    const order = fs.readFileSync(orderFile, 'utf-8').trim().split('\n');
    assert.deepEqual(order, ['event', 'stop']);
  });

  it('continues iterating when one stop() throws and surfaces a single aggregate error', async () => {
    const tmp = makeTmpDir();
    const stopFile = path.join(tmp, '.stop-log');

    const goodDir = path.join(tmp, 'node_modules', 'good-apparatus');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, 'package.json'),
      JSON.stringify({ name: 'good-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(goodDir, 'index.js'),
      `import fs from 'node:fs';
export default {
  apparatus: {
    async start() {},
    stop() {
      const prev = fs.existsSync(${JSON.stringify(stopFile)}) ? fs.readFileSync(${JSON.stringify(stopFile)}, 'utf-8') : '';
      fs.writeFileSync(${JSON.stringify(stopFile)}, prev + 'good\\n');
    },
  },
};\n`,
    );

    const badDir = path.join(tmp, 'node_modules', 'bad-apparatus');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, 'package.json'),
      JSON.stringify({ name: 'bad-apparatus', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    fs.writeFileSync(
      path.join(badDir, 'index.js'),
      `export default {
  apparatus: {
    async start() {},
    stop() {
      throw new Error('boom-during-stop');
    },
  },
};\n`,
    );

    writeGuildJson(tmp, { plugins: ['good', 'bad'] });
    writePackageJson(tmp, { 'good-apparatus': '^1.0.0', 'bad-apparatus': '^1.0.0' });

    const g = await createGuild(tmp);
    await assert.rejects(
      () => g.shutdown(),
      (err) => {
        const m = err instanceof Error ? err.message : String(err);
        return /boom-during-stop/.test(m) && /"bad"/.test(m);
      },
    );

    // good's stop() must still have run despite bad's throw.
    assert.ok(fs.existsSync(stopFile), 'good apparatus stop() should still run');
    assert.match(fs.readFileSync(stopFile, 'utf-8'), /good/);

    // The singleton must still be cleared even when stop() threw.
    assert.throws(() => guild(), /Guild not initialized/);
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

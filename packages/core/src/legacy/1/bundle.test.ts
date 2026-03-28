import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initGuild } from './init-guild.ts';
import { readBundleManifest, installBundle } from './bundle.ts';

/**
 * Strip the @shardworks/nexus dependency from a guild's package.json.
 * In tests, initGuild() writes this dep but it may not be published yet,
 * causing `npm install` to fail with ETARGET. Tests don't need it.
 */
function stripCliDep(home: string): void {
  const pkgPath = path.join(home, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  delete pkg.dependencies?.['@shardworks/nexus'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  execFileSync('git', ['add', 'package.json'], { cwd: home, stdio: 'pipe' });
  execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: home, stdio: 'pipe' });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a minimal npm package with a nexus descriptor at the given path. */
function makePackage(
  dir: string,
  name: string,
  descriptor: { type: string; data: Record<string, unknown> },
): string {
  const pkgDir = path.join(dir, name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
  }));

  const descriptorFile = `nexus-${descriptor.type}.json`;
  fs.writeFileSync(path.join(pkgDir, descriptorFile), JSON.stringify({
    version: '1.0.0',
    ...descriptor.data,
  }));

  if (descriptor.data['instructions']) {
    fs.writeFileSync(
      path.join(pkgDir, descriptor.data['instructions'] as string),
      '# Instructions\nUse this tool.',
    );
  }
  if (descriptor.data['entry']) {
    fs.writeFileSync(
      path.join(pkgDir, descriptor.data['entry'] as string),
      'export default {};',
    );
  }
  if (descriptor.data['content']) {
    fs.writeFileSync(
      path.join(pkgDir, descriptor.data['content'] as string),
      '# Content\nTraining content here.',
    );
  }

  return pkgDir;
}

/** Create a bundle directory with the given manifest and optional inline content. */
function makeBundle(
  dir: string,
  name: string,
  manifest: Record<string, unknown>,
  inlineContent?: Record<string, { descriptor: Record<string, unknown>; content?: string }>,
): string {
  const bundleDir = path.join(dir, name);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
  }));
  fs.writeFileSync(
    path.join(bundleDir, 'nexus-bundle.json'),
    JSON.stringify(manifest, null, 2),
  );

  // Create inline content directories
  if (inlineContent) {
    for (const [contentPath, data] of Object.entries(inlineContent)) {
      const fullPath = path.join(bundleDir, contentPath);
      fs.mkdirSync(fullPath, { recursive: true });

      // Determine descriptor file name from type field
      const type = data.descriptor['type'] as string;
      const descriptorFile = `nexus-${type}.json`;
      const descriptorData = { ...data.descriptor };
      delete descriptorData['type'];
      fs.writeFileSync(path.join(fullPath, descriptorFile), JSON.stringify(descriptorData));

      if (data.content) {
        const contentFile = descriptorData['content'] as string || 'content.md';
        fs.writeFileSync(path.join(fullPath, contentFile), data.content);
      }
    }
  }

  return bundleDir;
}

// ── readBundleManifest tests ────────────────────────────────────────────

describe('readBundleManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bundle-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a valid manifest', () => {
    const bundleDir = makeBundle(tmpDir, 'test-bundle', {
      description: 'Test bundle',
      tools: [{ package: 'test-impl@1.0' }],
      engines: [{ package: 'test-engine@1.0' }],
      curricula: [{ path: 'curricula/basics' }],
      temperaments: [{ package: 'test-temperament@1.0' }],
    });

    const manifest = readBundleManifest(bundleDir);
    assert.equal(manifest.description, 'Test bundle');
    assert.equal(manifest.tools!.length, 1);
    assert.equal(manifest.engines!.length, 1);
    assert.equal(manifest.curricula!.length, 1);
    assert.equal(manifest.temperaments!.length, 1);
  });

  it('errors when manifest is missing', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty'));
    assert.throws(
      () => readBundleManifest(path.join(tmpDir, 'empty')),
      /No nexus-bundle\.json found/,
    );
  });

  it('errors when tools has path', () => {
    const bundleDir = makeBundle(tmpDir, 'bad-bundle', {
      tools: [{ path: 'some/path', package: 'x' }],
    });
    assert.throws(
      () => readBundleManifest(bundleDir),
      /Tools must be npm packages or git URLs/,
    );
  });

  it('errors when tools missing package', () => {
    const bundleDir = makeBundle(tmpDir, 'bad-bundle', {
      tools: [{ name: 'no-pkg' }],
    });
    assert.throws(
      () => readBundleManifest(bundleDir),
      /Tools must have a "package" specifier/,
    );
  });

  it('errors when engines has path', () => {
    const bundleDir = makeBundle(tmpDir, 'bad-bundle', {
      engines: [{ path: 'some/path', package: 'x' }],
    });
    assert.throws(
      () => readBundleManifest(bundleDir),
      /Engines must be npm packages or git URLs/,
    );
  });

  it('errors when curriculum has neither package nor path', () => {
    const bundleDir = makeBundle(tmpDir, 'bad-bundle', {
      curricula: [{ name: 'orphan' }],
    });
    assert.throws(
      () => readBundleManifest(bundleDir),
      /must have either a "package" or "path"/,
    );
  });

  it('errors when temperament has neither package nor path', () => {
    const bundleDir = makeBundle(tmpDir, 'bad-bundle', {
      temperaments: [{ name: 'orphan' }],
    });
    assert.throws(
      () => readBundleManifest(bundleDir),
      /must have either a "package" or "path"/,
    );
  });

  it('accepts empty categories', () => {
    const bundleDir = makeBundle(tmpDir, 'minimal-bundle', {
      description: 'Minimal',
    });
    const manifest = readBundleManifest(bundleDir);
    assert.equal(manifest.tools, undefined);
    assert.equal(manifest.engines, undefined);
  });
});

// ── installBundle tests ─────────────────────────────────────────────────

describe('installBundle', () => {
  let tmpDir: string;
  let home: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bundle-inst-'));
    home = path.join(tmpDir, 'guild');
    initGuild(home, 'test-guild', 'test-model');
    stripCliDep(home);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs package-based tools and engines', () => {
    // Create tool packages
    makePackage(tmpDir, 'test-impl', {
      type: 'tool',
      data: { entry: 'handler.js', description: 'Test impl', instructions: 'instructions.md' },
    });
    makePackage(tmpDir, 'test-engine', {
      type: 'engine',
      data: { entry: 'index.js', description: 'Test engine' },
    });

    // Create bundle referencing local paths (npm resolves them)
    const bundleDir = makeBundle(tmpDir, 'test-bundle', {
      tools: [
        { package: path.join(tmpDir, 'test-impl') },
      ],
      engines: [
        { package: path.join(tmpDir, 'test-engine') },
      ],
    });

    const result = installBundle({
      home,
      bundleDir,
      bundleSource: 'test-bundle@1.0.0',
    });

    assert.equal(result.installed, 2);
    assert.deepEqual(result.artifacts.tools, ['test-impl']);
    assert.deepEqual(result.artifacts.engines, ['test-engine']);

    // Metadata in guild directories
    assert.ok(fs.existsSync(path.join(home, 'tools', 'test-impl', 'nexus-tool.json')));
    assert.ok(fs.existsSync(path.join(home, 'tools', 'test-impl', 'instructions.md')));
    assert.ok(fs.existsSync(path.join(home, 'engines', 'test-engine', 'nexus-engine.json')));

    // Packages in node_modules
    assert.ok(fs.existsSync(path.join(home, 'node_modules', 'test-impl')));
    assert.ok(fs.existsSync(path.join(home, 'node_modules', 'test-engine')));

    // guild.json entries
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['test-impl'].package, 'test-impl');
    assert.equal(config.tools['test-impl'].bundle, 'test-bundle@1.0.0');
    // Bundle-installed tools are registered in catalog but NOT added to baseTools
    // (role assignment is handled by the caller, e.g. init-guild.ts)
    assert.ok(!config.baseTools.includes('test-impl'));
    assert.equal(config.engines['test-engine'].bundle, 'test-bundle@1.0.0');
  });

  it('installs inline content (curricula and temperaments)', () => {
    const bundleDir = makeBundle(
      tmpDir,
      'content-bundle',
      {
        curricula: [{ path: 'curricula/basics' }],
        temperaments: [{ path: 'temperaments/guide' }],
      },
      {
        'curricula/basics': {
          descriptor: { type: 'curriculum', version: '1.0.0', content: 'content.md' },
          content: '# Guild Basics\nHow to work in a guild.',
        },
        'temperaments/guide': {
          descriptor: { type: 'temperament', version: '1.0.0', content: 'content.md' },
          content: '# Guide\nBe helpful and patient.',
        },
      },
    );

    const result = installBundle({
      home,
      bundleDir,
      bundleSource: 'content-bundle@1.0.0',
    });

    assert.equal(result.installed, 2);
    assert.deepEqual(result.artifacts.curricula, ['basics']);
    assert.deepEqual(result.artifacts.temperaments, ['guide']);

    // Full content copied to guild directories
    assert.ok(fs.existsSync(path.join(home, 'training', 'curricula', 'basics', 'nexus-curriculum.json')));
    const curriculumContent = fs.readFileSync(
      path.join(home, 'training', 'curricula', 'basics', 'content.md'),
      'utf-8',
    );
    assert.ok(curriculumContent.includes('Guild Basics'));

    assert.ok(fs.existsSync(path.join(home, 'training', 'temperaments', 'guide', 'nexus-temperament.json')));
    const temperamentContent = fs.readFileSync(
      path.join(home, 'training', 'temperaments', 'guide', 'content.md'),
      'utf-8',
    );
    assert.ok(temperamentContent.includes('helpful and patient'));

    // guild.json entries
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.curricula['basics'].upstream, null);
    assert.equal(config.curricula['basics'].bundle, 'content-bundle@1.0.0');
    assert.equal(config.temperaments['guide'].bundle, 'content-bundle@1.0.0');
  });

  it('installs mixed bundle (packages + inline)', () => {
    makePackage(tmpDir, 'mixed-impl', {
      type: 'tool',
      data: { entry: 'handler.js', description: 'Mixed impl', instructions: 'instructions.md' },
    });

    const bundleDir = makeBundle(
      tmpDir,
      'mixed-bundle',
      {
        tools: [{ package: path.join(tmpDir, 'mixed-impl') }],
        temperaments: [{ path: 'temperaments/calm' }],
      },
      {
        'temperaments/calm': {
          descriptor: { type: 'temperament', version: '0.1.0', content: 'content.md' },
          content: '# Calm\nStay calm.',
        },
      },
    );

    const result = installBundle({ home, bundleDir });

    assert.equal(result.installed, 2);
    assert.deepEqual(result.artifacts.tools, ['mixed-impl']);
    assert.deepEqual(result.artifacts.temperaments, ['calm']);
  });

  it('creates a single git commit', () => {
    makePackage(tmpDir, 'commit-impl', {
      type: 'tool',
      data: { entry: 'handler.js', description: 'Test' },
    });

    const bundleDir = makeBundle(tmpDir, 'commit-bundle', {
      tools: [{ package: path.join(tmpDir, 'commit-impl') }],
    });

    installBundle({
      home,
      bundleDir,
      bundleSource: 'commit-bundle@1.0.0',
    });

    const log = execFileSync('git', ['log', '--oneline'], { cwd: home, encoding: 'utf-8' });
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 2); // init + bundle install
    assert.ok(lines[0]!.includes('Install bundle commit-bundle@1.0.0'));
  });

  it('skips commit when commit=false', () => {
    const bundleDir = makeBundle(
      tmpDir,
      'nocommit-bundle',
      { temperaments: [{ path: 'temperaments/quiet' }] },
      {
        'temperaments/quiet': {
          descriptor: { type: 'temperament', version: '1.0.0', content: 'content.md' },
          content: 'Be quiet.',
        },
      },
    );

    installBundle({ home, bundleDir, commit: false });

    const log = execFileSync('git', ['log', '--oneline'], { cwd: home, encoding: 'utf-8' });
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 1); // only init commit
  });

  it('records bundle provenance in guild.json', () => {
    makePackage(tmpDir, 'prov-impl', {
      type: 'tool',
      data: { entry: 'handler.js', description: 'Test' },
    });

    const bundleDir = makeBundle(tmpDir, 'prov-bundle', {
      tools: [{ package: path.join(tmpDir, 'prov-impl') }],
    });

    installBundle({
      home,
      bundleDir,
      bundleSource: '@shardworks/guild-starter-kit@0.1.0',
    });

    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['prov-impl'].bundle, '@shardworks/guild-starter-kit@0.1.0');
  });

  it('handles empty bundle', () => {
    const bundleDir = makeBundle(tmpDir, 'empty-bundle', {
      description: 'Nothing here',
    });

    const result = installBundle({ home, bundleDir, commit: false });
    assert.equal(result.installed, 0);
  });

  it('installs migrations with renumbering and provenance', () => {
    // Create a bundle with two migrations
    const bundleDir = path.join(tmpDir, 'migration-bundle');
    fs.mkdirSync(path.join(bundleDir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
      name: 'migration-bundle', version: '1.0.0',
    }));
    fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
      migrations: [
        { path: 'migrations/001-create-things.sql' },
        { path: 'migrations/002-add-stuff.sql' },
      ],
    }));
    fs.writeFileSync(
      path.join(bundleDir, 'migrations/001-create-things.sql'),
      'CREATE TABLE things (id INTEGER PRIMARY KEY);',
    );
    fs.writeFileSync(
      path.join(bundleDir, 'migrations/002-add-stuff.sql'),
      'ALTER TABLE things ADD COLUMN stuff TEXT;',
    );

    const result = installBundle({
      home,
      bundleDir,
      bundleSource: 'migration-bundle@1.0.0',
      commit: false,
    });

    // Guild starts with no migrations (initGuild no longer writes them), so numbering is preserved
    assert.equal(result.artifacts.migrations.length, 2);
    assert.ok(result.artifacts.migrations[0]!.startsWith('001-'));
    assert.ok(result.artifacts.migrations[1]!.startsWith('002-'));

    // Files exist on disk
    const migrationsDir = path.join(home, 'nexus', 'migrations');
    assert.ok(fs.existsSync(path.join(migrationsDir, result.artifacts.migrations[0]!)));
    assert.ok(fs.existsSync(path.join(migrationsDir, result.artifacts.migrations[1]!)));

    // Provenance is returned
    assert.ok(result.migrationProvenance);
    const firstProv = result.migrationProvenance![result.artifacts.migrations[0]!];
    assert.equal(firstProv!.bundle, 'migration-bundle@1.0.0');
    assert.equal(firstProv!.originalName, '001-create-things.sql');
  });

  it('renumbers migrations when guild already has some', () => {
    // Manually add a pre-existing migration to the guild
    const migrationsDir = path.join(home, 'nexus', 'migrations');
    fs.writeFileSync(
      path.join(migrationsDir, '001-existing.sql'),
      'CREATE TABLE existing (id INTEGER);',
    );

    const bundleDir = path.join(tmpDir, 'fresh-migration-bundle');
    fs.mkdirSync(path.join(bundleDir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
      name: 'fresh-bundle', version: '1.0.0',
    }));
    fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
      migrations: [{ path: 'migrations/001-initial.sql' }],
    }));
    fs.writeFileSync(
      path.join(bundleDir, 'migrations/001-initial.sql'),
      'CREATE TABLE test (id INTEGER);',
    );

    const result = installBundle({ home, bundleDir, commit: false });
    assert.equal(result.artifacts.migrations[0], '002-initial.sql');
  });

  it('installs guild-starter-kit inline content and migrations', () => {
    // Use the real starter kit but with a trimmed manifest (no package artifacts
    // since those need npm registry access). This tests the actual temperament,
    // curriculum, and migration files from the starter kit.
    const starterKitDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', '..', 'guild-starter-kit',
    );

    // Create a content-only version of the manifest for testing
    const testBundleDir = path.join(tmpDir, 'starter-kit-content');
    fs.cpSync(starterKitDir, testBundleDir, { recursive: true });
    // Rewrite manifest to only include inline content
    fs.writeFileSync(path.join(testBundleDir, 'nexus-bundle.json'), JSON.stringify({
      description: 'Starter kit content test',
      temperaments: [{ path: 'temperaments/guide' }],
      curricula: [{ path: 'curricula/guild-operations' }],
      migrations: [{ path: 'migrations/001-schema.sql' }],
    }));

    const result = installBundle({
      home,
      bundleDir: testBundleDir,
      bundleSource: '@shardworks/guild-starter-kit@0.1.5',
      commit: false,
    });

    // All three inline categories installed
    assert.deepEqual(result.artifacts.temperaments, ['guide']);
    assert.deepEqual(result.artifacts.curricula, ['guild-operations']);
    assert.equal(result.artifacts.migrations.length, 1);

    // Temperament content on disk
    const tempContent = fs.readFileSync(
      path.join(home, 'training', 'temperaments', 'guide', 'content.md'),
      'utf-8',
    );
    assert.ok(tempContent.includes('Guide Temperament'));
    assert.ok(tempContent.includes('Patient'));

    // Curriculum content on disk
    const currContent = fs.readFileSync(
      path.join(home, 'training', 'curricula', 'guild-operations', 'content.md'),
      'utf-8',
    );
    assert.ok(currContent.includes('Guild Operations Curriculum'));
    assert.ok(currContent.includes('Artificer'));

    // Migration installed (guild starts empty, so numbering preserved)
    assert.ok(result.artifacts.migrations[0]!.startsWith('001-'));
    const migContent = fs.readFileSync(
      path.join(home, 'nexus', 'migrations', result.artifacts.migrations[0]!),
      'utf-8',
    );
    assert.ok(migContent.includes('CREATE TABLE animas'));

    // guild.json entries have provenance
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.temperaments['guide'].bundle, '@shardworks/guild-starter-kit@0.1.5');
    assert.equal(config.curricula['guild-operations'].bundle, '@shardworks/guild-starter-kit@0.1.5');

    // Migration provenance returned for applyMigrations() to use
    assert.ok(result.migrationProvenance);
    const migProv = Object.values(result.migrationProvenance!)[0]!;
    assert.equal(migProv.bundle, '@shardworks/guild-starter-kit@0.1.5');
    assert.equal(migProv.originalName, '001-schema.sql');
  });

  it('installs transitive bundles', () => {
    // Create a tool that the inner bundle references
    makePackage(tmpDir, 'inner-impl', {
      type: 'tool',
      data: { entry: 'handler.js', description: 'Inner tool' },
    });

    // Create the inner bundle as an npm package with nexus-bundle.json
    const innerBundleDir = path.join(tmpDir, 'inner-bundle');
    fs.mkdirSync(innerBundleDir, { recursive: true });
    fs.writeFileSync(path.join(innerBundleDir, 'package.json'), JSON.stringify({
      name: 'inner-bundle',
      version: '1.0.0',
    }));
    fs.writeFileSync(path.join(innerBundleDir, 'nexus-bundle.json'), JSON.stringify({
      tools: [{ package: path.join(tmpDir, 'inner-impl') }],
    }));

    // Create outer bundle that references the inner bundle as a package
    const outerBundleDir = makeBundle(tmpDir, 'outer-bundle', {
      tools: [{ package: innerBundleDir }],
    });

    const result = installBundle({ home, bundleDir: outerBundleDir, commit: false });

    // The inner bundle's implement should be installed
    assert.ok(result.artifacts.tools.includes('inner-impl'));
    assert.ok(fs.existsSync(path.join(home, 'tools', 'inner-impl', 'nexus-tool.json')));
  });
});

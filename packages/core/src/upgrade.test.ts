import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initGuild } from './init-guild.ts';
import { installBundle } from './bundle.ts';
import { applyMigrations } from './migrate.ts';
import { instantiate } from './instantiate.ts';
import { planUpgrade, applyUpgrade } from './upgrade.ts';
import { showAnima } from './anima.ts';
import { booksPath } from './nexus-home.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function stripCliDep(home: string): void {
  const pkgPath = path.join(home, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  delete pkg.dependencies?.['@shardworks/nexus'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  execFileSync('git', ['add', 'package.json'], { cwd: home, stdio: 'pipe' });
  execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: home, stdio: 'pipe' });
}

/** Create a minimal guild with an initial migration and a content artifact. */
function createTestGuild(tmpDir: string): string {
  const home = path.join(tmpDir, 'guild');
  initGuild(home, 'test-guild', 'sonnet');
  stripCliDep(home);

  // Create a v1 bundle with one migration and one curriculum
  const bundleDir = path.join(tmpDir, 'bundle-v1');
  fs.mkdirSync(bundleDir, { recursive: true });

  // Bundle package.json
  fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
    name: '@test/starter-kit',
    version: '1.0.0',
  }));

  // Migration
  const migrationsDir = path.join(bundleDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(migrationsDir, '001-initial.sql'), [
    `CREATE TABLE animas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE anima_compositions (id TEXT PRIMARY KEY, anima_id TEXT NOT NULL UNIQUE REFERENCES animas(id), curriculum_name TEXT NOT NULL, curriculum_version TEXT NOT NULL, temperament_name TEXT NOT NULL, temperament_version TEXT NOT NULL, curriculum_snapshot TEXT NOT NULL, temperament_snapshot TEXT NOT NULL, composed_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE roster (id TEXT PRIMARY KEY, anima_id TEXT NOT NULL REFERENCES animas(id), role TEXT NOT NULL, standing INTEGER NOT NULL DEFAULT 0, assigned_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE commissions (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, workshop TEXT NOT NULL, status_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE commission_assignments (id TEXT PRIMARY KEY, commission_id TEXT NOT NULL REFERENCES commissions(id), anima_id TEXT NOT NULL REFERENCES animas(id), assigned_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(commission_id, anima_id));`,
    `CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')));`,
  ].join('\n'));

  // Curriculum
  const currDir = path.join(bundleDir, 'curricula', 'basics');
  fs.mkdirSync(currDir, { recursive: true });
  fs.writeFileSync(path.join(currDir, 'nexus-curriculum.json'), JSON.stringify({
    version: '1.0.0',
    content: 'content.md',
  }));
  fs.writeFileSync(path.join(currDir, 'content.md'), '# Basics v1\nDo the thing.');

  // Temperament
  const tempDir = path.join(bundleDir, 'temperaments', 'chill');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'nexus-temperament.json'), JSON.stringify({
    version: '1.0.0',
    content: 'content.md',
  }));
  fs.writeFileSync(path.join(tempDir, 'content.md'), '# Chill v1\nBe relaxed.');

  // Bundle manifest
  fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
    description: 'Test bundle v1',
    curricula: [{ path: 'curricula/basics' }],
    temperaments: [{ path: 'temperaments/chill' }],
    migrations: [{ path: 'migrations/001-initial.sql' }],
  }));

  // Install the v1 bundle
  installBundle({ home, bundleDir, bundleSource: '@test/starter-kit@1.0.0', commit: false });
  applyMigrations(home);

  // Commit bundle install
  execFileSync('git', ['add', '-A'], { cwd: home, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Install v1 bundle'], { cwd: home, stdio: 'pipe' });

  return home;
}

/** Create a v2 bundle with additional migration and updated content. */
function createV2Bundle(tmpDir: string): string {
  const bundleDir = path.join(tmpDir, 'bundle-v2');
  fs.mkdirSync(bundleDir, { recursive: true });

  fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
    name: '@test/starter-kit',
    version: '2.0.0',
  }));

  // Migrations: original + new one
  const migrationsDir = path.join(bundleDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(migrationsDir, '001-initial.sql'), [
    `CREATE TABLE animas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE anima_compositions (id TEXT PRIMARY KEY, anima_id TEXT NOT NULL UNIQUE REFERENCES animas(id), curriculum_name TEXT NOT NULL, curriculum_version TEXT NOT NULL, temperament_name TEXT NOT NULL, temperament_version TEXT NOT NULL, curriculum_snapshot TEXT NOT NULL, temperament_snapshot TEXT NOT NULL, composed_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE roster (id TEXT PRIMARY KEY, anima_id TEXT NOT NULL REFERENCES animas(id), role TEXT NOT NULL, standing INTEGER NOT NULL DEFAULT 0, assigned_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE commissions (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL, workshop TEXT NOT NULL, status_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    `CREATE TABLE commission_assignments (id TEXT PRIMARY KEY, commission_id TEXT NOT NULL REFERENCES commissions(id), anima_id TEXT NOT NULL REFERENCES animas(id), assigned_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(commission_id, anima_id));`,
    `CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')));`,
  ].join('\n'));
  fs.writeFileSync(path.join(migrationsDir, '002-more-stuff.sql'),
    `CREATE TABLE widgets (id TEXT PRIMARY KEY, color TEXT);`);

  // Updated curriculum
  const currDir = path.join(bundleDir, 'curricula', 'basics');
  fs.mkdirSync(currDir, { recursive: true });
  fs.writeFileSync(path.join(currDir, 'nexus-curriculum.json'), JSON.stringify({
    version: '2.0.0',
    content: 'content.md',
  }));
  fs.writeFileSync(path.join(currDir, 'content.md'), '# Basics v2\nDo the thing better.');

  // Same temperament (no change)
  const tempDir = path.join(bundleDir, 'temperaments', 'chill');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'nexus-temperament.json'), JSON.stringify({
    version: '1.0.0',
    content: 'content.md',
  }));
  fs.writeFileSync(path.join(tempDir, 'content.md'), '# Chill v1\nBe relaxed.');

  fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
    description: 'Test bundle v2',
    curricula: [{ path: 'curricula/basics' }],
    temperaments: [{ path: 'temperaments/chill' }],
    migrations: [
      { path: 'migrations/001-initial.sql' },
      { path: 'migrations/002-more-stuff.sql' },
    ],
  }));

  return bundleDir;
}

// ── Tests ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('planUpgrade', () => {
  it('does not plan bundle migrations (core handles migrations now)', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    const plan = planUpgrade(home, v2);

    // Migrations are no longer planned from bundles — core owns them
    assert.equal(plan.migrations.length, 0);
  });

  it('detects updated curricula', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    const plan = planUpgrade(home, v2);

    const currUpdate = plan.contentUpdates.find(c => c.category === 'curricula');
    assert.ok(currUpdate, 'should detect curriculum update');
    assert.equal(currUpdate.name, 'basics');
    assert.equal(currUpdate.installedVersion, '1.0.0');
    assert.equal(currUpdate.bundleVersion, '2.0.0');
  });

  it('does not flag unchanged temperaments', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    const plan = planUpgrade(home, v2);

    const tempUpdate = plan.contentUpdates.find(c => c.category === 'temperaments');
    assert.equal(tempUpdate, undefined, 'should not flag unchanged temperament');
  });

  it('detects stale animas after content update', () => {
    const home = createTestGuild(tmpDir);

    // Create an anima using v1 curriculum
    instantiate({
      home,
      name: 'Worker',
      roles: ['artificer'],
      curriculum: 'basics',
      temperament: 'chill',
    });

    const v2 = createV2Bundle(tmpDir);
    const plan = planUpgrade(home, v2);

    assert.equal(plan.staleAnimas.length, 1);
    assert.equal(plan.staleAnimas[0]!.name, 'Worker');
    assert.ok(plan.staleAnimas[0]!.curriculum, 'should flag curriculum as stale');
    assert.equal(plan.staleAnimas[0]!.curriculum!.composedVersion, '1.0.0');
    assert.equal(plan.staleAnimas[0]!.curriculum!.currentVersion, '2.0.0');
    assert.equal(plan.staleAnimas[0]!.temperament, null, 'temperament unchanged, not stale');
  });

  it('reports empty plan when already up to date', () => {
    const home = createTestGuild(tmpDir);

    // "Upgrade" with the same v1 bundle — create a copy that looks like v1
    const sameBundle = path.join(tmpDir, 'bundle-same');
    fs.mkdirSync(sameBundle, { recursive: true });
    fs.writeFileSync(path.join(sameBundle, 'package.json'), JSON.stringify({
      name: '@test/starter-kit',
      version: '1.0.0',
    }));

    const migrationsDir = path.join(sameBundle, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, '001-initial.sql'),
      `CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);

    const currDir = path.join(sameBundle, 'curricula', 'basics');
    fs.mkdirSync(currDir, { recursive: true });
    fs.writeFileSync(path.join(currDir, 'nexus-curriculum.json'), JSON.stringify({
      version: '1.0.0',
      content: 'content.md',
    }));
    fs.writeFileSync(path.join(currDir, 'content.md'), '# Basics v1\nDo the thing.');

    const tempDir = path.join(sameBundle, 'temperaments', 'chill');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'nexus-temperament.json'), JSON.stringify({
      version: '1.0.0',
      content: 'content.md',
    }));
    fs.writeFileSync(path.join(tempDir, 'content.md'), '# Chill v1\nBe relaxed.');

    fs.writeFileSync(path.join(sameBundle, 'nexus-bundle.json'), JSON.stringify({
      description: 'Test bundle v1 (same)',
      curricula: [{ path: 'curricula/basics' }],
      temperaments: [{ path: 'temperaments/chill' }],
      migrations: [{ path: 'migrations/001-initial.sql' }],
    }));

    const plan = planUpgrade(home, sameBundle);

    assert.equal(plan.isEmpty, true);
    assert.equal(plan.migrations.length, 0);
    assert.equal(plan.contentUpdates.length, 0);
  });

  it('detects new tools missing from the guild', () => {
    const home = createTestGuild(tmpDir);

    // Create a bundle that declares a tool not in the guild
    const bundleDir = path.join(tmpDir, 'bundle-with-tools');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
      name: '@test/starter-kit',
      version: '2.0.0',
    }));

    // Same migration as v1 (no new ones)
    const migrationsDir = path.join(bundleDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, '001-initial.sql'),
      `CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);

    fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
      description: 'Test bundle with tools',
      tools: [
        { package: '@test/stdlib@0.x', name: 'existing-tool' },
        { package: '@test/stdlib@0.x', name: 'new-tool', roles: ['steward'] },
        { package: '@test/stdlib@0.x', name: 'shared-tool', roles: ['steward', 'artificer'] },
      ],
      migrations: [{ path: 'migrations/001-initial.sql' }],
    }));

    // Register 'existing-tool' in guild.json so only new-tool and shared-tool are detected
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    config.tools['existing-tool'] = { upstream: null, installedAt: new Date().toISOString(), package: '@test/stdlib' };
    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify(config, null, 2));

    const plan = planUpgrade(home, bundleDir);

    assert.equal(plan.newTools.length, 2);
    assert.equal(plan.newTools[0]!.name, 'new-tool');
    assert.deepEqual(plan.newTools[0]!.roles, ['steward']);
    assert.equal(plan.newTools[1]!.name, 'shared-tool');
    assert.deepEqual(plan.newTools[1]!.roles, ['steward', 'artificer']);
    assert.equal(plan.isEmpty, false);
  });
});

describe('applyUpgrade', () => {
  it('updates content (migrations are handled by core separately)', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    const plan = planUpgrade(home, v2);
    const result = applyUpgrade(home, v2, plan);

    // Migrations are no longer applied by applyUpgrade — core handles them
    assert.equal(result.migrationsApplied.length, 0);

    // Content was updated
    assert.equal(result.contentUpdated.length, 1);
    assert.ok(result.contentUpdated[0]!.includes('basics'));

    // Verify curriculum content was updated
    const content = fs.readFileSync(
      path.join(home, 'training', 'curricula', 'basics', 'content.md'),
      'utf-8',
    );
    assert.ok(content.includes('v2'), 'curriculum content should be v2');
  });

  it('does not update nexus version — that is the CLI responsibility', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    // Capture the version initGuild stamped before upgrading
    const configBefore = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    const versionBefore = configBefore.nexus;

    const plan = planUpgrade(home, v2);
    applyUpgrade(home, v2, plan);

    // applyUpgrade no longer stamps the version — the CLI layer does that
    // so it can stamp even when the bundle plan is empty (npm-only upgrade).
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.nexus, versionBefore, 'version should be unchanged by applyUpgrade');
  });

  it('registers new tools and assigns them to roles', () => {
    const home = createTestGuild(tmpDir);

    // Create a bundle with new tools
    const bundleDir = path.join(tmpDir, 'bundle-tools-apply');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
      name: '@test/starter-kit',
      version: '2.0.0',
    }));
    const migrationsDir = path.join(bundleDir, 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, '001-initial.sql'),
      `CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
    fs.writeFileSync(path.join(bundleDir, 'nexus-bundle.json'), JSON.stringify({
      tools: [
        { package: '@test/stdlib@0.x', name: 'new-shiny-tool', roles: ['steward', 'artificer'] },
      ],
      migrations: [{ path: 'migrations/001-initial.sql' }],
    }));

    const plan = planUpgrade(home, bundleDir);
    assert.equal(plan.newTools.length, 1);

    const result = applyUpgrade(home, bundleDir, plan);
    assert.equal(result.toolsRegistered.length, 1);
    assert.equal(result.toolsRegistered[0], 'tools/new-shiny-tool');

    // Verify guild.json
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.ok(config.tools['new-shiny-tool'], 'tool should be registered');
    assert.equal(config.tools['new-shiny-tool'].package, '@test/stdlib');
    assert.ok(config.roles.steward.tools.includes('new-shiny-tool'), 'steward should have tool');
    assert.ok(config.roles.artificer.tools.includes('new-shiny-tool'), 'artificer should have tool');

    // Verify idempotency — second plan should find nothing
    const plan2 = planUpgrade(home, bundleDir);
    assert.equal(plan2.newTools.length, 0);
  });

  it('is idempotent — second run finds nothing to do', () => {
    const home = createTestGuild(tmpDir);
    const v2 = createV2Bundle(tmpDir);

    // First upgrade
    const plan1 = planUpgrade(home, v2);
    applyUpgrade(home, v2, plan1);

    // Second upgrade with same bundle
    const plan2 = planUpgrade(home, v2);
    assert.equal(plan2.migrations.length, 0, 'no new migrations on second run');
    assert.equal(plan2.contentUpdates.length, 0, 'no content updates on second run');
  });

  it('recomposes stale animas when recompose option is set', () => {
    const home = createTestGuild(tmpDir);

    // Create an anima using v1 curriculum
    instantiate({
      home,
      name: 'Worker',
      roles: ['artificer'],
      curriculum: 'basics',
      temperament: 'chill',
    });

    const v2 = createV2Bundle(tmpDir);
    const plan = planUpgrade(home, v2);

    assert.equal(plan.staleAnimas.length, 1, 'should detect stale anima');

    // Apply with recompose
    const result = applyUpgrade(home, v2, plan, { recompose: true });

    assert.equal(result.recomposedAnimas.length, 1);
    assert.equal(result.recomposedAnimas[0], 'Worker');

    // Verify the anima exists with fresh composition
    const worker = showAnima(home, 'Worker');
    assert.ok(worker, 'Worker should still exist');
    assert.equal(worker!.status, 'active');
    assert.equal(worker!.curriculumVersion, '2.0.0', 'should have new curriculum version');
    assert.deepEqual(worker!.roles, ['artificer']);

    // Second plan should show no stale animas
    const plan2 = planUpgrade(home, v2);
    assert.equal(plan2.staleAnimas.length, 0, 'no stale animas after recompose');
  });
});

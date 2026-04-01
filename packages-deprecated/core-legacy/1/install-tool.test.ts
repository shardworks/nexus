import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initGuild } from './init-guild.ts';
import { installTool } from './install-tool.ts';
import { classifySource } from './install-tool.ts';
import { removeTool } from './remove-tool.ts';

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
  // Amend the initial commit so the guild repo is clean
  execFileSync('git', ['add', 'package.json'], { cwd: home, stdio: 'pipe' });
  execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: home, stdio: 'pipe' });
}

describe('classifySource', () => {
  it('classifies registry specifiers', () => {
    assert.equal(classifySource('some-tool'), 'registry');
    assert.equal(classifySource('some-tool@1.0.0'), 'registry');
    assert.equal(classifySource('@scope/tool'), 'registry');
    assert.equal(classifySource('@scope/tool@2.0'), 'registry');
  });

  it('classifies git URLs', () => {
    assert.equal(classifySource('git+https://github.com/org/repo.git#v1.0'), 'git-url');
    assert.equal(classifySource('git+ssh://git@github.com/org/repo.git'), 'git-url');
  });

  it('classifies workshop sources', () => {
    assert.equal(classifySource('workshop:forge#tool/fetch-jira@1.0'), 'workshop');
    assert.equal(classifySource('workshop:my-shop#main'), 'workshop');
  });

  it('classifies tarballs', () => {
    assert.equal(classifySource('./my-tool-1.0.0.tgz'), 'tarball');
    assert.equal(classifySource('/tmp/my-tool.tar.gz'), 'tarball');
  });

  it('classifies link when flag is set', () => {
    assert.equal(classifySource('/some/path', true), 'link');
    assert.equal(classifySource('some-tool@1.0', true), 'link');
  });
});

describe('installTool (registry via npm-local)', () => {
  let tmpDir: string;
  let home: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-npm-'));
    home = path.join(tmpDir, 'guild');
    initGuild(home, 'test-guild', 'test-model');
    stripCliDep(home);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a minimal npm package with a nexus descriptor. */
  function makeNpmTool(name: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
    }));
    fs.writeFileSync(path.join(dir, 'nexus-tool.json'), JSON.stringify({
      entry: 'handler.js',
      version: '1.0.0',
      description: 'Test tool',
      instructions: 'instructions.md',
    }));
    fs.writeFileSync(path.join(dir, 'handler.js'), 'export default {};');
    fs.writeFileSync(path.join(dir, 'instructions.md'), '# Test\nUse it.');
    return dir;
  }

  it('installs local npm package into node_modules via registry path', () => {
    // Local dirs are still handled by npm when used as source specifiers
    // (npm treats absolute paths as local package installs)
    const toolDir = makeNpmTool('test-npm-tool');
    const result = installTool({ home, source: toolDir });

    assert.equal(result.sourceKind, 'registry');
    assert.equal(result.name, 'test-npm-tool');

    // Package exists in guild root node_modules
    assert.ok(fs.existsSync(path.join(home, 'node_modules', 'test-npm-tool', 'handler.js')));

    // Metadata copied to guild directory
    const implDir = path.join(home, 'tools', 'test-npm-tool');
    assert.ok(fs.existsSync(path.join(implDir, 'nexus-tool.json')));
    assert.ok(fs.existsSync(path.join(implDir, 'instructions.md')));

    // Descriptor is pristine (no package field injected)
    const descriptor = JSON.parse(fs.readFileSync(path.join(implDir, 'nexus-tool.json'), 'utf-8'));
    assert.equal(descriptor.package, undefined);

    // Handler source NOT in tool dir (only metadata)
    assert.ok(!fs.existsSync(path.join(implDir, 'handler.js')));

    // guild.json has upstream and package
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['test-npm-tool'].upstream, 'test-npm-tool@1.0.0');
    assert.equal(config.tools['test-npm-tool'].package, 'test-npm-tool');
  });

  it('installs with --link creates symlink', () => {
    const toolDir = makeNpmTool('linked-tool');
    const result = installTool({ home, source: toolDir, link: true });

    assert.equal(result.sourceKind, 'link');

    // Symlink exists in node_modules
    const linkPath = path.join(home, 'node_modules', 'linked-tool');
    assert.ok(fs.existsSync(linkPath));
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());

    // Symlink points to source
    const target = fs.readlinkSync(linkPath);
    assert.equal(target, toolDir);

    // Metadata in tool dir
    const implDir = path.join(home, 'tools', 'linked-tool');
    assert.ok(fs.existsSync(path.join(implDir, 'nexus-tool.json')));

    // guild.json upstream is null for linked tools
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['linked-tool'].upstream, null);
  });

  it('errors on --link for non-directory', () => {
    assert.throws(
      () => installTool({ home, source: '/nonexistent/path', name: 'bad', link: true }),
      /not a directory/,
    );
  });

  it('errors on --link for directory without package.json', () => {
    const dir = path.join(tmpDir, 'bare-tool');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'nexus-tool.json'), JSON.stringify({
      entry: 'run.sh', version: '1.0.0',
    }));
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n:');

    assert.throws(
      () => installTool({ home, source: dir, name: 'bare', link: true }),
      /package\.json/,
    );
  });

  it('assigns to baseTools by default', () => {
    const toolDir = makeNpmTool('base-tool');
    installTool({ home, source: toolDir, link: true });

    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.ok(config.baseTools.includes('base-tool'));
    // ToolEntry should NOT have a roles field
    assert.equal(config.tools['base-tool'].roles, undefined);
  });

  it('assigns to specific roles when --roles is provided', () => {
    // Create roles in guild.json first
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    config.roles['artificer'] = { seats: null, tools: [], instructions: 'roles/artificer.md' };
    config.roles['sage'] = { seats: null, tools: [], instructions: 'roles/sage.md' };
    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify(config, null, 2) + '\n');
    execFileSync('git', ['add', '-A'], { cwd: home, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'add roles'], { cwd: home, stdio: 'pipe' });

    const toolDir = makeNpmTool('gated-tool');
    installTool({ home, source: toolDir, roles: ['artificer', 'sage'], link: true });

    const updated = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.ok(updated.roles['artificer'].tools.includes('gated-tool'));
    assert.ok(updated.roles['sage'].tools.includes('gated-tool'));
    // Should NOT be in baseTools
    assert.ok(!updated.baseTools.includes('gated-tool'));
  });

  it('creates a git commit', () => {
    const toolDir = makeNpmTool('committed-tool');
    installTool({ home, source: toolDir, link: true });

    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: home, encoding: 'utf-8' });
    assert.ok(log.includes('Install tool committed-tool'));
  });
});

describe('installTool tarball', () => {
  let tmpDir: string;
  let home: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tarball-'));
    home = path.join(tmpDir, 'guild');
    initGuild(home, 'test-guild', 'test-model');
    stripCliDep(home);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs tarball with full source in tool directory', () => {
    // Create a minimal npm package and pack it
    const srcDir = path.join(tmpDir, 'tarball-tool');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({
      name: 'tarball-tool',
      version: '1.0.0',
      type: 'module',
    }));
    fs.writeFileSync(path.join(srcDir, 'nexus-tool.json'), JSON.stringify({
      entry: 'handler.js',
      version: '1.0.0',
      description: 'Tarball test',
      instructions: 'instructions.md',
    }));
    fs.writeFileSync(path.join(srcDir, 'handler.js'), 'export default {};');
    fs.writeFileSync(path.join(srcDir, 'instructions.md'), '# Tarball\nUse it.');

    // Create tarball
    const packOutput = execFileSync('npm', ['pack'], {
      cwd: srcDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const tarballPath = path.join(srcDir, packOutput);

    const result = installTool({ home, source: tarballPath });

    assert.equal(result.sourceKind, 'tarball');
    assert.equal(result.name, 'tarball-tool');

    // Full source is in the tool dir (not just metadata)
    const implDir = path.join(home, 'tools', 'tarball-tool');
    assert.ok(fs.existsSync(path.join(implDir, 'handler.js')), 'handler should be in tool dir');
    assert.ok(fs.existsSync(path.join(implDir, 'package.json')), 'package.json should be in tool dir');

    // guild.json upstream is null for tarballs
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['tarball-tool'].upstream, null);

    // Package is NOT in guild's package.json dependencies
    const guildPkg = JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf-8'));
    assert.equal(guildPkg.dependencies?.['tarball-tool'], undefined);
  });
});

describe('removeTool', () => {
  let tmpDir: string;
  let home: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tool-'));
    home = path.join(tmpDir, 'guild');
    initGuild(home, 'test-guild', 'test-model');
    stripCliDep(home);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeNpmTool(name: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version: '1.0.0', type: 'module',
    }));
    fs.writeFileSync(path.join(dir, 'nexus-tool.json'), JSON.stringify({
      entry: 'handler.js', version: '1.0.0', description: 'Test',
    }));
    fs.writeFileSync(path.join(dir, 'handler.js'), 'export default {};');
    return dir;
  }

  it('removes npm-installed tool and cleans node_modules', () => {
    const toolDir = makeNpmTool('removable-npm');
    installTool({ home, source: toolDir });

    // Verify it's installed
    assert.ok(fs.existsSync(path.join(home, 'node_modules', 'removable-npm')));

    const result = removeTool({ home, name: 'removable-npm' });
    assert.equal(result.category, 'tools');

    // Slot gone
    assert.ok(!fs.existsSync(path.join(home, 'tools', 'removable-npm')));
    // node_modules cleaned
    assert.ok(!fs.existsSync(path.join(home, 'node_modules', 'removable-npm')));
    // guild.json cleaned
    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.tools['removable-npm'], undefined);
  });

  it('removes linked tool by removing symlink', () => {
    const toolDir = makeNpmTool('removable-link');
    installTool({ home, source: toolDir, link: true });

    // Verify symlink exists
    assert.ok(fs.lstatSync(path.join(home, 'node_modules', 'removable-link')).isSymbolicLink());

    removeTool({ home, name: 'removable-link' });

    // Symlink gone
    assert.ok(!fs.existsSync(path.join(home, 'node_modules', 'removable-link')));
    // Slot gone
    assert.ok(!fs.existsSync(path.join(home, 'tools', 'removable-link')));
  });

  it('errors on unknown tool', () => {
    assert.throws(
      () => removeTool({ home, name: 'nonexistent' }),
      /not found in guild\.json/,
    );
  });

  it('creates a git commit', () => {
    const toolDir = makeNpmTool('bye-tool');
    installTool({ home, source: toolDir, link: true });
    removeTool({ home, name: 'bye-tool' });

    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: home, encoding: 'utf-8' });
    assert.ok(log.includes('Remove tool bye-tool'));
  });
});

describe('initGuild npm support', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates package.json in guild root', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-init-npm-'));
    const home = path.join(tmpDir, 'guild');
    initGuild(home, 'my-guild', 'test-model');

    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf-8'));
    assert.equal(pkg.name, 'guild-my-guild');
    assert.equal(pkg.private, true);
  });

  it('creates .gitignore with node_modules and .nexus', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-init-npm-'));
    const home = path.join(tmpDir, 'guild');
    initGuild(home, 'my-guild', 'test-model');

    const gitignore = fs.readFileSync(path.join(home, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('node_modules/'));
    assert.ok(gitignore.includes('.nexus/'));
  });

  it('stores guild name in guild.json', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-init-npm-'));
    const home = path.join(tmpDir, 'guild');
    initGuild(home, 'my-guild', 'test-model');

    const config = JSON.parse(fs.readFileSync(path.join(home, 'guild.json'), 'utf-8'));
    assert.equal(config.name, 'my-guild');
  });
});

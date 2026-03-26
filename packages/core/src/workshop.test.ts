import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorkshop, removeWorkshop, listWorkshops, deriveWorkshopName } from './workshop.ts';
import { createInitialGuildConfig, writeGuildConfig, readGuildConfig } from './guild-config.ts';
import { workshopBarePath, worktreesPath } from './nexus-home.ts';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Create a minimal guild root with guild.json and .nexus directories. */
function createTestGuild(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, '.nexus', 'workshops'), { recursive: true });
  fs.mkdirSync(path.join(home, '.nexus', 'worktrees'), { recursive: true });
  const config = createInitialGuildConfig('test-guild', '0.1.0', 'test-model');
  writeGuildConfig(home, config);
}

/** Create a bare git repo that can serve as a remote. */
function createBareRemote(dir: string): string {
  const remotePath = path.join(dir, 'remote-repo.git');
  fs.mkdirSync(remotePath, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: remotePath, stdio: 'pipe' });

  // Push an initial commit so clone works
  const tmpCheckout = path.join(dir, 'tmp-checkout');
  fs.mkdirSync(tmpCheckout);
  git(['init', '-b', 'main'], tmpCheckout);
  git(['config', 'user.email', 'test@test.com'], tmpCheckout);
  git(['config', 'user.name', 'Test'], tmpCheckout);
  fs.writeFileSync(path.join(tmpCheckout, 'README.md'), '# Test\n');
  git(['add', '-A'], tmpCheckout);
  git(['commit', '-m', 'initial'], tmpCheckout);
  git(['remote', 'add', 'origin', remotePath], tmpCheckout);
  git(['push', 'origin', 'main'], tmpCheckout);
  fs.rmSync(tmpCheckout, { recursive: true });

  return remotePath;
}

describe('deriveWorkshopName', () => {
  it('derives name from HTTPS URL', () => {
    assert.equal(deriveWorkshopName('https://github.com/org/my-repo.git'), 'my-repo');
  });

  it('derives name from HTTPS URL without .git', () => {
    assert.equal(deriveWorkshopName('https://github.com/org/my-repo'), 'my-repo');
  });

  it('derives name from SSH URL', () => {
    assert.equal(deriveWorkshopName('git@github.com:org/my-repo.git'), 'my-repo');
  });

  it('derives name from org/name format', () => {
    assert.equal(deriveWorkshopName('myorg/cool-project'), 'cool-project');
  });
});

describe('addWorkshop', () => {
  let tmpDir: string;
  let home: string;
  let remotePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workshop-test-'));
    home = path.join(tmpDir, 'guild');
    createTestGuild(home);
    remotePath = createBareRemote(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clones repo and adds entry to guild.json', () => {
    const result = addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });

    assert.equal(result.name, 'my-repo');
    assert.equal(result.remoteUrl, remotePath);
    assert.ok(fs.existsSync(result.barePath), 'bare clone should exist');

    const config = readGuildConfig(home);
    assert.ok('my-repo' in config.workshops);
    assert.equal(config.workshops['my-repo']!.remoteUrl, remotePath);
    assert.ok(config.workshops['my-repo']!.addedAt);
  });

  it('throws if workshop name already exists', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });
    assert.throws(
      () => addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath }),
      /already exists/,
    );
  });

  it('throws if bare clone directory already exists', () => {
    // Manually create the bare path
    const barePath = workshopBarePath(home, 'my-repo');
    fs.mkdirSync(barePath, { recursive: true });

    assert.throws(
      () => addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath }),
      /already exists/,
    );
  });
});

describe('removeWorkshop', () => {
  let tmpDir: string;
  let home: string;
  let remotePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workshop-test-'));
    home = path.join(tmpDir, 'guild');
    createTestGuild(home);
    remotePath = createBareRemote(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes bare clone and guild.json entry', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });
    const barePath = workshopBarePath(home, 'my-repo');
    assert.ok(fs.existsSync(barePath));

    removeWorkshop({ home, name: 'my-repo' });

    assert.ok(!fs.existsSync(barePath), 'bare clone should be removed');
    const config = readGuildConfig(home);
    assert.ok(!('my-repo' in config.workshops));
  });

  it('removes worktree directory if present', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });

    // Simulate a worktree directory
    const wtDir = path.join(worktreesPath(home), 'my-repo', 'commission-1');
    fs.mkdirSync(wtDir, { recursive: true });

    removeWorkshop({ home, name: 'my-repo' });

    assert.ok(!fs.existsSync(path.join(worktreesPath(home), 'my-repo')));
  });

  it('throws if workshop does not exist', () => {
    assert.throws(
      () => removeWorkshop({ home, name: 'nonexistent' }),
      /not found/,
    );
  });
});

describe('listWorkshops', () => {
  let tmpDir: string;
  let home: string;
  let remotePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workshop-test-'));
    home = path.join(tmpDir, 'guild');
    createTestGuild(home);
    remotePath = createBareRemote(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no workshops registered', () => {
    const result = listWorkshops(home);
    assert.deepEqual(result, []);
  });

  it('returns workshop info with clone status', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });

    const result = listWorkshops(home);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'my-repo');
    assert.equal(result[0]!.remoteUrl, remotePath);
    assert.equal(result[0]!.cloned, true);
    assert.equal(result[0]!.activeWorktrees, 0);
  });

  it('reports missing bare clone', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });

    // Delete the bare clone behind the scenes
    fs.rmSync(workshopBarePath(home, 'my-repo'), { recursive: true });

    const result = listWorkshops(home);
    assert.equal(result[0]!.cloned, false);
  });

  it('counts active worktrees', () => {
    addWorkshop({ home, name: 'my-repo', remoteUrl: remotePath });

    // Simulate worktree directories
    const wtDir = path.join(worktreesPath(home), 'my-repo');
    fs.mkdirSync(path.join(wtDir, 'commission-1'), { recursive: true });
    fs.mkdirSync(path.join(wtDir, 'commission-2'), { recursive: true });

    const result = listWorkshops(home);
    assert.equal(result[0]!.activeWorktrees, 2);
  });
});

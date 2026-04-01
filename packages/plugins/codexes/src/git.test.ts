/**
 * Tests for the git helper module.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { git, resolveDefaultBranch, resolveRef, commitsAhead, GitError } from './git.ts';

// ── Test infrastructure ─────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nsg-git-test-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createTestRepo(): string {
  const dir = makeTmpDir('repo');
  gitSync(['init', '-b', 'main'], dir);
  gitSync(['config', 'user.email', 'test@test.com'], dir);
  gitSync(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  gitSync(['add', 'README.md'], dir);
  gitSync(['commit', '-m', 'Initial commit'], dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe('git()', () => {
  it('runs a git command and returns stdout', async () => {
    const repo = createTestRepo();
    const result = await git(['rev-parse', 'HEAD'], repo);
    assert.ok(result.stdout.length === 40); // SHA-1 hash
  });

  it('throws GitError on failure', async () => {
    const repo = createTestRepo();
    try {
      await git(['rev-parse', 'nonexistent-ref'], repo);
      assert.fail('Expected GitError');
    } catch (err) {
      assert.ok(err instanceof GitError);
      assert.ok(err.message.includes('rev-parse failed'));
      assert.deepEqual(err.command[0], 'git');
    }
  });
});

describe('resolveDefaultBranch()', () => {
  it('returns the default branch name', async () => {
    const repo = createTestRepo();
    const branch = await resolveDefaultBranch(repo);
    assert.equal(branch, 'main');
  });
});

describe('resolveRef()', () => {
  it('returns the commit SHA for a branch', async () => {
    const repo = createTestRepo();
    const sha = await resolveRef(repo, 'main');
    assert.ok(sha.length === 40);

    // Should match what git rev-parse gives us directly
    const expected = gitSync(['rev-parse', 'main'], repo);
    assert.equal(sha, expected);
  });
});

describe('commitsAhead()', () => {
  it('returns 0 when branches are at the same commit', async () => {
    const repo = createTestRepo();
    gitSync(['branch', 'feature'], repo);
    const ahead = await commitsAhead(repo, 'feature', 'main');
    assert.equal(ahead, 0);
  });

  it('returns the number of commits ahead', async () => {
    const repo = createTestRepo();
    gitSync(['checkout', '-b', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    gitSync(['add', 'a.txt'], repo);
    gitSync(['commit', '-m', 'first'], repo);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    gitSync(['add', 'b.txt'], repo);
    gitSync(['commit', '-m', 'second'], repo);

    const ahead = await commitsAhead(repo, 'feature', 'main');
    assert.equal(ahead, 2);
  });
});

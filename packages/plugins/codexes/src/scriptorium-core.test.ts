/**
 * Tests for the Scriptorium core logic.
 *
 * Creates real git repositories in temp directories to test the full
 * lifecycle: add → openDraft → commit → seal → push, and all the edge
 * cases (branch collisions, unsealed inscription guards, sealing with
 * rebase, startup reconciliation).
 *
 * Each test gets a fresh "remote" repo (the source of truth) and a
 * fresh guild directory. The Scriptorium operates against local file://
 * URLs, so no network access is needed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild } from '@shardworks/nexus-core';

import { ScriptoriumCore } from './scriptorium-core.ts';
import { git } from './git.ts';
import type { CodexesConfig } from './types.ts';

// ── Test infrastructure ─────────────────────────────────────────────

/** Dirs to clean up after each test. */
let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nsg-scriptorium-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** Run git synchronously in a directory. */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Create a "remote" bare repository with an initial commit on `main`.
 * Returns the file:// URL and the path.
 */
function createRemoteRepo(): { url: string; path: string } {
  // Create a non-bare repo first so we can make an initial commit
  const workDir = makeTmpDir('remote-work');
  gitSync(['init', '-b', 'main'], workDir);
  gitSync(['config', 'user.email', 'test@test.com'], workDir);
  gitSync(['config', 'user.name', 'Test'], workDir);
  fs.writeFileSync(path.join(workDir, 'README.md'), '# Test Repo\n');
  gitSync(['add', 'README.md'], workDir);
  gitSync(['commit', '-m', 'Initial commit'], workDir);

  // Clone to bare for use as "remote"
  const bareDir = makeTmpDir('remote-bare');
  // Remove the dir first since git clone won't clone into existing non-empty dir
  fs.rmSync(bareDir, { recursive: true });
  gitSync(['clone', '--bare', workDir, bareDir], os.tmpdir());

  return { url: `file://${bareDir}`, path: bareDir };
}

/** In-memory config store for the fake guild. */
interface FakeGuildState {
  home: string;
  configs: Record<string, unknown>;
}

function createFakeGuild(state: FakeGuildState): Guild {
  return {
    home: state.home,
    apparatus: () => { throw new Error('not available in test'); },
    config<T>(pluginId: string): T {
      return (state.configs[pluginId] ?? {}) as T;
    },
    writeConfig<T>(pluginId: string, value: T): void {
      state.configs[pluginId] = value;
    },
    guildConfig: () => ({ name: 'test-guild', nexus: '0.0.0', plugins: [] }),
    kits: () => [],
    apparatuses: () => [],
  };
}

/** Create a ScriptoriumCore with a fake guild and start it. */
function createStartedCore(opts?: {
  config?: CodexesConfig;
  home?: string;
}): { core: ScriptoriumCore; guildState: FakeGuildState } {
  const home = opts?.home ?? makeTmpDir('guild');
  const guildState: FakeGuildState = {
    home,
    configs: opts?.config ? { codexes: opts.config } : {},
  };
  setGuild(createFakeGuild(guildState));

  const core = new ScriptoriumCore();
  core.start();

  return { core, guildState };
}

// ── Cleanup ─────────────────────────────────────────────────────────

afterEach(() => {
  clearGuild();
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────

describe('ScriptoriumCore', () => {

  // ── Startup ─────────────────────────────────────────────────────

  describe('start()', () => {
    it('creates .nexus/codexes/ directory', () => {
      const { core, guildState } = createStartedCore();
      const codexesDir = path.join(guildState.home, '.nexus', 'codexes');
      assert.ok(fs.existsSync(codexesDir));
    });

    it('reads settings from config', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore({
        config: {
          settings: { maxMergeRetries: 5 },
          registered: { test: { remoteUrl: remote.url } },
        },
      });
      // The settings are private, but we can verify the codex was loaded
      const list = await core.createApi().list();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'test');
    });

    it('loads registered codexes from config and sets cloneStatus', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore({
        config: {
          registered: { mycodex: { remoteUrl: remote.url } },
        },
      });
      const api = core.createApi();
      const list = await api.list();
      assert.equal(list.length, 1);
      // Codex is cloning in background since bare clone doesn't exist yet
      assert.ok(
        list[0].cloneStatus === 'cloning' || list[0].cloneStatus === 'ready',
        `Expected 'cloning' or 'ready', got '${list[0].cloneStatus}'`,
      );
    });

    it('recognizes existing bare clones as ready', async () => {
      const remote = createRemoteRepo();
      const home = makeTmpDir('guild');
      // Pre-create the bare clone
      const codexesDir = path.join(home, '.nexus', 'codexes');
      fs.mkdirSync(codexesDir, { recursive: true });
      gitSync(['clone', '--bare', remote.url, path.join(codexesDir, 'mycodex.git')], home);

      const { core } = createStartedCore({
        home,
        config: {
          registered: { mycodex: { remoteUrl: remote.url } },
        },
      });

      const list = await core.createApi().list();
      assert.equal(list[0].cloneStatus, 'ready');
    });
  });

  // ── Codex Registry ──────────────────────────────────────────────

  describe('add()', () => {
    it('clones a bare repo and returns a ready CodexRecord', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      const record = await api.add('test-codex', remote.url);

      assert.equal(record.name, 'test-codex');
      assert.equal(record.remoteUrl, remote.url);
      assert.equal(record.cloneStatus, 'ready');
      assert.equal(record.activeDrafts, 0);

      // Verify bare clone exists on disk
      const clonePath = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      assert.ok(fs.existsSync(clonePath));
      // Verify it's a bare repo
      const isBare = gitSync(['rev-parse', '--is-bare-repository'], clonePath);
      assert.equal(isBare, 'true');
    });

    it('configures a remote.origin.fetch refspec on the bare clone', async () => {
      // Regression: `git clone --bare` leaves the remote with no fetch
      // refspec, so plain `git fetch origin` silently no-ops for
      // refs/remotes/origin/*. performClone() must persist an explicit
      // refspec so external callers (manual rebases in draft worktrees,
      // `git fetch origin` for debugging, etc.) see up-to-date remote
      // tracking refs without needing to know the trap.
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      const clonePath = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      const refspec = gitSync(['config', '--get-all', 'remote.origin.fetch'], clonePath);
      assert.equal(refspec, '+refs/heads/*:refs/remotes/origin/*');
    });

    it('persists codex entry to config', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      const config = guildState.configs['codexes'] as CodexesConfig;
      assert.ok(config.registered?.['test-codex']);
      assert.equal(config.registered['test-codex'].remoteUrl, remote.url);
    });

    it('rejects duplicate codex names', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await assert.rejects(
        () => api.add('test-codex', remote.url),
        /already registered/,
      );
    });

    it('cleans up on clone failure', async () => {
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await assert.rejects(
        () => api.add('bad-codex', 'file:///nonexistent/repo'),
        /Failed to clone/,
      );

      // Should not appear in the list
      const list = await api.list();
      assert.equal(list.length, 0);

      // Should not appear in config
      const config = guildState.configs['codexes'] as CodexesConfig | undefined;
      assert.ok(!config?.registered?.['bad-codex']);
    });
  });

  describe('list()', () => {
    it('returns empty array when no codexes registered', async () => {
      const { core } = createStartedCore();
      const list = await core.createApi().list();
      assert.deepEqual(list, []);
    });

    it('returns all registered codexes', async () => {
      const remote1 = createRemoteRepo();
      const remote2 = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('first', remote1.url);
      await api.add('second', remote2.url);

      const list = await api.list();
      assert.equal(list.length, 2);
      const names = list.map((c) => c.name).sort();
      assert.deepEqual(names, ['first', 'second']);
    });
  });

  describe('show()', () => {
    it('returns codex details with default branch', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const detail = await api.show('test-codex');

      assert.equal(detail.name, 'test-codex');
      assert.equal(detail.defaultBranch, 'main');
      assert.equal(detail.activeDrafts, 0);
      assert.deepEqual(detail.drafts, []);
    });

    it('throws for unknown codex', async () => {
      const { core } = createStartedCore();
      await assert.rejects(
        () => core.createApi().show('nonexistent'),
        /not registered/,
      );
    });

    it('includes active drafts in detail', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.openDraft({ codexName: 'test-codex', branch: 'draft-1' });

      const detail = await api.show('test-codex');
      assert.equal(detail.activeDrafts, 1);
      assert.equal(detail.drafts.length, 1);
      assert.equal(detail.drafts[0].branch, 'draft-1');
    });
  });

  describe('remove()', () => {
    it('removes bare clone, config entry, and in-memory state', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.remove('test-codex');

      // Gone from list
      const list = await api.list();
      assert.equal(list.length, 0);

      // Gone from disk
      const clonePath = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      assert.ok(!fs.existsSync(clonePath));

      // Gone from config
      const config = guildState.configs['codexes'] as CodexesConfig;
      assert.ok(!config.registered?.['test-codex']);
    });

    it('abandons active drafts before removing', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Draft worktree exists
      assert.ok(fs.existsSync(draft.path));

      await api.remove('test-codex');

      // Draft worktree cleaned up
      assert.ok(!fs.existsSync(draft.path));

      // No drafts remain
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 0);
    });

    it('throws for unknown codex', async () => {
      const { core } = createStartedCore();
      await assert.rejects(
        () => core.createApi().remove('nonexistent'),
        /not registered/,
      );
    });
  });

  describe('fetch()', () => {
    it('fetches latest refs and updates lastFetched', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      // Show before fetch — lastFetched should be null (add doesn't set it)
      const before = await api.show('test-codex');
      assert.equal(before.lastFetched, null);

      await api.fetch('test-codex');

      const after = await api.show('test-codex');
      assert.ok(after.lastFetched !== null);
    });

    it('throws for unknown codex', async () => {
      const { core } = createStartedCore();
      await assert.rejects(
        () => core.createApi().fetch('nonexistent'),
        /not registered/,
      );
    });
  });

  // ── Draft Binding Lifecycle ─────────────────────────────────────

  describe('openDraft()', () => {
    it('creates a worktree and returns a DraftRecord', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({
        codexName: 'test-codex',
        branch: 'my-feature',
      });

      assert.equal(draft.codexName, 'test-codex');
      assert.equal(draft.branch, 'my-feature');
      assert.ok(draft.id); // has an ID
      assert.ok(draft.createdAt); // has a timestamp
      assert.ok(draft.path.includes('my-feature'));

      // Worktree exists on disk
      assert.ok(fs.existsSync(draft.path));
      // Has .git file (worktree marker)
      assert.ok(fs.existsSync(path.join(draft.path, '.git')));
      // Contains the repo content
      assert.ok(fs.existsSync(path.join(draft.path, 'README.md')));
    });

    it('auto-generates branch name when omitted', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex' });

      assert.ok(draft.branch.startsWith('draft-'));
    });

    it('records associatedWith metadata', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({
        codexName: 'test-codex',
        branch: 'writ-42',
        associatedWith: 'writ-42',
      });

      assert.equal(draft.associatedWith, 'writ-42');
    });

    it('rejects duplicate branch names', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.openDraft({ codexName: 'test-codex', branch: 'my-branch' });

      await assert.rejects(
        () => api.openDraft({ codexName: 'test-codex', branch: 'my-branch' }),
        /already exists/,
      );
    });

    it('allows same branch name on different codexes', async () => {
      const remote1 = createRemoteRepo();
      const remote2 = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('codex-a', remote1.url);
      await api.add('codex-b', remote2.url);

      const draft1 = await api.openDraft({ codexName: 'codex-a', branch: 'feature' });
      const draft2 = await api.openDraft({ codexName: 'codex-b', branch: 'feature' });

      assert.notEqual(draft1.path, draft2.path);
    });

    it('throws for unknown codex', async () => {
      const { core } = createStartedCore();
      await assert.rejects(
        () => core.createApi().openDraft({ codexName: 'nonexistent' }),
        /not registered/,
      );
    });
  });

  describe('listDrafts()', () => {
    it('returns empty array when no drafts exist', async () => {
      const { core } = createStartedCore();
      const drafts = await core.createApi().listDrafts();
      assert.deepEqual(drafts, []);
    });

    it('returns all drafts', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.openDraft({ codexName: 'test-codex', branch: 'draft-1' });
      await api.openDraft({ codexName: 'test-codex', branch: 'draft-2' });

      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 2);
    });

    it('filters by codex name', async () => {
      const remote1 = createRemoteRepo();
      const remote2 = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('codex-a', remote1.url);
      await api.add('codex-b', remote2.url);
      await api.openDraft({ codexName: 'codex-a', branch: 'draft-a' });
      await api.openDraft({ codexName: 'codex-b', branch: 'draft-b' });

      const draftsA = await api.listDrafts('codex-a');
      assert.equal(draftsA.length, 1);
      assert.equal(draftsA[0].codexName, 'codex-a');

      const draftsB = await api.listDrafts('codex-b');
      assert.equal(draftsB.length, 1);
      assert.equal(draftsB[0].codexName, 'codex-b');
    });
  });

  describe('abandonDraft()', () => {
    it('removes the worktree and branch', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      assert.ok(fs.existsSync(draft.path));

      await api.abandonDraft({ codexName: 'test-codex', branch: 'my-draft', force: true });

      // Worktree gone
      assert.ok(!fs.existsSync(draft.path));
      // Removed from tracking
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 0);
    });

    it('rejects abandonment of draft with unsealed inscriptions without force', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Add a commit in the draft (an unsealed inscription)
      fs.writeFileSync(path.join(draft.path, 'new-file.txt'), 'hello\n');
      gitSync(['add', 'new-file.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'An inscription'], draft.path);

      await assert.rejects(
        () => api.abandonDraft({ codexName: 'test-codex', branch: 'my-draft' }),
        /unsealed inscription/,
      );

      // Draft still exists
      assert.ok(fs.existsSync(draft.path));
    });

    it('allows forced abandonment of draft with unsealed inscriptions', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Add a commit in the draft
      fs.writeFileSync(path.join(draft.path, 'new-file.txt'), 'hello\n');
      gitSync(['add', 'new-file.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'An inscription'], draft.path);

      // Force should work
      await api.abandonDraft({ codexName: 'test-codex', branch: 'my-draft', force: true });

      assert.ok(!fs.existsSync(draft.path));
    });

    it('throws for unknown draft', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      await assert.rejects(
        () => api.abandonDraft({ codexName: 'test-codex', branch: 'nonexistent' }),
        /No active draft/,
      );
    });
  });

  // ── Sealing ───────────────────────────────────────────────────────

  describe('seal()', () => {
    it('fast-forwards when draft is ahead of sealed binding', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Make a commit in the draft
      fs.writeFileSync(path.join(draft.path, 'feature.txt'), 'new feature\n');
      gitSync(['add', 'feature.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'Add feature'], draft.path);

      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
      });

      assert.equal(result.success, true);
      assert.equal(result.strategy, 'fast-forward');
      assert.equal(result.retries, 0);
      assert.ok(result.sealedCommit);
    });

    it('abandons draft after successful seal by default', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Make a commit
      fs.writeFileSync(path.join(draft.path, 'feature.txt'), 'new feature\n');
      gitSync(['add', 'feature.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'Add feature'], draft.path);

      await api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' });

      // Draft should be gone
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 0);
    });

    it('keeps draft when keepDraft is true', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Make a commit
      fs.writeFileSync(path.join(draft.path, 'feature.txt'), 'new feature\n');
      gitSync(['add', 'feature.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'Add feature'], draft.path);

      await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
        keepDraft: true,
      });

      // Draft should still exist
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 1);
    });

    it('seals when source and target are at the same commit', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // No commits — draft is at the same point as main
      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
      });

      assert.equal(result.success, true);
      assert.equal(result.retries, 0);
    });

    it('updates the sealed binding ref in the bare clone', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Get the main ref before
      const bareClone = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      const mainBefore = gitSync(['rev-parse', 'main'], bareClone);

      // Make a commit in the draft
      fs.writeFileSync(path.join(draft.path, 'feature.txt'), 'new feature\n');
      gitSync(['add', 'feature.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'Add feature'], draft.path);

      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
      });

      // main should have advanced
      const mainAfter = gitSync(['rev-parse', 'main'], bareClone);
      assert.notEqual(mainBefore, mainAfter);
      assert.equal(mainAfter, result.sealedCommit);
    });

    it('inscriptionsSealed is 0 for no-op seal (draft has no new commits)', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // No commits — draft is at the same point as main
      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
      });

      assert.equal(result.inscriptionsSealed, 0);
    });

    it('inscriptionsSealed counts all draft inscriptions on fast-forward seal', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);

      // Make 3 separate inscriptions
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(draft.path, `inscription-${i}.txt`), `inscription ${i}\n`);
        gitSync(['add', `inscription-${i}.txt`], draft.path);
        gitSync(['commit', '-m', `Inscription ${i}`], draft.path);
      }

      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
      });

      assert.equal(result.strategy, 'fast-forward');
      assert.equal(result.inscriptionsSealed, 3);
    });
  });

  // ── Seal: Rebase contention ──────────────────────────────────────

  describe('seal() rebase contention', () => {

    /**
     * Helper: set up a codex with two diverged drafts.
     *
     * Both draft-A and draft-B branch from the same initial commit on main.
     * Each writes to a different file so the rebase can succeed cleanly.
     *
     * Returns the api plus references to both drafts.
     */
    async function setupDivergedDrafts() {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      const draftA = await api.openDraft({ codexName: 'test-codex', branch: 'draft-a' });
      const draftB = await api.openDraft({ codexName: 'test-codex', branch: 'draft-b' });

      // Configure git in both worktrees
      for (const d of [draftA, draftB]) {
        gitSync(['config', 'user.email', 'test@test.com'], d.path);
        gitSync(['config', 'user.name', 'Test'], d.path);
      }

      // Draft A commits to file-a.txt
      fs.writeFileSync(path.join(draftA.path, 'file-a.txt'), 'from draft A\n');
      gitSync(['add', 'file-a.txt'], draftA.path);
      gitSync(['commit', '-m', 'Draft A inscription'], draftA.path);

      // Draft B commits to file-b.txt (no conflict with A)
      fs.writeFileSync(path.join(draftB.path, 'file-b.txt'), 'from draft B\n');
      gitSync(['add', 'file-b.txt'], draftB.path);
      gitSync(['commit', '-m', 'Draft B inscription'], draftB.path);

      return { api, guildState, draftA, draftB, remote };
    }

    it('rebases and seals when another draft advanced the target', async () => {
      const { api, guildState, draftA, draftB } = await setupDivergedDrafts();

      // Seal draft A first — this advances main past the common ancestor
      const resultA = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'draft-a',
      });
      assert.equal(resultA.success, true);
      assert.equal(resultA.strategy, 'fast-forward');
      assert.equal(resultA.retries, 0);

      // Now seal draft B — main has moved, so ff won't work; must rebase
      const resultB = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'draft-b',
      });

      assert.equal(resultB.success, true);
      assert.equal(resultB.strategy, 'rebase');
      // At least 1 retry (the initial ff attempt fails, rebase, then ff succeeds)
      assert.ok(resultB.retries >= 1, `Expected retries >= 1, got ${resultB.retries}`);
      assert.ok(resultB.sealedCommit);

      // The sealed commit should contain both files
      const bareClone = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      const mainRef = gitSync(['rev-parse', 'main'], bareClone);
      assert.equal(mainRef, resultB.sealedCommit);

      // Verify both inscriptions are present by checking the tree
      const tree = gitSync(['ls-tree', '--name-only', 'main'], bareClone);
      assert.ok(tree.includes('file-a.txt'), 'file-a.txt should be in tree after both seals');
      assert.ok(tree.includes('file-b.txt'), 'file-b.txt should be in tree after both seals');
    });

    it('reports rebase strategy and retry count accurately', async () => {
      const { api } = await setupDivergedDrafts();

      // Seal A (ff)
      await api.seal({ codexName: 'test-codex', sourceBranch: 'draft-a' });

      // Seal B (rebase required)
      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'draft-b',
      });

      // Strategy should be 'rebase' because ff was attempted and failed
      assert.equal(result.strategy, 'rebase');
      // Retries tracks the number of rebase-then-retry loops
      assert.ok(result.retries >= 1);
    });

    it('fails with conflict error when rebase cannot resolve', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      const draftA = await api.openDraft({ codexName: 'test-codex', branch: 'draft-a' });
      const draftB = await api.openDraft({ codexName: 'test-codex', branch: 'draft-b' });

      for (const d of [draftA, draftB]) {
        gitSync(['config', 'user.email', 'test@test.com'], d.path);
        gitSync(['config', 'user.name', 'Test'], d.path);
      }

      // Both drafts write conflicting content to the SAME file
      fs.writeFileSync(path.join(draftA.path, 'conflict.txt'), 'content from A\n');
      gitSync(['add', 'conflict.txt'], draftA.path);
      gitSync(['commit', '-m', 'Draft A writes conflict.txt'], draftA.path);

      fs.writeFileSync(path.join(draftB.path, 'conflict.txt'), 'content from B\n');
      gitSync(['add', 'conflict.txt'], draftB.path);
      gitSync(['commit', '-m', 'Draft B writes conflict.txt'], draftB.path);

      // Seal A — should succeed (ff)
      await api.seal({ codexName: 'test-codex', sourceBranch: 'draft-a' });

      // Seal B — rebase will conflict
      await assert.rejects(
        () => api.seal({ codexName: 'test-codex', sourceBranch: 'draft-b' }),
        /Sealing seized.*conflicts/,
      );

      // Draft B should still exist (not cleaned up on failure)
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].branch, 'draft-b');
    });

    it('respects maxRetries limit', async () => {
      const { api } = await setupDivergedDrafts();

      // Seal A first
      await api.seal({ codexName: 'test-codex', sourceBranch: 'draft-a' });

      // Seal B with maxRetries=0 — should fail since ff won't work
      // and we don't allow any retries after the initial attempt
      await assert.rejects(
        () => api.seal({
          codexName: 'test-codex',
          sourceBranch: 'draft-b',
          maxRetries: 0,
        }),
        /failed after 0 retries/,
      );
    });
  });

  // ── Seal: Diverged remote ─────────────────────────────────────────

  describe('seal() diverged remote', () => {

    /**
     * Helper: push a commit to the remote bare repo from an external clone,
     * simulating work done outside the Scriptorium.
     */
    function pushExternalCommit(remoteUrl: string, filename: string, content: string): void {
      const outsideClone = makeTmpDir('outside-clone');
      // git clone needs a non-existent or empty target dir
      fs.rmSync(outsideClone, { recursive: true });
      gitSync(['clone', remoteUrl, outsideClone], os.tmpdir());
      gitSync(['config', 'user.email', 'outside@test.com'], outsideClone);
      gitSync(['config', 'user.name', 'Outside'], outsideClone);
      fs.writeFileSync(path.join(outsideClone, filename), content);
      gitSync(['add', filename], outsideClone);
      gitSync(['commit', '-m', `External: ${filename}`], outsideClone);
      gitSync(['push', 'origin', 'main'], outsideClone);
    }

    it('seals successfully when remote advances between draft open and seal', async () => {
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);

      // Make an inscription in the draft
      fs.writeFileSync(path.join(draft.path, 'draft-feature.txt'), 'draft work\n');
      gitSync(['add', 'draft-feature.txt'], draft.path);
      gitSync(['commit', '-m', 'Draft inscription'], draft.path);

      // Simulate external push to the remote (outside the Scriptorium)
      pushExternalCommit(remote.url, 'external-change.txt', 'external work\n');

      // Confirm the bare clone's main is now behind the remote
      const bareClone = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      const remoteHead = gitSync(['rev-parse', 'main'], remote.path);
      const bareMainBefore = gitSync(['rev-parse', 'main'], bareClone);
      assert.notEqual(remoteHead, bareMainBefore, 'Remote should have advanced past bare clone before seal');

      // Seal should succeed: fetch picks up remote advancement, rebase handles divergence
      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'my-draft',
        keepDraft: true,
      });

      assert.equal(result.success, true);
      assert.equal(result.strategy, 'rebase');
      assert.ok(result.retries >= 1, `Expected retries >= 1, got ${result.retries}`);
      assert.equal(result.inscriptionsSealed, 1);

      // Sealed binding should include both the draft inscription and the external commit
      const bareMainAfter = gitSync(['rev-parse', 'main'], bareClone);
      assert.equal(bareMainAfter, result.sealedCommit);

      const tree = gitSync(['ls-tree', '--name-only', 'main'], bareClone);
      assert.ok(tree.includes('draft-feature.txt'), 'draft-feature.txt should be in sealed tree');
      assert.ok(tree.includes('external-change.txt'), 'external-change.txt should be in sealed tree');
    });

    it('push succeeds after sealing against a diverged remote', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);

      fs.writeFileSync(path.join(draft.path, 'draft-work.txt'), 'draft\n');
      gitSync(['add', 'draft-work.txt'], draft.path);
      gitSync(['commit', '-m', 'Draft work'], draft.path);

      // External push advances remote
      pushExternalCommit(remote.url, 'external.txt', 'external\n');

      // Seal — must rebase onto the remote-advanced main; seal now also pushes
      const result = await api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' });
      assert.equal(result.strategy, 'rebase');

      // Confirm remote has the sealed commit (seal() pushed it)
      const remoteHead = gitSync(['rev-parse', 'main'], remote.path);
      assert.equal(remoteHead, result.sealedCommit);
    });

    it('seal pushes to remote', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      fs.writeFileSync(path.join(draft.path, 'seal-push.txt'), 'seal push\n');
      gitSync(['add', 'seal-push.txt'], draft.path);
      gitSync(['commit', '-m', 'Seal push test'], draft.path);

      // seal() should push automatically — no explicit push() call
      const result = await api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' });
      assert.equal(result.success, true);

      // Remote must have the sealed commit without a separate push()
      const remoteHead = gitSync(['rev-parse', 'main'], remote.path);
      assert.equal(remoteHead, result.sealedCommit);
    });

    it('seal pushes on no-op seal', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      // Open a draft but make no commits — sealing is a no-op
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      const result = await api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' });
      assert.equal(result.success, true);
      assert.equal(result.inscriptionsSealed, 0);

      // Remote must match the sealed commit even on a no-op seal
      const remoteHead = gitSync(['rev-parse', 'main'], remote.path);
      assert.equal(remoteHead, result.sealedCommit);

      void draft; // suppress unused warning
    });

    it('push failure after seal throws with distinct message', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      fs.writeFileSync(path.join(draft.path, 'push-fail.txt'), 'push fail\n');
      gitSync(['add', 'push-fail.txt'], draft.path);
      gitSync(['commit', '-m', 'Push fail test'], draft.path);

      // Find the bare clone path via the draft's gitdir.
      // The gitdir is something like /tmp/.../codexes/test-codex.git/worktrees/my-draft
      // Go up two levels to get the bare clone root.
      const gitDir = gitSync(['rev-parse', '--git-dir'], draft.path);
      const cloneGitDir = path.resolve(path.join(gitDir, '..', '..'));

      // Set a push-only URL to an invalid location so fetch still works but push fails.
      // git remote set-url --push only overrides the push URL, leaving fetch URL intact.
      gitSync(['remote', 'set-url', '--push', 'origin', 'file:///nonexistent/path.git'], cloneGitDir);

      // seal() should fail with a push error, not a seal error
      await assert.rejects(
        () => api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' }),
        (err: unknown) => {
          assert.ok(err instanceof Error, 'Expected an Error');
          assert.match(err.message, /Push failed after successful seal/,
            `Expected push-failure message, got: ${err instanceof Error ? err.message : err}`);
          return true;
        },
      );

      // The local bare clone's ref should have been updated (seal succeeded locally)
      const localRef = gitSync(['rev-parse', 'main'], cloneGitDir);
      // The draft's HEAD should match the local sealed ref
      const draftHead = gitSync(['rev-parse', 'HEAD'], draft.path);
      assert.equal(localRef, draftHead);

      // The draft must still exist (push runs before abandonDraft)
      const drafts = await api.listDrafts();
      assert.equal(drafts.length, 1, 'Draft should still exist after push failure');
    });
  });

  // ── Seal: Detached-HEAD recovery ─────────────────────────────────

  describe('seal() detached-HEAD recovery', () => {

    it('reattaches the bare clone branch ref when worktree HEAD is detached', async () => {
      // Reproduces the Apr-26 reckoner-rename failure mode: an upstream
      // caller (e.g. review/revise) detached HEAD in the draft worktree
      // mid-flow. The rebase still produces correct commits, but
      // refs/heads/<draft> in the bare clone never advances. Without the
      // reattach, each retry iteration of the seal loop resolves the
      // stale pre-rebase SHA, the FF check keeps failing, and the loop
      // exits with the misleading "Sealing failed after N retries"
      // message.
      const remote = createRemoteRepo();
      const { core, guildState } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);

      const draftA = await api.openDraft({ codexName: 'test-codex', branch: 'draft-a' });
      const draftB = await api.openDraft({ codexName: 'test-codex', branch: 'draft-b' });

      for (const d of [draftA, draftB]) {
        gitSync(['config', 'user.email', 'test@test.com'], d.path);
        gitSync(['config', 'user.name', 'Test'], d.path);
      }

      // Draft A inscribes (will be sealed first to advance main)
      fs.writeFileSync(path.join(draftA.path, 'file-a.txt'), 'from draft A\n');
      gitSync(['add', 'file-a.txt'], draftA.path);
      gitSync(['commit', '-m', 'Draft A inscription'], draftA.path);

      // Draft B inscribes (will need rebase against the advanced main)
      fs.writeFileSync(path.join(draftB.path, 'file-b.txt'), 'from draft B\n');
      gitSync(['add', 'file-b.txt'], draftB.path);
      gitSync(['commit', '-m', 'Draft B inscription'], draftB.path);

      // Seal draft A first — fast-forward, advances main
      await api.seal({ codexName: 'test-codex', sourceBranch: 'draft-a' });

      // Detach HEAD in draft B before sealing — simulates a mid-flow
      // `git checkout HEAD~1` style inspection that left HEAD detached.
      gitSync(['checkout', '--detach'], draftB.path);

      // Seal draft B — must rebase onto the advanced main. Without the
      // reattach, refs/heads/draft-b would stay at the pre-rebase SHA
      // and the seal loop would exhaust retries.
      const result = await api.seal({
        codexName: 'test-codex',
        sourceBranch: 'draft-b',
        keepDraft: true,
      });

      assert.equal(result.success, true);
      assert.equal(result.strategy, 'rebase');
      assert.ok(result.sealedCommit);

      // The bare clone's refs/heads/draft-b should now resolve to the
      // rebased HEAD — the same commit the worktree sees.
      const bareClone = path.join(guildState.home, '.nexus', 'codexes', 'test-codex.git');
      const bareDraftRef = gitSync(['rev-parse', 'refs/heads/draft-b'], bareClone);
      const worktreeHead = gitSync(['rev-parse', 'HEAD'], draftB.path);
      assert.equal(bareDraftRef, worktreeHead);
      assert.equal(bareDraftRef, result.sealedCommit);

      // The remote main should carry the sealed commit (seal pushed).
      const remoteMain = gitSync(['rev-parse', 'main'], remote.path);
      assert.equal(remoteMain, result.sealedCommit);

      // Both inscriptions should be present in the sealed tree.
      const tree = gitSync(['ls-tree', '--name-only', 'main'], bareClone);
      assert.ok(tree.includes('file-a.txt'), 'file-a.txt should be in sealed tree');
      assert.ok(tree.includes('file-b.txt'), 'file-b.txt should be in sealed tree');
    });
  });

  // ── Startup Reconciliation ────────────────────────────────────────

  describe('startup reconciliation', () => {
    it('reconciles drafts from existing worktrees on disk', async () => {
      const remote = createRemoteRepo();
      const home = makeTmpDir('guild');

      // First: create a core, add a codex, open a draft
      const guildState1: FakeGuildState = {
        home,
        configs: {},
      };
      setGuild(createFakeGuild(guildState1));

      const core1 = new ScriptoriumCore();
      core1.start();
      const api1 = core1.createApi();

      await api1.add('test-codex', remote.url);
      const draft = await api1.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Verify draft exists
      assert.ok(fs.existsSync(draft.path));

      // Now simulate a restart: create a new core with the same home
      clearGuild();
      const guildState2: FakeGuildState = {
        home,
        configs: guildState1.configs, // keep the config
      };
      setGuild(createFakeGuild(guildState2));

      const core2 = new ScriptoriumCore();
      core2.start();
      const api2 = core2.createApi();

      // The draft should be reconciled from disk
      const drafts = await api2.listDrafts();
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].codexName, 'test-codex');
      assert.equal(drafts[0].branch, 'my-draft');
      assert.equal(drafts[0].path, draft.path);
    });
  });

  // ── Push ─────────────────────────────────────────────────────────

  describe('push()', () => {
    it('pushes sealed commits to the remote', async () => {
      const remote = createRemoteRepo();
      const { core } = createStartedCore();
      const api = core.createApi();

      await api.add('test-codex', remote.url);
      const draft = await api.openDraft({ codexName: 'test-codex', branch: 'my-draft' });

      // Make a commit and seal
      fs.writeFileSync(path.join(draft.path, 'feature.txt'), 'pushed feature\n');
      gitSync(['add', 'feature.txt'], draft.path);
      gitSync(['config', 'user.email', 'test@test.com'], draft.path);
      gitSync(['config', 'user.name', 'Test'], draft.path);
      gitSync(['commit', '-m', 'Add pushed feature'], draft.path);

      // seal() now pushes automatically — no explicit push() call needed
      const sealResult = await api.seal({ codexName: 'test-codex', sourceBranch: 'my-draft' });

      // Verify the remote has the commit (pushed by seal())
      const remoteHead = gitSync(['rev-parse', 'main'], remote.path);
      assert.equal(remoteHead, sealResult.sealedCommit);
    });

    it('throws for unknown codex', async () => {
      const { core } = createStartedCore();
      await assert.rejects(
        () => core.createApi().push({ codexName: 'nonexistent' }),
        /not registered/,
      );
    });
  });
});

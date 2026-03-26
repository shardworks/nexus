/**
 * workshop — core logic for managing guild workshops.
 *
 * Workshops are repositories where the guild does its work. Each workshop
 * is stored as a bare git clone in .nexus/workshops/{name}.git, with
 * commission worktrees created from it by the worktree-setup engine.
 *
 * This module provides:
 * - addWorkshop: clone a remote repo and register it in guild.json
 * - removeWorkshop: remove the bare clone, worktrees, and guild.json entry
 * - listWorkshops: return workshop entries with status info
 * - createWorkshop: create a new GitHub repo via `gh`, then add it
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readGuildConfig, writeGuildConfig } from './guild-config.ts';
import type { WorkshopEntry } from './guild-config.ts';
import { workshopBarePath, workshopsPath, worktreesPath } from './nexus-home.ts';

// ── Types ──────────────────────────────────────────────────────────────

export interface AddWorkshopOptions {
  /** Absolute path to the guild root. */
  home: string;
  /** Workshop name (used as the key in guild.json and the bare clone directory name). */
  name: string;
  /** Git remote URL to clone from. */
  remoteUrl: string;
}

export interface AddWorkshopResult {
  /** Workshop name. */
  name: string;
  /** Remote URL that was cloned. */
  remoteUrl: string;
  /** Path to the bare clone on disk. */
  barePath: string;
}

export interface RemoveWorkshopOptions {
  /** Absolute path to the guild root. */
  home: string;
  /** Workshop name to remove. */
  name: string;
}

export interface WorkshopInfo {
  /** Workshop name. */
  name: string;
  /** Remote URL from guild.json. */
  remoteUrl: string;
  /** When the workshop was added. */
  addedAt: string;
  /** Whether the bare clone exists on disk. */
  cloned: boolean;
  /** Number of active commission worktrees. */
  activeWorktrees: number;
}

export interface CreateWorkshopOptions {
  /** Absolute path to the guild root. */
  home: string;
  /** Repository name in org/name format. */
  repoName: string;
  /** Whether to create a private repo (default: true). */
  private?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Derive a workshop name from a remote URL or repo name.
 * "https://github.com/org/my-repo.git" → "my-repo"
 * "org/my-repo" → "my-repo"
 * "git@github.com:org/my-repo.git" → "my-repo"
 */
export function deriveWorkshopName(input: string): string {
  // Handle org/name format
  if (input.includes('/') && !input.includes(':') && !input.includes('.')) {
    return input.split('/').pop()!;
  }
  // Handle URLs — take the last path segment, strip .git
  const basename = input.split('/').pop() ?? input;
  return basename.replace(/\.git$/, '');
}

// ── Core operations ───────────────────────────────────────────────────

/**
 * Add a workshop by cloning a remote repo as a bare clone and registering
 * it in guild.json.
 *
 * @throws If the workshop name already exists in guild.json.
 * @throws If the bare clone directory already exists on disk.
 * @throws If the git clone fails.
 */
export function addWorkshop(opts: AddWorkshopOptions): AddWorkshopResult {
  const { home, name, remoteUrl } = opts;
  const config = readGuildConfig(home);

  if (name in config.workshops) {
    throw new Error(`Workshop "${name}" already exists in guild.json.`);
  }

  const barePath = workshopBarePath(home, name);
  if (fs.existsSync(barePath)) {
    throw new Error(`Bare clone already exists at ${barePath}. Remove it first or choose a different name.`);
  }

  // Ensure workshops directory exists
  fs.mkdirSync(workshopsPath(home), { recursive: true });

  // Clone as bare repo
  git(['clone', '--bare', remoteUrl, barePath]);

  // Register in guild.json
  const entry: WorkshopEntry = {
    remoteUrl,
    addedAt: new Date().toISOString(),
  };
  config.workshops[name] = entry;
  writeGuildConfig(home, config);

  return { name, remoteUrl, barePath };
}

/**
 * Remove a workshop — deletes the bare clone, any commission worktrees,
 * and the guild.json entry.
 *
 * @throws If the workshop doesn't exist in guild.json.
 */
export function removeWorkshop(opts: RemoveWorkshopOptions): void {
  const { home, name } = opts;
  const config = readGuildConfig(home);

  if (!(name in config.workshops)) {
    throw new Error(
      `Workshop "${name}" not found in guild.json. Available workshops: ${Object.keys(config.workshops).join(', ') || '(none)'}`,
    );
  }

  // Remove commission worktrees for this workshop
  const wtDir = path.join(worktreesPath(home), name);
  if (fs.existsSync(wtDir)) {
    fs.rmSync(wtDir, { recursive: true, force: true });
  }

  // Remove the bare clone
  const barePath = workshopBarePath(home, name);
  if (fs.existsSync(barePath)) {
    fs.rmSync(barePath, { recursive: true, force: true });
  }

  // Remove from guild.json
  delete config.workshops[name];
  writeGuildConfig(home, config);
}

/**
 * List all workshops with status info.
 */
export function listWorkshops(home: string): WorkshopInfo[] {
  const config = readGuildConfig(home);
  const results: WorkshopInfo[] = [];

  for (const [name, entry] of Object.entries(config.workshops)) {
    const barePath = workshopBarePath(home, name);
    const cloned = fs.existsSync(barePath);

    // Count active worktrees
    let activeWorktrees = 0;
    const wtDir = path.join(worktreesPath(home), name);
    if (fs.existsSync(wtDir)) {
      activeWorktrees = fs.readdirSync(wtDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .length;
    }

    results.push({
      name,
      remoteUrl: entry.remoteUrl,
      addedAt: entry.addedAt,
      cloned,
      activeWorktrees,
    });
  }

  return results;
}

export interface WorkshopDetail extends WorkshopInfo {
  /** Absolute path to the bare clone on disk. */
  barePath: string;
  /** Default branch name, if bare clone exists. */
  defaultBranch: string | null;
}

/**
 * Show detailed info for a single workshop.
 */
export function showWorkshop(home: string, name: string): WorkshopDetail | null {
  const config = readGuildConfig(home);
  const entry = config.workshops[name];
  if (!entry) return null;

  const barePath = workshopBarePath(home, name);
  const cloned = fs.existsSync(barePath);

  let activeWorktrees = 0;
  const wtDir = path.join(worktreesPath(home), name);
  if (fs.existsSync(wtDir)) {
    activeWorktrees = fs.readdirSync(wtDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .length;
  }

  let defaultBranch: string | null = null;
  if (cloned) {
    try {
      defaultBranch = git(['symbolic-ref', '--short', 'HEAD'], barePath);
    } catch { /* bare repos may not have HEAD set */ }
  }

  return {
    name,
    remoteUrl: entry.remoteUrl,
    addedAt: entry.addedAt,
    cloned,
    activeWorktrees,
    barePath,
    defaultBranch,
  };
}

/**
 * Check whether `gh` is installed and authenticated.
 * Returns null if OK, or an error message if not.
 */
export function checkGhAuth(): string | null {
  try {
    execFileSync('which', ['gh'], { stdio: 'pipe' });
  } catch {
    return 'GitHub CLI (gh) is not installed. Install from https://cli.github.com/';
  }

  try {
    const output = execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // gh auth status exits 0 when authenticated
    return null;
  } catch (err: unknown) {
    // gh auth status may write to stderr even on success in some versions
    if (err && typeof err === 'object' && 'stderr' in err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (stderr.includes('Logged in')) return null;
    }
    return 'GitHub CLI is not authenticated. Run: gh auth login';
  }
}

/**
 * Create a new GitHub repo and add it as a workshop.
 *
 * Precondition: `gh` must be installed and authenticated. Call checkGhAuth()
 * first to verify.
 *
 * @param opts.repoName - Repository name in "org/name" format.
 * @throws If gh auth check fails, repo creation fails, or add fails.
 */
export function createWorkshop(opts: CreateWorkshopOptions): AddWorkshopResult {
  const { home, repoName, private: isPrivate = true } = opts;

  // Verify gh is available and authenticated
  const authError = checkGhAuth();
  if (authError) {
    throw new Error(authError);
  }

  // Create the repo on GitHub
  const visibility = isPrivate ? '--private' : '--public';
  gh(['repo', 'create', repoName, visibility, '--confirm']);

  // Get the clone URL
  const remoteUrl = `https://github.com/${repoName}.git`;
  const name = deriveWorkshopName(repoName);

  // Bare-clone the empty repo, then seed it with an initial commit
  // using git plumbing so worktrees have a real 'main' ref to branch from.
  const result = addWorkshop({ home, name, remoteUrl });

  const bare = result.barePath;
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  const emptyTree = git(['mktree'], bare);  // reads empty stdin → empty tree
  const commit = git(['commit-tree', emptyTree, '-m', `Initial commit\n\n# ${name}`], bare);
  git(['update-ref', 'refs/heads/main', commit], bare);
  git(['push', 'origin', 'main'], bare);

  return result;
}

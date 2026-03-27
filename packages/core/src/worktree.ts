/**
 * Writ worktree management — creates isolated git worktrees for
 * writ sessions.
 *
 * When an anima is dispatched to work on a writ, this module:
 * 1. Creates a new git branch for the writ
 * 2. Sets up a git worktree pointing at that branch
 * 3. Returns the worktree path so the session can launch in the correct cwd
 *
 * Worktrees provide isolation — each writ gets its own working copy
 * of the repo, so multiple animas can work concurrently without conflicts
 * in the working directory.
 *
 * ## Directory layout
 *
 * Writ worktrees are created from workshop bare clones:
 *
 *   GUILD_ROOT/
 *     .nexus/
 *       workshops/
 *         workshop-a.git/          <- bare clone (source for worktrees)
 *       worktrees/
 *         workshop-a/
 *           writ-42/               <- worktree for writ #42
 *         workshop-b/
 *           writ-17/               <- worktree for writ #17
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workshopBarePath, worktreesPath } from './nexus-home.ts';

export interface WorktreeConfig {
  /** Absolute path to the guild root. */
  home: string;
  /** Workshop name — the bare clone source for the worktree. */
  workshop: string;
  /** Writ ID — used to derive branch name and worktree directory. */
  writId: string;
  /** Base branch to create the worktree from (default: 'main'). */
  baseBranch?: string;
}

export interface WorktreeResult {
  /** Absolute path to the created worktree. */
  path: string;
  /** Branch name created for the worktree. */
  branch: string;
  /** Writ ID this worktree serves. */
  writId: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Create a git worktree for a writ session.
 *
 * Creates a new branch from the base branch and sets up a worktree in
 * .nexus/worktrees/{workshop}/writ-{id}/.
 *
 * @throws If the worktree or branch already exists.
 */
export function setupWorktree(config: WorktreeConfig): WorktreeResult {
  const { home, workshop, writId, baseBranch = 'main' } = config;
  const bareRepo = workshopBarePath(home, workshop);
  const branch = `writ-${writId}`;
  const worktreeDir = path.join(worktreesPath(home), workshop, branch);

  if (fs.existsSync(worktreeDir)) {
    throw new Error(
      `Worktree directory already exists: ${worktreeDir}. ` +
      `Writ ${writId} may already have an active worktree.`,
    );
  }

  // Create parent directory
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  // Create branch and worktree in one operation
  // git worktree add -b <branch> <path> <base>
  git(['worktree', 'add', '-b', branch, worktreeDir, baseBranch], bareRepo);

  return { path: worktreeDir, branch, writId };
}

/**
 * Remove a worktree after a writ session completes.
 *
 * Removes the worktree directory and prunes it from git's tracking.
 * Does NOT delete the branch — the branch should be kept for history
 * until explicitly merged or pruned.
 */
export function teardownWorktree(home: string, workshop: string, writId: string): void {
  const bareRepo = workshopBarePath(home, workshop);
  const branch = `writ-${writId}`;
  const worktreeDir = path.join(worktreesPath(home), workshop, branch);

  if (!fs.existsSync(worktreeDir)) {
    throw new Error(
      `Worktree not found: ${worktreeDir}. Writ ${writId} may not have an active worktree.`,
    );
  }

  // Remove the worktree (--force handles untracked/modified files left by agents)
  git(['worktree', 'remove', '--force', worktreeDir], bareRepo);

  // Clean up the workshop worktree directory if empty
  const workshopDir = path.join(worktreesPath(home), workshop);
  if (fs.existsSync(workshopDir) && fs.readdirSync(workshopDir).length === 0) {
    fs.rmdirSync(workshopDir);
  }
}

/**
 * List active writ worktrees.
 */
export function listWorktrees(home: string, workshop?: string): WorktreeResult[] {
  const wtRoot = worktreesPath(home);

  if (!fs.existsSync(wtRoot)) return [];

  // If a specific workshop is given, only list worktrees for that workshop
  const workshopDirs = workshop
    ? [workshop]
    : fs.readdirSync(wtRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

  const results: WorktreeResult[] = [];

  for (const ws of workshopDirs) {
    const wsDir = path.join(wtRoot, ws);
    if (!fs.existsSync(wsDir)) continue;

    for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      // Match both new writ- and legacy commission- prefixes
      const writMatch = entry.name.match(/^writ-(.+)$/);
      const legacyMatch = entry.name.match(/^commission-(.+)$/);
      const match = writMatch ?? legacyMatch;
      if (!match) continue;

      results.push({
        path: path.join(wsDir, entry.name),
        branch: entry.name,
        writId: match[1]!,
      });
    }
  }

  return results;
}

/**
 * Lightweight git helper — typed wrapper around child_process.execFile.
 *
 * All git operations in the Scriptorium go through this module for
 * safety (no shell injection) and consistent error handling.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

interface GitResult {
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Run a git command with typed error handling.
 *
 * @param args - git subcommand and arguments (e.g. ['clone', '--bare', url])
 * @param cwd - working directory for the command
 */
export async function git(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stderr?: string; code?: number | null; message?: string };
    throw new GitError(
      `git ${args[0]} failed: ${e.stderr || e.message || 'unknown error'}`,
      ['git', ...args],
      e.stderr ?? '',
      e.code ?? null,
    );
  }
}

/**
 * Resolve the default branch of a bare clone by reading HEAD.
 *
 * Returns the branch name (e.g. 'main'), not the full ref.
 */
export async function resolveDefaultBranch(bareClonePath: string): Promise<string> {
  const { stdout } = await git(['symbolic-ref', 'HEAD'], bareClonePath);
  // stdout is e.g. 'refs/heads/main'
  return stdout.replace('refs/heads/', '');
}

/**
 * Get the commit SHA at the tip of a branch in a bare clone.
 */
export async function resolveRef(bareClonePath: string, ref: string): Promise<string> {
  const { stdout } = await git(['rev-parse', ref], bareClonePath);
  return stdout;
}

/**
 * Check if a branch has commits ahead of another branch.
 * Returns the number of commits ahead.
 */
export async function commitsAhead(
  bareClonePath: string,
  branch: string,
  base: string,
): Promise<number> {
  const { stdout } = await git(
    ['rev-list', '--count', `${base}..${branch}`],
    bareClonePath,
  );
  return parseInt(stdout, 10);
}

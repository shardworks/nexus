import fs from 'node:fs';
import path from 'node:path';

/**
 * Find the guild root by walking up from a starting directory looking for guild.json.
 *
 * This replaces the old NEXUS_HOME env var approach. The guild root IS the
 * guildhall — a regular git clone with guild.json at the root.
 *
 * @param startDir - Directory to start searching from (defaults to cwd).
 * @throws If no guild.json is found before reaching the filesystem root.
 */
export function findGuildRoot(startDir?: string): string {
  let dir = path.resolve(startDir ?? process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, 'guild.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        'Not inside a guild. Run `nexus init` to create one, or use --guild-root.',
      );
    }
    dir = parent;
  }
}

/** Path to the .nexus framework-managed directory. */
export function nexusDir(home: string): string {
  return path.join(home, '.nexus');
}

/** Path to the guild's Books SQLite database (Register, Ledger, Daybook, Clockworks). */
export function booksPath(home: string): string {
  return path.join(home, '.nexus', 'nexus.db');
}

/** @deprecated Use booksPath() instead. */
export function ledgerPath(home: string): string {
  return booksPath(home);
}

/** Path to the top-level worktrees directory (for commission worktrees). */
export function worktreesPath(home: string): string {
  return path.join(home, '.nexus', 'worktrees');
}

/** Path to the workshops directory (contains bare clones). */
export function workshopsPath(home: string): string {
  return path.join(home, '.nexus', 'workshops');
}

/** Path to a specific workshop's bare clone. */
export function workshopBarePath(home: string, name: string): string {
  return path.join(home, '.nexus', 'workshops', `${name}.git`);
}

/** Path to the clockworks daemon PID file. */
export function clockPidPath(home: string): string {
  return path.join(home, '.nexus', 'clock.pid');
}

/** Path to the clockworks daemon log file. */
export function clockLogPath(home: string): string {
  return path.join(home, '.nexus', 'clock.log');
}

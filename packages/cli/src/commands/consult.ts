/**
 * consult command
 *
 * Starts an interactive Claude session with a guild member (anima).
 * The anima is identified by role (positional) or by name (--name flag).
 *
 * Uses the unified session funnel in core for setup, metrics, and cleanup.
 */
import { createCommand } from 'commander';
import Database from 'better-sqlite3';
import { manifest, launchSession, ledgerPath } from '@shardworks/nexus-core';
import type { ResolvedWorkspace } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

/**
 * Look up the name of the first active anima holding a given role.
 *
 * If multiple animas share the role, one is selected arbitrarily (lowest id).
 * Throws if no active anima holds the role.
 */
export function resolveAnimaByRole(home: string, role: string): string {
  const db = new Database(ledgerPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const row = db.prepare(`
      SELECT a.name FROM animas a
      JOIN roster r ON r.anima_id = a.id
      WHERE r.role = ? AND a.status = 'active'
      ORDER BY a.id ASC
      LIMIT 1
    `).get(role) as { name: string } | undefined;

    if (!row) {
      throw new Error(`No active anima found for role "${role}".`);
    }
    return row.name;
  } finally {
    db.close();
  }
}

export function makeConsultCommand() {
  return createCommand('consult')
    .description('Start an interactive consultation with a guild member')
    .argument('[role]', 'Role to consult (finds the active anima holding this role)')
    .option('--name <anima>', 'Consult by anima name directly, bypassing role lookup')
    .action(async (role: string | undefined, options: { name?: string }, cmd) => {
      const home = resolveHome(cmd);

      if (!role && !options.name) {
        cmd.help();
        return;
      }

      if (role && options.name) {
        console.error('Error: provide a role argument or --name, not both.');
        process.exitCode = 1;
        return;
      }

      // Resolve anima name
      let animaName: string;
      try {
        animaName = options.name
          ? options.name
          : resolveAnimaByRole(home, role!);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // Manifest the anima (system prompt + tools)
      let result: Awaited<ReturnType<typeof manifest>>;
      try {
        result = await manifest(home, animaName);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Consulting ${result.anima.name} (${result.anima.roles.join(', ')})...\n`);

      // Workspace: guildhall for now (future: --workshop flag)
      const workspace: ResolvedWorkspace = { kind: 'guildhall' };

      try {
        await launchSession({
          home,
          manifest: result,
          prompt: null,
          interactive: true,
          workspace,
          trigger: 'consult',
        });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

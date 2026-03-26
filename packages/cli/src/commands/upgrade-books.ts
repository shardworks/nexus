import path from 'node:path';
import { createCommand } from 'commander';
import { findGuildRoot, applyCoreMigrations } from '@shardworks/nexus-core';

export function makeUpgradeBooksCommand() {
  return createCommand('upgrade-books')
    .description('Apply pending database migrations to the Books')
    .action((_opts, cmd) => {
      let home: string;
      try {
        const rootOpts = cmd.optsWithGlobals() as { guildRoot?: string };
        home = rootOpts.guildRoot
          ? path.resolve(rootOpts.guildRoot)
          : findGuildRoot();
      } catch {
        console.error('Not inside a guild. Run `nsg init` to create one, or use --guild-root.');
        process.exit(1);
      }

      const result = applyCoreMigrations(home);

      if (result.applied.length === 0) {
        console.log('Books are up to date. No pending migrations.');
        return;
      }

      console.log(`Applied ${result.applied.length} migration(s):`);
      for (const name of result.applied) {
        console.log(`  ✓ ${name}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} already-applied migration(s).`);
      }
    });
}

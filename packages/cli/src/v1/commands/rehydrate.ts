import { createCommand } from 'commander';
import { rehydrate } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeRestoreCommand() {
  return createCommand('restore')
    .description('Restore runtime state from git-tracked guild state (after fresh clone)')
    .action((_options: Record<string, unknown>, cmd) => {
      const home = resolveHome(cmd);

      try {
        const result = rehydrate(home);

        // Workshop results
        for (const name of result.workshopsCloned) {
          console.log(`Cloned workshop "${name}" from remote`);
        }
        for (const { name, error } of result.workshopsFailed) {
          console.log(`✗ Failed to clone workshop "${name}": ${error}`);
        }

        // Tool results
        if (result.fromPackageJson > 0) {
          console.log(`Restored ${result.fromPackageJson} package(s) from package.json`);
        }
        for (const name of result.fromSlotSource) {
          console.log(`Restored "${name}" from on-disk source`);
        }
        if (result.needsRelink.length > 0) {
          console.log('\nThe following linked tools need manual re-linking:');
          for (const name of result.needsRelink) {
            console.log(`  - ${name}`);
          }
        }

        const totalWork = result.workshopsCloned.length + result.workshopsFailed.length +
          result.fromPackageJson + result.fromSlotSource.length + result.needsRelink.length;
        if (totalWork === 0) {
          console.log('Nothing to restore.');
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

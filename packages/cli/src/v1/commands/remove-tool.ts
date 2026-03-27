import { createCommand } from 'commander';
import { removeTool } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeRemoveToolCommand() {
  return createCommand('remove')
    .description('Remove a tool, engine, curriculum, or temperament from the guild')
    .argument('<name>', 'Name of the tool to remove')
    .option('--type <type>', 'Restrict to a specific category (implements, engines, curricula, temperaments)')
    .action((name: string, options: { type?: string }, cmd) => {
      const home = resolveHome(cmd);
      const validTypes = ['tools', 'engines', 'curricula', 'temperaments'] as const;
      let category: typeof validTypes[number] | undefined;

      if (options.type) {
        if (!validTypes.includes(options.type as typeof validTypes[number])) {
          console.error(`Error: --type must be one of: ${validTypes.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        category = options.type as typeof validTypes[number];
      }

      const result = removeTool({ home, name, category });
      console.log(`Removed ${result.category.slice(0, -1)} "${result.name}"`);
    });
}

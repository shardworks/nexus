import { createCommand } from 'commander';
import { listTools } from '@shardworks/nexus-core';
import { makeInstallToolCommand } from './install-tool.ts';
import { makeRemoveToolCommand } from './remove-tool.ts';
import { resolveHome } from '../resolve-home.ts';

export function makeToolCommand() {
  const tool = createCommand('tool')
    .description('Manage guild tools (implements, engines, curricula, temperaments)');

  tool.addCommand(makeInstallToolCommand());
  tool.addCommand(makeRemoveToolCommand());

  // nsg tool list [--category <category>]
  tool.addCommand(
    createCommand('list')
      .description('List installed tools, engines, curricula, and temperaments')
      .option('--category <category>', 'Filter by category (tools, engines, curricula, temperaments)')
      .action((options: { category?: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listTools(home, options.category);

          if (items.length === 0) {
            console.log('No artifacts installed.');
            return;
          }

          // Group by category
          const grouped = new Map<string, typeof items>();
          for (const item of items) {
            if (!grouped.has(item.category)) grouped.set(item.category, []);
            grouped.get(item.category)!.push(item);
          }

          for (const [category, items] of grouped) {
            console.log(`${category}:`);
            for (const item of items) {
              const source = item.upstream ?? 'local';
              const bundleLabel = item.bundle ? ` (via ${item.bundle})` : '';
              console.log(`  ${item.name}  ${source}${bundleLabel}`);
            }
            console.log();
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return tool;
}

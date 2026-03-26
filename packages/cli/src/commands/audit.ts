import { createCommand } from 'commander';
import { listAuditLog } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeAuditCommand() {
  const cmd = createCommand('audit')
    .description('View audit log');

  // nsg audit list [--actor <name>] [--action <action>] [--target <type>] [--limit <n>]
  cmd.addCommand(
    createCommand('list')
      .description('List audit log entries')
      .option('--actor <name>', 'Filter by actor')
      .option('--action <action>', 'Filter by action')
      .option('--target <type>', 'Filter by target type')
      .option('--target-id <id>', 'Filter by target ID')
      .option('--limit <n>', 'Maximum number of results', '20')
      .action((options: { actor?: string; action?: string; target?: string; targetId?: string; limit: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listAuditLog(home, {
            actor: options.actor,
            action: options.action,
            targetType: options.target,
            targetId: options.targetId,
            limit: parseInt(options.limit, 10),
          });

          if (items.length === 0) {
            console.log('No audit entries found.');
            return;
          }

          console.log(`${items.length} audit entr${items.length === 1 ? 'y' : 'ies'}:\n`);
          for (const a of items) {
            const target = a.targetType ? ` ${a.targetType}:${a.targetId}` : '';
            console.log(`  ${a.timestamp}  ${a.actor}  ${a.action}${target}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

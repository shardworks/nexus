import { createCommand } from 'commander';
import { listDispatches } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeDispatchCommand() {
  const cmd = createCommand('dispatch')
    .description('View event dispatch history');

  // nsg dispatch list [--event <id>] [--status <status>] [--limit <n>]
  cmd.addCommand(
    createCommand('list')
      .description('List event dispatches')
      .option('--event <id>', 'Filter by event ID')
      .option('--handler <name>', 'Filter by handler name')
      .option('--status <status>', 'Filter by status (success, error)')
      .option('--limit <n>', 'Maximum number of results', '20')
      .action((options: { event?: string; handler?: string; status?: string; limit: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listDispatches(home, {
            eventId: options.event,
            handlerName: options.handler,
            status: options.status,
            limit: parseInt(options.limit, 10),
          });

          if (items.length === 0) {
            console.log('No dispatches found.');
            return;
          }

          console.log(`${items.length} dispatch${items.length === 1 ? '' : 'es'}:\n`);
          for (const d of items) {
            const status = d.status ?? 'unknown';
            const errorLabel = d.error ? ` — ${d.error}` : '';
            console.log(`  ${d.id}  [${status}]  ${d.handlerType}:${d.handlerName}  event:${d.eventId}${errorLabel}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

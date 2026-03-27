import { createCommand } from 'commander';
import { listEvents, readEvent } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeEventCommand() {
  const cmd = createCommand('event')
    .description('View event history');

  // nsg event list [--name <pattern>] [--emitter <name>] [--pending] [--limit <n>]
  cmd.addCommand(
    createCommand('list')
      .description('List events')
      .option('--name <pattern>', 'Filter by event name (SQL LIKE pattern, use % for wildcards)')
      .option('--emitter <name>', 'Filter by emitter')
      .option('--pending', 'Show only unprocessed events')
      .option('--limit <n>', 'Maximum number of results', '20')
      .action((options: { name?: string; emitter?: string; pending?: boolean; limit: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listEvents(home, {
            name: options.name,
            emitter: options.emitter,
            pending: options.pending ? true : undefined,
            limit: parseInt(options.limit, 10),
          });

          if (items.length === 0) {
            console.log('No events found.');
            return;
          }

          console.log(`${items.length} event${items.length === 1 ? '' : 's'}:\n`);
          for (const e of items) {
            console.log(`  ${e.id}  ${e.name}  (${e.emitter})  ${e.firedAt}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg event show <id>
  cmd.addCommand(
    createCommand('show')
      .description('Show details of an event')
      .argument('<id>', 'Event ID')
      .action((id: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const e = readEvent(home, id);
          if (!e) {
            console.error(`Event "${id}" not found.`);
            process.exitCode = 1;
            return;
          }

          console.log(`Event ${e.id}`);
          console.log(`  Name:    ${e.name}`);
          console.log(`  Emitter: ${e.emitter}`);
          console.log(`  Fired:   ${e.firedAt}`);
          if (e.payload) {
            console.log(`  Payload: ${JSON.stringify(e.payload, null, 2)}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

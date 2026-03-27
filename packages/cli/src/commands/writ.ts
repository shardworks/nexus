import { createCommand } from 'commander';
import {
  createWrit, readWrit, listWrits, failWrit, cancelWrit,
  getWritChildren, readGuildConfig, signalEvent,
  interruptWrit,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeWritCommand() {
  const cmd = createCommand('writ')
    .description('Manage writs');

  // nsg writ post <spec> --workshop <name>
  // nsg writ post <spec> --no-workshop
  const postCmd = createCommand('post')
    .description('Post a new writ to the guild')
    .argument('<spec>', 'Writ specification — what needs to be done')
    .option('--workshop <workshop>', 'Target workshop (workspace-bound work)')
    .option('--no-workshop', 'Knowledge/planning work (no workspace)')
    .option('--type <type>', 'Writ type (default: uses first declared type or "summon")')
    .action((spec: string, options: { workshop?: string | boolean; type?: string }, cmd) => {
      const home = resolveHome(cmd);
      try {
        // Validate workshop option: one of --workshop <name> or --no-workshop required
        const workshop = options.workshop;
        if (workshop === undefined) {
          console.error('Error: specify --workshop <name> for workspace-bound work, or --no-workshop for knowledge/planning work.');
          process.exitCode = 1;
          return;
        }

        // --no-workshop sets workshop to false
        const workshopName = workshop === false ? undefined : (workshop as string);

        // Validate workshop exists if provided
        if (workshopName) {
          const config = readGuildConfig(home);
          if (!(workshopName in config.workshops)) {
            const available = Object.keys(config.workshops).join(', ') || '(none)';
            console.error(`Error: Workshop "${workshopName}" not found in guild.json. Available: ${available}`);
            process.exitCode = 1;
            return;
          }
        }

        // Resolve type
        const type = options.type ?? resolveDefaultWritType(home);

        const title = spec.split('\n')[0]!.substring(0, 200);
        const writ = createWrit(home, {
          type,
          title,
          description: spec,
          workshop: workshopName,
          sourceType: 'patron',
        });

        // Signal writ.posted for the Clockworks
        signalEvent(home, 'writ.posted', {
          writId: writ.id,
          workshop: writ.workshop,
        }, 'framework');

        console.log(`Writ ${writ.id} posted${writ.workshop ? ` to workshop "${writ.workshop}"` : ' (no workspace)'}`);
        console.log(`  Run \`nsg clock run\` to process through Clockworks.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  cmd.addCommand(postCmd);

  // nsg writ list [--type <type>] [--status <status>] [--parent <id>] [--workshop <name>]
  cmd.addCommand(
    createCommand('list')
      .description('List writs')
      .option('--type <type>', 'Filter by writ type')
      .option('--status <status>', 'Filter by status')
      .option('--parent <id>', 'Filter by parent writ ID')
      .option('--workshop <workshop>', 'Filter by workshop')
      .action((options: { type?: string; status?: string; parent?: string; workshop?: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listWrits(home, {
            type: options.type,
            status: options.status as any,
            parentId: options.parent,
            workshop: options.workshop,
          });

          if (items.length === 0) {
            console.log('No writs found.');
            return;
          }

          console.log(`${items.length} writ${items.length === 1 ? '' : 's'}:\n`);
          for (const w of items) {
            const workshopLabel = w.workshop ? w.workshop : 'no-workspace';
            console.log(`  ${w.id}  [${w.status}]  ${w.type}  ${workshopLabel}`);
            console.log(`    ${w.title}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg writ show <id>
  cmd.addCommand(
    createCommand('show')
      .description('Show details of a writ')
      .argument('<id>', 'Writ ID')
      .action((id: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const writ = readWrit(home, id);
          if (!writ) {
            console.error(`Writ "${id}" not found.`);
            process.exitCode = 1;
            return;
          }

          console.log(`Writ ${writ.id}`);
          console.log(`  Type:      ${writ.type}`);
          console.log(`  Status:    ${writ.status}`);
          console.log(`  Workshop:  ${writ.workshop ?? '(none)'}`);
          console.log(`  Source:    ${writ.sourceType}${writ.sourceId ? ` (${writ.sourceId})` : ''}`);
          if (writ.parentId) console.log(`  Parent:    ${writ.parentId}`);
          if (writ.sessionId) console.log(`  Session:   ${writ.sessionId}`);
          console.log(`  Created:   ${writ.createdAt}`);
          console.log(`  Updated:   ${writ.updatedAt}`);
          console.log(`  Title:     ${writ.title}`);
          if (writ.description) {
            console.log(`  Description:`);
            console.log(`    ${writ.description.split('\n').join('\n    ')}`);
          }

          const children = getWritChildren(home, id);
          if (children.length > 0) {
            console.log(`\n  Children (${children.length}):`);
            for (const c of children) {
              const suffix = c.childCount > 0
                ? `(${c.completedCount}/${c.childCount} sub-items done)`
                : '';
              console.log(`    ${c.id}  [${c.status}]  ${c.type}  ${c.title} ${suffix}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg writ update <id> --action <fail|cancel|reopen>
  cmd.addCommand(
    createCommand('update')
      .description('Update a writ status')
      .argument('<id>', 'Writ ID')
      .requiredOption('--action <action>', 'Action: fail, cancel, or reopen')
      .action((id: string, options: { action: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          switch (options.action) {
            case 'fail':
              failWrit(home, id);
              console.log(`Writ ${id} failed.`);
              break;
            case 'cancel':
              cancelWrit(home, id);
              console.log(`Writ ${id} cancelled.`);
              break;
            case 'reopen':
              interruptWrit(home, id);
              console.log(`Writ ${id} reopened (status: ready).`);
              break;
            default:
              console.error(`Error: unknown action "${options.action}". Use: fail, cancel, reopen.`);
              process.exitCode = 1;
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

/**
 * Resolve a sensible default writ type. Looks for the first declared
 * writType in guild.json; falls back to 'summon'.
 */
function resolveDefaultWritType(home: string): string {
  const config = readGuildConfig(home);
  const declared = Object.keys(config.writTypes ?? {});
  return declared.length > 0 ? declared[0]! : 'summon';
}

import { createCommand } from 'commander';
import {
  commission, showCommission, updateCommissionStatus, listCommissions,
  checkCommissionCompletion,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeCommissionCommand() {
  const cmd = createCommand('commission')
    .description('Manage commissions');

  // nsg commission create <spec> --workshop <name>
  const createCmd = createCommand('create')
    .description('Post a commission to the guild')
    .argument('<spec>', 'Commission specification — what needs to be done')
    .requiredOption('--workshop <workshop>', 'Target workshop')
    .action((spec: string, options: { workshop: string }, cmd) => {
      const home = resolveHome(cmd);
      try {
        const result = commission({ home, spec, workshop: options.workshop });
        console.log(`Commission ${result.commissionId} posted to workshop "${options.workshop}"`);
        console.log(`  Run \`nsg clock run\` to process through Clockworks.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  cmd.addCommand(createCmd);

  // nsg commission list [--status <status>] [--workshop <workshop>]
  cmd.addCommand(
    createCommand('list')
      .description('List commissions')
      .option('--status <status>', 'Filter by status')
      .option('--workshop <workshop>', 'Filter by workshop')
      .action((options: { status?: string; workshop?: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listCommissions(home, options);

          if (items.length === 0) {
            console.log('No commissions found.');
            return;
          }

          console.log(`${items.length} commission${items.length === 1 ? '' : 's'}:\n`);
          for (const c of items) {
            const summary = c.content.length > 60 ? c.content.slice(0, 60) + '...' : c.content;
            console.log(`  ${c.id}  [${c.status}]  ${c.workshop}`);
            console.log(`    ${summary}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg commission show <id>
  cmd.addCommand(
    createCommand('show')
      .description('Show details of a commission (including assignments and sessions)')
      .argument('<id>', 'Commission ID')
      .action((id: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const result = showCommission(home, id);
          if (!result) {
            console.error(`Commission "${id}" not found.`);
            process.exitCode = 1;
            return;
          }

          console.log(`Commission ${result.id}`);
          console.log(`  Status:   ${result.status}`);
          if (result.statusReason) console.log(`  Reason:   ${result.statusReason}`);
          console.log(`  Workshop: ${result.workshop}`);
          console.log(`  Created:  ${result.createdAt}`);
          console.log(`  Updated:  ${result.updatedAt}`);
          console.log(`  Content:  ${result.content}`);

          if (result.assignments.length > 0) {
            console.log(`\n  Assignments:`);
            for (const a of result.assignments) {
              console.log(`    ${a.animaName} (${a.animaId}) — assigned ${a.assignedAt}`);
            }
          }

          if (result.sessions.length > 0) {
            console.log(`\n  Sessions:`);
            for (const s of result.sessions) {
              const status = s.endedAt ? `ended ${s.endedAt}` : 'active';
              console.log(`    ${s.sessionId}  ${s.animaId}  started ${s.startedAt}  ${status}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg commission check <id>
  cmd.addCommand(
    createCommand('check')
      .description('Check work completion for a commission')
      .argument('<id>', 'Commission ID')
      .action((id: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const check = checkCommissionCompletion(home, id);
          console.log(`Commission ${id} — work completion:`);
          console.log(`  Total:   ${check.total}`);
          console.log(`  Done:    ${check.done}`);
          console.log(`  Pending: ${check.pending}`);
          console.log(`  Failed:  ${check.failed}`);
          console.log(`  Complete: ${check.complete ? 'yes' : 'no'}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg commission update <id> --status <status> --reason <reason>
  cmd.addCommand(
    createCommand('update')
      .description('Update a commission\'s status')
      .argument('<id>', 'Commission ID')
      .requiredOption('--status <status>', 'New status')
      .requiredOption('--reason <reason>', 'Reason for status change')
      .action((id: string, options: { status: string; reason: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          updateCommissionStatus(home, id, options.status, options.reason);
          console.log(`Commission ${id} updated to "${options.status}".`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

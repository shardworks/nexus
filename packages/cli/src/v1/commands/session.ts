import { createCommand } from 'commander';
import { listSessions, showSession } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeSessionCommand() {
  const cmd = createCommand('session')
    .description('View session history');

  // nsg session list [--anima <name>] [--workshop <name>] [--trigger <type>] [--limit <n>]
  cmd.addCommand(
    createCommand('list')
      .description('List sessions')
      .option('--anima <name>', 'Filter by anima name or ID')
      .option('--workshop <name>', 'Filter by workshop')
      .option('--trigger <type>', 'Filter by trigger type (consult, summon, brief)')
      .option('--status <status>', 'Filter by status (active, completed)')
      .option('--limit <n>', 'Maximum number of results', '20')
      .action((options: { anima?: string; workshop?: string; trigger?: string; status?: string; limit: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const items = listSessions(home, {
            anima: options.anima,
            workshop: options.workshop,
            trigger: options.trigger,
            status: options.status as 'active' | 'completed' | undefined,
            limit: parseInt(options.limit, 10),
          });

          if (items.length === 0) {
            console.log('No sessions found.');
            return;
          }

          console.log(`${items.length} session${items.length === 1 ? '' : 's'}:\n`);
          for (const s of items) {
            const duration = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : 'running';
            const cost = s.costUsd !== null ? `$${s.costUsd.toFixed(4)}` : '';
            const status = s.endedAt ? `exit:${s.exitCode}` : 'active';
            console.log(`  ${s.id}  [${s.trigger}]  ${s.animaId}  ${duration}  ${cost}  ${status}`);
            if (s.workshop) console.log(`    workshop: ${s.workshop}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg session show <id>
  cmd.addCommand(
    createCommand('show')
      .description('Show details of a session')
      .argument('<id>', 'Session ID')
      .action((id: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const s = showSession(home, id);
          if (!s) {
            console.error(`Session "${id}" not found.`);
            process.exitCode = 1;
            return;
          }

          console.log(`Session ${s.id}`);
          console.log(`  Anima:     ${s.animaId}`);
          console.log(`  Provider:  ${s.provider}`);
          console.log(`  Trigger:   ${s.trigger}`);
          if (s.workshop) console.log(`  Workshop:  ${s.workshop}`);
          console.log(`  Workspace: ${s.workspaceKind}`);
          if (s.roles.length > 0) console.log(`  Roles:     ${s.roles.join(', ')}`);
          console.log(`  Started:   ${s.startedAt}`);
          if (s.endedAt) console.log(`  Ended:     ${s.endedAt}`);
          if (s.exitCode !== null) console.log(`  Exit code: ${s.exitCode}`);
          if (s.durationMs !== null) console.log(`  Duration:  ${(s.durationMs / 1000).toFixed(1)}s`);
          if (s.inputTokens !== null || s.outputTokens !== null) {
            console.log(`  Tokens:    ${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out`);
            if (s.cacheReadTokens || s.cacheWriteTokens) {
              console.log(`             ${s.cacheReadTokens ?? 0} cache read / ${s.cacheWriteTokens ?? 0} cache write`);
            }
          }
          if (s.costUsd !== null) console.log(`  Cost:      $${s.costUsd.toFixed(4)}`);
          if (s.providerSessionId) console.log(`  Provider session: ${s.providerSessionId}`);
          if (s.recordPath) console.log(`  Record:    ${s.recordPath}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return cmd;
}

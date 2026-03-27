import { createCommand } from 'commander';
import {
  instantiate, manifest,
  listAnimas, showAnima, updateAnima, removeAnima,
  checkAnimaStaleness, checkAllAnimaStaleness,
} from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

export function makeAnimaCommand() {
  const anima = createCommand('anima')
    .description('Manage animas');

  // nsg anima create <name> --roles <roles>
  anima.addCommand(
    createCommand('create')
      .description('Create a new anima in the guild')
      .argument('<name>', 'Name for the new anima')
      .requiredOption('--roles <roles>', 'Comma-separated roles (e.g. artificer,sage)')
      .option('--curriculum <curriculum>', 'Curriculum to assign')
      .option('--temperament <temperament>', 'Temperament to assign')
      .action((name: string, options: { roles: string; curriculum?: string; temperament?: string }, cmd) => {
        const home = resolveHome(cmd);
        const roles = options.roles.split(',').map(r => r.trim()).filter(Boolean);

        if (roles.length === 0) {
          console.error('Error: at least one role is required');
          process.exitCode = 1;
          return;
        }

        try {
          const result = instantiate({
            home, name, roles,
            curriculum: options.curriculum,
            temperament: options.temperament,
          });

          console.log(`Anima "${result.name}" created (id: ${result.animaId})`);
          console.log(`  Roles: ${result.roles.join(', ')}`);
          if (result.curriculum) console.log(`  Curriculum: ${result.curriculum}`);
          if (result.temperament) console.log(`  Temperament: ${result.temperament}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg anima list [--status <status>] [--role <role>]
  anima.addCommand(
    createCommand('list')
      .description('List animas in the guild')
      .option('--status <status>', 'Filter by status (aspirant, active, retired)')
      .option('--role <role>', 'Filter by role')
      .action((options: { status?: string; role?: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const animas = listAnimas(home, options);

          if (animas.length === 0) {
            console.log('No animas found.');
            return;
          }

          // Check staleness for all active animas in one pass
          const stalenessMap = checkAllAnimaStaleness(home);

          console.log(`${animas.length} anima${animas.length === 1 ? '' : 's'}:\n`);
          for (const a of animas) {
            const staleness = stalenessMap.get(a.id);
            const statusIcon = a.status === 'active' ? '●' : a.status === 'retired' ? '○' : '◌';
            const staleFlag = staleness ? ' ⚠ stale' : '';
            console.log(`  ${statusIcon} ${a.name} [${a.id}]${staleFlag}`);
            console.log(`    Roles: ${a.roles.join(', ')}`);
            if (staleness?.curriculum) {
              console.log(`    Curriculum: ${staleness.curriculum.composedVersion} → ${staleness.curriculum.currentVersion} available`);
            }
            if (staleness?.temperament) {
              console.log(`    Temperament: ${staleness.temperament.composedVersion} → ${staleness.temperament.currentVersion} available`);
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg anima show <name>
  anima.addCommand(
    createCommand('show')
      .description('Show detailed information about an anima')
      .argument('<name>', 'Anima ID or name')
      .action((name: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          const result = showAnima(home, name);
          if (!result) {
            console.error(`Anima "${name}" not found.`);
            process.exitCode = 1;
            return;
          }

          const staleness = result.status === 'active'
            ? checkAnimaStaleness(home, result.id)
            : null;

          console.log(`${result.name} [${result.id}]`);
          console.log(`  Status: ${result.status}${staleness?.stale ? ' ⚠ stale composition' : ''}`);
          console.log(`  Roles: ${result.roles.join(', ')}`);
          if (result.curriculumName) {
            const currStale = staleness?.curriculum;
            const currLabel = currStale
              ? ` (${currStale.composedVersion} → ${currStale.currentVersion} available)`
              : '';
            console.log(`  Curriculum: ${result.curriculumName} v${result.curriculumVersion}${currLabel}`);
          }
          if (result.temperamentName) {
            const tempStale = staleness?.temperament;
            const tempLabel = tempStale
              ? ` (${tempStale.composedVersion} → ${tempStale.currentVersion} available)`
              : '';
            console.log(`  Temperament: ${result.temperamentName} v${result.temperamentVersion}${tempLabel}`);
          }
          console.log(`  Created: ${result.createdAt}`);
          console.log(`  Updated: ${result.updatedAt}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg anima update <name> [--status <status>] [--roles <roles>]
  anima.addCommand(
    createCommand('update')
      .description('Update an anima\'s status or roles')
      .argument('<name>', 'Anima ID or name')
      .option('--status <status>', 'New status (aspirant, active, retired)')
      .option('--roles <roles>', 'New roles (comma-separated, replaces all)')
      .action((name: string, options: { status?: string; roles?: string }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const roles = options.roles?.split(',').map(r => r.trim()).filter(Boolean);
          const result = updateAnima(home, name, { status: options.status, roles });
          console.log(`Anima "${result.name}" updated.`);
          console.log(`  Status: ${result.status}`);
          console.log(`  Roles: ${result.roles.join(', ')}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg anima remove <name>
  anima.addCommand(
    createCommand('remove')
      .description('Remove (retire) an anima from the guild')
      .argument('<name>', 'Anima ID or name')
      .action((name: string, _, cmd) => {
        const home = resolveHome(cmd);
        try {
          removeAnima(home, name);
          console.log(`Anima "${name}" removed.`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  // nsg anima manifest <name> — special debug/inspect verb
  anima.addCommand(
    createCommand('manifest')
      .description('Resolve an anima\'s composition and show session config')
      .argument('<anima>', 'Anima name to manifest')
      .option('--json', 'Output full session config as JSON')
      .action(async (animaName: string, options: { json?: boolean }, cmd) => {
        const home = resolveHome(cmd);
        try {
          const result = await manifest(home, animaName);
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Anima: ${result.anima.name} (${result.anima.roles.join(', ')})`);
            console.log(`Tools: ${result.tools.map(i => i.name).join(', ')}`);
            console.log(`System prompt: ${result.systemPrompt.length} chars`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );

  return anima;
}

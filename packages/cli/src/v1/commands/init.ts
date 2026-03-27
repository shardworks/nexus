import { createCommand } from 'commander';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { initGuild, installBundle, instantiate, applyCoreMigrations } from '@shardworks/nexus-core';

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_BUNDLE = '@shardworks/guild-starter-kit';

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

/**
 * Fetch a bundle package into the guild's node_modules (without saving to package.json),
 * and return the path to the installed bundle directory.
 */
function fetchBundle(home: string, bundleSpec: string): string {
  execFileSync('npm', ['install', '--no-save', bundleSpec], { cwd: home, stdio: 'pipe' });

  // Resolve the installed package name from the specifier
  // Strip version range: "@scope/name@^1.0" → "@scope/name"
  let packageName = bundleSpec;
  if (packageName.startsWith('@') && packageName.lastIndexOf('@') > 0) {
    packageName = packageName.substring(0, packageName.lastIndexOf('@'));
  } else if (packageName.includes('@') && !packageName.startsWith('@')) {
    packageName = packageName.split('@')[0]!;
  }

  return path.join(home, 'node_modules', packageName);
}

export function makeInitCommand() {
  return createCommand('init')
    .description('Create a new guild — guildhall, directory structure, guild.json, and Ledger')
    .argument('[path]', 'Path for the new guild (interactive prompt if omitted)')
    .option('--model <model>', 'Default model for anima sessions', DEFAULT_MODEL)
    .option('--bundle <spec>', 'Bundle to install (npm specifier or local path)', DEFAULT_BUNDLE)
    .action(async (pathArg: string | undefined, options: { model: string; bundle: string }) => {
      let guildPath: string;
      let guildName: string;

      if (pathArg) {
        guildPath = pathArg;
        guildName = path.basename(path.resolve(pathArg));
      } else {
        const name = await prompt('Guild name');
        if (!name) {
          console.error('Error: guild name is required.');
          process.exitCode = 1;
          return;
        }
        guildPath = name;
        guildName = name;
      }

      const model = options.model;
      const home = path.resolve(guildPath);

      try {
        // 1. Create guild skeleton (git repo, dirs, guild.json)
        initGuild(home, guildName, model);

        // 2. Fetch and install the starter kit bundle
        const bundleDir = fetchBundle(home, options.bundle);
        installBundle({ home, bundleDir, commit: false });

        // 3. Create Books database via core migrations
        applyCoreMigrations(home);

        // 4. Instantiate the starting animas
        instantiate({
          home,
          name: 'Steward',
          roles: ['steward'],
          curriculum: 'guild-operations',
          temperament: 'guide',
        });
        instantiate({
          home,
          name: 'Unnamed Artificer',
          roles: ['artificer'],
          curriculum: 'guild-operations',
          temperament: 'artisan',
        });

        // 5. Commit everything from the bundle install + animas
        execFileSync('git', ['add', '-A'], { cwd: home, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'Install starter kit'], { cwd: home, stdio: 'pipe' });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Guild "${guildName}" created at ${home}`);
      console.log(`\n  cd ${guildPath}`);
      console.log(`  nsg consult steward    # ask your guild steward for help\n`);
    });
}

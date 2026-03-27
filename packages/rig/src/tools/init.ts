/**
 * nsg init — create a new guild.
 *
 * Writes the minimum viable guild: directory structure, guild.json,
 * package.json, .gitignore. Does NOT git init, install bundles, create
 * the database, or instantiate animas — those are separate steps.
 *
 * After init, the user runs `nsg plugin install` to add capabilities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tool, VERSION } from '@shardworks/nexus-core';
import { z } from 'zod';

const DEFAULT_MODEL = 'sonnet';

export default tool({
  name: 'init',
  description: 'Create a new guild — directory structure, guild.json, and package.json',
  allowedContexts: ['cli'],
  params: {
    path: z.string().describe('Directory path for the new guild'),
    name: z.string().optional().describe('Guild name (defaults to directory basename)'),
    model: z.string().optional().describe('Default model for anima sessions (default: sonnet)'),
  },
  handler: async (params, _context) => {
    const home = path.resolve(params.path);
    const name = params.name ?? path.basename(home);
    const model = params.model ?? DEFAULT_MODEL;

    // Validate target
    if (fs.existsSync(home)) {
      const entries = fs.readdirSync(home);
      if (entries.length > 0) {
        throw new Error(`${home} exists and is not empty.`);
      }
    }

    // Create guild root
    fs.mkdirSync(home, { recursive: true });

    // .nexus infrastructure (gitignored)
    fs.mkdirSync(path.join(home, '.nexus'), { recursive: true });

    // Scaffold guild directories
    const dirs = [
      'roles',
      'codex',
    ];
    for (const dir of dirs) {
      const full = path.join(home, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, '.gitkeep'), '');
    }

    // guild.json — clean config with empty plugin list
    const guildConfig = {
      name,
      nexus: VERSION,
      model,
      plugins: [] as string[],
      roles: {} as Record<string, unknown>,
      baseTools: [] as string[],
      tools: {} as Record<string, unknown>,
      engines: {} as Record<string, unknown>,
      workshops: {} as Record<string, unknown>,
      curricula: {} as Record<string, unknown>,
      temperaments: {} as Record<string, unknown>,
    };
    fs.writeFileSync(
      path.join(home, 'guild.json'),
      JSON.stringify(guildConfig, null, 2) + '\n',
    );

    // package.json — makes the guild an npm project so plugins install as deps.
    // If running from a published version, pin @shardworks/nexus so nsg is
    // available in the guild's node_modules/.bin without a global install.
    const dependencies: Record<string, string> = {};
    if (VERSION !== '0.0.0') {
      dependencies['@shardworks/nexus'] = `^${VERSION}`;
    }

    const packageJson = {
      name: `guild-${name}`,
      private: true,
      version: '0.0.0',
      type: 'module',
      dependencies,
    };
    fs.writeFileSync(
      path.join(home, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n',
    );

    // .gitignore
    fs.writeFileSync(
      path.join(home, '.gitignore'),
      ['node_modules/', '.nexus/', ''].join('\n'),
    );

    // codex placeholder
    fs.writeFileSync(path.join(home, 'codex', 'all.md'), '');

    // npm install to get dependencies into node_modules
    if (Object.keys(dependencies).length > 0) {
      execFileSync('npm', ['install'], { cwd: home, stdio: 'pipe' });
    }

    const lines = [
      `Guild "${name}" created at ${home}`,
      '',
      `  cd ${params.path}`,
      '  git init                                        # if you want version control',
      '  nsg plugin install @shardworks/nexus-stdlib     # install standard tools',
      '',
    ];
    return lines.join('\n');
  },
});

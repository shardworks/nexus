import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCommand } from 'commander';
import { VERSION } from '@shardworks/nexus-core';

const require = createRequire(import.meta.url);

interface DepEntry {
  name: string;
  version: string;
}

/**
 * Resolve the installed version of a package by finding its package.json
 * on disk. Works even when the package's `exports` field doesn't expose
 * package.json directly.
 */
function resolvePackageVersion(name: string): string | null {
  try {
    // resolve.paths: null → use Node's normal resolution from this file
    const entryPath = require.resolve(name);
    // Walk up from the resolved entry until we find package.json
    let dir = dirname(entryPath);
    for (let i = 0; i < 10; i++) {
      try {
        const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? null;
      } catch {
        // no package.json at this level — keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // require.resolve failed entirely
  }
  return null;
}

/** Collect installed versions of all @shardworks/* dependencies. */
function collectShardworksDeps(): DepEntry[] {
  const pkg = require('../../package.json');
  const deps: Record<string, string> = pkg.dependencies ?? {};

  return Object.keys(deps)
    .filter((name) => name.startsWith('@shardworks/'))
    .sort()
    .map((name) => {
      const resolved = resolvePackageVersion(name);
      return { name, version: resolved ?? deps[name] };
    });
}

export function makeVersionCommand() {
  return createCommand('version')
    .description('Display CLI version and dependency information')
    .option('--all', 'Include versions of all @shardworks/* dependencies')
    .option('--json', 'Output in JSON format')
    .action((opts: { all?: boolean; json?: boolean }) => {
      if (!opts.all) {
        // Same output as --version flag
        console.log(VERSION);
        return;
      }

      const deps = collectShardworksDeps();

      if (opts.json) {
        console.log(JSON.stringify({ version: VERSION, dependencies: deps }, null, 2));
        return;
      }

      // Human-readable table
      console.log(`nsg v${VERSION}\n`);
      console.log('Dependencies:');

      const nameWidth = Math.max(...deps.map((d) => d.name.length), 4);
      const header = `  ${'Package'.padEnd(nameWidth)}  Version`;
      const separator = `  ${'─'.repeat(nameWidth)}  ${'─'.repeat(12)}`;

      console.log(header);
      console.log(separator);
      for (const dep of deps) {
        console.log(`  ${dep.name.padEnd(nameWidth)}  ${dep.version}`);
      }
    });
}

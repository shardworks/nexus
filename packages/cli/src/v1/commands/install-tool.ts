import { createCommand } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installTool, installBundle, classifySource, isBundleDir } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

/**
 * For registry/git-url sources, npm-install the package (no-save) and check
 * if it contains a bundle manifest. Returns the package dir if bundle, null otherwise.
 */
function detectBundle(home: string, source: string): string | null {
  const sourceKind = classifySource(source, false);
  if (sourceKind !== 'registry' && sourceKind !== 'git-url') return null;

  execFileSync('npm', ['install', '--no-save', source], { cwd: home, stdio: 'pipe' });

  // Resolve package name from specifier
  let packageName = source;
  if (packageName.startsWith('@') && packageName.lastIndexOf('@') > 0) {
    packageName = packageName.substring(0, packageName.lastIndexOf('@'));
  } else if (packageName.includes('@') && !packageName.startsWith('@')) {
    packageName = packageName.split('@')[0]!;
  }

  const packageDir = path.join(home, 'node_modules', packageName);
  return isBundleDir(packageDir) ? packageDir : null;
}

export function makeInstallToolCommand() {
  return createCommand('install')
    .description('Install a tool, engine, curriculum, temperament, or bundle into the guild')
    .argument('<source>', 'Local directory, npm package specifier, tarball path, or bundle')
    .option('--name <name>', 'Override the tool name (defaults to package name or directory name)')
    .option('--roles <roles>', 'Assign to specific roles instead of baseTools (comma-separated)')
    .option('--link', 'Symlink local directory instead of copying (for active development)')
    .action((source: string, options: { name?: string; roles?: string; link?: boolean }, cmd) => {
      const home = resolveHome(cmd);
      const roles = options.roles?.split(',').map(r => r.trim()).filter(Boolean);

      try {
        // Check if the source is a bundle (registry/git-url packages only)
        if (!options.link) {
          const bundleDir = detectBundle(home, source);
          if (bundleDir) {
            const result = installBundle({ home, bundleDir, bundleSource: source });
            console.log(`Installed bundle "${source}" (${result.installed} artifacts)`);
            for (const [category, names] of Object.entries(result.artifacts)) {
              if (names.length > 0) {
                console.log(`  ${category}: ${names.join(', ')}`);
              }
            }
            return;
          }
        }

        // Not a bundle — install as a single tool
        const result = installTool({
          home,
          source,
          name: options.name,
          roles,
          link: options.link,
        });

        console.log(`Installed ${result.category.slice(0, -1)} "${result.name}"`);
        if (result.warnings.length > 0) {
          console.log(`\n  ⚠ Precondition warnings (tool installed but may not be operational):`);
          for (const w of result.warnings) {
            console.log(`    → ${w}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

import { createCommand } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planUpgrade, applyUpgrade, readGuildConfig, writeGuildConfig, clockStatus, clockStop, clockStart } from '@shardworks/nexus-core';
import { resolveHome } from '../resolve-home.ts';

const DEFAULT_BUNDLE = '@shardworks/guild-starter-kit';

/**
 * Fetch a bundle package into a temporary location and return the path.
 * Uses --no-save so it doesn't modify the guild's package.json.
 */
function fetchBundle(home: string, bundleSpec: string): string {
  execFileSync('npm', ['install', '--no-save', bundleSpec], { cwd: home, stdio: 'pipe' });

  // Resolve package name from the specifier
  let packageName = bundleSpec;
  if (packageName.startsWith('@') && packageName.lastIndexOf('@') > 0) {
    packageName = packageName.substring(0, packageName.lastIndexOf('@'));
  } else if (packageName.includes('@') && !packageName.startsWith('@')) {
    packageName = packageName.split('@')[0]!;
  }

  return path.join(home, 'node_modules', packageName);
}

/** Read the resolved version of a package from its installed package.json. */
function installedVersion(home: string, packageName: string): string | null {
  const pkgPath = path.join(home, 'node_modules', packageName, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return (pkg.version as string) ?? null;
}

/** A dependency that was updated by npm. */
interface DependencyUpdate {
  name: string;
  from: string | null;
  to: string | null;
}

/**
 * Update @shardworks/* dependencies to their latest versions.
 *
 * Reads the guild's package.json for @shardworks/* deps, snapshots their
 * current installed versions, runs `npm install <pkg>@latest` for each,
 * then diffs to find what actually changed. This updates both the
 * package.json specifiers and the lockfile.
 */
function updateDependencies(home: string): DependencyUpdate[] {
  // Read the guild's declared dependencies
  const pkgPath = path.join(home, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;

  // Find @shardworks/* packages
  const shardworksDeps = Object.keys(deps).filter(name => name.startsWith('@shardworks/'));
  if (shardworksDeps.length === 0) return [];

  // Snapshot current installed versions
  const before = new Map<string, string | null>();
  for (const name of shardworksDeps) {
    before.set(name, installedVersion(home, name));
  }

  // Install latest versions — this updates both package.json specifiers
  // and the lockfile, unlike `npm update` which only touches the lockfile.
  const specs = shardworksDeps.map(name => `${name}@latest`);
  execFileSync('npm', ['install', ...specs], { cwd: home, stdio: 'pipe' });

  // Diff versions
  const updates: DependencyUpdate[] = [];
  for (const name of shardworksDeps) {
    const fromVersion = before.get(name) ?? null;
    const toVersion = installedVersion(home, name);
    if (fromVersion !== toVersion) {
      updates.push({ name, from: fromVersion, to: toVersion });
    }
  }

  return updates;
}

export function makeUpgradeCommand() {
  return createCommand('upgrade')
    .description('Upgrade the guild to the latest framework version — npm packages, migrations, training content, and stale anima detection')
    .option('--dry-run', 'Show what would change without applying')
    .option('--recompose', 'Retire and recreate stale animas with fresh compositions')
    .option('--bundle <spec>', 'Bundle to upgrade from (npm specifier)', DEFAULT_BUNDLE)
    .action(async (options: { dryRun?: boolean; recompose?: boolean; bundle: string }, cmd) => {
      const home = resolveHome(cmd);

      try {
        const config = readGuildConfig(home);
        console.log(`Guild: ${config.name}`);
        console.log(`Current nexus version: ${config.nexus}`);
        console.log();

        // ── Step 0: Stop daemon before upgrading ─────────────────────
        // Node.js caches ESM imports, so the running daemon must be stopped
        // before packages change. We also don't want the daemon processing
        // events with a half-upgraded package set. Restart in finally{}.

        const wasDaemonRunning = !options.dryRun && clockStatus(home).running;
        if (wasDaemonRunning) {
          clockStop(home);
          console.log('Clockworks daemon stopped for upgrade.');
          console.log();
        }

        try {

        // ── Step 1: Update npm dependencies ──────────────────────────

        console.log('Updating @shardworks/* packages...');
        const depUpdates = options.dryRun ? [] : updateDependencies(home);

        if (depUpdates.length > 0) {
          for (const dep of depUpdates) {
            console.log(`  ↑ ${dep.name}: ${dep.from ?? 'not installed'} → ${dep.to}`);
          }
        } else {
          console.log('  All packages up to date.');
        }
        console.log();

        // ── Step 2: Fetch and plan bundle upgrade ────────────────────

        console.log(`Fetching ${options.bundle}...`);
        const bundleDir = fetchBundle(home, options.bundle);
        console.log();

        // Plan the upgrade
        const plan = planUpgrade(home, bundleDir);

        // ── Report ────────────────────────────────────────────────────

        console.log(`Bundle plan from ${plan.bundleSource}:`);
        console.log();

        // New tools/engines
        if (plan.newTools.length > 0) {
          console.log(`  New tools/engines (${plan.newTools.length}):`);
          for (const t of plan.newTools) {
            const roleLabel = t.roles.length > 0 ? ` → ${t.roles.join(', ')}` : '';
            console.log(`    + ${t.category}/${t.name}${roleLabel}`);
          }
          console.log();
        }

        // Content updates
        if (plan.contentUpdates.length > 0) {
          console.log(`  Content updates (${plan.contentUpdates.length}):`);
          for (const c of plan.contentUpdates) {
            const label = c.category === 'curricula' ? 'curriculum' : 'temperament';
            console.log(`    ↑ ${label}/${c.name}: ${c.installedVersion} → ${c.bundleVersion}`);
          }
          console.log();
        }

        // Stale animas
        if (plan.staleAnimas.length > 0) {
          console.log(`  ⚠ Stale anima compositions (${plan.staleAnimas.length}):`);
          for (const a of plan.staleAnimas) {
            console.log(`    ${a.name} (${a.id}) — roles: ${a.roles.join(', ')}`);
            if (a.curriculum) {
              console.log(`      curriculum: ${a.curriculum.composedVersion} → ${a.curriculum.currentVersion} available`);
            }
            if (a.temperament) {
              console.log(`      temperament: ${a.temperament.composedVersion} → ${a.temperament.currentVersion} available`);
            }
          }
          console.log();

          if (options.recompose) {
            console.log(`  Stale animas will be retired and recreated with fresh compositions.`);
          } else {
            console.log(`  Stale animas will continue using their original training content.`);
            console.log(`  Use --recompose to retire and recreate them, or do it manually via the steward.`);
          }
          console.log();
        }

        // Nothing to do in the bundle
        if (plan.isEmpty && depUpdates.length === 0) {
          console.log('  Everything is up to date. Nothing to upgrade.');
          return;
        }

        if (plan.isEmpty) {
          console.log('  Bundle content is up to date.');
          console.log();
        }

        // Dry run stops here
        if (options.dryRun) {
          console.log('Dry run — no changes applied.');
          return;
        }

        // ── Step 3: Apply bundle changes ─────────────────────────────

        if (!plan.isEmpty) {
          console.log('Applying bundle upgrade...');
          const result = applyUpgrade(home, bundleDir, plan, {
            recompose: options.recompose,
          });

          if (result.toolsRegistered.length > 0) {
            console.log(`  ✓ Registered ${result.toolsRegistered.length} tool(s)/engine(s)`);
          }
          if (result.contentUpdated.length > 0) {
            console.log(`  ✓ Updated ${result.contentUpdated.length} content artifact(s)`);
          }
          if (result.recomposedAnimas.length > 0) {
            console.log(`  ✓ Recomposed ${result.recomposedAnimas.length} anima(s): ${result.recomposedAnimas.join(', ')}`);
          } else if (result.staleAnimaCount > 0) {
            console.log(`  ⚠ ${result.staleAnimaCount} anima(s) using outdated compositions`);
          }
          console.log();
        }

        // ── Step 4: Update nexus version stamp ───────────────────────
        // Always stamp the version — even if the bundle had no changes,
        // the framework packages may have been updated.

        const versionMatch = plan.bundleSource.match(/@(\d+\.\d+\.\d+.*)$/);
        if (versionMatch) {
          const updatedConfig = readGuildConfig(home);
          const newVersion = versionMatch[1]!;
          if (updatedConfig.nexus !== newVersion) {
            updatedConfig.nexus = newVersion;
            writeGuildConfig(home, updatedConfig);
            console.log(`Nexus version: ${config.nexus} → ${newVersion}`);
          }
        }

        console.log('Upgrade complete.');

        } finally {
          // ── Restart daemon if it was running before we stopped it ────
          if (wasDaemonRunning) {
            try {
              const result = clockStart(home);
              console.log(`Clockworks daemon restarted (PID ${result.pid}).`);
            } catch (restartErr) {
              console.error(`Warning: failed to restart clockworks daemon: ${(restartErr as Error).message}`);
            }
          }
        }

      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

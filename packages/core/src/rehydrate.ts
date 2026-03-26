/**
 * rehydrate — reconstruct runtime state from git-tracked guild state.
 *
 * After a fresh clone, the guild's node_modules is empty and workshop bare
 * clones are missing. This function:
 * 1. Re-clones workshop bare repos from their remote URLs in guild.json
 * 2. Runs `npm install` to resolve registry/git-url deps from package.json
 * 3. For each tool with full source on disk (workshop/tarball), runs
 *    `npm install --no-save <tool-path>` to install from the tracked source
 * 4. Reports any linked tools that need to be re-linked manually
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readGuildConfig } from './guild-config.ts';
import type { ToolEntry } from './guild-config.ts';
import { workshopBarePath, workshopsPath } from './nexus-home.ts';

/** Map category -> on-disk parent directory (relative to guild root). */
const DIR_MAP: Record<string, string> = {
  tools: 'tools',
  engines: 'engines',
  curricula: 'training/curricula',
  temperaments: 'training/temperaments',
};

export interface RehydrateResult {
  /** Workshop bare clones restored from remote URLs. */
  workshopsCloned: string[];
  /** Workshops that failed to clone (name + error message). */
  workshopsFailed: { name: string; error: string }[];
  /** Tools restored from package.json (registry/git-url). */
  fromPackageJson: number;
  /** Tools restored from on-disk source (workshop/tarball). */
  fromSlotSource: string[];
  /** Tools that need manual re-linking. */
  needsRelink: string[];
}

/**
 * Rehydrate a guild's node_modules from tracked state.
 *
 * Idempotent and safe to run at any time.
 */
export function rehydrate(home: string): RehydrateResult {
  const result: RehydrateResult = {
    workshopsCloned: [],
    workshopsFailed: [],
    fromPackageJson: 0,
    fromSlotSource: [],
    needsRelink: [],
  };

  // 1. Re-clone workshop bare repos from guild.json remote URLs
  const config = readGuildConfig(home);
  const wsDir = workshopsPath(home);
  fs.mkdirSync(wsDir, { recursive: true });

  for (const [name, entry] of Object.entries(config.workshops)) {
    const barePath = workshopBarePath(home, name);
    if (fs.existsSync(barePath)) continue; // already cloned

    try {
      execFileSync('git', ['clone', '--bare', entry.remoteUrl, barePath], {
        stdio: 'pipe',
      });
      result.workshopsCloned.push(name);
    } catch (err) {
      result.workshopsFailed.push({
        name,
        error: (err as Error).message,
      });
    }
  }

  // 2. Run npm install to resolve registry/git-url deps from package.json
  const pkgPath = path.join(home, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const depCount = Object.keys(pkg.dependencies ?? {}).length;
    if (depCount > 0) {
      execFileSync('npm', ['install'], { cwd: home, stdio: 'pipe' });
      result.fromPackageJson = depCount;
    }
  }

  // 3. Scan guild.json for tools that have full source on disk
  for (const [category, registry] of Object.entries({
    tools: config.tools,
    engines: config.engines,
  })) {
    for (const [name, entry] of Object.entries(registry)) {
      const toolEntry = entry as ToolEntry;
      const upstream = toolEntry.upstream;
      const parentDir = DIR_MAP[category]!;
      const toolDir = path.join(home, parentDir, name);

      // Check if this is a workshop/tarball tool with full source on disk
      if (upstream === null || (upstream && upstream.startsWith('workshop:'))) {
        // Check if tool dir has a package.json (indicating full source)
        const toolPkgPath = path.join(toolDir, 'package.json');
        if (fs.existsSync(toolPkgPath)) {
          // Install from tool source
          try {
            execFileSync('npm', ['install', '--no-save', toolDir], {
              cwd: home,
              stdio: 'pipe',
            });
            result.fromSlotSource.push(name);
          } catch {
            // If install fails, the tool may need manual intervention
          }
        }
      }

      // Check if this was a linked tool (no upstream, no full source,
      // but has a package field in the descriptor)
      if (upstream === null) {
        const hasFullSource = fs.existsSync(path.join(toolDir, 'package.json'));
        if (!hasFullSource) {
          // This was likely a linked tool — needs manual re-linking
          result.needsRelink.push(name);
        }
      }
    }
  }

  return result;
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readGuildConfig, writeGuildConfig } from './guild-config.ts';

const DIR_MAP: Record<string, string> = {
  tools: 'tools',
  engines: 'engines',
  curricula: 'training/curricula',
  temperaments: 'training/temperaments',
};

/** The registries in guild.json that can contain tools, in search order. */
const REGISTRIES = ['tools', 'engines', 'curricula', 'temperaments'] as const;

export interface RemoveToolOptions {
  home: string;
  name: string;
  /** Restrict to a specific category. If omitted, searches all registries. */
  category?: 'tools' | 'engines' | 'curricula' | 'temperaments';
}

export interface RemoveResult {
  category: 'tools' | 'engines' | 'curricula' | 'temperaments';
  name: string;
  removedFrom: string;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Read the npm package name from a tool's guild.json entry.
 * Returns null if the tool has no package field (e.g. script-only tools).
 */
function getPackageName(entry: Record<string, unknown>): string | null {
  return (entry['package'] as string) ?? null;
}

/**
 * Remove a tool from the guild — deregister from guild.json and delete from disk.
 *
 * For npm-installed tools, also runs `npm uninstall` to clean up node_modules.
 * For linked tools, removes the symlink from node_modules.
 */
export function removeTool(opts: RemoveToolOptions): RemoveResult {
  const { home, name } = opts;
  const config = readGuildConfig(home);

  // Find the tool in guild.json
  const searchIn = opts.category ? [opts.category] : REGISTRIES;
  let foundCategory: typeof REGISTRIES[number] | undefined;

  for (const cat of searchIn) {
    if (config[cat][name]) {
      foundCategory = cat;
      break;
    }
  }

  if (!foundCategory) {
    throw new Error(`Tool "${name}" not found in guild.json.`);
  }

  const entry = config[foundCategory][name];

  // Clean up npm-installed packages from node_modules
  const packageName = getPackageName(entry as unknown as Record<string, unknown>);
  const upstream = 'upstream' in entry ? (entry.upstream as string | null) : null;

  if (packageName) {
    const linkPath = path.join(home, 'node_modules', packageName);
    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      // Linked tool: just remove the symlink
      fs.unlinkSync(linkPath);
      // Clean up empty scoped directory if needed
      const scopeDir = path.dirname(linkPath);
      if (scopeDir !== path.join(home, 'node_modules') &&
          fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } else if (upstream && !upstream.startsWith('workshop:')) {
      // Registry/git-url tool saved to package.json: use npm uninstall
      try {
        execFileSync('npm', ['uninstall', packageName], { cwd: home, stdio: 'pipe' });
      } catch {
        // If npm uninstall fails (e.g. package already gone), continue with cleanup
      }
    } else {
      // Workshop/tarball tool (not in package.json): remove from node_modules manually
      if (fs.existsSync(linkPath)) {
        fs.rmSync(linkPath, { recursive: true });
      }
    }
  }

  // Remove on-disk directory
  const parentDir = DIR_MAP[foundCategory];
  const toolDir = path.join(home, parentDir, name);

  if (fs.existsSync(toolDir)) {
    fs.rmSync(toolDir, { recursive: true });
  }

  // Deregister from guild.json
  delete config[foundCategory][name];

  // Clean up role references for tools
  if (foundCategory === 'tools') {
    // Remove from baseTools
    const baseIdx = config.baseTools.indexOf(name);
    if (baseIdx !== -1) {
      config.baseTools.splice(baseIdx, 1);
    }
    // Remove from all role tool lists
    for (const role of Object.values(config.roles)) {
      const roleIdx = role.tools.indexOf(name);
      if (roleIdx !== -1) {
        role.tools.splice(roleIdx, 1);
      }
    }
  }

  writeGuildConfig(home, config);

  // Commit
  git(['add', '-A'], home);
  git(['commit', '-m', `Remove ${foundCategory.slice(0, -1)} ${name}`], home);

  return { category: foundCategory, name, removedFrom: toolDir };
}

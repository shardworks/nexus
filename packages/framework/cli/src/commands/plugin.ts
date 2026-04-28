/**
 * nsg plugin-* — manage guild plugins.
 *
 * Framework commands for plugin lifecycle. Available via CLI only (not MCP).
 *
 * Plugin install/remove are pure npm + guild.json operations. No tool
 * discovery at install time — tools are resolved at runtime by the
 * Instrumentarium via its permission-based model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tool } from '@shardworks/tools-apparatus';
import {
  guild,
  readGuildConfig,
  writeGuildConfig,
  derivePluginId,
  readGuildPackageJson,
  resolvePackageNameForPluginId,
} from '@shardworks/nexus-core';
import { z } from 'zod';

// ── Helpers ────────────────────────────────────────────────────────────

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function pnpm(args: string[], cwd: string): string {
  return execFileSync('pnpm', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

/**
 * Detect the package manager used by the guild.
 *
 * Checks for lockfiles in order of specificity. Falls back to 'npm'
 * when no lockfile is present (e.g. fresh guilds before first install).
 */
export function detectPackageManager(guildRoot: string): 'npm' | 'pnpm' {
  if (fs.existsSync(path.join(guildRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

/**
 * Parse a source specifier to extract the npm package name.
 * e.g. "@shardworks/nexus-stdlib@1.0" → "@shardworks/nexus-stdlib"
 *      "nexus-stdlib" → "nexus-stdlib"
 *
 * Returns null for git URLs — the package name must be read from
 * the guild's package.json after npm install.
 *
 * Known limitations: does not handle npm: alias specifiers, tarball URLs,
 * or workspace: protocol. These are uncommon for plugin install and can
 * be added if needed.
 */
function parsePackageName(source: string): string | null {
  if (source.startsWith('git+') || source.startsWith('git://') || source.endsWith('.git')) {
    return null;
  }
  if (source.startsWith('@')) {
    const lastAt = source.lastIndexOf('@');
    if (lastAt > 0) return source.substring(0, lastAt);
    return source;
  }
  if (source.includes('@')) {
    return source.split('@')[0]!;
  }
  return source;
}

/**
 * Find the most recently added dependency in the guild's package.json.
 * Used after `npm install <git-url>` where we can't parse the name from the source.
 *
 * Relies on Object.keys() returning insertion-ordered string keys (guaranteed
 * by the ES2015 spec for non-integer keys, and by V8/Node). A diff-based
 * approach (snapshot deps before install, compare after) would be more robust
 * but overkill for this edge case.
 */
function detectInstalledPackage(guildRoot: string): string {
  const pkgPath = path.join(guildRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const deps = pkg.dependencies as Record<string, string> | undefined ?? {};
  const names = Object.keys(deps);
  const last = names[names.length - 1];
  if (!last) throw new Error('Could not determine package name after npm install.');
  return last;
}

// ── Commands ───────────────────────────────────────────────────────────

export const pluginList = tool({
  name: 'plugin-list',
  description: 'List installed plugins',
  callableBy: ['patron'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (params) => {
    const { home } = guild();
    const config = readGuildConfig(home);
    const pluginIds = config.plugins;

    if (pluginIds.length === 0) {
      if (params.json) return [];
      return 'No plugins installed.';
    }

    if (params.json) {
      return [...pluginIds].sort().map((id) => ({ id }));
    }
    return [...pluginIds].sort().join('\n');
  },
});

export const pluginInstall = tool({
  name: 'plugin-install',
  description: 'Install a plugin into the guild',
  callableBy: ['patron'],
  params: {
    source: z.string().describe('Package name, git URL, or local folder path'),
    type: z.enum(['registry', 'link']).optional().describe('Install type: "registry" (npm install) or "link" (local folder). Auto-detected when source is a folder path.'),
  },
  handler: async (params) => {
    const { home } = guild();
    const { source } = params;

    // Auto-detect link mode when source looks like a filesystem path
    const sourceDir = path.resolve(source);
    const looksLikePath = source.startsWith('.') || source.startsWith('/');
    const isDirectory = looksLikePath && fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory();
    const installType = params.type ?? (isDirectory ? 'link' : 'registry');

    // 1. Install the npm package into the guild
    let packageName: string;

    if (installType === 'link') {
      const sourceDir = path.resolve(source);
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error(`No package.json found in ${sourceDir}. --link requires a directory with a package.json.`);
      }
      const pkgJson = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8')) as Record<string, unknown>;
      packageName = pkgJson.name as string;
      const pm = detectPackageManager(home);
      if (pm === 'pnpm') {
        pnpm(['add', `link:${sourceDir}`], home);
      } else {
        npm(['install', '--save', `file:${sourceDir}`], home);
      }
    } else {
      npm(['install', '--save', source], home);
      packageName = parsePackageName(source) ?? detectInstalledPackage(home);

      const { pkgJson } = readGuildPackageJson(home, packageName);
      if (!pkgJson) {
        throw new Error(`Package "${packageName}" not found in node_modules after install.`);
      }
    }

    const pluginId = derivePluginId(packageName);

    // 2. Update guild.json — add to plugins list
    const config = readGuildConfig(home);

    if (!config.plugins.includes(pluginId)) {
      config.plugins.push(pluginId);
    }

    writeGuildConfig(home, config);

    return `Installed plugin: ${pluginId} (${packageName})`;
  },
});

export const pluginRemove = tool({
  name: 'plugin-remove',
  description: 'Remove a plugin from the guild',
  callableBy: ['patron'],
  params: {
    name: z.string().describe('Plugin id or package name to remove'),
  },
  handler: async (params) => {
    const { home } = guild();
    const config = readGuildConfig(home);
    const targetId = params.name.startsWith('@') ? derivePluginId(params.name) : params.name;

    if (!config.plugins.includes(targetId)) {
      throw new Error(`Plugin "${targetId}" is not installed.`);
    }

    config.plugins = config.plugins.filter((id) => id !== targetId);
    writeGuildConfig(home, config);

    const packageName = resolvePackageNameForPluginId(home, targetId);
    if (packageName) {
      try {
        const pm = detectPackageManager(home);
        if (pm === 'pnpm') {
          pnpm(['remove', packageName], home);
        } else {
          npm(['uninstall', packageName], home);
        }
      } catch {
        // Don't fail if uninstall fails — guild.json is already updated
      }
    }

    return `Removed plugin: ${targetId}`;
  },
});

export const pluginUpgrade = tool({
  name: 'plugin-upgrade',
  description: 'Upgrade a plugin to a newer version',
  callableBy: ['patron'],
  params: {
    name: z.string().describe('Plugin id or package name to upgrade'),
    version: z.string().optional().describe('Target version (default: latest)'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});

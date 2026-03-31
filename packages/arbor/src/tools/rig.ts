/**
 * nsg rig — manage guild plugins.
 *
 * Arbor built-in commands for plugin lifecycle. Available via CLI only (not MCP).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  tool,
  readGuildConfigV2,
  writeGuildConfigV2,
  resolveAllToolsFromExport,
} from '@shardworks/nexus-core';
import { z } from 'zod';
import { derivePluginId, readGuildPackageJson, resolveGuildPackageEntry, resolvePackageNameForPluginId } from '../resolve-package.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

/**
 * Parse a source specifier to extract the npm package name.
 * e.g. "@shardworks/nexus-stdlib@1.0" → "@shardworks/nexus-stdlib"
 *      "nexus-stdlib" → "nexus-stdlib"
 *
 * Returns null for git URLs — the package name must be read from
 * the guild's package.json after npm install.
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

/**
 * Discover tools exported by an installed plugin package.
 * Imports the package from the guild's node_modules and returns
 * all ToolDefinitions found in its default export.
 */
async function discoverPluginTools(
  guildRoot: string,
  packageName: string,
): Promise<string[]> {
  const entryPath = resolveGuildPackageEntry(guildRoot, packageName);
  const mod = await import(entryPath) as { default: unknown };
  const tools = resolveAllToolsFromExport(mod.default);
  return tools.map((t) => t.name);
}

// ── Commands ───────────────────────────────────────────────────────────

export const rigList = tool({
  name: 'rig-list',
  description: 'List installed plugins',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfigV2(home);
    const pluginIds = config.plugins;

    if (pluginIds.length === 0) {
      if (_params.json) return [];
      return 'No plugins installed.';
    }

    if (_params.json) {
      return [...pluginIds].sort().map((id) => ({ id }));
    }
    return [...pluginIds].sort().join('\n');
  },
});

export const rigInstall = tool({
  name: 'rig-install',
  description: 'Install a plugin into the guild',
  callableFrom: ['cli'],
  params: {
    source: z.string().describe('Package name or git URL, e.g. "@shardworks/nexus-stdlib", "foo@1.0", or "git+https://..."'),
    roles: z.string().optional().describe('Comma-separated role names to assign tools to (default: baseTools)'),
    type: z.enum(['registry', 'link']).optional().describe('Install type: "registry" (npm install, default) or "link" (symlink local dir)'),
  },
  handler: async (params, { home }) => {
    const { source } = params;
    const installType = params.type ?? 'registry';
    const roles = params.roles?.split(',').map((r) => r.trim()).filter(Boolean);

    // 1. Install the npm package into the guild
    let packageName: string;

    if (installType === 'link') {
      const sourceDir = path.resolve(source);
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error(`No package.json found in ${sourceDir}. --link requires a directory with a package.json.`);
      }
      const pkgJson = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8')) as Record<string, unknown>;
      packageName = pkgJson.name as string;
      npm(['install', '--save', `file:${sourceDir}`], home);
    } else {
      npm(['install', '--save', source], home);
      packageName = parsePackageName(source) ?? detectInstalledPackage(home);

      const { pkgJson } = readGuildPackageJson(home, packageName);
      if (!pkgJson) {
        throw new Error(`Package "${packageName}" not found in node_modules after install.`);
      }
    }

    const pluginId = derivePluginId(packageName);

    // 2. Discover tools from the plugin's exports
    const toolNames = await discoverPluginTools(home, packageName);

    // 3. Update guild.json — add to plugins list, update access control
    const config = readGuildConfigV2(home);

    if (!config.plugins.includes(pluginId)) {
      config.plugins.push(pluginId);
    }

    for (const toolName of toolNames) {
      if (roles && roles.length > 0) {
        for (const role of roles) {
          if (config.roles[role] && !config.roles[role].tools.includes(toolName)) {
            config.roles[role].tools.push(toolName);
          }
        }
      } else {
        if (!config.baseTools.includes(toolName)) {
          config.baseTools.push(toolName);
        }
      }
    }

    writeGuildConfigV2(home, config);

    const lines = [
      `Installed plugin: ${pluginId} (${packageName})`,
      `Discovered ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}: ${toolNames.join(', ')}`,
    ];
    if (roles && roles.length > 0) {
      lines.push(`Assigned to roles: ${roles.join(', ')}`);
    } else {
      lines.push('Added to baseTools (available to all animas)');
    }
    return lines.join('\n');
  },
});

export const rigRemove = tool({
  name: 'rig-remove',
  description: 'Remove a plugin from the guild',
  callableFrom: ['cli'],
  params: {
    name: z.string().describe('Plugin id or package name to remove'),
  },
  handler: async (params, { home }) => {
    const config = readGuildConfigV2(home);
    const targetId = params.name.startsWith('@') ? derivePluginId(params.name) : params.name;

    if (!config.plugins.includes(targetId)) {
      throw new Error(`Plugin "${targetId}" is not installed.`);
    }

    const packageName = resolvePackageNameForPluginId(home, targetId);

    let toolsToRemove: string[] = [];
    if (packageName) {
      try {
        toolsToRemove = await discoverPluginTools(home, packageName);
      } catch {
        // Can't load module — skip access control cleanup; tools may be orphaned
      }
    }

    for (const toolName of toolsToRemove) {
      const baseIdx = config.baseTools.indexOf(toolName);
      if (baseIdx !== -1) config.baseTools.splice(baseIdx, 1);

      for (const role of Object.values(config.roles)) {
        const roleIdx = role.tools.indexOf(toolName);
        if (roleIdx !== -1) role.tools.splice(roleIdx, 1);
      }
    }

    config.plugins = config.plugins.filter((id) => id !== targetId);

    writeGuildConfigV2(home, config);

    if (packageName) {
      try {
        npm(['uninstall', packageName], home);
      } catch {
        // Don't fail if npm uninstall fails — guild.json is already updated
      }
    }

    return `Removed plugin: ${targetId} (${toolsToRemove.length} tool${toolsToRemove.length === 1 ? '' : 's'} unregistered)`;
  },
});

export const rigUpgrade = tool({
  name: 'rig-upgrade',
  description: 'Upgrade a plugin to a newer version',
  callableFrom: ['cli'],
  params: {
    name: z.string().describe('Plugin id or package name to upgrade'),
    version: z.string().optional().describe('Target version (default: latest)'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});

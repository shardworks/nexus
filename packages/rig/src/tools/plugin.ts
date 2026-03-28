/**
 * nsg plugin — manage guild plugins.
 *
 * Rig built-in commands for plugin lifecycle. Available via CLI only (not MCP).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  tool,
  readGuildConfig,
  writeGuildConfig,
  resolveAllToolsFromExport,
} from '@shardworks/nexus-core';
import type { ToolEntry, PluginDescriptor } from '@shardworks/nexus-core';
import { z } from 'zod';
import { derivePluginKey } from '../rig.ts';
import { readGuildPackageJson, resolveGuildPackageEntry } from '../resolve-package.ts';

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
  // Git URLs: can't parse name, must detect after install
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
 * Read nexus-plugin.json from an installed package, if it exists.
 * Returns null if the package has no descriptor (which is fine —
 * tools are discovered from exports, descriptor is optional).
 */
function readPluginDescriptor(
  guildRoot: string,
  packageName: string,
): PluginDescriptor | null {
  const descriptorPath = path.join(
    guildRoot, 'node_modules', packageName, 'nexus-plugin.json',
  );
  if (!fs.existsSync(descriptorPath)) return null;
  return JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as PluginDescriptor;
}

/**
 * Check that all declared plugin dependencies are installed in the guild.
 * Returns an array of missing plugin keys. Empty = all satisfied.
 */
function checkPluginDependencies(
  descriptor: PluginDescriptor,
  installedPlugins: string[],
): string[] {
  if (!descriptor.dependencies?.length) return [];

  const installed = new Set(installedPlugins);
  const missing: string[] = [];
  for (const dep of descriptor.dependencies) {
    if (!installed.has(dep.plugin)) {
      missing.push(dep.plugin);
    }
  }
  return missing;
}

/**
 * Discover tools exported by an installed npm package.
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

export const pluginList = tool({
  name: 'plugin-list',
  description: 'List installed plugins',
  allowedContexts: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfig(home);
    const pluginKeys = config.plugins ?? [];

    if (pluginKeys.length === 0) {
      if (_params.json) return [];
      return 'No plugins installed.';
    }

    // Collect tool counts per plugin from the tools catalog
    const pluginToolCounts = new Map<string, number>();
    for (const entry of Object.values(config.tools)) {
      if (!entry.package) continue;
      const key = derivePluginKey(entry.package);
      pluginToolCounts.set(key, (pluginToolCounts.get(key) ?? 0) + 1);
    }

    const results = pluginKeys.map((key) => {
      const toolCount = pluginToolCounts.get(key) ?? 0;
      return { key, toolCount };
    });

    if (_params.json) return results;

    const lines = results.map(
      (r) => `${r.key}  (${r.toolCount} tool${r.toolCount === 1 ? '' : 's'})`,
    );
    return lines.join('\n');
  },
});

export const pluginInstall = tool({
  name: 'plugin-install',
  description: 'Install a plugin into the guild',
  allowedContexts: ['cli'],
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
      // Link mode: symlink a local directory into node_modules
      const sourceDir = path.resolve(source);
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error(`No package.json found in ${sourceDir}. --link requires a directory with a package.json.`);
      }
      const pkgJson = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8'));
      packageName = pkgJson.name;

      const nodeModules = path.join(home, 'node_modules');
      fs.mkdirSync(nodeModules, { recursive: true });
      const linkTarget = path.join(nodeModules, packageName);
      fs.mkdirSync(path.dirname(linkTarget), { recursive: true });
      if (fs.existsSync(linkTarget)) {
        fs.rmSync(linkTarget, { recursive: true });
      }
      fs.symlinkSync(sourceDir, linkTarget, 'dir');
    } else {
      // npm install handles both registry specifiers and git URLs
      npm(['install', '--save', source], home);
      packageName = parsePackageName(source) ?? detectInstalledPackage(home);

      // Verify it actually installed
      const { pkgJson } = readGuildPackageJson(home, packageName);
      if (!pkgJson) {
        throw new Error(`Package "${packageName}" not found in node_modules after install.`);
      }
    }

    const pluginKey = derivePluginKey(packageName);

    // 2. Check plugin dependencies (if nexus-plugin.json declares any)
    const config = readGuildConfig(home);
    const descriptor = readPluginDescriptor(home, packageName);
    if (descriptor) {
      const installedPlugins = config.plugins ?? [];
      const missing = checkPluginDependencies(descriptor, installedPlugins);
      if (missing.length > 0) {
        throw new Error(
          `Plugin "${pluginKey}" requires plugins that are not installed: ${missing.join(', ')}. ` +
          `Install them first with: nsg plugin install <name>`,
        );
      }
    }

    // 3. Discover tools from the package's exports
    const toolNames = await discoverPluginTools(home, packageName);

    // 4. Update guild.json
    const now = new Date().toISOString();

    // Add to plugins array
    if (!config.plugins) config.plugins = [];
    if (!config.plugins.includes(pluginKey)) {
      config.plugins.push(pluginKey);
    }

    // Register each tool
    for (const toolName of toolNames) {
      const entry: ToolEntry = {
        upstream: `${packageName}@${readGuildPackageJson(home, packageName).version}`,
        installedAt: now,
        package: packageName,
      };
      config.tools[toolName] = entry;

      // Assign to roles or baseTools
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

    writeGuildConfig(home, config);

    const lines = [
      `Installed plugin: ${pluginKey} (${packageName})`,
      `Registered ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}: ${toolNames.join(', ')}`,
    ];
    if (roles && roles.length > 0) {
      lines.push(`Assigned to roles: ${roles.join(', ')}`);
    } else {
      lines.push('Added to baseTools (available to all animas)');
    }
    return lines.join('\n');
  },
});

export const pluginRemove = tool({
  name: 'plugin-remove',
  description: 'Remove a plugin from the guild',
  allowedContexts: ['cli'],
  params: {
    name: z.string().describe('Plugin key or package name to remove'),
  },
  handler: async (params, { home }) => {
    const config = readGuildConfig(home);
    const targetKey = params.name.startsWith('@') ? derivePluginKey(params.name) : params.name;

    // Find the plugin in guild.json
    if (!config.plugins?.includes(targetKey)) {
      throw new Error(`Plugin "${targetKey}" is not installed.`);
    }

    // Find all tools owned by this plugin
    const toolsToRemove: string[] = [];
    let packageName: string | null = null;

    for (const [toolName, entry] of Object.entries(config.tools)) {
      if (!entry.package) continue;
      if (derivePluginKey(entry.package) === targetKey) {
        toolsToRemove.push(toolName);
        packageName = entry.package;
      }
    }

    // Remove tools from guild.json
    for (const toolName of toolsToRemove) {
      delete config.tools[toolName];

      // Remove from baseTools
      const baseIdx = config.baseTools.indexOf(toolName);
      if (baseIdx !== -1) config.baseTools.splice(baseIdx, 1);

      // Remove from role tool lists
      for (const role of Object.values(config.roles)) {
        const roleIdx = role.tools.indexOf(toolName);
        if (roleIdx !== -1) role.tools.splice(roleIdx, 1);
      }
    }

    // Remove from plugins array
    config.plugins = config.plugins.filter((k) => k !== targetKey);

    writeGuildConfig(home, config);

    // npm uninstall
    if (packageName) {
      try {
        npm(['uninstall', packageName], home);
      } catch {
        // Don't fail if npm uninstall fails — guild.json is already updated
      }
    }

    return `Removed plugin: ${targetKey} (${toolsToRemove.length} tool${toolsToRemove.length === 1 ? '' : 's'} unregistered)`;
  },
});

export const pluginUpgrade = tool({
  name: 'plugin-upgrade',
  description: 'Upgrade a plugin to a newer version and run its migrations',
  allowedContexts: ['cli'],
  params: {
    name: z.string().describe('Plugin key or package name to upgrade'),
    version: z.string().optional().describe('Target version (default: latest)'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});

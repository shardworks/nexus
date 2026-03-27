/**
 * nsg plugin — manage guild plugins.
 *
 * Rig built-in commands for plugin lifecycle. Available via CLI only (not MCP).
 * Stubs for now — `install`, `remove`, and `upgrade` are implemented in
 * commission-rig-plugin-install.
 */

import { createRequire } from 'node:module';
import { tool, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';
import { derivePluginKey } from '../rig.ts';

const _require = createRequire(import.meta.url);

export const pluginList = tool({
  name: 'plugin-list',
  description: 'List installed plugins',
  allowedContexts: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfig(home);

    // Collect unique packages from the tools catalog
    const plugins = new Map<string, { key: string; version: string; toolCount: number }>();
    for (const entry of Object.values(config.tools)) {
      if (!entry.package) continue;
      if (plugins.has(entry.package)) {
        plugins.get(entry.package)!.toolCount++;
        continue;
      }
      let version = 'unknown';
      try {
        const pkg = _require(`${entry.package}/package.json`) as { version?: string };
        version = pkg.version ?? 'unknown';
      } catch { /* not installed */ }

      plugins.set(entry.package, {
        key: derivePluginKey(entry.package),
        version,
        toolCount: 1,
      });
    }

    if (_params.json) {
      return Array.from(plugins.entries()).map(([packageName, info]) => ({
        packageName,
        ...info,
      }));
    }

    if (plugins.size === 0) {
      return 'No plugins installed.';
    }

    const lines = Array.from(plugins.entries()).map(
      ([_pkg, info]) => `${info.key}  ${info.version}  (${info.toolCount} tool${info.toolCount === 1 ? '' : 's'})`,
    );
    return lines.join('\n');
  },
});

export const pluginInstall = tool({
  name: 'plugin-install',
  description: 'Install a plugin into the guild',
  allowedContexts: ['cli'],
  params: {
    name: z.string().describe('Plugin package name to install'),
  },
  handler: async () => {
    return 'Not yet implemented — see commission-rig-plugin-install.';
  },
});

export const pluginRemove = tool({
  name: 'plugin-remove',
  description: 'Remove a plugin from the guild',
  allowedContexts: ['cli'],
  params: {
    name: z.string().describe('Plugin key or package name to remove'),
  },
  handler: async () => {
    return 'Not yet implemented — see commission-rig-plugin-install.';
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
    return 'Not yet implemented — see commission-rig-plugin-install.';
  },
});

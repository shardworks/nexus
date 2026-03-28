/**
 * nsg rig — manage guild rigs.
 *
 * Mainspring built-in commands for rig lifecycle. Available via CLI only (not MCP).
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
import type { RigDescriptor } from '@shardworks/nexus-core';
import { z } from 'zod';
import { deriveRigId, readGuildPackageJson, resolveGuildPackageEntry, resolvePackageNameForRigKey } from '../resolve-package.ts';

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
 * Read rig.json from an installed rig package, if it exists.
 * Returns null if the package has no descriptor (which is fine —
 * tools are discovered from exports, descriptor is optional).
 */
function readRigDescriptor(
  guildRoot: string,
  packageName: string,
): RigDescriptor | null {
  const descriptorPath = path.join(
    guildRoot, 'node_modules', packageName, 'rig.json',
  );
  if (!fs.existsSync(descriptorPath)) return null;
  return JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as RigDescriptor;
}

/**
 * Check that all declared rig dependencies are installed in the guild.
 * Returns an array of missing rig keys. Empty = all satisfied.
 */
function checkRigDependencies(
  descriptor: RigDescriptor,
  installedRigs: string[],
): string[] {
  if (!descriptor.dependencies?.length) return [];

  const installed = new Set(installedRigs);
  const missing: string[] = [];
  for (const dep of descriptor.dependencies) {
    if (!installed.has(dep.rig)) {
      missing.push(dep.rig);
    }
  }
  return missing;
}

/**
 * Discover tools exported by an installed rig package.
 * Imports the package from the guild's node_modules and returns
 * all ToolDefinitions found in its default export.
 */
async function discoverRigTools(
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
  description: 'List installed rigs',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfigV2(home);
    const rigKeys = config.rigs;

    if (rigKeys.length === 0) {
      if (_params.json) return [];
      return 'No rigs installed.';
    }

    if (_params.json) {
      return [...rigKeys].sort().map((key) => ({ key }));
    }
    return [...rigKeys].sort().join('\n');
  },
});

export const rigInstall = tool({
  name: 'rig-install',
  description: 'Install a rig into the guild',
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
      // Link mode: use `npm install --save file:path` — symlinks the local dir into
      // node_modules AND tracks it in package.json so the reverse key lookup works.
      const sourceDir = path.resolve(source);
      if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error(`No package.json found in ${sourceDir}. --link requires a directory with a package.json.`);
      }
      const pkgJson = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8')) as Record<string, unknown>;
      packageName = pkgJson.name as string;
      npm(['install', '--save', `file:${sourceDir}`], home);
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

    const rigId = deriveRigId(packageName);

    // 2. Check rig dependencies (if rig.json declares any)
    const config = readGuildConfigV2(home);
    const descriptor = readRigDescriptor(home, packageName);
    if (descriptor) {
      const missing = checkRigDependencies(descriptor, config.rigs);
      if (missing.length > 0) {
        throw new Error(
          `Rig "${rigId}" requires rigs that are not installed: ${missing.join(', ')}. ` +
          `Install them first with: nsg rig install <name>`,
        );
      }
    }

    // 3. Discover tools from the rig's exports
    const toolNames = await discoverRigTools(home, packageName);

    // 4. Update guild.json — add to rigs list, update access control
    if (!config.rigs.includes(rigId)) {
      config.rigs.push(rigId);
    }

    // Register tool names in access control lists
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
      `Installed rig: ${rigId} (${packageName})`,
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
  description: 'Remove a rig from the guild',
  callableFrom: ['cli'],
  params: {
    name: z.string().describe('Rig key or package name to remove'),
  },
  handler: async (params, { home }) => {
    const config = readGuildConfigV2(home);
    const targetKey = params.name.startsWith('@') ? deriveRigId(params.name) : params.name;

    if (!config.rigs.includes(targetKey)) {
      throw new Error(`Rig "${targetKey}" is not installed.`);
    }

    // Resolve package name before we uninstall — package.json still has it now
    const packageName = resolvePackageNameForRigKey(home, targetKey);

    // Discover tools by loading the rig module (package still installed at this point)
    let toolsToRemove: string[] = [];
    if (packageName) {
      try {
        toolsToRemove = await discoverRigTools(home, packageName);
      } catch {
        // Can't load module — skip access control cleanup; tools may be orphaned
      }
    }

    // Remove tool names from access control
    for (const toolName of toolsToRemove) {
      const baseIdx = config.baseTools.indexOf(toolName);
      if (baseIdx !== -1) config.baseTools.splice(baseIdx, 1);

      for (const role of Object.values(config.roles)) {
        const roleIdx = role.tools.indexOf(toolName);
        if (roleIdx !== -1) role.tools.splice(roleIdx, 1);
      }
    }

    // Remove from rigs list
    config.rigs = config.rigs.filter((k) => k !== targetKey);

    writeGuildConfigV2(home, config);

    // npm uninstall — after guild.json is updated
    if (packageName) {
      try {
        npm(['uninstall', packageName], home);
      } catch {
        // Don't fail if npm uninstall fails — guild.json is already updated
      }
    }

    return `Removed rig: ${targetKey} (${toolsToRemove.length} tool${toolsToRemove.length === 1 ? '' : 's'} unregistered)`;
  },
});

export const rigUpgrade = tool({
  name: 'rig-upgrade',
  description: 'Upgrade a rig to a newer version and run its migrations',
  callableFrom: ['cli'],
  params: {
    name: z.string().describe('Rig key or package name to upgrade'),
    version: z.string().optional().describe('Target version (default: latest)'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});

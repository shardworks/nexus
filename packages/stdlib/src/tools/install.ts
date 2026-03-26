/**
 * install-tool tool.
 *
 * This is the canonical implementation — called by the MCP engine (for animas),
 * the CLI (for humans), and importable by engines. All access paths execute
 * the same logic.
 *
 * Detects bundles automatically: if the source package contains a
 * nexus-bundle.json, delegates to installBundle instead of installTool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tool, installTool, installBundle, classifySource, isBundleDir } from '@shardworks/nexus-core';
import { z } from 'zod';

/**
 * For registry/git-url sources, npm-install the package (no-save) and check
 * if it contains a bundle manifest. Returns the package dir if bundle, null otherwise.
 */
function detectBundle(home: string, source: string): string | null {
  const sourceKind = classifySource(source, false);
  if (sourceKind !== 'registry' && sourceKind !== 'git-url') return null;

  execFileSync('npm', ['install', '--no-save', source], { cwd: home, stdio: 'pipe' });

  let packageName = source;
  if (packageName.startsWith('@') && packageName.lastIndexOf('@') > 0) {
    packageName = packageName.substring(0, packageName.lastIndexOf('@'));
  } else if (packageName.includes('@') && !packageName.startsWith('@')) {
    packageName = packageName.split('@')[0]!;
  }

  const packageDir = path.join(home, 'node_modules', packageName);
  return isBundleDir(packageDir) ? packageDir : null;
}

export default tool({
  name: 'tool-install',
  description: 'Install a tool, engine, curriculum, temperament, or bundle into the guild',
  instructionsFile: './instructions/tool-install.md',
  params: {
    source: z.string().describe('npm package specifier, git URL, workshop ref, tarball path, or bundle specifier'),
    name: z.string().optional().describe('Override the tool name (defaults to package name or directory name)'),
    roles: z.array(z.string()).optional().describe('Roles for tool access gating'),
    link: z.boolean().optional().describe('Symlink local directory instead of copying (for active development)'),
  },
  handler: (params, { home }) => {
    // Check if source is a bundle
    if (!params.link) {
      const bundleDir = detectBundle(home, params.source);
      if (bundleDir) {
        return installBundle({ home, bundleDir, bundleSource: params.source });
      }
    }

    return installTool({ home, ...params });
  },
});

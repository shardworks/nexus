/**
 * Package resolution utilities for guild-installed npm packages.
 *
 * Resolves entry points from the guild's node_modules by reading package.json
 * exports maps directly. Needed because guild rigs are ESM-only packages
 * and createRequire() can't resolve their exports.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read a package.json from the guild's node_modules.
 * Returns the parsed JSON and version. Falls back gracefully.
 */
export function readGuildPackageJson(
  guildRoot: string,
  pkgName: string,
): { version: string; pkgJson: Record<string, unknown> | null } {
  const pkgJsonPath = path.join(guildRoot, 'node_modules', pkgName, 'package.json');
  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    return { version: (pkgJson.version as string) ?? 'unknown', pkgJson };
  } catch {
    return { version: 'unknown', pkgJson: null };
  }
}

/**
 * Resolve the npm package name for a rig key by consulting the guild's root package.json.
 *
 * Reverses the `deriveRigKey()` mapping:
 * - Key containing `/`  → `@key`          (e.g. `acme/my-rig` → `@acme/my-rig`)
 * - Key without `/`     → prefer `@shardworks/key` in deps; fall back to unscoped `key`
 *
 * Returns null if no matching dependency is found — the rig may not be npm-tracked
 * (e.g. manually placed in node_modules without a package.json entry).
 */
export function resolvePackageNameForRigKey(guildRoot: string, rigKey: string): string | null {
  const pkgPath = path.join(guildRoot, 'package.json');
  let deps: string[] = [];
  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    deps = Object.keys((pkgJson.dependencies as Record<string, string> | undefined) ?? {});
  } catch {
    return null;
  }

  // Key with / came from @scope/name → scope/name; reverse is prepend @
  if (rigKey.includes('/')) {
    const pkg = '@' + rigKey;
    return deps.includes(pkg) ? pkg : null;
  }

  // Key without /: prefer the official @shardworks/ scope; fall back to unscoped
  const official = '@shardworks/' + rigKey;
  if (deps.includes(official)) return official;
  if (deps.includes(rigKey)) return rigKey;
  return null;
}

/**
 * Resolve the entry point for a guild-installed package.
 *
 * Reads the package's exports map to find the ESM entry point.
 * Returns an absolute path suitable for dynamic import().
 */
export function resolveGuildPackageEntry(guildRoot: string, pkgName: string): string {
  const pkgDir = path.join(guildRoot, 'node_modules', pkgName);
  const { pkgJson } = readGuildPackageJson(guildRoot, pkgName);

  if (pkgJson) {
    const exports = pkgJson.exports as Record<string, unknown> | string | undefined;
    if (exports) {
      if (typeof exports === 'string') return path.join(pkgDir, exports);
      const main = (exports as Record<string, unknown>)['.'];
      if (typeof main === 'string') return path.join(pkgDir, main);
      if (main && typeof main === 'object') {
        const importPath = (main as Record<string, string>).import;
        if (importPath) return path.join(pkgDir, importPath);
      }
    }
    if (pkgJson.main) return path.join(pkgDir, pkgJson.main as string);
  }

  return path.join(pkgDir, 'index.js');
}

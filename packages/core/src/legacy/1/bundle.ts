/**
 * Bundle — a manifest that delivers multiple installable artifacts to a guild.
 *
 * A bundle is a recipe, not a dependency. The installer reads the manifest,
 * installs each artifact individually (via installTool), and discards the
 * bundle itself. Each artifact becomes an independent guild dependency.
 *
 * ## Manifest: `nexus-bundle.json`
 *
 * The manifest has explicit top-level arrays for each artifact category:
 * - `tools` and `engines` require a `package` specifier (runtime code)
 * - `curricula` and `temperaments` support `package` OR `path` (content-only)
 *
 * ## Transitive bundles
 *
 * A package entry can itself contain a `nexus-bundle.json`. The installer
 * recurses, so bundles can compose other bundles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installTool } from './install-tool.ts';
import { readGuildConfig, writeGuildConfig } from './guild-config.ts';

// ── Manifest types ──────────────────────────────────────────────────────

/** A package-based artifact entry (tools and engines). */
export interface BundlePackageEntry {
  /** npm package specifier or git URL. */
  package: string;
  /** Override the artifact name in the guild. */
  name?: string;
  /** Roles this tool should be assigned to (used during upgrade to add missing tools to roles). */
  roles?: string[];
}

/** A content artifact entry (curricula and temperaments). */
export interface BundleContentEntry {
  /** npm package specifier or git URL. */
  package?: string;
  /** Path relative to the bundle root for inline content. */
  path?: string;
  /** Override the artifact name in the guild. */
  name?: string;
}

/** A migration entry (always inline via `path`). */
export interface BundleMigrationEntry {
  /** Path relative to the bundle root for the .sql file. */
  path: string;
}

/** The `nexus-bundle.json` manifest shape. */
export interface BundleManifest {
  /** Human-readable description of the bundle. */
  description?: string;
  /** Tools to install (require `package`). */
  tools?: BundlePackageEntry[];
  /** Engines to install (require `package`). */
  engines?: BundlePackageEntry[];
  /** Curricula to install (`package` or `path`). */
  curricula?: BundleContentEntry[];
  /** Temperaments to install (`package` or `path`). */
  temperaments?: BundleContentEntry[];
  /** Migrations to install (always inline, renumbered on install). */
  migrations?: BundleMigrationEntry[];
}

// ── Options ─────────────────────────────────────────────────────────────

export interface InstallBundleOptions {
  /** Absolute path to the guild root directory. */
  home: string;
  /** Absolute path to the bundle directory (contains nexus-bundle.json). */
  bundleDir: string;
  /** Bundle provenance string, e.g. "@shardworks/guild-starter-kit@0.1.0". */
  bundleSource?: string;
  /** Whether to create a git commit after installing. Defaults to true. */
  commit?: boolean;
}

export interface InstallBundleResult {
  /** Number of artifacts installed. */
  installed: number;
  /** Names of installed artifacts, grouped by category. */
  artifacts: {
    tools: string[];
    engines: string[];
    curricula: string[];
    temperaments: string[];
    migrations: string[];
  };
  /** Provenance map for installed migrations: guild filename → { bundle, originalName }. */
  migrationProvenance?: Record<string, { bundle: string; originalName: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const BUNDLE_MANIFEST = 'nexus-bundle.json';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ── Descriptor types for each category ──────────────────────────────────

const DESCRIPTOR_MAP: Record<string, string> = {
  tools: 'nexus-tool.json',
  engines: 'nexus-engine.json',
  curricula: 'nexus-curriculum.json',
  temperaments: 'nexus-temperament.json',
};

const DIR_MAP: Record<string, string> = {
  tools: 'tools',
  engines: 'engines',
  curricula: 'training/curricula',
  temperaments: 'training/temperaments',
};

/**
 * Check if a directory contains a nexus-bundle.json manifest.
 */
export function isBundleDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, BUNDLE_MANIFEST));
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Read and validate a nexus-bundle.json manifest.
 *
 * Enforces schema rules:
 * - tools/engines must use `package`, not `path`
 * - curricula/temperaments must have either `package` or `path`
 */
export function readBundleManifest(bundleDir: string): BundleManifest {
  const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No ${BUNDLE_MANIFEST} found in ${bundleDir}`);
  }

  const manifest = readJson(manifestPath) as BundleManifest;

  // Validate tools: must have package, no path allowed
  for (const entry of manifest.tools ?? []) {
    if (!entry.package) {
      throw new Error(
        'Tools must have a "package" specifier. ' +
        'Tools have runtime code and potential npm dependencies — they cannot be inline.',
      );
    }
    if ('path' in entry) {
      throw new Error(
        'Tools must be npm packages or git URLs. Use a "package" specifier instead of "path".',
      );
    }
  }

  // Validate engines: must have package, no path allowed
  for (const entry of manifest.engines ?? []) {
    if (!entry.package) {
      throw new Error(
        'Engines must have a "package" specifier. ' +
        'Engines have runtime code and potential npm dependencies — they cannot be inline.',
      );
    }
    if ('path' in entry) {
      throw new Error(
        'Engines must be npm packages or git URLs. Use a "package" specifier instead of "path".',
      );
    }
  }

  // Validate content entries: must have package or path
  for (const entry of manifest.curricula ?? []) {
    if (!entry.package && !entry.path) {
      throw new Error('Curriculum entries must have either a "package" or "path" specifier.');
    }
  }
  for (const entry of manifest.temperaments ?? []) {
    if (!entry.package && !entry.path) {
      throw new Error('Temperament entries must have either a "package" or "path" specifier.');
    }
  }

  // Validate migrations: must have path, no package allowed
  for (const entry of manifest.migrations ?? []) {
    if (!entry.path) {
      throw new Error('Migration entries must have a "path" specifier.');
    }
    if ('package' in entry) {
      throw new Error(
        'Migrations must be inline SQL files. Use a "path" specifier instead of "package".',
      );
    }
  }

  return manifest;
}

// ── Inline content installation ─────────────────────────────────────────

/**
 * Install an inline content artifact (curriculum or temperament) from a
 * path relative to the bundle directory.
 *
 * Copies the full directory to the guild and registers in guild.json.
 */
function installInlineContent(
  home: string,
  bundleDir: string,
  category: 'curricula' | 'temperaments',
  entry: BundleContentEntry,
  bundleSource?: string,
): string {
  const contentDir = path.resolve(bundleDir, entry.path!);
  if (!fs.existsSync(contentDir)) {
    throw new Error(`Inline content path not found: ${contentDir}`);
  }

  // Read descriptor to get version
  const descriptorFile = DESCRIPTOR_MAP[category]!;
  const descriptorPath = path.join(contentDir, descriptorFile);
  if (!fs.existsSync(descriptorPath)) {
    throw new Error(`No ${descriptorFile} found in ${contentDir}`);
  }
  const descriptor = readJson(descriptorPath);

  const name = entry.name || path.basename(contentDir);

  // Copy full directory to guild
  const parentDir = DIR_MAP[category]!;
  const targetDir = path.join(home, parentDir, name);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });
  copyDir(contentDir, targetDir);

  // Register in guild.json
  const config = readGuildConfig(home);
  config[category][name] = {
    upstream: null,
    installedAt: new Date().toISOString(),
    ...(bundleSource ? { bundle: bundleSource } : {}),
  };
  writeGuildConfig(home, config);

  return name;
}

/** Recursively copy a directory, skipping node_modules and .git. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        copyDir(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

/**
 * Install a bundle into a guild.
 *
 * Reads the bundle manifest, installs all referenced artifacts individually,
 * and optionally commits the result. The bundle itself is NOT retained as
 * a guild dependency — each artifact is installed independently.
 *
 * Package artifacts (tools, engines, and packaged content) are installed
 * via npm. Inline content artifacts (curricula/temperaments with `path`) are
 * copied directly from the bundle directory.
 *
 * If an installed package contains its own `nexus-bundle.json`, the installer
 * recurses to install the transitive bundle's artifacts.
 */
export function installBundle(opts: InstallBundleOptions): InstallBundleResult {
  const { home, bundleDir, commit = true } = opts;

  // Auto-detect bundle provenance from package.json if not provided
  let bundleSource = opts.bundleSource;
  if (!bundleSource) {
    const bundlePkgPath = path.join(bundleDir, 'package.json');
    if (fs.existsSync(bundlePkgPath)) {
      const bundlePkg = readJson(bundlePkgPath);
      const name = bundlePkg['name'] as string | undefined;
      const version = bundlePkg['version'] as string | undefined;
      if (name && version) {
        bundleSource = `${name}@${version}`;
      }
    }
  }

  const manifest = readBundleManifest(bundleDir);

  const result: InstallBundleResult = {
    installed: 0,
    artifacts: { tools: [], engines: [], curricula: [], temperaments: [], migrations: [] },
  };

  // ── Collect all package specifiers for batch npm install ──────────────

  const packageSpecs: string[] = [];

  for (const entry of manifest.tools ?? []) {
    packageSpecs.push(entry.package);
  }
  for (const entry of manifest.engines ?? []) {
    packageSpecs.push(entry.package);
  }
  for (const entry of manifest.curricula ?? []) {
    if (entry.package) packageSpecs.push(entry.package);
  }
  for (const entry of manifest.temperaments ?? []) {
    if (entry.package) packageSpecs.push(entry.package);
  }

  // ── Install inline content BEFORE npm install ──────────────────────
  // The bundle may have been fetched with --no-save. The batch npm install
  // below can prune unsaved packages from node_modules, destroying the
  // bundle directory. Extract all inline content while it still exists.

  // Install inline curricula
  for (const entry of manifest.curricula ?? []) {
    if (!entry.package) {
      const name = installInlineContent(home, bundleDir, 'curricula', entry, bundleSource);
      result.artifacts.curricula.push(name);
      result.installed++;
    }
  }

  // Install inline temperaments
  for (const entry of manifest.temperaments ?? []) {
    if (!entry.package) {
      const name = installInlineContent(home, bundleDir, 'temperaments', entry, bundleSource);
      result.artifacts.temperaments.push(name);
      result.installed++;
    }
  }

  // Install migrations (inline only, renumbered into guild sequence)
  if (manifest.migrations && manifest.migrations.length > 0) {
    const migrationsDir = path.join(home, 'nexus', 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Find current highest sequence in guild
    const existing = fs.readdirSync(migrationsDir);
    const MIGRATION_PATTERN = /^(\d{3})-(.+)\.sql$/;
    let maxSeq = 0;
    for (const file of existing) {
      const match = file.match(MIGRATION_PATTERN);
      if (match) {
        maxSeq = Math.max(maxSeq, parseInt(match[1]!, 10));
      }
    }

    const provenance: Record<string, { bundle: string; originalName: string }> = {};

    for (const entry of manifest.migrations) {
      const srcPath = path.resolve(bundleDir, entry.path);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Migration file not found: ${srcPath}`);
      }

      const originalName = path.basename(srcPath);
      maxSeq++;
      const seq = String(maxSeq).padStart(3, '0');

      // Derive description from original filename (strip sequence prefix if present)
      const descMatch = originalName.match(/^\d{3}-(.+)$/);
      const description = descMatch ? descMatch[1] : originalName;
      const guildFilename = `${seq}-${description}`;

      fs.copyFileSync(srcPath, path.join(migrationsDir, guildFilename));

      if (bundleSource) {
        provenance[guildFilename] = { bundle: bundleSource, originalName };
      }

      result.artifacts.migrations.push(guildFilename);
      result.installed++;
    }

    if (Object.keys(provenance).length > 0) {
      result.migrationProvenance = provenance;
    }
  }

  // ── Batch npm install all package dependencies ────────────────────────
  // Safe to run now — all inline content has been extracted from bundleDir.
  if (packageSpecs.length > 0) {
    npm(['install', '--save', ...packageSpecs], home);
  }

  // ── Install package-based artifacts ───────────────────────────────────

  // Helper to install a single package artifact via installTool
  const installPackageArtifact = (
    entry: BundlePackageEntry | BundleContentEntry,
    category: 'tools' | 'engines' | 'curricula' | 'temperaments',
  ): string => {
    const spec = (entry as BundlePackageEntry).package;

    // Resolve package name from the specifier
    const packageName = resolvePackageName(spec, home);
    const packageDir = path.join(home, 'node_modules', packageName);

    // Check for transitive bundle
    const nestedBundlePath = path.join(packageDir, BUNDLE_MANIFEST);
    if (fs.existsSync(nestedBundlePath)) {
      const nestedResult = installBundle({
        home,
        bundleDir: packageDir,
        bundleSource: spec,
        commit: false,
      });
      // Merge nested results
      result.installed += nestedResult.installed;
      for (const cat of ['tools', 'engines', 'curricula', 'temperaments'] as const) {
        result.artifacts[cat].push(...nestedResult.artifacts[cat]);
      }
      return packageName;
    }

    // Find descriptor to determine artifact type.
    // For collection packages (exporting arrays), the descriptor may not exist
    // at the package root — that's fine, the name comes from the bundle manifest.
    const descriptorFile = DESCRIPTOR_MAP[category]!;
    const descriptorPath = path.join(packageDir, descriptorFile);
    const hasDescriptor = fs.existsSync(descriptorPath);
    const descriptor = hasDescriptor ? readJson(descriptorPath) : {};

    // Determine artifact name — bundle manifest name takes priority
    const name = entry.name || packageName.replace(/^@[^/]+\//, '');

    if (!hasDescriptor && !entry.name) {
      throw new Error(
        `Package "${packageName}" does not contain ${descriptorFile} and no "name" ` +
        `was specified in the bundle manifest. Collection packages must declare ` +
        `a "name" for each artifact in the bundle manifest.`,
      );
    }

    // Copy metadata to guild directory
    const parentDir = DIR_MAP[category]!;
    const targetDir = path.join(home, parentDir, name);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    if (hasDescriptor) {
      // Copy descriptor
      fs.copyFileSync(descriptorPath, path.join(targetDir, descriptorFile));

      // Copy instructions if referenced
      const instructionsFile = descriptor['instructions'] as string | undefined;
      if (instructionsFile) {
        const instrPath = path.join(packageDir, instructionsFile);
        if (fs.existsSync(instrPath)) {
          fs.copyFileSync(instrPath, path.join(targetDir, instructionsFile));
        }
      }

      // Copy content file if referenced (for curricula/temperaments)
      const contentFile = descriptor['content'] as string | undefined;
      if (contentFile) {
        const contentPath = path.join(packageDir, contentFile);
        if (fs.existsSync(contentPath)) {
          fs.copyFileSync(contentPath, path.join(targetDir, contentFile));
        }
      }
    }
    // For collection packages without a per-tool descriptor: no files to copy.
    // Instructions come from the tool() definition at runtime (manifest engine
    // imports the module and reads the `instructions` field).

    // Register in guild.json
    const config = readGuildConfig(home);
    const now = new Date().toISOString();
    const version = descriptor['version'] as string | undefined;
    const upstreamVersion = version ? `${packageName}@${version}` : packageName;

    if (category === 'tools' || category === 'engines') {
      config[category][name] = {
        upstream: upstreamVersion,
        installedAt: now,
        package: packageName,
        ...(bundleSource ? { bundle: bundleSource } : {}),
      };

      // Bundle-installed tools are registered in the catalog only.
      // Role assignment is handled by the caller (e.g. init-guild.ts
      // sets up roles with explicit tool lists). Tools not assigned to
      // any role or baseTools are installed but not accessible to animas.
    } else {
      config[category][name] = {
        upstream: upstreamVersion,
        installedAt: now,
        ...(bundleSource ? { bundle: bundleSource } : {}),
      };
    }

    writeGuildConfig(home, config);
    return name;
  };

  // Install tools
  for (const entry of manifest.tools ?? []) {
    const name = installPackageArtifact(entry, 'tools');
    result.artifacts.tools.push(name);
    result.installed++;
  }

  // Install engines
  for (const entry of manifest.engines ?? []) {
    const name = installPackageArtifact(entry, 'engines');
    result.artifacts.engines.push(name);
    result.installed++;
  }

  // Install package-based curricula
  for (const entry of manifest.curricula ?? []) {
    if (entry.package) {
      const name = installPackageArtifact(entry, 'curricula');
      result.artifacts.curricula.push(name);
      result.installed++;
    }
  }

  // Install package-based temperaments
  for (const entry of manifest.temperaments ?? []) {
    if (entry.package) {
      const name = installPackageArtifact(entry, 'temperaments');
      result.artifacts.temperaments.push(name);
      result.installed++;
    }
  }

  // Commit all changes in one batch
  if (commit) {
    git(['add', '-A'], home);
    const bundleLabel = bundleSource || path.basename(bundleDir);
    git(['commit', '-m', `Install bundle ${bundleLabel}`], home);
  }

  return result;
}

// ── Package name resolution ─────────────────────────────────────────────

/**
 * Resolve a package specifier to a package name.
 *
 * - Local paths: reads name from the source's package.json
 * - Git URLs: finds the package in guild's package.json deps
 * - Registry specifiers: parses name from "name@version" or "@scope/name@version"
 */
function resolvePackageName(spec: string, guildRoot: string): string {
  // Local path: read package.json directly
  const isLocalPath = spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../');
  if (isLocalPath) {
    const pkgJsonPath = path.join(path.resolve(spec), 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(`No package.json found at ${pkgJsonPath}`);
    }
    const pkg = readJson(pkgJsonPath);
    const name = pkg['name'] as string | undefined;
    if (!name) {
      throw new Error(`No "name" field in ${pkgJsonPath}`);
    }
    return name;
  }

  // Git URL: find the package in node_modules by reading package.json deps
  if (spec.startsWith('git+')) {
    const guildPkg = readJson(path.join(guildRoot, 'package.json'));
    const deps = guildPkg['dependencies'] as Record<string, string> | undefined ?? {};
    for (const [name, value] of Object.entries(deps)) {
      if (value === spec || value.includes(spec.replace(/^git\+/, ''))) {
        return name;
      }
    }
    throw new Error(`Could not resolve package name for git URL: ${spec}`);
  }

  // Registry specifier: parse name from "name@version" or "@scope/name@version"
  if (spec.startsWith('@') && spec.lastIndexOf('@') > 0) {
    return spec.substring(0, spec.lastIndexOf('@'));
  }
  if (spec.includes('@')) {
    return spec.split('@')[0]!;
  }
  return spec;
}

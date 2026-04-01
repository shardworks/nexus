import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workshopBarePath } from './nexus-home.ts';
import { readGuildConfig, writeGuildConfig } from './guild-config.ts';
import type { ToolEntry, TrainingEntry } from './guild-config.ts';
import { checkToolPreconditions } from './preconditions.ts';

/** Descriptor file names in priority order for detection. */
const DESCRIPTOR_FILES = [
  'nexus-tool.json',
  'nexus-engine.json',
  'nexus-curriculum.json',
  'nexus-temperament.json',
] as const;

type DescriptorFile = typeof DESCRIPTOR_FILES[number];

/** Map descriptor file -> artifact category in guild.json */
const CATEGORY_MAP: Record<DescriptorFile, 'tools' | 'engines' | 'curricula' | 'temperaments'> = {
  'nexus-tool.json': 'tools',
  'nexus-engine.json': 'engines',
  'nexus-curriculum.json': 'curricula',
  'nexus-temperament.json': 'temperaments',
};

/** Map category -> on-disk parent directory (relative to guild root). */
const DIR_MAP: Record<string, string> = {
  tools: 'tools',
  engines: 'engines',
  curricula: 'training/curricula',
  temperaments: 'training/temperaments',
};

/**
 * How the source was classified for installation.
 *
 * - `registry`  — npm package specifier (e.g. `foo@1.0`, `@scope/tool`)
 * - `git-url`   — git URL (e.g. `git+https://github.com/org/repo.git#v1.0`)
 * - `workshop`  — workshop ref (e.g. `workshop:forge#tool/fetch-jira@1.0`)
 * - `tarball`   — local .tgz/.tar.gz file
 * - `link`      — symlinked local directory (dev mode)
 */
export type SourceKind = 'registry' | 'git-url' | 'workshop' | 'tarball' | 'link';

export interface InstallToolOptions {
  /** Absolute path to the guild root directory. */
  home: string;
  /**
   * Source specifier:
   *
   * - npm package specifier: `some-tool@1.0`, `@scope/tool`
   * - Git URL: `git+https://github.com/org/repo.git#v1.0`
   * - Workshop ref: `workshop:forge#tool/fetch-jira@1.0`
   * - Tarball: `./my-tool-1.0.0.tgz`
   * - Local directory (with `--link`): `~/projects/my-tool`
   */
  source: string;
  /** Override the tool name (defaults to package name or directory basename). */
  name?: string;
  /**
   * For tools: which roles should have access. If specified, adds the
   * tool to these roles' tool lists. If omitted, adds to baseTools.
   */
  roles?: string[];
  /** Whether to create a git commit after installing. Defaults to true. */
  commit?: boolean;
  /**
   * Symlink a local directory instead of copying (dev mode).
   * Only valid for local directories with `package.json`.
   * Changes to the source are reflected immediately at runtime.
   * **Not durable** — will not survive a fresh clone.
   */
  link?: boolean;
  /** Bundle provenance — which bundle delivered this artifact. */
  bundle?: string;
}

export interface InstallResult {
  category: 'tools' | 'engines' | 'curricula' | 'temperaments';
  name: string;
  installedTo: string;
  sourceKind: SourceKind;
  /** Precondition warnings — unmet environment requirements. Tool is still installed. */
  warnings: string[];
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

/** Detect the descriptor file in a directory. Returns the filename or throws. */
function findDescriptor(dir: string): DescriptorFile {
  for (const f of DESCRIPTOR_FILES) {
    if (fs.existsSync(path.join(dir, f))) return f;
  }
  throw new Error(
    `No descriptor found in ${dir}. Expected one of: ${DESCRIPTOR_FILES.join(', ')}`,
  );
}

/** Read a JSON file. */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Write a JSON file. */
function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/** Directories to skip when copying tool sources. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Recursively copy a directory, skipping node_modules and .git. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        copyDir(srcPath, destPath);
      }
    } else if (entry.isSymbolicLink()) {
      const realPath = fs.realpathSync(srcPath);
      if (fs.statSync(realPath).isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          copyDir(realPath, destPath);
        }
      } else {
        fs.copyFileSync(realPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy only the metadata files (descriptor + instructions) from a source
 * directory into the guild tool directory. This is used for npm-installed
 * tools where the runtime code lives in node_modules but the metadata
 * needs to be git-tracked in the guild.
 */
function copyMetadata(sourceDir: string, targetDir: string, descriptorFile: string, descriptor: Record<string, unknown>): void {
  fs.mkdirSync(targetDir, { recursive: true });

  // Always copy the descriptor
  fs.copyFileSync(path.join(sourceDir, descriptorFile), path.join(targetDir, descriptorFile));

  // Copy instructions if referenced
  const instructionsFile = descriptor['instructions'] as string | undefined;
  if (instructionsFile) {
    const instrPath = path.join(sourceDir, instructionsFile);
    if (fs.existsSync(instrPath)) {
      fs.copyFileSync(instrPath, path.join(targetDir, instructionsFile));
    }
  }
}

/**
 * Classify a source string to determine the installation method.
 *
 * @param source - The source specifier.
 * @param link - Whether the --link flag was set.
 */
export function classifySource(source: string, link: boolean = false): SourceKind {
  if (link) return 'link';
  if (source.startsWith('workshop:')) return 'workshop';
  if (source.startsWith('git+')) return 'git-url';
  if (source.endsWith('.tgz') || source.endsWith('.tar.gz')) return 'tarball';
  return 'registry';
}

/**
 * Resolve the installed package directory in node_modules after npm install.
 */
function resolveInstalledPackage(guildRoot: string, packageName: string): string {
  const pkgDir = path.join(guildRoot, 'node_modules', packageName);
  if (!fs.existsSync(pkgDir)) {
    throw new Error(`Could not find installed package at ${pkgDir}`);
  }
  return pkgDir;
}

/**
 * Read the package name from a package.json file.
 */
function readPackageName(dir: string): string {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found in ${dir}`);
  }
  const pkg = readJson(pkgPath);
  const name = pkg['name'] as string | undefined;
  if (!name) {
    throw new Error(`No "name" field in ${pkgPath}`);
  }
  return name;
}

/**
 * Parse a registry source specifier to extract the package name.
 * e.g. "foo@1.0" -> "foo", "@scope/foo@1.0" -> "@scope/foo"
 */
function parsePackageName(source: string): string {
  // Scoped packages: @scope/name@version
  if (source.startsWith('@') && source.lastIndexOf('@') > 0) {
    return source.substring(0, source.lastIndexOf('@'));
  }
  // Unscoped: name@version
  if (source.includes('@')) {
    return source.split('@')[0]!;
  }
  // Bare name without version
  return source;
}

/**
 * Determine package name from guild's package.json dependencies.
 * Used when we can't derive the name from the source specifier (e.g. tarballs).
 */
function findNewDependency(guildRoot: string): string {
  const guildhallPkg = readJson(path.join(guildRoot, 'package.json'));
  const deps = guildhallPkg['dependencies'] as Record<string, string> | undefined ?? {};
  const depNames = Object.keys(deps);
  const packageName = depNames[depNames.length - 1];
  if (!packageName) {
    throw new Error('Could not determine package name after npm install');
  }
  return packageName;
}

// ── Install paths ───────────────────────────────────────────────────────

/**
 * Install via npm --save (registry and git-url sources).
 * Package is added to guild's package.json for durability.
 */
function installViaNpmSave(
  guildRoot: string,
  source: string,
  sourceKind: SourceKind,
): { packageName: string; packageDir: string; descriptorFile: DescriptorFile; descriptor: Record<string, unknown>; pkg: Record<string, unknown> } {
  npm(['install', '--save', source], guildRoot);

  // Determine the installed package name:
  // - Registry specifiers (e.g. "foo@1.0"): parse name from specifier
  // - Local paths: read name from source's package.json (reliable for batch installs)
  // - Git URLs: detect as new dependency in guild's package.json
  const isLocalPath = source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
  let packageName: string;
  if (isLocalPath) {
    packageName = readPackageName(path.resolve(source));
  } else if (sourceKind === 'registry') {
    packageName = parsePackageName(source);
  } else {
    packageName = findNewDependency(guildRoot);
  }

  const packageDir = resolveInstalledPackage(guildRoot, packageName);
  const descriptorFile = findDescriptor(packageDir);
  const descriptor = readJson(path.join(packageDir, descriptorFile));
  const pkg = readJson(path.join(packageDir, 'package.json'));

  return { packageName, packageDir, descriptorFile, descriptor, pkg };
}

/**
 * Install via npm, detect package name, optionally remove from package.json.
 * Used for tarball and workshop sources where we need --no-save semantics
 * but need to discover the package name.
 */
function installViaNpmDetect(
  guildRoot: string,
  npmSource: string,
  save: boolean,
): { packageName: string; packageDir: string; descriptorFile: DescriptorFile; descriptor: Record<string, unknown>; pkg: Record<string, unknown> } {
  // Always install with --save first to detect the package name
  npm(['install', '--save', npmSource], guildRoot);

  const packageName = findNewDependency(guildRoot);
  const packageDir = resolveInstalledPackage(guildRoot, packageName);
  const descriptorFile = findDescriptor(packageDir);
  const descriptor = readJson(path.join(packageDir, descriptorFile));
  const pkg = readJson(path.join(packageDir, 'package.json'));

  // If we don't want to save, remove from package.json but keep in node_modules
  if (!save) {
    const guildPkg = readJson(path.join(guildRoot, 'package.json'));
    const deps = guildPkg['dependencies'] as Record<string, string> | undefined;
    if (deps && packageName in deps) {
      delete deps[packageName];
      writeJson(path.join(guildRoot, 'package.json'), guildPkg);
    }
  }

  return { packageName, packageDir, descriptorFile, descriptor, pkg };
}

/**
 * Install via symlink (dev mode for local dirs with package.json).
 * Creates a symlink in node_modules pointing to the source directory.
 */
function installViaLink(
  guildRoot: string,
  source: string,
): { packageName: string; packageDir: string; descriptorFile: DescriptorFile; descriptor: Record<string, unknown>; pkg: Record<string, unknown> } {
  const sourceDir = path.resolve(source);

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${sourceDir}`);
  }
  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    throw new Error('The --link option requires a directory with a package.json.');
  }

  const packageName = readPackageName(sourceDir);

  // Ensure node_modules exists
  const nodeModulesDir = path.join(guildRoot, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  // Handle scoped packages: @scope/name needs @scope/ directory
  const linkTarget = path.join(nodeModulesDir, packageName);
  fs.mkdirSync(path.dirname(linkTarget), { recursive: true });

  // Remove existing link/directory if present
  if (fs.existsSync(linkTarget)) {
    fs.rmSync(linkTarget, { recursive: true });
  }

  fs.symlinkSync(sourceDir, linkTarget, 'dir');

  const descriptorFile = findDescriptor(sourceDir);
  const descriptor = readJson(path.join(sourceDir, descriptorFile));
  const pkg = readJson(path.join(sourceDir, 'package.json'));

  return { packageName, packageDir: sourceDir, descriptorFile, descriptor, pkg };
}

// ── Main ────────────────────────────────────────────────────────────────

/**
 * Install a tool (implement, engine, curriculum, or temperament) into the guild.
 *
 * Supports five source types:
 * - **Registry** — npm package specifier, fully durable via package.json
 * - **Git URL** — `git+https://...`, fully durable via package.json
 * - **Workshop** — `workshop:name#ref`, durable within the guild via full source on disk
 * - **Tarball** — `.tgz` file, durable via full source on disk
 * - **Link** — symlinked local dir (dev mode), NOT durable
 *
 * For npm-installed tools, runtime code lives in node_modules. Metadata
 * (descriptor + instructions) is copied to the tool directory for git tracking.
 * The `package` field in guild.json tells the manifest engine to resolve by package name.
 */
export function installTool(opts: InstallToolOptions): InstallResult {
  const { home, source, roles, commit = true, link = false, bundle } = opts;
  const sourceKind = classifySource(source, link);

  let descriptorFile: DescriptorFile;
  let descriptor: Record<string, unknown>;
  let pkg: Record<string, unknown>;
  let packageName: string | null = null;
  let isNpmInstalled = false;
  let copyFullSource = false;
  let upstream: string | null = null;

  if (sourceKind === 'link') {
    // ── Link mode: symlink local dir ──────────────────────────────────
    const result = installViaLink(home, source);
    descriptorFile = result.descriptorFile;
    descriptor = result.descriptor;
    pkg = result.pkg;
    packageName = result.packageName;
    isNpmInstalled = true;
    upstream = null;
  } else if (sourceKind === 'registry' || sourceKind === 'git-url') {
    // ── Registry / Git URL: npm install --save ────────────────────────
    const result = installViaNpmSave(home, source, sourceKind);
    descriptorFile = result.descriptorFile;
    descriptor = result.descriptor;
    pkg = result.pkg;
    packageName = result.packageName;
    isNpmInstalled = true;
    upstream = sourceKind === 'git-url' ? source : `${result.packageName}@${result.pkg['version'] as string}`;
  } else if (sourceKind === 'workshop') {
    // ── Workshop: resolve to git+file:// URL, npm install, full source ─
    const parsed = parseWorkshopSource(source);
    const barePath = workshopBarePath(home, parsed.workshop);
    if (!fs.existsSync(barePath)) {
      throw new Error(`Workshop bare repo not found: ${barePath}`);
    }
    const gitFileUrl = `git+file://${barePath}#${parsed.ref}`;

    const result = installViaNpmDetect(home, gitFileUrl, false);
    descriptorFile = result.descriptorFile;
    descriptor = result.descriptor;
    pkg = result.pkg;
    packageName = result.packageName;
    isNpmInstalled = true;
    copyFullSource = true;
    upstream = source; // Store the original workshop:name#ref specifier
  } else {
    // ── Tarball: npm install --no-save, full source to tool dir ────────
    const resolvedSource = path.resolve(source);
    const result = installViaNpmDetect(home, resolvedSource, false);
    descriptorFile = result.descriptorFile;
    descriptor = result.descriptor;
    pkg = result.pkg;
    packageName = result.packageName;
    isNpmInstalled = true;
    copyFullSource = true;
    upstream = null;
  }

  const category = CATEGORY_MAP[descriptorFile];

  // Resolve name: --name flag > package name > directory basename
  const name = opts.name
    || (packageName ? packageName.replace(/^@[^/]+\//, '') : null)
    || path.basename(path.resolve(source));
  if (!name || name === '.' || name === '..') {
    throw new Error('Could not determine tool name. Use --name to specify one.');
  }

  // Determine target directory for metadata/files in the guild.
  const parentDir = DIR_MAP[category]!;
  const targetDir = path.join(home, parentDir, name);

  if (isNpmInstalled && copyFullSource) {
    // Workshop/tarball: copy full source to tool dir for durability
    const pkgSourceDir = resolveInstalledPackage(home, packageName!);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }
    copyDir(pkgSourceDir, targetDir);
  } else if (isNpmInstalled) {
    // Registry/git-url/link: copy only metadata to tool dir
    const pkgSourceDir = sourceKind === 'link'
      ? path.resolve(source)
      : resolveInstalledPackage(home, packageName!);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }
    copyMetadata(pkgSourceDir, targetDir, descriptorFile, descriptor);
  }

  // Register in guild.json
  const config = readGuildConfig(home);
  const now = new Date().toISOString();

  if (category === 'tools' || category === 'engines') {
    const entry: ToolEntry = {
      upstream,
      installedAt: now,
    };
    if (packageName) {
      entry.package = packageName;
    }
    if (bundle) {
      entry.bundle = bundle;
    }
    config[category][name] = entry;

    // For tools, assign to roles or baseTools
    if (category === 'tools') {
      if (roles && roles.length > 0) {
        // Add to specific roles' tool lists
        for (const role of roles) {
          if (config.roles[role]) {
            if (!config.roles[role].tools.includes(name)) {
              config.roles[role].tools.push(name);
            }
          }
          // If role doesn't exist, silently skip — the user might create it later
        }
      } else {
        // Default: add to baseTools (available to all animas)
        if (!config.baseTools.includes(name)) {
          config.baseTools.push(name);
        }
      }
    }
  } else {
    const entry: TrainingEntry = {
      upstream,
      installedAt: now,
    };
    if (bundle) {
      entry.bundle = bundle;
    }
    config[category][name] = entry;
  }

  writeGuildConfig(home, config);

  // Commit (unless suppressed -- e.g. during bootstrap)
  if (commit) {
    git(['add', '-A'], home);
    git(['commit', '-m', `Install ${category.slice(0, -1)} ${name}`], home);
  }

  // Check preconditions for tools and engines — warn but don't fail
  const warnings: string[] = [];
  if (category === 'tools' || category === 'engines') {
    const descriptorFile = category === 'tools' ? 'nexus-tool.json' : 'nexus-engine.json';
    const descriptorPath = path.join(targetDir, descriptorFile);
    const results = checkToolPreconditions(descriptorPath);
    for (const r of results) {
      if (!r.passed && r.message) {
        warnings.push(r.message);
      }
    }
  }

  return { category, name, installedTo: targetDir, sourceKind, warnings };
}

// ── Workshop source parsing ─────────────────────────────────────────────

/**
 * Parse a workshop source specifier.
 * Format: `workshop:<name>#<ref>`
 */
function parseWorkshopSource(source: string): { workshop: string; ref: string } {
  const withoutPrefix = source.substring('workshop:'.length);
  const hashIndex = withoutPrefix.indexOf('#');
  if (hashIndex === -1) {
    throw new Error(
      `Invalid workshop source "${source}". Expected format: workshop:<name>#<ref>`,
    );
  }
  return {
    workshop: withoutPrefix.substring(0, hashIndex),
    ref: withoutPrefix.substring(hashIndex + 1),
  };
}

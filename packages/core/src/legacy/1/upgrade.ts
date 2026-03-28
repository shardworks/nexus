/**
 * Upgrade — plan and apply framework upgrades to an existing guild.
 *
 * Compares the guild's current state against a bundle (typically the
 * guild-starter-kit at a newer version) and produces a plan describing:
 *
 * - New tools and engines to register (with role assignments)
 * - Updated curricula and temperaments
 * - Stale anima compositions (using outdated training content)
 *
 * Database migrations are handled separately by nexus-core and applied
 * automatically on database open (see `ensureBooks()` in migrate.ts).
 *
 * The plan can be inspected (dry-run) or applied. Content artifacts
 * are overwritten with the newer version. Stale animas are reported
 * but not automatically recomposed — the operator decides.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig, writeGuildConfig } from './guild-config.ts';
import { readBundleManifest, type BundleManifest } from './bundle.ts';
import { listAnimas, checkAllAnimaStaleness } from './anima.ts';
import { removeAnima } from './anima.ts';
import { instantiate } from './instantiate.ts';

// ── Plan types ──────────────────────────────────────────────────────────

/** A migration that the bundle wants to deliver but the guild doesn't have. */
export interface MigrationPlanEntry {
  /** Original filename in the bundle (e.g. "002-clockworks.sql"). */
  bundleFilename: string;
  /** The sequence number it will get in the guild. */
  guildSequence: number;
  /** The filename it will have in the guild (e.g. "005-clockworks.sql"). */
  guildFilename: string;
}

/** A content artifact (curriculum or temperament) that has a newer version available. */
export interface ContentUpdateEntry {
  /** Category: 'curricula' or 'temperaments'. */
  category: 'curricula' | 'temperaments';
  /** Name of the content artifact. */
  name: string;
  /** Currently installed version (from guild.json entry or disk descriptor). */
  installedVersion: string;
  /** Version in the bundle. */
  bundleVersion: string;
  /** Path in the bundle to the content directory. */
  bundlePath: string;
}

/** A tool or engine that the bundle declares but the guild doesn't have. */
export interface ToolPlanEntry {
  /** Category: 'tools' or 'engines'. */
  category: 'tools' | 'engines';
  /** Artifact name in the guild. */
  name: string;
  /** npm package that provides this tool. */
  package: string;
  /** Roles this tool should be assigned to (from the bundle manifest). */
  roles: string[];
}

/** An anima whose composition references an outdated curriculum or temperament. */
export interface StaleAnimaEntry {
  /** Anima ID. */
  id: string;
  /** Anima name. */
  name: string;
  /** Roles held by the anima. */
  roles: string[];
  /** Curriculum staleness (null if current or no curriculum). */
  curriculum: { composedVersion: string; currentVersion: string } | null;
  /** Temperament staleness (null if current or no temperament). */
  temperament: { composedVersion: string; currentVersion: string } | null;
}

/** The full upgrade plan. */
export interface UpgradePlan {
  /** Bundle source identifier (e.g. "@shardworks/guild-starter-kit@0.1.55"). */
  bundleSource: string;
  /** New migrations to install and apply. */
  migrations: MigrationPlanEntry[];
  /** Content artifacts with newer versions available. */
  contentUpdates: ContentUpdateEntry[];
  /** Tools and engines the bundle declares but the guild doesn't have. */
  newTools: ToolPlanEntry[];
  /** Animas running on outdated compositions. */
  staleAnimas: StaleAnimaEntry[];
  /** Whether there is anything to do. */
  isEmpty: boolean;
}

/** Options for applying an upgrade plan. */
export interface ApplyUpgradeOptions {
  /** If true, retire stale animas and recreate them with fresh compositions. */
  recompose?: boolean;
}

/** Result of applying an upgrade plan. */
export interface UpgradeResult {
  /** Migrations that were installed and applied. */
  migrationsApplied: string[];
  /** Content artifacts that were updated. */
  contentUpdated: string[];
  /** Tools and engines that were registered. */
  toolsRegistered: string[];
  /** Number of stale animas (reported, not changed). */
  staleAnimaCount: number;
  /** Animas that were recomposed (retired + recreated). */
  recomposedAnimas: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

/**
 * Read a content descriptor (nexus-curriculum.json or nexus-temperament.json)
 * and return its version string.
 */
function readContentVersion(dir: string, category: 'curricula' | 'temperaments'): string {
  const descriptorFile = category === 'curricula'
    ? 'nexus-curriculum.json'
    : 'nexus-temperament.json';
  const descriptorPath = path.join(dir, descriptorFile);
  if (!fs.existsSync(descriptorPath)) return 'unknown';
  const descriptor = readJson(descriptorPath);
  return (descriptor.version as string) || 'unknown';
}

// ── Plan ────────────────────────────────────────────────────────────────

/**
 * Plan an upgrade by diffing the guild's current state against a bundle.
 *
 * This is a read-only operation — it inspects the guild and bundle but
 * makes no changes. The returned plan describes everything that would
 * happen if the upgrade were applied.
 *
 * @param home - Absolute path to the guild root.
 * @param bundleDir - Absolute path to the bundle directory.
 * @param bundleSource - Provenance string (e.g. "@shardworks/guild-starter-kit@0.1.55").
 */
export function planUpgrade(
  home: string,
  bundleDir: string,
  bundleSource?: string,
): UpgradePlan {
  // Auto-detect bundle provenance if not provided
  if (!bundleSource) {
    const bundlePkgPath = path.join(bundleDir, 'package.json');
    if (fs.existsSync(bundlePkgPath)) {
      const pkg = readJson(bundlePkgPath);
      const name = pkg.name as string | undefined;
      const version = pkg.version as string | undefined;
      if (name && version) bundleSource = `${name}@${version}`;
    }
  }
  bundleSource = bundleSource || path.basename(bundleDir);

  const manifest = readBundleManifest(bundleDir);

  const plan: UpgradePlan = {
    bundleSource,
    migrations: [],
    contentUpdates: [],
    newTools: [],
    staleAnimas: [],
    isEmpty: true,
  };

  // ── Tool/engine diff ───────────────────────────────────────────────

  planNewTools(home, manifest, 'tools', plan);
  planNewTools(home, manifest, 'engines', plan);

  // ── Content diff ────────────────────────────────────────────────────

  planContentUpdates(home, bundleDir, manifest, 'curricula', plan);
  planContentUpdates(home, bundleDir, manifest, 'temperaments', plan);

  // ── Stale anima detection ───────────────────────────────────────────
  // This detects staleness based on what's *currently* on disk, plus
  // any content updates the plan would apply. So if the plan updates
  // curriculum v1.0 → v1.1, animas on v1.0 will show as stale.

  detectStaleAnimas(home, plan);

  plan.isEmpty = plan.newTools.length === 0
    && plan.contentUpdates.length === 0
    && plan.staleAnimas.length === 0;

  return plan;
}

/**
 * Diff bundle tools/engines against what the guild already has registered.
 *
 * Any tool declared in the bundle but missing from guild.json is planned
 * for installation, along with its role assignments.
 */
function planNewTools(
  home: string,
  manifest: BundleManifest,
  category: 'tools' | 'engines',
  plan: UpgradePlan,
): void {
  const entries = manifest[category];
  if (!entries) return;

  const config = readGuildConfig(home);
  const registered = config[category];

  for (const entry of entries) {
    const name = entry.name || entry.package;
    if (registered[name]) continue; // Already registered

    plan.newTools.push({
      category,
      name,
      package: entry.package,
      roles: entry.roles ?? [],
    });
  }
}

/**
 * Diff bundle content (curricula or temperaments) against guild versions.
 */
function planContentUpdates(
  home: string,
  bundleDir: string,
  manifest: BundleManifest,
  category: 'curricula' | 'temperaments',
  plan: UpgradePlan,
): void {
  const entries = manifest[category];
  if (!entries) return;

  for (const entry of entries) {
    // Only handle inline content (path-based). Package content is handled
    // by npm update and doesn't need special upgrade logic.
    if (!entry.path) continue;

    const contentDir = path.resolve(bundleDir, entry.path);
    if (!fs.existsSync(contentDir)) continue;

    const name = entry.name || path.basename(contentDir);
    const bundleVersion = readContentVersion(contentDir, category);

    // Read installed version from disk
    const parentDir = category === 'curricula' ? 'training/curricula' : 'training/temperaments';
    const installedDir = path.join(home, parentDir, name);
    const installedVersion = fs.existsSync(installedDir)
      ? readContentVersion(installedDir, category)
      : 'not installed';

    if (bundleVersion !== installedVersion) {
      plan.contentUpdates.push({
        category,
        name,
        installedVersion,
        bundleVersion,
        bundlePath: entry.path,
      });
    }
  }
}

/**
 * Detect animas whose compositions reference outdated training content.
 *
 * Uses the shared checkAllAnimaStaleness function, then enriches with
 * planned content update versions (so animas are flagged as stale even
 * if the content hasn't been written to disk yet).
 */
function detectStaleAnimas(home: string, plan: UpgradePlan): void {
  const dbPath = booksPath(home);
  if (!fs.existsSync(dbPath)) return;

  // Check that the animas table exists
  const db = new Database(dbPath);
  try {
    const hasAnimas = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='animas'`,
    ).get();
    if (!hasAnimas) return;
  } finally {
    db.close();
  }

  // Get all active animas for enrichment
  const activeAnimas = listAnimas(home, { status: 'active' });

  // Use the shared staleness check for current on-disk state
  const currentStaleness = checkAllAnimaStaleness(home);

  // Also check against planned content updates (content not yet on disk)
  // Build a map of what versions will be current after upgrade
  const plannedVersions = new Map<string, string>();
  for (const update of plan.contentUpdates) {
    plannedVersions.set(`${update.category}:${update.name}`, update.bundleVersion);
  }

  // For each active anima, check both current staleness and planned staleness
  const db2 = new Database(booksPath(home));
  db2.pragma('foreign_keys = ON');

  try {
    for (const anima of activeAnimas) {
      // Get composition data
      const comp = db2.prepare(`
        SELECT curriculum_name, curriculum_version,
               temperament_name, temperament_version
        FROM anima_compositions WHERE anima_id = ?
      `).get(anima.id) as {
        curriculum_name: string | null; curriculum_version: string | null;
        temperament_name: string | null; temperament_version: string | null;
      } | undefined;

      if (!comp) continue;

      // Start with current staleness
      const existing = currentStaleness.get(anima.id);
      let curriculum = existing?.curriculum ?? null;
      let temperament = existing?.temperament ?? null;

      // Check planned curriculum update
      if (!curriculum && comp.curriculum_name && comp.curriculum_version) {
        const plannedVersion = plannedVersions.get(`curricula:${comp.curriculum_name}`);
        if (plannedVersion && plannedVersion !== comp.curriculum_version) {
          curriculum = { composedVersion: comp.curriculum_version, currentVersion: plannedVersion };
        }
      }

      // Check planned temperament update
      if (!temperament && comp.temperament_name && comp.temperament_version) {
        const plannedVersion = plannedVersions.get(`temperaments:${comp.temperament_name}`);
        if (plannedVersion && plannedVersion !== comp.temperament_version) {
          temperament = { composedVersion: comp.temperament_version, currentVersion: plannedVersion };
        }
      }

      if (curriculum || temperament) {
        plan.staleAnimas.push({
          id: anima.id,
          name: anima.name,
          roles: anima.roles,
          curriculum,
          temperament,
        });
      }
    }
  } finally {
    db2.close();
  }
}

// ── Apply ───────────────────────────────────────────────────────────────

/**
 * Apply an upgrade plan to the guild.
 *
 * Installs new migrations, updates content artifacts, and bumps the
 * nexus version in guild.json. Optionally recomposes stale animas
 * (retires each one and recreates with the same name, roles, curriculum,
 * and temperament — picking up the latest training content).
 *
 * @param home - Absolute path to the guild root.
 * @param bundleDir - Absolute path to the bundle directory.
 * @param plan - The upgrade plan to apply (from planUpgrade).
 * @param opts - Options (e.g. recompose).
 */
export function applyUpgrade(
  home: string,
  bundleDir: string,
  plan: UpgradePlan,
  opts: ApplyUpgradeOptions = {},
): UpgradeResult {
  const result: UpgradeResult = {
    migrationsApplied: [],
    contentUpdated: [],
    toolsRegistered: [],
    staleAnimaCount: plan.staleAnimas.length,
    recomposedAnimas: [],
  };

  // ── Update content artifacts ──────────────────────────────────────

  for (const update of plan.contentUpdates) {
    const parentDir = update.category === 'curricula'
      ? 'training/curricula'
      : 'training/temperaments';
    const targetDir = path.join(home, parentDir, update.name);
    const sourceDir = path.resolve(bundleDir, update.bundlePath);

    // Remove old content and copy new
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    copyDir(sourceDir, targetDir);

    // Update guild.json entry
    const config = readGuildConfig(home);
    if (config[update.category][update.name]) {
      config[update.category][update.name]!.installedAt = new Date().toISOString();
      if (plan.bundleSource) {
        config[update.category][update.name]!.bundle = plan.bundleSource;
      }
    }
    writeGuildConfig(home, config);

    result.contentUpdated.push(`${update.category}/${update.name}`);
  }

  // ── Register new tools/engines ──────────────────────────────────────

  if (plan.newTools.length > 0) {
    const config = readGuildConfig(home);
    const now = new Date().toISOString();

    for (const tool of plan.newTools) {
      // Register in the guild's tool/engine catalog
      config[tool.category][tool.name] = {
        upstream: null,
        installedAt: now,
        package: tool.package.replace(/@[^@/]+$/, ''), // strip version from specifier
        ...(plan.bundleSource ? { bundle: plan.bundleSource } : {}),
      };

      // Add to each declared role's tool list
      for (const roleName of tool.roles) {
        const role = config.roles[roleName];
        if (role && !role.tools.includes(tool.name)) {
          role.tools.push(tool.name);
        }
      }

      result.toolsRegistered.push(`${tool.category}/${tool.name}`);
    }

    writeGuildConfig(home, config);
  }

  // ── Recompose stale animas ─────────────────────────────────────────

  if (opts.recompose && plan.staleAnimas.length > 0) {
    for (const staleAnima of plan.staleAnimas) {
      // Read the full detail before retiring (need curriculum/temperament names)
      const db = new Database(booksPath(home));
      db.pragma('foreign_keys = ON');
      let curriculumName: string | undefined;
      let temperamentName: string | undefined;
      try {
        const comp = db.prepare(`
          SELECT curriculum_name, temperament_name
          FROM anima_compositions WHERE anima_id = ?
        `).get(staleAnima.id) as {
          curriculum_name: string | null;
          temperament_name: string | null;
        } | undefined;
        curriculumName = comp?.curriculum_name || undefined;
        temperamentName = comp?.temperament_name || undefined;
      } finally {
        db.close();
      }

      // Retire the old anima and rename it to free up the name.
      // The retired anima keeps a timestamped name for audit trail.
      removeAnima(home, staleAnima.id);
      const retiredName = `${staleAnima.name} (retired ${new Date().toISOString().slice(0, 19)})`;
      const renameDb = new Database(booksPath(home));
      renameDb.prepare(`UPDATE animas SET name = ? WHERE id = ?`).run(retiredName, staleAnima.id);
      renameDb.close();

      // Recreate with the same name, roles, curriculum, and temperament
      instantiate({
        home,
        name: staleAnima.name,
        roles: staleAnima.roles,
        curriculum: curriculumName,
        temperament: temperamentName,
      });

      result.recomposedAnimas.push(staleAnima.name);
    }
  }

  return result;
}

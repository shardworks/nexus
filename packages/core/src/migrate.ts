/**
 * Database migration — applies pending SQL migrations to the guild's Books.
 *
 * Core framework migrations ship with the `@shardworks/nexus-core` package
 * and are applied automatically when the Books are opened (unless the guild
 * opts out via `settings.autoMigrate: false` in guild.json).
 *
 * Migrations are numbered sequentially (001-schema.sql, etc.) and applied in
 * order. The module tracks which migrations have been applied in a
 * `_migrations` table and only runs new ones.
 *
 * ## Migration sources
 *
 * 1. **Core migrations** — bundled with nexus-core, define the framework schema.
 * 2. **Guild migrations** — in the guild's `nexus/migrations/` directory, for
 *    guild-specific schema extensions delivered by bundles.
 *
 * ## Migration file naming
 *
 * Files must match the pattern: NNN-description.sql
 * where NNN is a zero-padded sequence number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';

/** A migration file discovered on disk. */
export interface MigrationFile {
  /** Sequence number (e.g. 1, 2, 3). */
  sequence: number;
  /** Full filename (e.g. '001-initial-schema.sql'). */
  filename: string;
  /** Absolute path to the file. */
  path: string;
}

/** Provenance metadata for migrations installed via bundles. */
export interface MigrationProvenance {
  /** Bundle that delivered this migration (e.g. "@shardworks/guild-starter-kit@0.1.5"). */
  bundle: string;
  /** Original filename in the bundle before renumbering (e.g. "001-initial-schema.sql"). */
  originalName: string;
}

/** Result of applying migrations. */
export interface MigrateResult {
  /** Migrations that were applied in this run. */
  applied: string[];
  /** Migrations that were already applied (skipped). */
  skipped: string[];
  /** Total number of migrations on disk. */
  total: number;
}

/** Pattern for migration filenames: NNN-description.sql */
const MIGRATION_PATTERN = /^(\d{3})-(.+)\.sql$/;

/**
 * Resolve the path to core's bundled migrations directory.
 *
 * In development (running from src/), this is `../../migrations/` relative
 * to this file. When published (running from dist/), it's `../migrations/`.
 * We check both locations.
 */
function coreMigrationsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);

  // Published layout: dist/migrate.js → ../migrations/
  const fromDist = path.resolve(thisDir, '..', 'migrations');
  if (fs.existsSync(fromDist)) return fromDist;

  // Dev layout: src/migrate.ts → ../migrations/
  const fromSrc = path.resolve(thisDir, '..', 'migrations');
  if (fs.existsSync(fromSrc)) return fromSrc;

  // Shouldn't happen, but don't crash — return a nonexistent path
  // and let discoverMigrations() handle it gracefully.
  return fromDist;
}

/**
 * Ensure the _migrations tracking table exists.
 *
 * This table is NOT part of the regular schema migrations — it's the
 * module's own bookkeeping, created on first use.
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      sequence        INTEGER PRIMARY KEY,
      filename        TEXT    NOT NULL,
      applied_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      bundle          TEXT,
      original_name   TEXT
    );
  `);

  // Add provenance columns if upgrading from an older schema.
  // SQLite errors on duplicate ADD COLUMN, so check first.
  const cols = db.pragma('table_info(_migrations)') as { name: string }[];
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('bundle')) {
    db.exec(`ALTER TABLE _migrations ADD COLUMN bundle TEXT;`);
  }
  if (!colNames.has('original_name')) {
    db.exec(`ALTER TABLE _migrations ADD COLUMN original_name TEXT;`);
  }
}

/**
 * Discover migration files in a directory, sorted by sequence.
 */
export function discoverMigrations(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const files = fs.readdirSync(migrationsDir);
  const migrations: MigrationFile[] = [];

  for (const file of files) {
    const match = file.match(MIGRATION_PATTERN);
    if (!match) continue;

    migrations.push({
      sequence: parseInt(match[1]!, 10),
      filename: file,
      path: path.join(migrationsDir, file),
    });
  }

  // Sort by sequence number
  migrations.sort((a, b) => a.sequence - b.sequence);
  return migrations;
}

/**
 * Get the set of already-applied migration sequence numbers.
 */
function getAppliedSequences(db: Database.Database): Set<number> {
  const rows = db.prepare(
    `SELECT sequence FROM _migrations ORDER BY sequence`,
  ).all() as { sequence: number }[];
  return new Set(rows.map(r => r.sequence));
}

/**
 * Apply pending migrations from a list of migration files.
 *
 * Low-level function that applies migrations to an already-open database.
 * Used by both `applyCoreMigrations` and `applyMigrations`.
 */
function applyMigrationFiles(
  db: Database.Database,
  migrations: MigrationFile[],
  applied: Set<number>,
  provenance?: Record<string, MigrationProvenance>,
): MigrateResult {
  const result: MigrateResult = {
    applied: [],
    skipped: [],
    total: migrations.length,
  };

  for (const migration of migrations) {
    if (applied.has(migration.sequence)) {
      result.skipped.push(migration.filename);
      continue;
    }

    // Read and apply the migration.
    // PRAGMAs can't run inside transactions, so extract them and run separately.
    const sql = fs.readFileSync(migration.path, 'utf-8');
    const pragmaPattern = /^\s*PRAGMA\s+[^;]+;\s*$/gmi;
    const pragmas = sql.match(pragmaPattern) || [];
    const body = sql.replace(pragmaPattern, '').trim();

    for (const pragma of pragmas) {
      db.exec(pragma);
    }

    const prov = provenance?.[migration.filename];

    db.transaction(() => {
      if (body) db.exec(body);
      db.prepare(
        `INSERT INTO _migrations (sequence, filename, bundle, original_name) VALUES (?, ?, ?, ?)`,
      ).run(
        migration.sequence,
        migration.filename,
        prov?.bundle ?? null,
        prov?.originalName ?? null,
      );
    })();

    result.applied.push(migration.filename);
  }

  return result;
}

/**
 * Apply pending core framework migrations to the guild's Books.
 *
 * Core migrations are bundled with the nexus-core package and define
 * the framework's required schema (sessions, commissions, writs, etc.).
 *
 * @param home - Absolute path to the guild root.
 * @returns Summary of what was applied and skipped.
 */
export function applyCoreMigrations(home: string): MigrateResult {
  const migrations = discoverMigrations(coreMigrationsDir());

  if (migrations.length === 0) {
    return { applied: [], skipped: [], total: 0 };
  }

  const dbPath = booksPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  try {
    ensureMigrationsTable(db);
    const applied = getAppliedSequences(db);
    return applyMigrationFiles(db, migrations, applied);
  } finally {
    db.close();
  }
}

/**
 * Apply pending guild-local migrations to the guild's Books.
 *
 * Guild-local migrations live in `nexus/migrations/` within the guild
 * directory and are delivered by bundles for guild-specific schema extensions.
 *
 * @param home - Absolute path to the guild root.
 * @param provenance - Optional map of guild filename → bundle provenance.
 * @returns Summary of what was applied and skipped.
 */
export function applyMigrations(
  home: string,
  provenance?: Record<string, MigrationProvenance>,
): MigrateResult {
  const migrationsDir = path.join(home, 'nexus', 'migrations');
  const dbPath = booksPath(home);

  // Discover available migrations
  const migrations = discoverMigrations(migrationsDir);

  if (migrations.length === 0) {
    return { applied: [], skipped: [], total: 0 };
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  try {
    ensureMigrationsTable(db);
    const applied = getAppliedSequences(db);
    return applyMigrationFiles(db, migrations, applied, provenance);
  } finally {
    db.close();
  }
}

// ── Auto-migration ──────────────────────────────────────────────────────

/** Track which guild roots have been auto-migrated this process. */
const migratedThisProcess = new Set<string>();

/**
 * Ensure the guild's Books database has all pending core migrations applied.
 *
 * Called automatically before database access. Reads `settings.autoMigrate`
 * from guild.json (defaults to `true`). Skips if auto-migration is disabled
 * or if this guild was already migrated in the current process.
 *
 * @param home - Absolute path to the guild root.
 * @returns The migrations that were applied, or null if skipped.
 */
export function ensureBooks(home: string): MigrateResult | null {
  const resolved = path.resolve(home);
  if (migratedThisProcess.has(resolved)) return null;

  const config = readGuildConfig(home);
  const autoMigrate = config.settings?.autoMigrate ?? true;

  if (!autoMigrate) {
    migratedThisProcess.add(resolved);
    return null;
  }

  const result = applyCoreMigrations(home);
  migratedThisProcess.add(resolved);

  if (result.applied.length > 0) {
    console.error(
      `Books: applied ${result.applied.length} pending migration(s): ${result.applied.join(', ')}`,
    );
  }

  return result;
}

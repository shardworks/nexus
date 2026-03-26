/**
 * Anima CRUD — list, show, update, and remove operations for guild animas.
 *
 * Create is handled by instantiate.ts (complex composition logic).
 * Read-by-name is handled by manifest.ts's readAnima() (used at manifest time).
 * This module provides the remaining CRUD surface.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { generateId } from './id.ts';

// ── Types ──────────────────────────────────────────────────────────────

export interface AnimaSummary {
  id: string;
  name: string;
  status: string;
  roles: string[];
  createdAt: string;
}

export interface AnimaDetail {
  id: string;
  name: string;
  status: string;
  roles: string[];
  curriculumName: string;
  curriculumVersion: string;
  temperamentName: string;
  temperamentVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListAnimasOptions {
  status?: string;
  role?: string;
}

export interface UpdateAnimaOptions {
  status?: string;
  roles?: string[];
}

/** Staleness info for a single training content axis (curriculum or temperament). */
export interface StalenessInfo {
  /** Version baked into the anima's composition. */
  composedVersion: string;
  /** Version currently on disk. */
  currentVersion: string;
}

/** Staleness check result for an anima. */
export interface AnimaStaleness {
  /** Whether the anima has any stale content. */
  stale: boolean;
  /** Curriculum staleness (null if current or no curriculum). */
  curriculum: StalenessInfo | null;
  /** Temperament staleness (null if current or no temperament). */
  temperament: StalenessInfo | null;
}

// ── Functions ──────────────────────────────────────────────────────────

/**
 * Resolve the name of the first active anima holding a given role.
 *
 * If multiple animas share the role, one is selected arbitrarily (lowest id).
 * Throws if no active anima holds the role.
 */
export function resolveAnimaByRole(home: string, role: string): string {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const row = db.prepare(`
      SELECT a.name FROM animas a
      JOIN roster r ON r.anima_id = a.id
      WHERE r.role = ? AND a.status = 'active'
      ORDER BY a.id ASC
      LIMIT 1
    `).get(role) as { name: string } | undefined;

    if (!row) {
      throw new Error(`No active anima found for role "${role}".`);
    }
    return row.name;
  } finally {
    db.close();
  }
}

/**
 * List animas with optional filters.
 */
export function listAnimas(home: string, opts: ListAnimasOptions = {}): AnimaSummary[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT a.id, a.name, a.status, a.created_at FROM animas a`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.role) {
      query += ` JOIN roster r ON r.anima_id = a.id`;
      conditions.push(`r.role = ?`);
      params.push(opts.role);
    }

    if (opts.status) {
      conditions.push(`a.status = ?`);
      params.push(opts.status);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` GROUP BY a.id ORDER BY a.created_at`;

    const rows = db.prepare(query).all(...params) as {
      id: string; name: string; status: string; created_at: string;
    }[];

    // Fetch roles for each anima
    const getRoles = db.prepare(`SELECT role FROM roster WHERE anima_id = ? ORDER BY role`);

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      roles: (getRoles.all(row.id) as { role: string }[]).map(r => r.role),
      createdAt: row.created_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * Show detailed information about a single anima by ID.
 */
export function showAnima(home: string, animaId: string): AnimaDetail | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT a.id, a.name, a.status, a.created_at, a.updated_at,
              c.curriculum_name, c.curriculum_version,
              c.temperament_name, c.temperament_version
       FROM animas a
       LEFT JOIN anima_compositions c ON c.anima_id = a.id
       WHERE a.id = ? OR a.name = ?`,
    ).get(animaId, animaId) as {
      id: string; name: string; status: string; created_at: string; updated_at: string;
      curriculum_name: string | null; curriculum_version: string | null;
      temperament_name: string | null; temperament_version: string | null;
    } | undefined;

    if (!row) return null;

    const roles = (db.prepare(
      `SELECT role FROM roster WHERE anima_id = ? ORDER BY role`,
    ).all(row.id) as { role: string }[]).map(r => r.role);

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      roles,
      curriculumName: row.curriculum_name ?? '',
      curriculumVersion: row.curriculum_version ?? '',
      temperamentName: row.temperament_name ?? '',
      temperamentVersion: row.temperament_version ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

/**
 * Update an anima's status and/or roles.
 */
export function updateAnima(
  home: string,
  animaId: string,
  opts: UpdateAnimaOptions,
): AnimaDetail {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    return db.transaction(() => {
      // Resolve by id or name
      const existing = db.prepare(
        `SELECT id, name FROM animas WHERE id = ? OR name = ?`,
      ).get(animaId, animaId) as { id: string; name: string } | undefined;

      if (!existing) {
        throw new Error(`Anima "${animaId}" not found.`);
      }

      if (opts.status) {
        db.prepare(
          `UPDATE animas SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(opts.status, existing.id);
      }

      if (opts.roles) {
        // Replace all roles
        db.prepare(`DELETE FROM roster WHERE anima_id = ?`).run(existing.id);
        const insertRole = db.prepare(
          `INSERT INTO roster (id, anima_id, role) VALUES (?, ?, ?)`,
        );
        for (const role of opts.roles) {
          insertRole.run(generateId('r'), existing.id, role);
        }
      }

      // Audit
      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('aud'), 'operator', 'anima_updated', 'anima', existing.id,
        JSON.stringify(opts),
      );

      // Read updated record inline (same connection, inside transaction)
      const row = db.prepare(
        `SELECT a.id, a.name, a.status, a.created_at, a.updated_at,
                c.curriculum_name, c.curriculum_version,
                c.temperament_name, c.temperament_version
         FROM animas a
         LEFT JOIN anima_compositions c ON c.anima_id = a.id
         WHERE a.id = ?`,
      ).get(existing.id) as {
        id: string; name: string; status: string; created_at: string; updated_at: string;
        curriculum_name: string | null; curriculum_version: string | null;
        temperament_name: string | null; temperament_version: string | null;
      };

      const roles = (db.prepare(
        `SELECT role FROM roster WHERE anima_id = ? ORDER BY role`,
      ).all(existing.id) as { role: string }[]).map(r => r.role);

      return {
        id: row.id,
        name: row.name,
        status: row.status,
        roles,
        curriculumName: row.curriculum_name ?? '',
        curriculumVersion: row.curriculum_version ?? '',
        temperamentName: row.temperament_name ?? '',
        temperamentVersion: row.temperament_version ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    })();
  } finally {
    db.close();
  }
}

/**
 * Read the version from a training content descriptor on disk.
 * Returns 'unknown' if the descriptor is missing or has no version.
 */
function readTrainingVersion(
  home: string,
  category: 'curricula' | 'temperaments',
  name: string,
): string | null {
  const descriptorFile = category === 'curricula'
    ? 'nexus-curriculum.json'
    : 'nexus-temperament.json';
  const parentDir = category === 'curricula' ? 'training/curricula' : 'training/temperaments';
  const descriptorPath = path.join(home, parentDir, name, descriptorFile);

  if (!fs.existsSync(descriptorPath)) return null;
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'));
    return (descriptor.version as string) || 'unknown';
  } catch {
    return null;
  }
}

/**
 * Check whether an anima's composition is stale (using outdated training content).
 *
 * Compares the curriculum and temperament versions baked into the anima's
 * composition against the versions currently on disk.
 */
export function checkAnimaStaleness(home: string, animaId: string): AnimaStaleness | null {
  const detail = showAnima(home, animaId);
  if (!detail) return null;

  let curriculum: StalenessInfo | null = null;
  let temperament: StalenessInfo | null = null;

  if (detail.curriculumName) {
    const currentVersion = readTrainingVersion(home, 'curricula', detail.curriculumName);
    if (currentVersion && currentVersion !== detail.curriculumVersion) {
      curriculum = { composedVersion: detail.curriculumVersion, currentVersion };
    }
  }

  if (detail.temperamentName) {
    const currentVersion = readTrainingVersion(home, 'temperaments', detail.temperamentName);
    if (currentVersion && currentVersion !== detail.temperamentVersion) {
      temperament = { composedVersion: detail.temperamentVersion, currentVersion };
    }
  }

  return {
    stale: curriculum !== null || temperament !== null,
    curriculum,
    temperament,
  };
}

/**
 * Check staleness for all active animas at once.
 * Returns a map of anima ID → staleness info, only including stale animas.
 */
export function checkAllAnimaStaleness(home: string): Map<string, AnimaStaleness> {
  const result = new Map<string, AnimaStaleness>();

  // Build the current version map once (avoid repeated disk reads)
  const versionCache = new Map<string, string | null>();
  function getCachedVersion(category: 'curricula' | 'temperaments', name: string): string | null {
    const key = `${category}:${name}`;
    if (!versionCache.has(key)) {
      versionCache.set(key, readTrainingVersion(home, category, name));
    }
    return versionCache.get(key)!;
  }

  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const animas = db.prepare(`
      SELECT a.id, a.name,
             c.curriculum_name, c.curriculum_version,
             c.temperament_name, c.temperament_version
      FROM animas a
      LEFT JOIN anima_compositions c ON c.anima_id = a.id
      WHERE a.status = 'active'
    `).all() as {
      id: string; name: string;
      curriculum_name: string | null; curriculum_version: string | null;
      temperament_name: string | null; temperament_version: string | null;
    }[];

    for (const anima of animas) {
      let curriculum: StalenessInfo | null = null;
      let temperament: StalenessInfo | null = null;

      if (anima.curriculum_name && anima.curriculum_version) {
        const currentVersion = getCachedVersion('curricula', anima.curriculum_name);
        if (currentVersion && currentVersion !== anima.curriculum_version) {
          curriculum = { composedVersion: anima.curriculum_version, currentVersion };
        }
      }

      if (anima.temperament_name && anima.temperament_version) {
        const currentVersion = getCachedVersion('temperaments', anima.temperament_name);
        if (currentVersion && currentVersion !== anima.temperament_version) {
          temperament = { composedVersion: anima.temperament_version, currentVersion };
        }
      }

      if (curriculum || temperament) {
        result.set(anima.id, { stale: true, curriculum, temperament });
      }
    }
  } finally {
    db.close();
  }

  return result;
}

/**
 * Remove (retire) an anima. Sets status to 'retired' and removes roster entries.
 */
export function removeAnima(home: string, animaId: string): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    db.transaction(() => {
      const existing = db.prepare(
        `SELECT id, name FROM animas WHERE id = ? OR name = ?`,
      ).get(animaId, animaId) as { id: string; name: string } | undefined;

      if (!existing) {
        throw new Error(`Anima "${animaId}" not found.`);
      }

      db.prepare(
        `UPDATE animas SET status = 'retired', updated_at = datetime('now') WHERE id = ?`,
      ).run(existing.id);

      db.prepare(`DELETE FROM roster WHERE anima_id = ?`).run(existing.id);

      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('aud'), 'operator', 'anima_removed', 'anima', existing.id,
        JSON.stringify({ name: existing.name }),
      );
    })();
  } finally {
    db.close();
  }
}

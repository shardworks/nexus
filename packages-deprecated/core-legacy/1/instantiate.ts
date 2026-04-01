/**
 * instantiate — core logic for creating new animas.
 *
 * Creates an anima record in the Register with its full composition: roles,
 * curriculum, and temperament. Reads and snapshots the training content at
 * instantiation time so the anima's composition is frozen to specific versions.
 *
 * Role validation:
 * - Each role must be defined in guild.json — hard error if not.
 * - Each role's seat capacity is checked — hard error if exceeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';
import { generateId } from './id.ts';

export interface InstantiateOptions {
  /** Absolute path to the guild root. */
  home: string;
  /** Name for the new anima. Must be unique within the guild. */
  name: string;
  /** Roles the anima will hold (determines implement access via role gating). */
  roles: string[];
  /** Curriculum to assign (by name, must be registered in guild.json). */
  curriculum?: string;
  /** Temperament to assign (by name, must be registered in guild.json). */
  temperament?: string;
}

export interface InstantiateResult {
  animaId: string;
  name: string;
  roles: string[];
  curriculum: string | null;
  temperament: string | null;
}

/**
 * Read training content from disk given its guild.json entry.
 *
 * @param guildRoot - Path to the guild root.
 * @param category - 'curricula' or 'temperaments'.
 * @param name - The training content name.
 * @returns Object with version and the actual content text.
 */
function readTrainingContent(
  guildRoot: string,
  category: 'curricula' | 'temperaments',
  name: string,
): { version: string; content: string } {
  const dir = path.join(guildRoot, 'training', category, name);
  const descriptorFile = category === 'curricula'
    ? 'nexus-curriculum.json'
    : 'nexus-temperament.json';
  const descriptorPath = path.join(dir, descriptorFile);

  if (!fs.existsSync(descriptorPath)) {
    throw new Error(
      `${category.slice(0, -1)} "${name}" not found on disk at ${dir}`,
    );
  }

  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'));
  const contentFile = descriptor.content as string;
  const contentPath = path.join(dir, contentFile);

  if (!fs.existsSync(contentPath)) {
    throw new Error(
      `Content file "${contentFile}" not found for ${category.slice(0, -1)} "${name}" at ${contentPath}`,
    );
  }

  const version = (descriptor.version as string) || 'unknown';

  return {
    version,
    content: fs.readFileSync(contentPath, 'utf-8'),
  };
}

/**
 * Instantiate a new anima in the guild.
 *
 * Creates the anima record, assigns roles in the roster, and snapshots the
 * composition (curriculum + temperament content at current versions). All
 * operations happen in a single transaction.
 *
 * Role validation:
 * - Every role must be defined in guild.json.roles — throws if undefined.
 * - Seat capacity is checked — throws if assigning this anima would exceed
 *   the role's seat limit.
 */
export function instantiate(opts: InstantiateOptions): InstantiateResult {
  const { home, name, roles, curriculum, temperament } = opts;
  if (roles.length === 0) {
    throw new Error('At least one role is required.');
  }

  // Validate curriculum and temperament exist in guild.json
  const config = readGuildConfig(home);

  // Validate all roles exist in guild.json
  for (const role of roles) {
    if (!config.roles[role]) {
      throw new Error(
        `Role "${role}" is not defined in guild.json. ` +
        `Available roles: ${Object.keys(config.roles).join(', ') || '(none)'}`,
      );
    }
  }

  if (curriculum && !config.curricula[curriculum]) {
    throw new Error(
      `Curriculum "${curriculum}" not found in guild.json. Available: ${Object.keys(config.curricula).join(', ') || '(none)'}`,
    );
  }

  if (temperament && !config.temperaments[temperament]) {
    throw new Error(
      `Temperament "${temperament}" not found in guild.json. Available: ${Object.keys(config.temperaments).join(', ') || '(none)'}`,
    );
  }

  // Read and snapshot training content
  let curriculumSnapshot: { name: string; version: string; content: string } | null = null;
  if (curriculum) {
    const { version, content } = readTrainingContent(home, 'curricula', curriculum);
    curriculumSnapshot = { name: curriculum, version, content };
  }

  let temperamentSnapshot: { name: string; version: string; content: string } | null = null;
  if (temperament) {
    const { version, content } = readTrainingContent(home, 'temperaments', temperament);
    temperamentSnapshot = { name: temperament, version, content };
  }

  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const result = db.transaction(() => {
      // Check name uniqueness
      const existing = db.prepare(
        `SELECT id FROM animas WHERE name = ?`,
      ).get(name) as { id: string } | undefined;

      if (existing) {
        throw new Error(`Anima "${name}" already exists in the Register.`);
      }

      // Validate seat capacity for each role
      for (const role of roles) {
        const roleDef = config.roles[role]!;
        if (roleDef.seats !== null) {
          const currentCount = (db.prepare(
            `SELECT COUNT(*) as count FROM roster r JOIN animas a ON r.anima_id = a.id WHERE r.role = ? AND a.status = 'active'`,
          ).get(role) as { count: number }).count;

          if (currentCount >= roleDef.seats) {
            throw new Error(
              `Role "${role}" is full — ${roleDef.seats} seat${roleDef.seats === 1 ? '' : 's'}, ` +
              `${currentCount} occupied. Cannot assign another anima.`,
            );
          }
        }
      }

      // Create anima
      const animaId = generateId('a');
      db.prepare(
        `INSERT INTO animas (id, name, status) VALUES (?, ?, 'active')`,
      ).run(animaId, name);

      // Assign roles in roster
      const insertRole = db.prepare(
        `INSERT INTO roster (id, anima_id, role) VALUES (?, ?, ?)`,
      );
      for (const role of roles) {
        insertRole.run(generateId('r'), animaId, role);
      }

      // Record composition snapshot
      db.prepare(
        `INSERT INTO anima_compositions (id, anima_id, curriculum_name, curriculum_version, curriculum_snapshot, temperament_name, temperament_version, temperament_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('ac'),
        animaId,
        curriculumSnapshot?.name ?? '',
        curriculumSnapshot?.version ?? '',
        curriculumSnapshot?.content ?? '',
        temperamentSnapshot?.name ?? '',
        temperamentSnapshot?.version ?? '',
        temperamentSnapshot?.content ?? '',
      );

      // Audit log
      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('aud'),
        'instantiate',
        'anima_instantiated',
        'anima',
        animaId,
        JSON.stringify({ roles, curriculum: curriculum ?? null, temperament: temperament ?? null }),
      );

      return animaId;
    })();

    return {
      animaId: result as string,
      name,
      roles,
      curriculum: curriculum ?? null,
      temperament: temperament ?? null,
    };
  } finally {
    db.close();
  }
}

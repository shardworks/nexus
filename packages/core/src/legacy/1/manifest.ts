/**
 * Manifest — assembles an anima's identity for a session.
 *
 * Reads the anima's composition from the Register (roles, curricula, temperament),
 * resolves tools by role gating and precondition checks, reads all prompt
 * ingredients from disk, and assembles the composed system prompt.
 *
 * The manifest is the anima's *identity*: who are you, what can you do.
 * The *user prompt* (commission spec, brief, conversation topic) is NOT part
 * of the manifest — it comes from the caller.
 *
 * Absorbed from the former `engine-manifest` package. MCP config generation
 * is NOT here — that's a transport detail owned by session providers.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';
import { readPreconditions, checkPreconditions } from './preconditions.ts';
import { resolveToolFromExport } from './tool.ts';
import type { GuildConfig, ToolEntry } from './guild-config.ts';

/** Extract the npm package name from a package specifier that may include a subpath. */
function basePackageName(pkg: string): string {
  // Scoped: @scope/name/subpath → @scope/name
  if (pkg.startsWith('@')) {
    const parts = pkg.split('/');
    return parts.slice(0, 2).join('/');
  }
  // Unscoped: name/subpath → name
  return pkg.split('/')[0]!;
}

// ── Types ──────────────────────────────────────────────────────────────

/** An anima's record from the Register, including composition metadata. */
export interface AnimaRecord {
  id: string;
  name: string;
  status: string;
  roles: string[];
  curriculumName: string;
  curriculumVersion: string;
  curriculumSnapshot: string;
  temperamentName: string;
  temperamentVersion: string;
  temperamentSnapshot: string;
}

/** A resolved tool that the anima has access to. */
export interface ResolvedTool {
  /** Tool name — how the anima sees it. */
  name: string;
  /** Absolute path to the tool's directory on disk. */
  path: string;
  /** Instructions content (if instructions.md exists). */
  instructions: string | null;
  /** npm package name for runtime resolution, or null for file-path resolution. */
  package: string | null;
}

/** A tool that was resolved by role but failed precondition checks. */
export interface UnavailableTool {
  /** Tool name. */
  name: string;
  /** Human-readable reasons why the tool is unavailable. */
  reasons: string[];
}

/** The fully-resolved manifest for an anima session. */
export interface ManifestResult {
  /** The anima record from the Register. */
  anima: AnimaRecord;
  /** The composed system prompt for the anima. */
  systemPrompt: string;
  /** The individual ingredients that produced the system prompt. */
  composition: {
    codex: string;
    roleInstructions: string;
    curriculum: { name: string; version: string; content: string } | null;
    temperament: { name: string; version: string; content: string } | null;
    toolInstructions: Array<{ toolName: string; instructions: string }>;
  };
  /** Resolved tools the anima has access to. */
  tools: ResolvedTool[];
  /** Tools that matched the anima's roles but failed precondition checks. */
  unavailable: UnavailableTool[];
  /** Warnings generated during manifest (e.g. undefined roles). */
  warnings: string[];
}

// ── Core Functions ─────────────────────────────────────────────────────

/**
 * Read an anima's full record from the Register, including roles and composition.
 */
export function readAnima(home: string, animaName: string): AnimaRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    // Get anima
    const anima = db.prepare(
      `SELECT id, name, status FROM animas WHERE name = ?`,
    ).get(animaName) as { id: string; name: string; status: string } | undefined;

    if (!anima) {
      throw new Error(`Anima "${animaName}" not found in the Register.`);
    }

    // Get roles
    const roleRows = db.prepare(
      `SELECT role FROM roster WHERE anima_id = ? ORDER BY role`,
    ).all(anima.id) as { role: string }[];
    const roles = roleRows.map(r => r.role);

    // Get composition — now includes name/version metadata
    const composition = db.prepare(
      `SELECT curriculum_name, curriculum_version, curriculum_snapshot,
              temperament_name, temperament_version, temperament_snapshot
       FROM anima_compositions WHERE anima_id = ?`,
    ).get(anima.id) as {
      curriculum_name: string;
      curriculum_version: string;
      curriculum_snapshot: string;
      temperament_name: string;
      temperament_version: string;
      temperament_snapshot: string;
    } | undefined;

    return {
      id: anima.id,
      name: anima.name,
      status: anima.status,
      roles,
      curriculumName: composition?.curriculum_name ?? '',
      curriculumVersion: composition?.curriculum_version ?? '',
      curriculumSnapshot: composition?.curriculum_snapshot ?? '',
      temperamentName: composition?.temperament_name ?? '',
      temperamentVersion: composition?.temperament_version ?? '',
      temperamentSnapshot: composition?.temperament_snapshot ?? '',
    };
  } finally {
    db.close();
  }
}

/**
 * Resolve the set of tools an anima has access to, based on role
 * definitions and precondition checks.
 *
 * 1. Start with baseTools (available to all animas)
 * 2. For each anima role, look up the role in guild.json.roles
 *    - If defined: union in that role's tools
 *    - If undefined: warn and skip (no tools, no instructions from that role)
 * 3. Deduplicate tool names
 * 4. Resolve each tool from guild.json.tools catalog
 * 5. Run precondition checks — split into available and unavailable
 *
 * Returns available tools, unavailable tools, and any warnings.
 */
export async function resolveTools(
  home: string,
  config: GuildConfig,
  animaRoles: string[],
): Promise<{ available: ResolvedTool[]; unavailable: UnavailableTool[]; warnings: string[] }> {
  const warnings: string[] = [];

  // Collect tool names: start with base, union in role-specific
  const toolNames = new Set<string>(config.baseTools ?? []);

  for (const role of animaRoles) {
    const roleDef = config.roles[role];
    if (!roleDef) {
      warnings.push(
        `Role "${role}" is assigned to this anima but not defined in guild.json. ` +
        `No tools or instructions from this role will be available.`,
      );
      continue;
    }
    for (const toolName of roleDef.tools) {
      toolNames.add(toolName);
    }
  }

  // Resolve each tool from the catalog
  const available: ResolvedTool[] = [];
  const unavailable: UnavailableTool[] = [];

  for (const name of toolNames) {
    const entry = config.tools[name] as ToolEntry | undefined;
    if (!entry) {
      warnings.push(
        `Tool "${name}" is referenced by a role or baseTools but not found in guild.json.tools. Skipping.`,
      );
      continue;
    }

    // Resolve on-disk path
    const toolPath = path.join(home, 'tools', name);
    const descriptorPath = path.join(toolPath, 'nexus-tool.json');

    // Check preconditions before including in the available set
    const preconditions = readPreconditions(descriptorPath);
    if (preconditions.length > 0) {
      const results = checkPreconditions(preconditions);
      const failures = results.filter(r => !r.passed).map(r => r.message!);
      if (failures.length > 0) {
        unavailable.push({ name, reasons: failures });
        continue;
      }
    }

    // Read instructions from multiple sources, in priority order:
    // 1. Descriptor file on disk (nexus-tool.json → instructions field)
    // 2. Tool definition (import module → instructions or instructionsFile)
    let instructions: string | null = null;

    // Source 1: descriptor file on disk
    if (fs.existsSync(descriptorPath)) {
      try {
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'));
        if (descriptor.instructions) {
          const instructionsPath = path.join(toolPath, descriptor.instructions);
          if (fs.existsSync(instructionsPath)) {
            instructions = fs.readFileSync(instructionsPath, 'utf-8');
          }
        }
      } catch {
        // If descriptor is unreadable, skip instructions from descriptor
      }
    }

    // Source 2: tool definition (for collection packages or tools with
    // inline instructions / instructionsFile in the tool() definition)
    if (!instructions && entry.package) {
      try {
        const mod = await import(entry.package);
        const toolDef = resolveToolFromExport(mod.default, name);
        if (toolDef) {
          if (toolDef.instructions) {
            // Inline instructions text
            instructions = toolDef.instructions;
          } else if (toolDef.instructionsFile) {
            // File path relative to the package root in node_modules.
            const instrPath = path.join(
              home, 'node_modules', basePackageName(entry.package), toolDef.instructionsFile,
            );
            if (fs.existsSync(instrPath)) {
              instructions = fs.readFileSync(instrPath, 'utf-8');
            }
          }
        }
      } catch {
        // If import fails, skip — instructions are optional
      }
    }

    available.push({
      name,
      path: toolPath,
      instructions,
      package: entry.package ?? null,
    });
  }

  return { available, unavailable, warnings };
}

/**
 * Read codex documents from the guildhall — guild-wide policy for all animas.
 *
 * Reads all .md files in the codex/ directory (non-recursive top level).
 */
export function readCodex(home: string): string {
  const codexDir = path.join(home, 'codex');

  if (!fs.existsSync(codexDir)) return '';

  const sections: string[] = [];

  // Read top-level .md files (included for all animas)
  for (const entry of fs.readdirSync(codexDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = fs.readFileSync(path.join(codexDir, entry.name), 'utf-8').trim();
      if (content) sections.push(content);
    }
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Read role-specific instructions for an anima's roles.
 *
 * For each role the anima holds, reads the instructions file pointed to by
 * the role definition in guild.json. Skips undefined roles (warning already
 * emitted by resolveTools). Skips roles without instructions.
 */
export function readRoleInstructions(
  home: string,
  config: GuildConfig,
  animaRoles: string[],
): string {
  const sections: string[] = [];

  for (const role of animaRoles) {
    const roleDef = config.roles[role];
    if (!roleDef || !roleDef.instructions) continue;

    const instructionsPath = path.join(home, roleDef.instructions);
    if (!fs.existsSync(instructionsPath)) continue;

    try {
      const content = fs.readFileSync(instructionsPath, 'utf-8').trim();
      if (content) {
        sections.push(content);
      }
    } catch {
      // If unreadable, skip
    }
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Assemble the composed system prompt for an anima session.
 *
 * Sections are included in order: codex → role instructions → curricula →
 * temperament → tool instructions → unavailable tools notice.
 * Empty sections are omitted.
 */
export function assembleSystemPrompt(
  codex: string,
  roleInstructions: string,
  anima: AnimaRecord,
  tools: ResolvedTool[],
  unavailable: UnavailableTool[] = [],
): string {
  const sections: string[] = [];

  // Codex — guild-wide policies and procedures
  if (codex.trim()) {
    sections.push(`# Codex\n\n${codex}`);
  }

  // Role instructions — role-specific operational guidance
  if (roleInstructions.trim()) {
    sections.push(`# Role Instructions\n\n${roleInstructions}`);
  }

  // Curricula — the anima's training content
  if (anima.curriculumSnapshot.trim()) {
    sections.push(`# Training\n\n${anima.curriculumSnapshot}`);
  }

  // Temperament — the anima's personality
  if (anima.temperamentSnapshot.trim()) {
    sections.push(`# Temperament\n\n${anima.temperamentSnapshot}`);
  }

  // Tool instructions — guidance for each tool the anima has access to
  const toolInstructions = tools
    .filter(t => t.instructions)
    .map(t => t.instructions!);

  if (toolInstructions.length > 0) {
    sections.push(`# Tool Instructions\n\n${toolInstructions.join('\n\n---\n\n')}`);
  }

  // Unavailable tools notice — tell the anima what's broken and why
  if (unavailable.length > 0) {
    const notices = unavailable.map(u => {
      const reasons = u.reasons.map(r => `  - ${r}`).join('\n');
      return `**${u.name}** — unavailable:\n${reasons}`;
    });
    sections.push(
      `# Unavailable Tools\n\n` +
      `The following tools are registered for your roles but are currently ` +
      `unavailable due to unmet environment requirements. Do not attempt to use them. ` +
      `If a patron or operator asks you to perform work that requires these tools, ` +
      `explain what is needed to make them available.\n\n` +
      notices.join('\n\n'),
    );
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Manifest an anima for a session.
 *
 * This is the main entry point. Reads the anima's composition, resolves
 * tools by role, assembles the system prompt, and returns the full
 * manifest with composition provenance.
 */
export async function manifest(home: string, animaName: string): Promise<ManifestResult> {
  const config = readGuildConfig(home);
  const anima = readAnima(home, animaName);

  if (anima.status !== 'active') {
    throw new Error(
      `Anima "${animaName}" is not active (status: ${anima.status}). Cannot manifest.`,
    );
  }

  // Resolve tools based on role definitions + precondition checks
  const { available, unavailable, warnings } = await resolveTools(home, config, anima.roles);

  // Read codex (guild-wide, no role filtering)
  const codex = readCodex(home);

  // Read role-specific instructions
  const roleInstructions = readRoleInstructions(home, config, anima.roles);

  // Assemble system prompt (includes role instructions and unavailability notices)
  const systemPrompt = assembleSystemPrompt(codex, roleInstructions, anima, available, unavailable);

  // Build composition provenance
  const curriculum = anima.curriculumName
    ? { name: anima.curriculumName, version: anima.curriculumVersion, content: anima.curriculumSnapshot }
    : null;

  const temperament = anima.temperamentName
    ? { name: anima.temperamentName, version: anima.temperamentVersion, content: anima.temperamentSnapshot }
    : null;

  const toolInstructions = available
    .filter(t => t.instructions)
    .map(t => ({ toolName: t.name, instructions: t.instructions! }));

  return {
    anima,
    systemPrompt,
    composition: {
      codex,
      roleInstructions,
      curriculum,
      temperament,
      toolInstructions,
    },
    tools: available,
    unavailable,
    warnings,
  };
}

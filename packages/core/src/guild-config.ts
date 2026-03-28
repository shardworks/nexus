import fs from 'node:fs';
import path from 'node:path';

/** Definition of a guild role — a structural position in the guild. */
export interface RoleDefinition {
  /**
   * Maximum number of animas that can hold this role simultaneously.
   * `null` means unbounded.
   */
  seats: number | null;
  /** Tools available to animas in this role (additive with baseTools). */
  tools: string[];
  /**
   * Path to role-specific instructions markdown, relative to guild root.
   * Read fresh at manifest time and delivered to animas holding this role.
   */
  instructions?: string;
}

/** A custom event declaration in guild.json clockworks.events. */
export interface EventDeclaration {
  /** Human-readable description of what this event means. */
  description?: string;
  /** Optional payload schema hint (not enforced in Phase 1). */
  schema?: Record<string, string>;
}

/** A writ type declaration in guild.json. */
export interface WritTypeDeclaration {
  /** Human-readable description of this writ type. */
  description: string;
}

/** A standing order — a registered response to an event. */
export type StandingOrder =
  | { on: string; run: string }
  | { on: string; summon: string; prompt?: string }
  | { on: string; brief: string };

/** The clockworks configuration block in guild.json. */
export interface ClockworksConfig {
  /** Custom event declarations. */
  events?: Record<string, EventDeclaration>;
  /** Standing orders — event → action mappings. */
  standingOrders?: StandingOrder[];
}

/** A registered workshop — a repository where the guild does its work. */
export interface WorkshopEntry {
  /** Git remote URL (the clone source). */
  remoteUrl: string;
  /** ISO-8601 timestamp of when the workshop was added. */
  addedAt: string;
}

/** Guild-level settings — operational flags and preferences. */
export interface GuildSettings {
  /**
   * Default LLM model for anima sessions (e.g. 'sonnet', 'opus').
   * Replaces the top-level `model` field from GuildConfig V1.
   */
  model?: string;
  /**
   * Automatically apply pending database migrations when the Books are opened.
   * Defaults to `true` when not specified. Set to `false` to require explicit
   * migration via `nsg guild upgrade-books`.
   */
  autoMigrate?: boolean;
}

/**
 * Guild configuration — V2.
 *
 * The rig-centric model: rigs are npm packages; capabilities (tools, engines,
 * training content) are declared by rigs and discovered dynamically at runtime.
 * No per-capability registries — `config.rigs` + `node_modules` is the source
 * of truth. The default model moves into `settings`.
 *
 * Breaking change from GuildConfig (V1): drops `tools`, `engines`, `curricula`,
 * `temperaments`, and top-level `model`. Requires `rigs` (was optional).
 */
export interface GuildConfigV2 {
  /** Guild name — used as the guildhall npm package name. */
  name: string;
  /** Installed Nexus framework version. */
  nexus: string;
  /** Registered workshops indexed by name. */
  workshops: Record<string, WorkshopEntry>;
  /** Guild roles — structural positions that animas fill. */
  roles: Record<string, RoleDefinition>;
  /** Tool names available to all animas regardless of role. */
  baseTools: string[];
  /** Installed rig keys (derived from npm package names). Always present; starts empty. */
  rigs: string[];
  /** Clockworks configuration — events, standing orders. */
  clockworks?: ClockworksConfig;
  /** Writ types declared by this guild. Built-in types (mandate, summon) are implicit. */
  writTypes?: Record<string, WritTypeDeclaration>;
  /** Guild-level settings — operational flags and preferences. Includes default model. */
  settings?: GuildSettings;
}

/**
 * Create the default guild.json content for a new V2 guild.
 * All collections start empty. The default model is stored in settings.
 */
export function createInitialGuildConfigV2(name: string, nexusVersion: string, model: string): GuildConfigV2 {
  return {
    name,
    nexus: nexusVersion,
    workshops: {},
    roles: {},
    baseTools: [],
    rigs: [],
    settings: { model },
  };
}

/** Read and parse a V2 guild.json from the guild root. */
export function readGuildConfigV2(home: string): GuildConfigV2 {
  const configFile = guildConfigPath(home);
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as GuildConfigV2;
}

/** Write a V2 guild.json to the guild root. */
export function writeGuildConfigV2(home: string, config: GuildConfigV2): void {
  const configFile = guildConfigPath(home);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

/** Resolve the path to guild.json in the guild root. */
export function guildConfigPath(home: string): string {
  return path.join(home, 'guild.json');
}


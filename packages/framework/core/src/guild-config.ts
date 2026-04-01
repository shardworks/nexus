import fs from 'node:fs';
import path from 'node:path';

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
 * Guild configuration.
 *
 * The plugin-centric model: plugins are npm packages; capabilities (tools, engines,
 * training content) are declared by plugins and discovered dynamically at runtime.
 * Framework-level keys (`name`, `nexus`, `plugins`, `settings`) are defined here;
 * all other top-level keys are plugin configuration sections, keyed by plugin id.
 */
export interface GuildConfig {
  /** Guild name — used as the guildhall npm package name. */
  name: string;
  /** Installed Nexus framework version. */
  nexus: string;
  /** Registered workshops indexed by name. */
  workshops: Record<string, WorkshopEntry>;
  /** Installed plugin ids (derived from npm package names). Always present; starts empty. */
  plugins: string[];
  /** Clockworks configuration — events, standing orders. */
  clockworks?: ClockworksConfig;
  /** Writ types declared by this guild. Built-in types (mandate, summon) are implicit. */
  writTypes?: Record<string, WritTypeDeclaration>;
  /** Guild-level settings — operational flags and preferences. Includes default model. */
  settings?: GuildSettings;
}

/**
 * Create the default guild.json content for a new guild.
 * All collections start empty. The default model is stored in settings.
 */
export function createInitialGuildConfig(name: string, nexusVersion: string, model: string): GuildConfig {
  return {
    name,
    nexus: nexusVersion,
    workshops: {},
    plugins: [],
    settings: { model },
  };
}

/** Read and parse guild.json from the guild root. */
export function readGuildConfig(home: string): GuildConfig {
  const configFile = guildConfigPath(home);
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as GuildConfig;
}

/** Write guild.json to the guild root. */
export function writeGuildConfig(home: string, config: GuildConfig): void {
  const configFile = guildConfigPath(home);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

/** Resolve the path to guild.json in the guild root. */
export function guildConfigPath(home: string): string {
  return path.join(home, 'guild.json');
}


/**
 * GuildConfig V1 — legacy guild.json shape.
 *
 * Kept here for backward compatibility with code written before the rig-centric
 * model (GuildConfigV2). New code should import from the top-level guild-config.ts
 * and use GuildConfigV2.
 *
 * V1 vs V2 differences:
 *   - V1 has explicit per-capability registries: tools, engines, curricula, temperaments
 *   - V1 has a top-level `model` field (moved to settings.model in V2)
 *   - V1 has `rigs?: string[]` (optional); V2 has `rigs: string[]` (required)
 */

import fs from 'node:fs';
import { guildConfigPath } from '../../guild-config.ts';
import type {
  InstalledCapability,
  WorkshopEntry,
  RoleDefinition,
  ClockworksConfig,
  WritTypeDeclaration,
  GuildSettings,
} from '../../guild-config.ts';

// Re-export all shared types so legacy code can import them from this module
export * from '../../guild-config.ts';

// Backward-compat aliases — ToolEntry and TrainingEntry were merged into InstalledCapability.
export type { InstalledCapability as ToolEntry, InstalledCapability as TrainingEntry } from '../../guild-config.ts';

/**
 * Guild configuration — V1 (legacy).
 *
 * @deprecated Use GuildConfigV2 for new guilds.
 */
export interface GuildConfig {
  name: string;
  nexus: string;
  /** Top-level model — moved to settings.model in V2. */
  model: string;
  workshops: Record<string, WorkshopEntry>;
  roles: Record<string, RoleDefinition>;
  baseTools: string[];
  /** Explicit tool registry — removed in V2 (tools are discovered from rig modules). */
  tools: Record<string, InstalledCapability>;
  /** Explicit engine registry — removed in V2. */
  engines: Record<string, InstalledCapability>;
  /** Explicit curricula registry — removed in V2. */
  curricula: Record<string, InstalledCapability>;
  /** Explicit temperaments registry — removed in V2. */
  temperaments: Record<string, InstalledCapability>;
  clockworks?: ClockworksConfig;
  writTypes?: Record<string, WritTypeDeclaration>;
  settings?: GuildSettings;
  /** Optional in V1; required in V2. */
  rigs?: string[];
}

/**
 * Create a default V1 guild.json.
 * @deprecated Use createInitialGuildConfigV2 for new guilds.
 */
export function createInitialGuildConfig(name: string, nexusVersion: string, model: string): GuildConfig {
  return {
    name,
    nexus: nexusVersion,
    model,
    workshops: {},
    roles: {},
    baseTools: [],
    tools: {},
    engines: {},
    curricula: {},
    temperaments: {},
  };
}

/**
 * Read and parse a V1 guild.json from the guild root.
 * @deprecated Use readGuildConfigV2 for new guilds.
 */
export function readGuildConfig(home: string): GuildConfig {
  const configFile = guildConfigPath(home);
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as GuildConfig;
}

/**
 * Write a V1 guild.json to the guild root.
 * @deprecated Use writeGuildConfigV2 for new guilds.
 */
export function writeGuildConfig(home: string, config: GuildConfig): void {
  const configFile = guildConfigPath(home);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

// @shardworks/nexus-core — public SDK surface

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json');
export const VERSION: string = _pkg.version;

// ── Promoted modules — canonical source lives here at top-level ────────

export {
  // Plugin/Kit/Apparatus model
  type Kit,
  type Apparatus,
  type Plugin,
  type LoadedKit,
  type LoadedApparatus,
  type LoadedPlugin,
  type StartupContext,
  isKit,
  isApparatus,
  isLoadedKit,
  isLoadedApparatus,
} from './plugin.ts';

// Guild — the process-level singleton for accessing guild infrastructure.
export {
  type Guild,
  guild,
  setGuild,
  clearGuild,
} from './guild.ts';

// Transitional: BookOptions moves to nexus-books apparatus when that ships.
export { type BookOptions } from './books.ts';

export {
  findGuildRoot,
  nexusDir,
  worktreesPath,
  workshopsPath,
  workshopBarePath,
  clockPidPath,
  clockLogPath,
} from './nexus-home.ts';

export {
  derivePluginId,
  readGuildPackageJson,
  resolvePackageNameForPluginId,
  resolveGuildPackageEntry,
} from './resolve-package.ts';

export {
  type GuildConfig,
  createInitialGuildConfig,
  readGuildConfig,
  writeGuildConfig,
  type WorkshopEntry,
  type EventDeclaration,
  type StandingOrder,
  type ClockworksConfig,
  type WritTypeDeclaration,
  type GuildSettings,
  guildConfigPath,
} from './guild-config.ts';

// ── Session provider registry ─────────────────────────────────────────

export {
  type ManifestResult,
  type SessionChunk,
  type SessionProvider,
  type SessionProviderLaunchOptions,
  type SessionProviderResult,
  registerSessionProvider,
  getSessionProvider,
} from './session-provider.ts';

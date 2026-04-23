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
  type FailedPlugin,
  type StartupContext,
  type KitEntry,
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

export {
  findGuildRoot,
  nexusDir,
  worktreesPath,
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
  type EventDeclaration,
  type StandingOrder,
  type ClockworksConfig,
  type GuildSettings,
  guildConfigPath,
} from './guild-config.ts';

export { generateId, shortId } from './id.ts';

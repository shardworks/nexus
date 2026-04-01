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
  type ToolCaller,
  type ToolDefinition,
  tool,
  isToolDefinition,
  resolveToolFromExport,
} from './tool.ts';

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
  discoverPluginTools,
} from './resolve-package.ts';

export {
  type GuildConfig,
  createInitialGuildConfig,
  readGuildConfig,
  writeGuildConfig,
  type RoleDefinition,
  type WorkshopEntry,
  type EventDeclaration,
  type StandingOrder,
  type ClockworksConfig,
  type WritTypeDeclaration,
  type GuildSettings,
  guildConfigPath,
} from './guild-config.ts';

// ── Legacy modules ────────────────────────────────────────────────────
// V1 APIs (clockworks, writs, animas, workshops, etc.) are available at
// the @shardworks/nexus-core/legacy/1 subpath. They are NOT re-exported
// from this barrel. Import from '@shardworks/nexus-core/legacy/1' directly.

// Session provider registry — slim singleton that lives in core so clock-daemon
// can import it without creating a circular dependency with nexus-sessions.
// The full session funnel (launchSession, listSessions, etc.) lives in nexus-sessions.
export {
  type SessionChunk,
  type SessionProvider,
  type SessionProviderLaunchOptions,
  type SessionProviderResult,
  registerSessionProvider,
  getSessionProvider,
} from './session-provider.ts';

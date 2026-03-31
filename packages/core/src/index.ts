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
  type GuildContext,
  type HandlerContext,
  isKit,
  isApparatus,
  isLoadedKit,
  isLoadedApparatus,
} from './plugin.ts';

// Transitional: BookOptions moves to nexus-books apparatus when that ships.
export { type BookOptions } from './books.ts';

export {
  type Book,
  type ReadOnlyBook,
  type BookQuery,
  type ListOptions,
  type Pagination,
} from './book.ts';

// HandlerContext supersedes RigContext — re-exported from rig-context.ts for continuity.
export { type HandlerContext as RigContext } from './rig-context.ts';

export {
  type ToolCaller,
  type ToolDefinition,
  tool,
  isToolDefinition,
  resolveToolFromExport,
  resolveAllToolsFromExport,
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
  // V2 — plugin-centric model (canonical for new guilds)
  type GuildConfigV2,
  createInitialGuildConfigV2,
  readGuildConfigV2,
  writeGuildConfigV2,
  // Shared types (V1 and V2)
  type RoleDefinition,
  type WorkshopEntry,
  type EventDeclaration,
  type StandingOrder,
  type ClockworksConfig,
  type WritTypeDeclaration,
  type GuildSettings,
  guildConfigPath,
} from './guild-config.ts';

// ── Legacy modules — not yet promoted, still live in legacy/1 ─────────

export {
  type GuildEvent,
  type EngineContext,
  type EngineDefinition,
  engine,
  isClockworkEngine,
  resolveEngineFromExport,
} from './legacy/1/engine.ts';

export {
  signalEvent,
  validateCustomEvent,
  isFrameworkEvent,
  readPendingEvents,
  readEvent,
  markEventProcessed,
  recordDispatch,
  type ListEventsOptions,
  type DispatchRecord,
  type ListDispatchesOptions,
  listEvents,
  listDispatches,
} from './legacy/1/events.ts';

export {
  type TickResult,
  type DispatchSummary,
  type ClockRunResult,
  type ClockStartOptions,
  type ClockStartResult,
  type ClockStopResult,
  type ClockStatus,
  clockTick,
  clockRun,
  clockStart,
  clockStop,
  clockStatus,
  desugarOrder,
  extractParams,
} from './legacy/1/clockworks.ts';

export {
  type InstallToolOptions,
  type InstallResult,
  type SourceKind,
  classifySource,
  installTool,
} from './legacy/1/install-tool.ts';

export {
  type RemoveToolOptions,
  type RemoveResult,
  removeTool,
} from './legacy/1/remove-tool.ts';

export {
  type InstantiateOptions,
  type InstantiateResult,
  instantiate,
} from './legacy/1/instantiate.ts';

export { initGuild } from './legacy/1/init-guild.ts';

export {
  type BundleManifest,
  type BundlePackageEntry,
  type BundleContentEntry,
  type BundleMigrationEntry,
  type InstallBundleOptions,
  type InstallBundleResult,
  readBundleManifest,
  installBundle,
  isBundleDir,
} from './legacy/1/bundle.ts';

export {
  type RehydrateResult,
  rehydrate,
} from './legacy/1/rehydrate.ts';

export {
  type AddWorkshopOptions,
  type AddWorkshopResult,
  type RemoveWorkshopOptions,
  type WorkshopInfo,
  type WorkshopDetail,
  type CreateWorkshopOptions,
  addWorkshop,
  removeWorkshop,
  listWorkshops,
  showWorkshop,
  createWorkshop,
  checkGhAuth,
  deriveWorkshopName,
} from './legacy/1/workshop.ts';

export {
  type Precondition,
  type CommandPrecondition,
  type CommandOutputPrecondition,
  type EnvPrecondition,
  type PreconditionCheckResult,
  type ToolPreconditionResult,
  readPreconditions,
  checkOne,
  checkPreconditions,
  checkAllPreconditions,
  checkToolPreconditions,
} from './legacy/1/preconditions.ts';

export {
  type WorktreeConfig,
  type WorktreeResult,
  setupWorktree,
  teardownWorktree,
  listWorktrees,
} from './legacy/1/worktree.ts';

export {
  type MigrationFile,
  type MigrationProvenance,
  type MigrateResult,
  discoverMigrations,
  applyMigrations,
  applyCoreMigrations,
  ensureBooks,
} from './legacy/1/migrate.ts';

export {
  type AnimaRecord,
  type ResolvedTool,
  type UnavailableTool,
  type ManifestResult,
  readAnima,
  resolveTools,
  readCodex,
  readRoleInstructions,
  assembleSystemPrompt,
  manifest,
} from './legacy/1/manifest.ts';

export {
  type SessionProvider,
  type SessionProviderLaunchOptions,
  type SessionProviderResult,
  type SessionLaunchOptions,
  type SessionResult,
  type SessionChunk,
  type WorkspaceContext,
  type ResolvedWorkspace,
  type SessionRecord,
  type SessionSummary,
  type SessionDetail,
  type ListSessionsOptions,
  registerSessionProvider,
  getSessionProvider,
  resolveWorkspace,
  createTempWorktree,
  removeTempWorktree,
  launchSession,
  listSessions,
  countSessionsForWrit,
  showSession,
} from './legacy/1/session.ts';

export {
  type ConversationChunk,
  type CreateConversationOptions,
  type CreateConversationResult,
  type ConversationSummary,
  type ConversationDetail,
  type ListConversationsOptions,
  createConversation,
  takeTurn,
  endConversation,
  nextParticipant,
  listConversations,
  showConversation,
  formatConveneMessage,
} from './legacy/1/conversation.ts';

export {
  type UpgradePlan,
  type UpgradeResult,
  type ApplyUpgradeOptions,
  type MigrationPlanEntry,
  type ContentUpdateEntry,
  type ToolPlanEntry,
  type StaleAnimaEntry,
  planUpgrade,
  applyUpgrade,
} from './legacy/1/upgrade.ts';

export { generateId } from './legacy/1/id.ts';

export {
  type AnimaSummary,
  type AnimaDetail,
  type ListAnimasOptions,
  type UpdateAnimaOptions,
  type AnimaStaleness,
  type StalenessInfo,
  resolveAnimaByRole,
  listAnimas,
  showAnima,
  updateAnima,
  removeAnima,
  checkAnimaStaleness,
  checkAllAnimaStaleness,
} from './legacy/1/anima.ts';

export {
  type ToolSummary,
  listTools,
} from './legacy/1/tool-registry.ts';

export {
  type WritRecord,
  type WritStatus,
  type CreateWritOptions,
  type ListWritsOptions,
  type WritChildSummary,
  BUILTIN_WRIT_TYPES,
  validateWritType,
  createWrit,
  readWrit,
  listWrits,
  activateWrit,
  completeWrit,
  adminCompleteWrit,
  failWrit,
  cancelWrit,
  interruptWrit,
  reopenFailedWrit,
  rollupParent,
  getWritChildren,
  buildProgressAppendix,
  hydratePromptTemplate,
} from './legacy/1/writ.ts';

export {
  type AuditEntry,
  type ListAuditLogOptions,
  listAuditLog,
} from './legacy/1/audit.ts';

/**
 * Framework commands — hardcoded CLI commands that work with or without a guild.
 *
 * These are guild lifecycle and plugin management commands that the CLI
 * registers directly, bypassing plugin discovery. They are the CLI's own
 * commands, not tools contributed by kits or apparatus.
 *
 * Plugin-contributed tools are discovered at runtime via The Instrumentarium
 * when a guild is present and the tools apparatus is installed.
 */

import type { ToolDefinition } from '@shardworks/nexus-core';
import init from './init.ts';
import version from './version.ts';
import status from './status.ts';
import upgrade from './upgrade.ts';
import { pluginList, pluginInstall, pluginRemove, pluginUpgrade } from './plugin.ts';

/** All framework commands, typed as the base ToolDefinition for uniform handling. */
export const frameworkCommands = [
  init,
  version,
  status,
  upgrade,
  pluginList,
  pluginInstall,
  pluginRemove,
  pluginUpgrade,
] as ToolDefinition[];

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

import type { Command } from 'commander';
import type { ToolDefinition } from '@shardworks/tools-apparatus';
import init from './init.ts';
import version from './version.ts';
import status from './status.ts';
import upgrade from './upgrade.ts';
import start from './start.ts';
import stop from './stop.ts';
import { pluginList, pluginInstall, pluginRemove, pluginUpgrade } from './plugin.ts';
import { buildSignalCommand } from './signal.ts';
import { buildClockCommand } from './clock.ts';

/** All framework commands, typed as the base ToolDefinition for uniform handling. */
export const frameworkCommands = [
  init,
  version,
  status,
  upgrade,
  start,
  stop,
  pluginList,
  pluginInstall,
  pluginRemove,
  pluginUpgrade,
] as ToolDefinition[];

/**
 * Hand-written Commander commands that bypass the tool auto-builder.
 *
 * These exist for commands whose CLI shape (positional arguments,
 * locally-parsed flag values, custom emitter defaults, …) does not fit
 * the Zod-driven option generator in `program.ts`. Each entry is a
 * factory that returns a fully-configured Command — the CLI registers
 * them alongside the auto-built framework and plugin commands.
 *
 * Currently: `nsg signal`, `nsg clock` (see those files for the
 * rationale on each).
 */
export const customFrameworkCommands: Array<() => Command> = [
  buildSignalCommand,
  buildClockCommand,
];

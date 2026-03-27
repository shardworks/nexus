import path from 'node:path';
import { findGuildRoot, ensureBooks } from '@shardworks/nexus-core';

/** Minimal interface for reading global options from any Commander command. */
interface CommandLike {
  optsWithGlobals(): Record<string, unknown>;
}

/**
 * Resolve the guild root from a command's parent options or auto-detection.
 *
 * Reads `--guild-root` from the root program's options. If not set, walks
 * up from cwd looking for guild.json.
 *
 * Also ensures the Books database has all pending core migrations applied
 * (unless the guild has `settings.autoMigrate: false`).
 */
export function resolveHome(cmd: CommandLike): string {
  const rootOpts = cmd.optsWithGlobals() as { guildRoot?: string };
  const home = rootOpts.guildRoot ? path.resolve(rootOpts.guildRoot) : findGuildRoot();
  ensureBooks(home);
  return home;
}

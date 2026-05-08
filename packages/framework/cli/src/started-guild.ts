/**
 * CLI-internal carrier for the `StartedGuild` returned by
 * `createGuild()`.
 *
 * The `Guild` accessor in `@shardworks/nexus-core` deliberately
 * narrows away `shutdown()` because plugin code has no legitimate
 * reason to tear down the guild it is running inside (commission
 * decision D1). The bootstrap caller — `program.ts` — does have a
 * reason: when a long-lived foreground command (the `nsg start`
 * unified daemon, or the standalone `nsg clock start --foreground`
 * daemon) finishes, the SIGTERM/SIGINT handler must invoke
 * `shutdown()` on the way out so every apparatus's optional
 * `stop()` runs and handles get released.
 *
 * The threading channel used to be implicit (handlers called
 * `guild()` and trusted the singleton). With the lifecycle contract
 * in place, the daemon handlers need the richer `StartedGuild` value;
 * this module is where `program.ts` deposits it for those handlers to
 * read without changing the `tool({ … })` factory's signature.
 *
 * Per D8 the threading is explicit: `program.ts` sets, the start
 * tool's handler gets. There is no transparent fallback to the
 * `guild()` singleton — if no one called `setStartedGuild()` the
 * accessor returns `undefined` and the daemon decides what to do.
 */

import type { StartedGuild } from '@shardworks/nexus-core';

let _started: StartedGuild | undefined;

/** Record the `StartedGuild` returned by Arbor's `createGuild()`. */
export function setStartedGuild(g: StartedGuild): void {
  _started = g;
}

/**
 * Read the `StartedGuild` deposited by `program.ts`. Returns
 * `undefined` when no guild has been started in this process —
 * callers in daemon paths should treat that as a fail-loud
 * misconfiguration.
 */
export function getStartedGuild(): StartedGuild | undefined {
  return _started;
}

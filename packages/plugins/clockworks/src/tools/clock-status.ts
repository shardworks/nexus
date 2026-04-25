import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';

import { clockStatus } from '../daemon.ts';

/**
 * `clock-status` — anima-facing read of the Clockworks daemon status.
 *
 * Animas call this tool to discover whether the unattended Clockworks
 * daemon is currently processing events. The shape returned matches
 * the structured payload of `nsg clock status --json` so the patron
 * and anima surfaces stay aligned. Read-only — no side effects beyond
 * the side effect that `clockStatus` itself owns (it unlinks a stale
 * pidfile when one is detected, exactly as it would for a patron call).
 *
 * The tool is restricted to `callableBy: ['anima']` so the patron-facing
 * CLI auto-builder does not register a duplicate `nsg clock-status`
 * command — the patron surface is the hand-written `nsg clock status`
 * subcommand in the framework CLI.
 *
 * No parameters: the daemon is per-guild, the guild is implied by the
 * resolving call to `guild()`, and there's no second consumer that
 * would earn additional knobs (e.g. verbose, tail).
 */
export default tool({
  name: 'clock-status',
  description: 'Report whether the Clockworks daemon is running.',
  instructions:
    'Returns the structured status of the Clockworks daemon: whether ' +
    "it is running, and (when running) the daemon's pid, log file " +
    'path, and uptime in milliseconds. Read-only.',
  callableBy: ['anima'],
  params: {},
  handler: async () => {
    const home = guild().home;
    return clockStatus(home);
  },
});

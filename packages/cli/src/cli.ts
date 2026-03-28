#!/usr/bin/env node

/**
 * nsg — new entry point, built on the rig architecture.
 *
 * Dynamically discovers installed tools via rig, registers them as Commander
 * commands, and delegates argument parsing and invocation to Commander.
 *
 * Tools are filtered to those with 'cli' in allowedChannels (or no allowedChannels
 * set, which defaults to all channels). Tools marked 'mcp'-only are invisible here.
 *
 * nsg1 is the legacy entry point (src/v1/cli.ts) — fully preserved and functional.
 * The guild continues to use nsg1 for anything not yet migrated. Over time, nsg1
 * is retired as commands migrate to nsg.
 */

import { main } from './program.ts';

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

#!/usr/bin/env node

/**
 * nsg — CLI entry point, built on the plugin architecture.
 *
 * Dynamically discovers installed tools via plugins, registers them as Commander
 * commands, and delegates argument parsing and invocation to Commander.
 *
 * Tools are filtered to those with 'cli' in callableBy (or no callableBy
 * set, which defaults to all callers). Tools marked 'anima'-only are invisible here.
 */

import { main } from './program.ts';

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

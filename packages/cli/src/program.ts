/**
 * nsg program — dynamic Commander setup via rig tool resolution.
 *
 * Discovers installed tools at startup via resolveGuildCommands(), then
 * registers each as a Commander command with auto-generated options from
 * its Zod param schema.
 *
 * Commander lives here; rig handles all manifest and import logic.
 */

import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { findGuildRoot, createRig } from '@shardworks/nexus-rig';
import type { NexusTool } from '@shardworks/nexus-rig';

type ZodShape = Record<string, z.ZodTypeAny>;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Convert camelCase key to kebab-case CLI flag.
 * e.g. 'writId' → '--writ-id'
 */
function toFlag(key: string): string {
  return `--${key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Register a NexusTool as a Commander subcommand.
 *
 * Generates options from the Zod param shape. Commander converts kebab-case
 * flags back to camelCase in opts(), matching the tool's schema keys directly.
 *
 * The action handler validates params through the tool's Zod schema before
 * calling the handler — Zod error messages are surfaced cleanly.
 */
function registerToolCommand(
  program: Command,
  toolDef: NexusTool,
  home: string,
): void {
  const cmd = new Command(toolDef.name).description(toolDef.description);

  const shape = toolDef.params.shape as ZodShape;
  for (const [key, schema] of Object.entries(shape)) {
    const flag = toFlag(key);
    const description = schema.description ?? key;

    // Optional fields get .option(); required fields get .requiredOption().
    // The tool's Zod schema does the actual validation before the handler runs.
    if (schema.isOptional()) {
      cmd.option(`${flag} <value>`, description);
    } else {
      cmd.requiredOption(`${flag} <value>`, description);
    }
  }

  cmd.action(async (opts: Record<string, string | undefined>) => {
    try {
      const validated = toolDef.params.parse(opts);
      const result = await toolDef.handler(validated, { home });

      const output =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      console.log(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

  program.addCommand(cmd);
}

// ── Entry ──────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // Pre-parse to extract --guild-root before tool discovery.
  // Commander can't load tool commands without the guild root, so we need
  // this value before building the full program.
  const pre = new Command()
    .option('--guild-root <path>', 'Guild root directory')
    .allowUnknownOption()
    .exitOverride();

  try {
    pre.parse(process.argv);
  } catch {
    // Ignore errors — we only care about --guild-root
  }

  const preOpts = pre.opts() as { guildRoot?: string };

  const program = new Command('nsg')
    .description('Nexus Mk 2.1 — rig-powered guild CLI')
    .option('--guild-root <path>', 'Guild root directory (default: auto-detect from cwd)');

  // Discover guild and load tools. Failing gracefully keeps nsg usable
  // outside of a guild (e.g. for nsg init in a future commission).
  let home: string | undefined;
  try {
    home = preOpts.guildRoot
      ? path.resolve(preOpts.guildRoot)
      : findGuildRoot();
  } catch {
    // Not in a guild — no tool commands available
  }

  if (home) {
    const rig = createRig(home);
    const tools = await rig.listTools({ channel: 'cli' });
    for (const toolDef of tools) {
      registerToolCommand(program, toolDef, home);
    }
  }

  program.parse(process.argv);
}

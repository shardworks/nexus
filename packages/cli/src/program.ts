/**
 * nsg program — dynamic Commander setup via rig tool resolution.
 *
 * Discovers installed tools at startup via the Rig, then registers each
 * as a Commander command with auto-generated options from its Zod param schema.
 *
 * Tool names are auto-grouped when multiple tools share a hyphen prefix:
 * 'plugin-list' + 'plugin-install' → 'nsg plugin list' / 'nsg plugin install'.
 * A tool like 'show-writ' stays flat ('nsg show-writ') since no other tool
 * starts with 'show-'.
 *
 * Commander lives here; rig handles all manifest and import logic.
 */

import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { findGuildRoot, createRig, builtinTools } from '@shardworks/nexus-rig';
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
 * Build a Commander command from a NexusTool.
 *
 * Generates options from the Zod param shape. Commander converts kebab-case
 * flags back to camelCase in opts(), matching the tool's schema keys directly.
 *
 * The action handler validates params through the tool's Zod schema before
 * calling the handler — Zod error messages are surfaced cleanly.
 */
function buildToolCommand(
  commandName: string,
  toolDef: NexusTool,
  home: string,
): Command {
  const cmd = new Command(commandName).description(toolDef.description);

  const shape = toolDef.params.shape as ZodShape;
  for (const [key, schema] of Object.entries(shape)) {
    const flag = toFlag(key);
    const description = schema.description ?? key;

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

  return cmd;
}

/**
 * Determine which hyphen prefixes have enough tools to warrant a group.
 *
 * Returns a Set of prefixes that have 2+ tools sharing them.
 * 'plugin-list' + 'plugin-install' → 'plugin' is a group.
 * 'show-writ' alone → 'show' is NOT a group.
 */
function findGroupPrefixes(tools: NexusTool[]): Set<string> {
  const prefixCounts = new Map<string, number>();

  for (const t of tools) {
    const idx = t.name.indexOf('-');
    if (idx === -1) continue;
    const prefix = t.name.slice(0, idx);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }

  const groups = new Set<string>();
  for (const [prefix, count] of prefixCounts) {
    if (count >= 2) groups.add(prefix);
  }
  return groups;
}

/**
 * Register all tools as Commander commands.
 *
 * Tools whose hyphen prefix appears in `groupPrefixes` are nested:
 * 'plugin-list' → 'nsg plugin list'.
 *
 * All other tools are registered flat:
 * 'show-writ' → 'nsg show-writ'.
 * 'signal' → 'nsg signal'.
 */
function registerAllTools(
  program: Command,
  tools: NexusTool[],
  home: string,
): void {
  const groupPrefixes = findGroupPrefixes(tools);
  const groups = new Map<string, Command>();

  for (const toolDef of tools) {
    const idx = toolDef.name.indexOf('-');

    // No hyphen, or prefix doesn't qualify as a group → flat command
    if (idx === -1 || !groupPrefixes.has(toolDef.name.slice(0, idx))) {
      program.addCommand(buildToolCommand(toolDef.name, toolDef, home));
      continue;
    }

    // Nested: split on first hyphen
    const groupName = toolDef.name.slice(0, idx);
    const subName = toolDef.name.slice(idx + 1);

    let group = groups.get(groupName);
    if (!group) {
      group = new Command(groupName).description(`${groupName} commands`);
      program.addCommand(group);
      groups.set(groupName, group);
    }

    group.addCommand(buildToolCommand(subName, toolDef, home));
  }
}

// ── Entry ──────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // Pre-parse to extract --guild-root before tool discovery.
  const pre = new Command()
    .option('--guild-root <path>', 'Guild root directory')
    .allowUnknownOption()
    .allowExcessArguments()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });

  try {
    pre.parse(process.argv);
  } catch {
    // Ignore errors — we only care about --guild-root
  }

  const preOpts = pre.opts() as { guildRoot?: string };

  const program = new Command('nsg')
    .description('Nexus Mk 2.1 — rig-powered guild CLI')
    .option('--guild-root <path>', 'Guild root directory (default: auto-detect from cwd)');

  // Discover guild root. Built-in rig commands work without a guild;
  // plugin tools only load when a guild is found.
  let home: string | undefined;
  try {
    home = preOpts.guildRoot
      ? path.resolve(preOpts.guildRoot)
      : findGuildRoot();
  } catch {
    // Not in a guild
  }

  // Always register rig built-in tools (version, status, plugin, upgrade).
  // These are framework commands that work with or without a guild.
  const rigPluginName = '@shardworks/nexus-rig';
  const builtins = builtinTools
    .filter((t) => !t.allowedContexts || t.allowedContexts.includes('cli'))
    .map((t) => ({ ...t, pluginName: rigPluginName }) as NexusTool);
  registerAllTools(program, builtins, home ?? process.cwd());

  // Load guild plugin tools when inside a guild
  if (home) {
    const rig = createRig(home);
    const tools = await rig.listTools({ channel: 'cli' });
    // Filter out rig built-ins (already registered above)
    const pluginTools = tools.filter((t) => t.pluginName !== rigPluginName);
    registerAllTools(program, pluginTools, home);
  }

  program.parse(process.argv);
}

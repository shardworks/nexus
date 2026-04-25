/**
 * nsg program — dynamic Commander setup.
 *
 * Two command sources:
 *
 * 1. **Framework commands** — hardcoded in the CLI package (init, status,
 *    version, upgrade, plugin management). Always available, even without
 *    a guild.
 *
 * 2. **Plugin tools** — discovered at runtime via The Instrumentarium
 *    (tools apparatus). Only available when a guild is present and the
 *    tools apparatus is installed.
 *
 * Tool names are auto-grouped when multiple tools share a hyphen prefix:
 * 'plugin-list' + 'plugin-install' → 'nsg plugin list' / 'nsg plugin install'.
 * A tool like 'show-writ' stays flat ('nsg show-writ') since no other tool
 * starts with 'show-'.
 */

import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { findGuildRoot, guild } from '@shardworks/nexus-core';
import type { ToolDefinition, InstrumentariumApi } from '@shardworks/tools-apparatus';
import { createGuild } from '@shardworks/nexus-arbor';
import { frameworkCommands, customFrameworkCommands } from './commands/index.ts';
import { toFlag, isBooleanSchema, isRepeatableSchema, findGroupPrefixes, coerceCliOpts, resolveGuildRoot } from './helpers.ts';

type ZodShape = Record<string, z.ZodTypeAny>;

/**
 * Build a Commander command from a ToolDefinition.
 *
 * Generates options from the Zod param shape. Commander converts kebab-case
 * flags back to camelCase in opts(), matching the tool's schema keys directly.
 *
 * The action handler validates params through the tool's Zod schema before
 * calling the handler — Zod error messages are surfaced cleanly.
 */
/**
 * Detect whether a Zod schema is a required string type (not optional, not defaulted).
 */
function isRequiredStringSchema(schema: z.ZodTypeAny): boolean {
  return !schema.isOptional() && schema.safeParse('test').success && !schema.safeParse(42).success;
}

/**
 * Detect if a tool has exactly one required string param that looks like an
 * identifier — named `id` or ending with `Id`. Returns the param key if found,
 * undefined otherwise. Additional required non-id-like string params (e.g.
 * `goal`, `conclusion`) do not block detection; only the id key is promoted
 * to the positional slot.
 *
 * Convention: when detected, the CLI registers this param as an optional
 * positional argument so `nsg click show <id>` works alongside `--id <id>`,
 * and `nsg click amend <id> --goal "..."` works alongside
 * `nsg click amend --id <id> --goal "..."`.
 *
 * Multiple id-like required strings (e.g. `click-link`'s `sourceId` and
 * `targetId`) are ambiguous — no positional is registered in that case.
 */
function detectPositionalId(shape: ZodShape): string | undefined {
  const idLikeRequiredKeys: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    if (isRequiredStringSchema(schema) && (key === 'id' || key.endsWith('Id'))) {
      idLikeRequiredKeys.push(key);
    }
  }
  // Exactly one id-like required param — unambiguous positional target.
  if (idLikeRequiredKeys.length === 1) return idLikeRequiredKeys[0];
  return undefined;
}

export function buildToolCommand(
  commandName: string,
  toolDef: ToolDefinition,
): Command {
  const cmd = new Command(commandName).description(toolDef.description);

  const shape = toolDef.params.shape as ZodShape;
  const positionalKey = detectPositionalId(shape);

  for (const [key, schema] of Object.entries(shape)) {
    const flag = toFlag(key);
    const description = schema.description ?? key;

    if (isBooleanSchema(schema)) {
      // Boolean flags: --flag (no <value>), sets to true when present
      cmd.option(flag, description);
    } else if (isRepeatableSchema(schema)) {
      // Repeatable flags: --flag val1 --flag val2 → collects into an array.
      // Always optional — a required array param doesn't make sense for CLI.
      cmd.option(
        `${flag} <value>`,
        description,
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      );
    } else if (key === positionalKey) {
      // Positional ID convention: register both as optional flag AND positional.
      // The flag is optional because the positional can supply the value.
      cmd.option(`${flag} <value>`, description);
    } else if (schema.isOptional()) {
      cmd.option(`${flag} <value>`, description);
    } else {
      cmd.requiredOption(`${flag} <value>`, description);
    }
  }

  // Add positional argument for the ID param (optional, since --flag still works)
  if (positionalKey) {
    cmd.argument(`[${positionalKey}]`, shape[positionalKey].description ?? positionalKey);
  }

  cmd.action(async (...args: unknown[]) => {
    try {
      // Commander passes positional args before opts. With one optional positional:
      // action(positionalValue, opts, cmd) or action(opts, cmd) if no positional defined
      let opts: Record<string, unknown>;
      let positionalValue: string | undefined;

      if (positionalKey) {
        positionalValue = args[0] as string | undefined;
        opts = args[1] as Record<string, unknown>;
      } else {
        opts = args[0] as Record<string, unknown>;
      }

      // Merge positional into opts — flag takes precedence over positional
      if (positionalKey && positionalValue && opts[positionalKey] === undefined) {
        opts[positionalKey] = positionalValue;
      }

      const coerced = coerceCliOpts(shape, opts);
      const validated = toolDef.params.parse(coerced);
      const result = await toolDef.handler(validated);

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
 * Register tool definitions as Commander commands.
 *
 * Tools whose hyphen prefix appears in `groupPrefixes` are nested:
 * 'plugin-list' → 'nsg plugin list'.
 *
 * All other tools are registered flat:
 * 'show-writ' → 'nsg show-writ'.
 * 'signal' → 'nsg signal'.
 */
function registerTools(
  program: Command,
  tools: ToolDefinition[],
): void {
  const groupPrefixes = findGroupPrefixes(tools);
  const groups = new Map<string, Command>();

  for (const toolDef of tools) {
    const idx = toolDef.name.indexOf('-');

    // No hyphen, or prefix doesn't qualify as a group → flat command
    if (idx === -1 || !groupPrefixes.has(toolDef.name.slice(0, idx))) {
      program.addCommand(buildToolCommand(toolDef.name, toolDef));
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

    group.addCommand(buildToolCommand(subName, toolDef));
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
    .description('Nexus Mk 2.1 — guild CLI')
    .option('--guild-root <path>', 'Guild root directory (default: $GUILD_ROOT or auto-detect from cwd)');

  // Discover guild root. Resolution order:
  //   1. --guild-root CLI flag (highest priority)
  //   2. GUILD_ROOT environment variable
  //   3. Auto-detect by walking up from cwd looking for guild.json
  // Framework commands work without a guild;
  // plugin tools only load when a guild with The Instrumentarium is found.
  const home = resolveGuildRoot(
    preOpts.guildRoot,
    process.env.GUILD_ROOT,
    findGuildRoot,
  );

  // Always register framework commands (init, status, version, upgrade,
  // plugin management). These work with or without a guild.
  registerTools(program, frameworkCommands);

  // Register hand-written framework commands that bypass the
  // tool→Commander auto-builder (e.g. `nsg signal`). Each factory
  // returns a fully-configured Command. These are always available so
  // their --help text is reachable even outside a guild; the handler
  // itself errors out if a guild is required.
  for (const buildCommand of customFrameworkCommands) {
    program.addCommand(buildCommand());
  }

  // Load plugin-contributed tools when inside a guild.
  // Tools are discovered via The Instrumentarium (tools apparatus).
  // If the guild doesn't have the tools apparatus installed, no plugin
  // tools are available — only framework commands.
  if (home) {
    try {
      await createGuild(home);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[nsg] Guild failed to load: ${message}`);
      console.warn('[nsg] Plugin-contributed commands are unavailable. Framework commands still work.');
    }

    try {
      const instrumentarium = guild().apparatus<InstrumentariumApi>('tools');
      const pluginTools = instrumentarium.list()
        .filter((r) => !r.definition.callableBy || r.definition.callableBy.includes('patron'))
        .map((r) => r.definition);
      registerTools(program, pluginTools);
    } catch {
      // No Instrumentarium installed or guild failed to load —
      // only framework commands available.
    }
  }

  program.parse(process.argv);
}


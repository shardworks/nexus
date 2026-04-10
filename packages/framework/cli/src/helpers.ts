/**
 * Pure helper functions for CLI command generation.
 *
 * Extracted from program.ts so they can be tested independently
 * without pulling in heavy runtime dependencies (Arbor, Instrumentarium).
 */

import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

/**
 * Convert camelCase key to kebab-case CLI flag.
 * e.g. 'writId' → '--writ-id'
 */
export function toFlag(key: string): string {
  return `--${key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Detect whether a Zod schema accepts booleans (and only booleans).
 * Used to register Commander flags without <value> for boolean params.
 */
export function isBooleanSchema(schema: z.ZodTypeAny): boolean {
  return (
    schema.safeParse(true).success &&
    schema.safeParse(false).success &&
    !schema.safeParse(42).success &&
    !schema.safeParse('test').success
  );
}

/**
 * Detect whether a Zod schema accepts an array value, possibly wrapped
 * in ZodOptional and/or ZodDefault.
 *
 * Returns true for:
 * - z.array(...)
 * - z.union([z.string(), z.array(...)]) (union with an array branch)
 * - Either of the above wrapped in .optional() / .default()
 *
 * Used to register Commander options with a collector function so that
 * repeating `--flag val1 --flag val2` collects values into an array.
 */
export function isRepeatableSchema(schema: z.ZodTypeAny): boolean {
  let inner: z.ZodTypeAny = schema;

  // Unwrap Optional / Default in any nesting order
  for (let i = 0; i < 3; i++) {
    if (inner instanceof z.ZodOptional) {
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodDefault) {
      inner = inner.unwrap() as z.ZodTypeAny;
    } else {
      break;
    }
  }

  // Direct array
  if (inner instanceof z.ZodArray) return true;

  // Union with at least one array branch
  if (inner instanceof z.ZodUnion) {
    const options = (inner as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options as z.ZodTypeAny[];
    return options.some((opt) => opt instanceof z.ZodArray);
  }

  return false;
}

/**
 * Check whether a Zod schema is a number type, possibly wrapped
 * in ZodOptional and/or ZodDefault.
 */
function isNumberSchema(schema: z.ZodTypeAny): boolean {
  let inner: z.ZodTypeAny = schema;

  if (inner instanceof z.ZodOptional) {
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  if (inner instanceof z.ZodDefault) {
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  // Handle the reverse nesting order too (default wrapping optional)
  if (inner instanceof z.ZodOptional) {
    inner = inner.unwrap() as z.ZodTypeAny;
  }

  return inner instanceof z.ZodNumber;
}

/**
 * Coerce Commander string opts to match the expected Zod schema types.
 *
 * Commander passes all --option <value> arguments as strings. This function
 * walks the Zod shape and converts string values to numbers where the
 * schema expects z.number() (including when wrapped in ZodOptional/ZodDefault).
 *
 * Undefined values pass through unchanged — Zod handles optional/default.
 * Non-number schemas are left untouched.
 */
export function coerceCliOpts(
  shape: Record<string, z.ZodTypeAny>,
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...opts };

  for (const [key, schema] of Object.entries(shape)) {
    const value = result[key];

    // Repeatable options: Commander's collector starts with [] as default.
    // An empty array means the flag was never passed — convert to undefined
    // so Zod's .optional() handles it. A single-element array is kept as-is
    // since the Zod union accepts both scalar and array forms.
    if (Array.isArray(value) && isRepeatableSchema(schema)) {
      if (value.length === 0) {
        result[key] = undefined;
      }
      // Non-empty arrays pass through unchanged — Zod validates the values.
      continue;
    }

    if (typeof value !== 'string') continue;

    if (isNumberSchema(schema)) {
      result[key] = Number(value);
    }
  }

  return result;
}

/**
 * Resolve the guild root directory from available sources.
 *
 * Resolution order (highest priority first):
 *   1. `cliFlag` — the `--guild-root` CLI option
 *   2. `envVar` — the `GUILD_ROOT` environment variable
 *   3. `autoDetect` — a callback that walks up from cwd (e.g. `findGuildRoot()`)
 *
 * Returns `undefined` when no source yields a guild root.
 */
export function resolveGuildRoot(
  cliFlag: string | undefined,
  envVar: string | undefined,
  autoDetect: () => string,
): string | undefined {
  const explicit = cliFlag ?? envVar;
  try {
    return explicit ? path.resolve(explicit) : autoDetect();
  } catch {
    return undefined;
  }
}

/**
 * Determine which hyphen prefixes have enough tools to warrant a group.
 *
 * Returns a Set of prefixes that have 2+ tools sharing them.
 * 'plugin-list' + 'plugin-install' → 'plugin' is a group.
 * 'show-writ' alone → 'show' is NOT a group.
 */
export function findGroupPrefixes(tools: ToolDefinition[]): Set<string> {
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

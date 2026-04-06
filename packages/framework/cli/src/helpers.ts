/**
 * Pure helper functions for CLI command generation.
 *
 * Extracted from program.ts so they can be tested independently
 * without pulling in heavy runtime dependencies (Arbor, Instrumentarium).
 */

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
 * Check whether a Zod schema is a number type, possibly wrapped
 * in ZodOptional and/or ZodDefault.
 */
function isNumberSchema(schema: z.ZodTypeAny): boolean {
  let inner: z.ZodTypeAny = schema;

  if (inner instanceof z.ZodOptional) {
    inner = inner.unwrap();
  }
  if (inner instanceof z.ZodDefault) {
    inner = inner.unwrap();
  }
  // Handle the reverse nesting order too (default wrapping optional)
  if (inner instanceof z.ZodOptional) {
    inner = inner.unwrap();
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
    if (typeof value !== 'string') continue;

    if (isNumberSchema(schema)) {
      result[key] = Number(value);
    }
  }

  return result;
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

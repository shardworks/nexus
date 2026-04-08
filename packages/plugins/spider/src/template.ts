/**
 * Givens template interpolation — isolated module.
 *
 * Handles ${...} expression scanning, parsing, resolution, and stringification.
 * Designed to be replaceable with an external templating library if needed.
 *
 * Supported syntax:
 *   ${expr}         — interpolate expression; whole-value or inline
 *   \${expr}        — escape: produces literal "${expr}" in output, not interpolated
 */

/** Regex to find all ${...} expressions in a string (non-escaped). */
const TEMPLATE_EXPR_RE = /\$\{([^}]+)\}/g;

/** Regex to detect escaped \${ sequences. */
const ESCAPED_TEMPLATE_RE = /\\\$\{/g;

/** Sentinel used during interpolation to protect escaped sequences from the regex. */
const ESCAPE_SENTINEL = '\x00ESCAPED_DOLLAR_BRACE\x00';

/**
 * Sentinel value returned by the `resolve` callback to indicate that an
 * expression should be left in place (not interpolated).
 *
 * Used by spawn-time resolution to preserve ${yields.*} expressions for
 * the later run-time resolution phase.
 */
export const SKIP: unique symbol = Symbol('SKIP');

/**
 * Resolve a dot-path against a root value.
 *
 * @example
 * resolveDotPath({ a: { b: 42 } }, 'a.b') → 42
 * resolveDotPath({ a: 1 }, 'a.b.c') → undefined
 *
 * Returns `undefined` if any segment along the path is nullish or not an object.
 */
export function resolveDotPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Convert a resolved value to a string for inline interpolation.
 *
 * - `undefined` → `''` (empty string)
 * - `string` → as-is
 * - `number`, `boolean`, `bigint`, `symbol` → `String(value)`
 * - `object` or `array` (including `null`) → `JSON.stringify(value)`
 */
export function stringifyForInline(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Test whether a string contains any `${...}` template expressions,
 * ignoring escaped `\${` sequences.
 */
export function containsTemplate(value: string): boolean {
  // Quick check before regex
  if (!value.includes('${')) return false;
  const cleaned = value.replace(ESCAPED_TEMPLATE_RE, '');
  // Reset lastIndex before testing since TEMPLATE_EXPR_RE is global
  const re = new RegExp(TEMPLATE_EXPR_RE.source);
  return re.test(cleaned);
}

/**
 * Extract all expression bodies from a template string.
 * Returns the content inside each `${...}`, ignoring escaped `\${`.
 *
 * @example
 * extractExpressions('Hello ${writ.title} at ${yields.d.path}')
 *   → ['writ.title', 'yields.d.path']
 */
export function extractExpressions(value: string): string[] {
  const cleaned = value.replace(ESCAPED_TEMPLATE_RE, ESCAPE_SENTINEL);
  const exprs: string[] = [];
  const re = new RegExp(TEMPLATE_EXPR_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    exprs.push(match[1]);
  }
  return exprs;
}

/**
 * Interpolate a template string.
 *
 * **Whole-value mode:** When the string is exactly one `${...}` expression
 * with no surrounding text, returns the raw resolved value (preserving type).
 * If the resolver returns `undefined`, the result is `undefined` (caller
 * decides whether to omit the key).
 *
 * **Inline mode:** When the string has surrounding text or multiple
 * expressions, returns a string with all expressions replaced by their
 * stringified values (see `stringifyForInline`).
 *
 * The `resolve` callback receives the expression body (e.g. `'writ.title'`,
 * `'yields.draft.path'`) and returns:
 * - A value (including `undefined` for missing/unresolvable)
 * - The `SKIP` sentinel to leave the expression untouched in the output
 *
 * Escaped `\${` sequences produce literal `${` in the output and are never
 * passed to the resolver.
 */
export function interpolateTemplate(
  value: string,
  resolve: (expr: string) => unknown | typeof SKIP,
): unknown {
  // Protect escaped sequences
  const working = value.replace(ESCAPED_TEMPLATE_RE, ESCAPE_SENTINEL);

  // Check for single-expression whole-value: exactly ${expr} with nothing else
  const singleRe = /^\$\{([^}]+)\}$/;
  const singleMatch = singleRe.exec(working);
  if (singleMatch) {
    const resolved = resolve(singleMatch[1]);
    if (resolved === SKIP) {
      // Leave the original expression — restore escapes and return as-is
      return value;
    }
    // For whole-value, return raw value (preserving type).
    // undefined → return undefined (caller decides whether to omit key).
    return resolved;
  }

  // Multi-expression or inline: interpolate as string
  const result = working.replace(
    new RegExp(TEMPLATE_EXPR_RE.source, 'g'),
    (fullMatch: string, expr: string) => {
      const resolved = resolve(expr);
      if (resolved === SKIP) return fullMatch; // leave expression in place
      return stringifyForInline(resolved);
    },
  );

  // Restore escaped sequences to literal ${
  return result.replaceAll(ESCAPE_SENTINEL, '${');
}

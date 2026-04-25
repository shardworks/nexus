/**
 * manifest-files.ts — predicted-files-touched parser.
 *
 * Pure-function module. Extracts distinct file-path tokens from the
 * `<task><files>...</files></task>` regions of any embedded
 * `<task-manifest>` block in a spec string. The output is the count of
 * distinct paths the planner predicted — a cost-signal the
 * `astrolabe.plan-finalize` engine records on every PlanDoc and uses
 * to drive the soft-warn `astrolabe.plan.files-over-threshold` event.
 *
 * Scoping rules:
 *   - Only `<files>` elements that are descendants of a `<task>` are
 *     considered. A manifest-level `<files>` (sibling of `<task>`) is
 *     intentionally ignored — only task-scoped predictions count.
 *   - A path token must contain at least one `/`, must not contain
 *     `://` (URL guard), and must match a strict path-shaped character
 *     class. The class is tight enough to reject free-form prose words
 *     and URLs, loose enough to accept globs (`*`, `?`, `{`, `}`, `[`,
 *     `]`) and unusual extensions.
 *   - Distinct paths are counted once across all tasks.
 *
 * Failure mode:
 *   - On wholesale parse failure (no recognisable manifest, malformed
 *     XML, no matching tokens) the function returns 0. It never throws
 *     — plan-finalize is in a do-not-halt contract.
 */

// Lenient regexes — stop at the next matching close-tag. `\b[^>]*>` handles
// optional attributes (e.g. `<task id="t1">`). All flags are case-insensitive
// and global so `matchAll` enumerates every block in document order.
const TASK_MANIFEST_RE = /<task-manifest\b[^>]*>([\s\S]*?)<\/task-manifest>/gi;
const TASK_RE = /<task\b[^>]*>([\s\S]*?)<\/task>/gi;
const FILES_RE = /<files\b[^>]*>([\s\S]*?)<\/files>/gi;

// Path-token regex. Allowed characters: letters, digits, and a curated set
// of path / glob punctuation (`_`, `.`, `-`, `/`, `*`, `?`, `{`, `}`, `[`,
// `]`, `@`, `~`, `+`, `=`, `:`, `,`). Whitespace, quotes, parentheses,
// angle brackets, semicolons, and the rest of prose punctuation are
// excluded — they act as token separators.
//
// `:` is in the class so URL-shaped tokens are captured as a single span
// (e.g. `https://example.com/foo`); the post-match `://` test then rejects
// them. Without `:` in the class a URL would split at the first colon,
// leaving `//example.com/foo` looking path-shaped.
//
// `,` is in the class so brace-expansion globs survive intact (e.g.
// `packages/{a,b}/*.tsx`). Comma in prose (`foo/a.ts, foo/b.ts`) is
// followed by whitespace, which separates tokens; the trailing comma is
// stripped by `normalizeToken`.
const PATH_TOKEN_RE = /[A-Za-z0-9_.\-/*?{}\[\]@~+=:,]+/g;

/**
 * Counts the distinct file-path tokens predicted by a spec's task-manifest.
 *
 * Returns 0 when the spec is empty, contains no `<task-manifest>` block,
 * is malformed beyond recognition, or yields no path-shaped tokens.
 */
export function countManifestFiles(spec: string): number {
  return extractManifestFilePaths(spec).size;
}

/**
 * Returns the set of distinct file-path tokens predicted by a spec's
 * task-manifest. Same scoping and parsing rules as `countManifestFiles`.
 *
 * Exposed primarily for testing the extraction surface — plan-finalize
 * uses `countManifestFiles` directly.
 */
export function extractManifestFilePaths(spec: string): Set<string> {
  const paths = new Set<string>();
  if (typeof spec !== 'string' || spec.length === 0) return paths;

  try {
    for (const manifestMatch of spec.matchAll(TASK_MANIFEST_RE)) {
      const manifestBody = manifestMatch[1] ?? '';
      for (const taskMatch of manifestBody.matchAll(TASK_RE)) {
        const taskBody = taskMatch[1] ?? '';
        for (const filesMatch of taskBody.matchAll(FILES_RE)) {
          const filesBody = filesMatch[1] ?? '';
          for (const tokenMatch of filesBody.matchAll(PATH_TOKEN_RE)) {
            const candidate = normalizeToken(tokenMatch[0]);
            if (isPathLike(candidate)) {
              paths.add(candidate);
            }
          }
        }
      }
    }
  } catch {
    // Lenient regex parsing — on any unexpected exception, return empty.
    // Per the do-not-halt contract, parse failure means count = 0.
    return new Set<string>();
  }

  return paths;
}

/**
 * Strip trailing prose punctuation (`.`, `,`, `;`, `:`) from a candidate
 * token. Path-internal periods are preserved (file extensions); only the
 * trailing run is stripped. This keeps path tokens cleanly comparable
 * even when they are written into prose like "modify packages/foo.ts."
 * (with a sentence-final period).
 */
function normalizeToken(raw: string): string {
  return raw.replace(/[.,;:]+$/, '');
}

/**
 * Path-shape predicate. A token is path-like when it contains at least
 * one `/`, contains no `://` (URL guard), and contains at least one
 * alphanumeric character (so a bare `/` or `/...` of pure punctuation
 * is rejected).
 */
function isPathLike(token: string): boolean {
  if (token.length === 0) return false;
  if (!token.includes('/')) return false;
  if (token.includes('://')) return false;
  if (!/[A-Za-z0-9]/.test(token)) return false;
  return true;
}

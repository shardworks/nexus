/**
 * Link-type normalization.
 *
 * The Clerk's `WritLinkDoc.type` is an open string used as a casual label, and
 * callers spell the "same" relationship many different ways: `fixes`, `Fixes`,
 * `depends-on`, `dependsOn`, `depends_on`, `depends on`. Left alone, each of
 * those produces a distinct composite-id link document — which destroys any
 * mechanism that wants to react to a *specific* relationship.
 *
 * This module exposes a single pure function, `normalizeLinkType`, that
 * collapses variant spellings of the same label to a single canonical form.
 * Normalization is purely syntactic — it is NOT synonymy. `requires` and
 * `depends on` normalize to distinct strings; callers that want to treat them
 * as the same relationship should attach the same `semanticMeaning` to both.
 *
 * The pipeline, in order:
 *
 *   1. Lowercase every character.
 *   2. Split camelCase boundaries by inserting a space between a lowercase
 *      or digit character and the following uppercase character. (Performed
 *      before lowercasing in the implementation by doing the split against
 *      the original string, because otherwise the boundaries disappear.)
 *   3. Replace snake_case `_` and kebab-case `-` separators with a space.
 *   4. Collapse any run of whitespace (spaces, tabs, newlines) to a single
 *      space.
 *   5. Trim leading and trailing whitespace.
 *
 * An all-whitespace or empty input canonicalizes to the empty string `''`;
 * callers must validate the result if they require a non-empty canonical
 * form.
 */

/**
 * Normalize a link-type string to its canonical form.
 *
 * @param input - The raw type string supplied by a caller.
 * @returns The canonical lowercase, space-separated form.
 */
export function normalizeLinkType(input: string): string {
  // Split camelCase boundaries FIRST, against the original casing —
  // otherwise lowercasing erases the boundary between adjacent words.
  // Insert a space whenever a lowercase letter or digit is followed by an
  // uppercase letter. This also handles acronym-like runs (e.g. `XMLParser`
  // → `XML Parser`) via a second pass.
  const camelSplit = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Lowercase everything so the stored form is case-insensitive.
  const lowered = camelSplit.toLowerCase();

  // Replace snake_case and kebab-case separators with spaces.
  const separatorsReplaced = lowered.replace(/[-_]+/g, ' ');

  // Collapse runs of whitespace to a single space, then trim.
  const collapsed = separatorsReplaced.replace(/\s+/g, ' ').trim();

  return collapsed;
}

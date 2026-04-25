/**
 * Presentation-layer derivation helpers shared by every writ-bearing
 * surface (writ-list rows, writ-show top-level + parent + children.items,
 * writ-tree nodes, the Oculus page).
 *
 * Two responsibilities:
 *
 *   1. `derivePresentation(writ, getConfig)` projects a writ onto its
 *      type-config-declared classification and outbound transitions, plus
 *      attrs and an unknown-state flag for callers that need them. The
 *      function is total: when the writ's type is unregistered or its
 *      state is undeclared, `classification` becomes `'unknown'` and
 *      `allowedTransitions` is empty so the presentation layer can fall
 *      through to its unknown-state UX (e.g. tree's `?` glyph) rather
 *      than abort.
 *
 *   2. `deriveStateIndicator(state)` takes a config-declared state row
 *      (classification + attrs) and returns the box-drawing tree glyph
 *      and CSS badge class per T5/D4's mapping table. Used by the CLI
 *      tree renderer; the Oculus page mirrors the same rules client-side
 *      against the `/api/writ/types` payload so the two surfaces stay in
 *      sync without server-side HTML generation.
 */

import type { WritDoc } from './types.ts';
import type {
  WritTypeConfig,
  WritTypeStateAttr,
  WritTypeStateClassification,
} from './writ-type-config.ts';

/**
 * Presentation-layer projection of a writ's lifecycle state. Embedded on
 * every shape that carries a writ phase (list rows, tree nodes, show's
 * top-level writ + parent + children.items) so renderers can pick badge
 * classes, glyphs, and action affordances without a second registry
 * lookup.
 */
export interface WritPresentation {
  /**
   * Classification of the writ's current state in its type config, or
   * `'unknown'` when the writ's type is unregistered or its phase is
   * undeclared. `'unknown'` is presentation-only — domain-side classifier
   * helpers (`ClerkApi.isInitial`/`isActive`/`isTerminal`) keep their
   * fail-loud contract.
   */
  classification: WritTypeStateClassification | 'unknown';
  /**
   * Outbound transition names declared on the writ's current state. Empty
   * when the state is terminal, unknown, or its config row carries an
   * empty `allowedTransitions` array.
   */
  allowedTransitions: string[];
  /**
   * Per-state attribute tags from the writ's current state config row.
   * Empty when the state is unknown or declares no attrs.
   */
  attrs: WritTypeStateAttr[];
}

/**
 * Project a writ onto its lifecycle presentation. Total — never throws,
 * even when the writ's type is not registered or its phase is not
 * declared in the type's state list.
 */
export function derivePresentation(
  writ: Pick<WritDoc, 'type' | 'phase'>,
  getConfig: (name: string) => WritTypeConfig | undefined,
): WritPresentation {
  const config = getConfig(writ.type);
  if (!config) {
    return { classification: 'unknown', allowedTransitions: [], attrs: [] };
  }
  const state = config.states.find((s) => s.name === writ.phase);
  if (!state) {
    return { classification: 'unknown', allowedTransitions: [], attrs: [] };
  }
  return {
    classification: state.classification,
    allowedTransitions: [...state.allowedTransitions],
    attrs: [...(state.attrs ?? [])],
  };
}

/**
 * Single-glyph + CSS-class indicator for a writ-type state, derived
 * branchlessly from classification + attrs per the T5/D4 mapping:
 *
 *   - initial                          → ◌  / draft
 *   - active without `stuck` attr      → ●  / active
 *   - active with `stuck` attr         → ◇  / warning
 *   - terminal with `success` attr     → ○  / success
 *   - terminal with `failure` attr     → ✕  / error
 *   - terminal with `cancelled` attr   → ⊘  / warning
 *   - terminal with no recognized attr → ○  / neutral
 *   - unknown classification           → ?  / neutral
 *
 * The mandate config's six states recover their pre-T5 glyphs and badge
 * classes byte-for-byte through this mapping; plugin-contributed types
 * using the four well-known attrs (`success`, `failure`, `cancelled`,
 * `stuck`) inherit the same vocabulary for free.
 */
export interface StateIndicator {
  /** Box-drawing glyph for tree renderers. */
  glyph: string;
  /**
   * CSS badge class suffix matching `.badge--{class}` declarations in
   * the Oculus shared stylesheet (`success`, `error`, `warning`,
   * `active`, `draft`, `neutral`).
   */
  badgeClass: string;
}

export function deriveStateIndicator(input: {
  classification: WritTypeStateClassification | 'unknown';
  attrs: readonly WritTypeStateAttr[];
}): StateIndicator {
  const { classification, attrs } = input;
  const has = (a: string): boolean => attrs.includes(a);

  if (classification === 'initial') {
    return { glyph: '◌', badgeClass: 'draft' };
  }
  if (classification === 'active') {
    if (has('stuck')) return { glyph: '◇', badgeClass: 'warning' };
    return { glyph: '●', badgeClass: 'active' };
  }
  if (classification === 'terminal') {
    if (has('success')) return { glyph: '○', badgeClass: 'success' };
    if (has('failure')) return { glyph: '✕', badgeClass: 'error' };
    if (has('cancelled')) return { glyph: '⊘', badgeClass: 'warning' };
    return { glyph: '○', badgeClass: 'neutral' };
  }
  // Unknown classification (writ type unregistered or state undeclared).
  return { glyph: '?', badgeClass: 'neutral' };
}

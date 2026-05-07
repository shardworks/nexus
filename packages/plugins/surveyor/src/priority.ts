/**
 * Priority translation — cartograph hints → Reckoner Priority.
 *
 * Translates a layer (vision / charge / piece) plus a `SurveyorExt` hint
 * blob into the five-dimensional `Priority` shape the Reckoner petitioner
 * API requires.
 *
 * Decision anchors:
 *   D4 — vision → `'major-area'`, charge → `'minor-area'`, piece → `'minor-area'`
 *   D5 — domain is omitted (Reckoner's contract default fills `[]`)
 *   visionRelation defaults to `'vision-advancer'`
 *   severity defaults to `'moderate'`
 *   time.decay defaults to `false`
 *   time.deadline defaults to `null`
 *   complexity defaults to `'bounded'`
 *
 * NOTE (obs-1): The surveying-cascade.md §3.10 table lists `piece = trivial`
 * and `domain: ['planning']`. `trivial` is not a valid `SCOPE_VALUES` entry
 * and `'planning'` is not a valid `DOMAIN_VALUES` entry in the current
 * Reckoner types. Per D4 / D5 the substrate uses `'minor-area'` for piece
 * scope and omits domain. The doc mismatch is recorded as obs-1; do not
 * extend the Reckoner enums in this commission.
 */

import type { Priority, ComplexityTier } from '@shardworks/reckoner-apparatus';
import type { SurveyorExt, SurveyorLayer } from './types.ts';

// ── Scope defaults per layer (D4) ──────────────────────────────────────

const LAYER_SCOPE: Record<SurveyorLayer, Priority['scope']> = {
  vision: 'major-area',
  charge: 'minor-area',
  piece:  'minor-area',
};

// ── Severity parsing ───────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<Priority['severity']>(['critical', 'serious', 'moderate', 'minor']);

function parseSeverity(raw: string | undefined): Priority['severity'] {
  if (raw !== undefined && VALID_SEVERITIES.has(raw as Priority['severity'])) {
    return raw as Priority['severity'];
  }
  return 'moderate';
}

// ── Complexity parsing ─────────────────────────────────────────────────

const VALID_COMPLEXITIES = new Set<ComplexityTier>([
  'mechanical', 'bounded', 'exploratory', 'open-ended',
]);

function parseComplexity(raw: string | undefined): ComplexityTier | undefined {
  if (raw !== undefined && VALID_COMPLEXITIES.has(raw as ComplexityTier)) {
    return raw as ComplexityTier;
  }
  return undefined;
}

// ── Public translator ──────────────────────────────────────────────────

/**
 * Derive a fully-populated Reckoner `Priority` from the surveyor layer and
 * the cartograph node's `ext['surveyor']` hints. Returns the complexity tier
 * alongside the priority (as an optional field) since the Reckoner petition
 * accepts it as a separate field.
 */
export function defaultPriority(
  layer: SurveyorLayer,
  hints: SurveyorExt | undefined,
): { priority: Priority; complexity?: ComplexityTier } {
  const scope = LAYER_SCOPE[layer];
  const severity = parseSeverity(hints?.severity);
  const decay = hints?.decay ?? false;
  const deadline = hints?.deadline ?? null;
  const complexity = parseComplexity(hints?.complexity);

  const priority: Priority = {
    visionRelation: 'vision-advancer',
    severity,
    scope,
    time: { decay, deadline },
    // D5: domain omitted so Reckoner default fills [].
    domain: [],
  };

  return {
    priority,
    ...(complexity !== undefined ? { complexity } : {}),
  };
}

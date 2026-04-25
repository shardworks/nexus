/**
 * Unit tests for the presentation-layer derivation helpers
 * (writ-presentation.ts).
 *
 * Covers:
 *   - `deriveStateIndicator` — the classification + attrs → glyph + badge
 *     class mapping (T5/D4). Recovers mandate's existing six glyphs
 *     byte-for-byte and generalises to any registered type.
 *   - `derivePresentation` — total, fallback-on-unknown projection that
 *     embeds classification + allowedTransitions on every writ-bearing
 *     surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePresentation,
  deriveStateIndicator,
} from './writ-presentation.ts';
import type { WritTypeConfig } from './writ-type-config.ts';

// ── Fixtures ────────────────────────────────────────────────────────

const mandateConfig: WritTypeConfig = {
  name: 'mandate',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

// ── deriveStateIndicator ────────────────────────────────────────────

describe('deriveStateIndicator — classification + attrs → glyph + badge class', () => {
  it('initial → ◌ / draft', () => {
    const r = deriveStateIndicator({ classification: 'initial', attrs: [] });
    assert.equal(r.glyph, '◌');
    assert.equal(r.badgeClass, 'draft');
  });

  it('active without stuck → ● / active', () => {
    const r = deriveStateIndicator({ classification: 'active', attrs: [] });
    assert.equal(r.glyph, '●');
    assert.equal(r.badgeClass, 'active');
  });

  it('active with stuck attr → ◇ / warning', () => {
    const r = deriveStateIndicator({ classification: 'active', attrs: ['stuck'] });
    assert.equal(r.glyph, '◇');
    assert.equal(r.badgeClass, 'warning');
  });

  it('terminal with success → ○ / success', () => {
    const r = deriveStateIndicator({ classification: 'terminal', attrs: ['success'] });
    assert.equal(r.glyph, '○');
    assert.equal(r.badgeClass, 'success');
  });

  it('terminal with failure → ✕ / error', () => {
    const r = deriveStateIndicator({ classification: 'terminal', attrs: ['failure'] });
    assert.equal(r.glyph, '✕');
    assert.equal(r.badgeClass, 'error');
  });

  it('terminal with cancelled → ⊘ / warning', () => {
    const r = deriveStateIndicator({ classification: 'terminal', attrs: ['cancelled'] });
    assert.equal(r.glyph, '⊘');
    assert.equal(r.badgeClass, 'warning');
  });

  it('terminal with no recognized attr → ○ / neutral', () => {
    const r = deriveStateIndicator({ classification: 'terminal', attrs: [] });
    assert.equal(r.glyph, '○');
    assert.equal(r.badgeClass, 'neutral');
  });

  it('unknown classification → ? / neutral', () => {
    const r = deriveStateIndicator({ classification: 'unknown', attrs: [] });
    assert.equal(r.glyph, '?');
    assert.equal(r.badgeClass, 'neutral');
  });

  it('mandate state config recovers byte-for-byte glyphs', () => {
    // Drive the helper through every mandate state and confirm the
    // pre-T5 glyph mapping survives.
    const expected: Record<string, string> = {
      new: '◌',
      open: '●',
      stuck: '◇',
      completed: '○',
      failed: '✕',
      cancelled: '⊘',
    };
    for (const state of mandateConfig.states) {
      const { glyph } = deriveStateIndicator({
        classification: state.classification,
        attrs: state.attrs ?? [],
      });
      assert.equal(glyph, expected[state.name], `mandate state "${state.name}" glyph drift`);
    }
  });
});

// ── derivePresentation ──────────────────────────────────────────────

describe('derivePresentation — total writ → presentation projection', () => {
  it('projects classification and allowedTransitions for a registered state', () => {
    const writ = { type: 'mandate', phase: 'open' };
    const r = derivePresentation(writ, () => mandateConfig);
    assert.equal(r.classification, 'active');
    assert.deepEqual(r.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);
    assert.deepEqual(r.attrs, []);
  });

  it('projects attrs for stuck state', () => {
    const writ = { type: 'mandate', phase: 'stuck' };
    const r = derivePresentation(writ, () => mandateConfig);
    assert.equal(r.classification, 'active');
    assert.deepEqual(r.attrs, ['stuck']);
  });

  it('falls back to unknown when type is unregistered', () => {
    const writ = { type: 'ghost', phase: 'open' };
    const r = derivePresentation(writ, () => undefined);
    assert.equal(r.classification, 'unknown');
    assert.deepEqual(r.allowedTransitions, []);
    assert.deepEqual(r.attrs, []);
  });

  it('falls back to unknown when phase is undeclared', () => {
    const writ = { type: 'mandate', phase: 'fictional' };
    const r = derivePresentation(writ, () => mandateConfig);
    assert.equal(r.classification, 'unknown');
    assert.deepEqual(r.allowedTransitions, []);
    assert.deepEqual(r.attrs, []);
  });

  it('terminal states have empty allowedTransitions', () => {
    const writ = { type: 'mandate', phase: 'completed' };
    const r = derivePresentation(writ, () => mandateConfig);
    assert.equal(r.classification, 'terminal');
    assert.deepEqual(r.allowedTransitions, []);
    assert.deepEqual(r.attrs, ['success']);
  });
});

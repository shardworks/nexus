/**
 * Tests for the link-label normalization helper.
 *
 * Covers each transform in isolation plus composed inputs that exercise the
 * twelve observed spellings of the same relationship collapsing to a single
 * canonical form.
 *
 * Normalization is syntactic, NOT synonymy: `requires` and `depends on` are
 * distinct after normalization. Synonymy is expressed via `kind`,
 * not by this function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLinkLabel } from './link-normalize.ts';

describe('normalizeLinkLabel — individual transforms', () => {
  describe('lowercase conversion', () => {
    it('lowercases an all-uppercase input', () => {
      assert.equal(normalizeLinkLabel('FIXES'), 'fixes');
    });

    it('lowercases a mixed-case input with no word boundaries', () => {
      assert.equal(normalizeLinkLabel('Fixes'), 'fixes');
    });

    it('leaves an already-lowercase input untouched', () => {
      assert.equal(normalizeLinkLabel('fixes'), 'fixes');
    });
  });

  describe('trim', () => {
    it('trims leading whitespace', () => {
      assert.equal(normalizeLinkLabel('   fixes'), 'fixes');
    });

    it('trims trailing whitespace', () => {
      assert.equal(normalizeLinkLabel('fixes   '), 'fixes');
    });

    it('trims both ends', () => {
      assert.equal(normalizeLinkLabel('   fixes   '), 'fixes');
    });
  });

  describe('camelCase splitting', () => {
    it('splits a simple camelCase input', () => {
      assert.equal(normalizeLinkLabel('dependsOn'), 'depends on');
    });

    it('splits multiple camelCase boundaries', () => {
      assert.equal(normalizeLinkLabel('isBlockedBy'), 'is blocked by');
    });

    it('splits acronym-then-word boundaries', () => {
      assert.equal(normalizeLinkLabel('XMLParser'), 'xml parser');
    });

    it('leaves all-lowercase runs alone', () => {
      assert.equal(normalizeLinkLabel('dependson'), 'dependson');
    });
  });

  describe('snake_case splitting', () => {
    it('replaces a single underscore with a space', () => {
      assert.equal(normalizeLinkLabel('depends_on'), 'depends on');
    });

    it('collapses a run of underscores to a single space', () => {
      assert.equal(normalizeLinkLabel('depends__on'), 'depends on');
    });
  });

  describe('kebab-case splitting', () => {
    it('replaces a single hyphen with a space', () => {
      assert.equal(normalizeLinkLabel('depends-on'), 'depends on');
    });

    it('collapses a run of hyphens to a single space', () => {
      assert.equal(normalizeLinkLabel('depends--on'), 'depends on');
    });
  });

  describe('whitespace collapse', () => {
    it('collapses multiple spaces to one', () => {
      assert.equal(normalizeLinkLabel('depends    on'), 'depends on');
    });

    it('collapses tabs and newlines to a single space', () => {
      assert.equal(normalizeLinkLabel('depends\t\non'), 'depends on');
    });
  });

  describe('empty and whitespace-only input', () => {
    it('canonicalizes an empty string to an empty string', () => {
      assert.equal(normalizeLinkLabel(''), '');
    });

    it('canonicalizes whitespace-only input to an empty string', () => {
      assert.equal(normalizeLinkLabel('   \t\n  '), '');
    });
  });
});

describe('normalizeLinkLabel — composed pipeline on the twelve observed spellings', () => {
  // All twelve of these represent the same `depends on` relationship; they
  // must all produce the identical canonical form.
  const variants = [
    'depends on',
    'Depends On',
    'DEPENDS ON',
    'depends-on',
    'Depends-On',
    'DEPENDS-ON',
    'depends_on',
    'Depends_On',
    'DEPENDS_ON',
    'dependsOn',
    'DependsOn',
    '  dependsOn  ',
  ];

  for (const variant of variants) {
    it(`collapses ${JSON.stringify(variant)} to "depends on"`, () => {
      assert.equal(normalizeLinkLabel(variant), 'depends on');
    });
  }

  it('is idempotent — normalizing a canonical form returns the same value', () => {
    const canonical = normalizeLinkLabel('dependsOn');
    assert.equal(normalizeLinkLabel(canonical), canonical);
  });

  it('leaves distinct relationships distinct (not synonymy)', () => {
    // `requires` and `depends on` are NOT synonyms under normalization.
    assert.notEqual(normalizeLinkLabel('requires'), normalizeLinkLabel('depends-on'));
  });

  it('canonicalizes the builtin `fixes` label as its own canonical form', () => {
    // The existing `link.id === '<src>:<tgt>:fixes'` assertions rely on this.
    assert.equal(normalizeLinkLabel('fixes'), 'fixes');
  });
});

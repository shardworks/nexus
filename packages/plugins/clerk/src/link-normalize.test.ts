/**
 * Tests for the link-type normalization helper.
 *
 * Covers each transform in isolation plus composed inputs that exercise the
 * twelve observed spellings of the same relationship collapsing to a single
 * canonical form.
 *
 * Normalization is syntactic, NOT synonymy: `requires` and `depends on` are
 * distinct after normalization. Synonymy is expressed via `semanticMeaning`,
 * not by this function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLinkType } from './link-normalize.ts';

describe('normalizeLinkType — individual transforms', () => {
  describe('lowercase conversion', () => {
    it('lowercases an all-uppercase input', () => {
      assert.equal(normalizeLinkType('FIXES'), 'fixes');
    });

    it('lowercases a mixed-case input with no word boundaries', () => {
      assert.equal(normalizeLinkType('Fixes'), 'fixes');
    });

    it('leaves an already-lowercase input untouched', () => {
      assert.equal(normalizeLinkType('fixes'), 'fixes');
    });
  });

  describe('trim', () => {
    it('trims leading whitespace', () => {
      assert.equal(normalizeLinkType('   fixes'), 'fixes');
    });

    it('trims trailing whitespace', () => {
      assert.equal(normalizeLinkType('fixes   '), 'fixes');
    });

    it('trims both ends', () => {
      assert.equal(normalizeLinkType('   fixes   '), 'fixes');
    });
  });

  describe('camelCase splitting', () => {
    it('splits a simple camelCase input', () => {
      assert.equal(normalizeLinkType('dependsOn'), 'depends on');
    });

    it('splits multiple camelCase boundaries', () => {
      assert.equal(normalizeLinkType('isBlockedBy'), 'is blocked by');
    });

    it('splits acronym-then-word boundaries', () => {
      assert.equal(normalizeLinkType('XMLParser'), 'xml parser');
    });

    it('leaves all-lowercase runs alone', () => {
      assert.equal(normalizeLinkType('dependson'), 'dependson');
    });
  });

  describe('snake_case splitting', () => {
    it('replaces a single underscore with a space', () => {
      assert.equal(normalizeLinkType('depends_on'), 'depends on');
    });

    it('collapses a run of underscores to a single space', () => {
      assert.equal(normalizeLinkType('depends__on'), 'depends on');
    });
  });

  describe('kebab-case splitting', () => {
    it('replaces a single hyphen with a space', () => {
      assert.equal(normalizeLinkType('depends-on'), 'depends on');
    });

    it('collapses a run of hyphens to a single space', () => {
      assert.equal(normalizeLinkType('depends--on'), 'depends on');
    });
  });

  describe('whitespace collapse', () => {
    it('collapses multiple spaces to one', () => {
      assert.equal(normalizeLinkType('depends    on'), 'depends on');
    });

    it('collapses tabs and newlines to a single space', () => {
      assert.equal(normalizeLinkType('depends\t\non'), 'depends on');
    });
  });

  describe('empty and whitespace-only input', () => {
    it('canonicalizes an empty string to an empty string', () => {
      assert.equal(normalizeLinkType(''), '');
    });

    it('canonicalizes whitespace-only input to an empty string', () => {
      assert.equal(normalizeLinkType('   \t\n  '), '');
    });
  });
});

describe('normalizeLinkType — composed pipeline on the twelve observed spellings', () => {
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
      assert.equal(normalizeLinkType(variant), 'depends on');
    });
  }

  it('is idempotent — normalizing a canonical form returns the same value', () => {
    const canonical = normalizeLinkType('dependsOn');
    assert.equal(normalizeLinkType(canonical), canonical);
  });

  it('leaves distinct relationships distinct (not synonymy)', () => {
    // `requires` and `depends on` are NOT synonyms under normalization.
    assert.notEqual(normalizeLinkType('requires'), normalizeLinkType('depends-on'));
  });

  it('canonicalizes the builtin `fixes` label as its own canonical form', () => {
    // The existing `link.id === '<src>:<tgt>:fixes'` assertions rely on this.
    assert.equal(normalizeLinkType('fixes'), 'fixes');
  });
});

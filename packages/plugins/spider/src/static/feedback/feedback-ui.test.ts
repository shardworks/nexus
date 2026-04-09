/**
 * Feedback UI — static asset regression tests.
 *
 * These tests verify the source text of feedback.js to ensure structural
 * invariants hold.  Because feedback.js is a vanilla-JS IIFE (no modules),
 * we validate the source text directly with regex pattern matching.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const feedbackJs = readFileSync(resolve(__dirname, 'feedback.js'), 'utf-8');

// ── IIFE wrapper ──────────────────────────────────────────────────────

describe('feedback.js IIFE structure', () => {
  it('starts with an IIFE and strict mode', () => {
    assert.match(
      feedbackJs,
      /^\(function\s*\(\)\s*\{\s*'use strict';/,
      'file must begin with a strict-mode IIFE',
    );
  });

  it('does not contain import or require statements', () => {
    assert.doesNotMatch(
      feedbackJs,
      /\b(import\s|require\s*\()/,
      'IIFE must not use module imports',
    );
  });
});

// ── Question-type branching ───────────────────────────────────────────

describe('feedback.js question-type branching', () => {
  it('branches on choice question type', () => {
    assert.match(
      feedbackJs,
      /=== 'choice'/,
      'must branch on choice question type',
    );
  });

  it('branches on boolean question type', () => {
    assert.match(
      feedbackJs,
      /=== 'boolean'/,
      'must branch on boolean question type',
    );
  });

  it('branches on text question type', () => {
    assert.match(
      feedbackJs,
      /=== 'text'/,
      'must branch on text question type',
    );
  });
});

// ── Answer POST body shapes ───────────────────────────────────────────

describe('feedback.js answer POST body shapes', () => {
  it('constructs choice select POST body with select key', () => {
    assert.match(
      feedbackJs,
      /select:\s*optKey/,
      'choice select body must include select: optKey',
    );
  });

  it('constructs choice custom POST body with custom key', () => {
    assert.match(
      feedbackJs,
      /custom:\s*text/,
      'choice custom body must include custom: text',
    );
  });

  it('sends boolean values as strings "true" and "false"', () => {
    assert.match(
      feedbackJs,
      /value:\s*strVal/,
      'boolean answer body must use a string variable for value',
    );
    // Verify the string construction
    assert.match(
      feedbackJs,
      /newVal\s*\?\s*'true'\s*:\s*'false'/,
      'boolean value must be built from string literals "true" and "false"',
    );
  });

  it('constructs text POST body with value key', () => {
    assert.match(
      feedbackJs,
      /question:\s*qKey,\s*value:\s*value/,
      'text answer body must include value: value',
    );
  });
});

// ── Badge class mapping ───────────────────────────────────────────────

describe('feedback.js badge class mapping', () => {
  it('maps pending to badge--warning', () => {
    assert.match(feedbackJs, /badge--warning/, 'must contain badge--warning');
  });

  it('maps completed to badge--success', () => {
    assert.match(feedbackJs, /badge--success/, 'must contain badge--success');
  });

  it('maps rejected to badge--error', () => {
    assert.match(feedbackJs, /badge--error/, 'must contain badge--error');
  });
});

// ── Event delegation attributes ───────────────────────────────────────

describe('feedback.js event delegation attributes', () => {
  it('uses data-question-key attribute', () => {
    assert.match(
      feedbackJs,
      /data-question-key/,
      'must use data-question-key for event delegation',
    );
  });

  it('uses data-option-key attribute', () => {
    assert.match(
      feedbackJs,
      /data-option-key/,
      'must use data-option-key for event delegation',
    );
  });
});

// ── API endpoint URLs ─────────────────────────────────────────────────

describe('feedback.js API endpoint URLs', () => {
  it('references the list endpoint', () => {
    assert.match(feedbackJs, /\/api\/input\/request-list/, 'must reference request-list endpoint');
  });

  it('references the answer endpoint', () => {
    assert.match(feedbackJs, /\/api\/input\/request-answer/, 'must reference request-answer endpoint');
  });

  it('references the complete endpoint', () => {
    assert.match(feedbackJs, /\/api\/input\/request-complete/, 'must reference request-complete endpoint');
  });

  it('references the reject endpoint', () => {
    assert.match(feedbackJs, /\/api\/input\/request-reject/, 'must reference request-reject endpoint');
  });
});

// ── Polling interval ──────────────────────────────────────────────────

describe('feedback.js polling', () => {
  it('uses 12000ms polling interval', () => {
    assert.match(
      feedbackJs,
      /12000/,
      'must use 12000ms (12 second) polling interval',
    );
  });
});

// ── Custom radio option ───────────────────────────────────────────────

describe('feedback.js custom choice option', () => {
  it('uses __custom__ sentinel key for custom radio option', () => {
    assert.match(
      feedbackJs,
      /__custom__/,
      'must use __custom__ as the sentinel key for custom radio',
    );
  });
});

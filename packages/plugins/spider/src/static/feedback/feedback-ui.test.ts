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

// ── Tag badge rendering ──────────────────────────────────────────────

describe('feedback.js tag badge rendering', () => {
  it('defines a renderTags helper function', () => {
    assert.match(
      feedbackJs,
      /function renderTags\(spec\)/,
      'must define a renderTags helper function',
    );
  });

  it('renders tag badges with the .tag CSS class', () => {
    assert.match(
      feedbackJs,
      /class="tag"/,
      'must render tags with class="tag"',
    );
  });

  it('returns empty string when spec.tags is falsy or empty', () => {
    assert.match(
      feedbackJs,
      /!spec\.tags\s*\|\|\s*spec\.tags\.length\s*===\s*0.*return\s*''/,
      'renderTags must return empty string for falsy or empty tags',
    );
  });

  it('calls renderTags in choice question renderer after question-label', () => {
    assert.match(
      feedbackJs,
      /question-label.*?<\/span>'\s*\+\s*renderTags\(spec\)\s*\+\s*'<\/div>/,
      'choice renderer must call renderTags after question-label span',
    );
  });

  it('calls renderTags in boolean question renderer after boolean-label', () => {
    assert.match(
      feedbackJs,
      /boolean-label.*?<\/span>'\s*\+\s*renderTags\(spec\)/,
      'boolean renderer must call renderTags after boolean-label span',
    );
  });

  it('calls renderTags in text question renderer after label', () => {
    assert.match(
      feedbackJs,
      /<\/label>'\s*\n\s*\+\s*renderTags\(spec\)\s*\n\s*\+\s*'<textarea/,
      'text renderer must call renderTags between label and textarea',
    );
  });
});

// ── Tag filter toolbar ───────────────────────────────────────────────

describe('feedback.js tag filter toolbar', () => {
  it('creates toolbar element with tag-filter-toolbar ID', () => {
    assert.match(
      feedbackJs,
      /id\s*=\s*'tag-filter-toolbar'/,
      'must create a toolbar element with id tag-filter-toolbar',
    );
  });

  it('creates tag filter buttons with tag-filter-btn class', () => {
    assert.match(
      feedbackJs,
      /tag-filter-btn/,
      'must create buttons with tag-filter-btn class',
    );
  });

  it('stores active tag filter state in activeTagFilters variable', () => {
    assert.match(
      feedbackJs,
      /var activeTagFilters\s*=\s*\{\}/,
      'must declare activeTagFilters state variable',
    );
  });

  it('defines an applyTagFilters function', () => {
    assert.match(
      feedbackJs,
      /function applyTagFilters\(\)/,
      'must define an applyTagFilters function',
    );
  });

  it('sorts tags alphabetically for toolbar display', () => {
    assert.match(
      feedbackJs,
      /Object\.keys\(tagSet\)\.sort\(\)/,
      'must sort tags alphabetically using .sort()',
    );
  });

  it('includes a clear filters button with tag-filter-clear class', () => {
    assert.match(
      feedbackJs,
      /tag-filter-clear/,
      'must include a clear filters element with tag-filter-clear class',
    );
  });

  it('displays showing count with tag-filter-count class', () => {
    assert.match(
      feedbackJs,
      /tag-filter-count/,
      'must include a count display with tag-filter-count class',
    );
  });

  it('clears activeTagFilters in navigateToList', () => {
    assert.match(
      feedbackJs,
      /activeTagFilters\s*=\s*\{\};\s*\n\s*detailView/,
      'navigateToList must reset activeTagFilters before hiding detail view',
    );
  });

  it('removes existing toolbar before re-rendering', () => {
    assert.match(
      feedbackJs,
      /getElementById\('tag-filter-toolbar'\);\s*\n\s*if\s*\(oldToolbar\)\s*oldToolbar\.remove\(\)/,
      'renderDetail must remove existing tag-filter-toolbar on re-render',
    );
  });
});

// ── Deep-link URL state (?feedback=ID) ──────────────────────────────────

describe('feedback.js — deep-link URL state', () => {
  it('exposes currentUrlParams + updateUrl helpers (D9 — Ratchet pattern)', () => {
    assert.match(
      feedbackJs,
      /function currentUrlParams\(\)\s*\{[\s\S]*?new URLSearchParams\(window\.location\.search\)/,
      'currentUrlParams reads window.location.search live',
    );
    assert.match(
      feedbackJs,
      /function updateUrl\(changes\)\s*\{[\s\S]*?window\.history\.pushState/,
      'updateUrl pushes via history.pushState',
    );
  });

  it('showDetail pushes ?feedback=ID using the request id (stable across reorderings)', () => {
    const block = feedbackJs.match(
      /function showDetail\(index(?:, opts)?\)[\s\S]*?(?=\n  \/\*\*|\n  function )/,
    );
    assert.ok(block, 'should find showDetail body');
    assert.match(
      block[0],
      /updateUrl\(\{\s*feedback:\s*currentRequest\.id\s*\}\)/,
      'showDetail pushes ?feedback=<currentRequest.id> — keyed on the id, not the index',
    );
    assert.match(block[0], /skipUrlPush/, 'showDetail accepts a skipUrlPush opt');
  });

  it('navigateToList clears ?feedback via updateUrl({feedback: null}) — never pops history (D11)', () => {
    const block = feedbackJs.match(
      /function navigateToList\((?:opts)?\)[\s\S]*?fetchList\(\);[\s\S]*?startPoll\(\);\s*\}/,
    );
    assert.ok(block, 'should find navigateToList body');
    assert.match(
      block[0],
      /updateUrl\(\{\s*feedback:\s*null\s*\}\)/,
      'navigateToList should push a clean URL via updateUrl({feedback: null})',
    );
    assert.ok(
      !/window\.history\.back\s*\(/.test(block[0]),
      'navigateToList should never invoke history.back',
    );
  });

  it('a popstate listener routes browser navigation back through the page', () => {
    assert.match(
      feedbackJs,
      /window\.addEventListener\(\s*['"]popstate['"]/,
      'feedback.js registers a popstate listener',
    );
    const block = feedbackJs.match(
      /addEventListener\(\s*['"]popstate['"][\s\S]*?\}\)/,
    );
    assert.ok(block, 'should find popstate handler body');
    assert.match(
      block[0],
      /currentUrlParams\(\)\.get\(['"]feedback['"]\)/,
      'popstate handler reads ?feedback from the new URL',
    );
    assert.match(
      block[0],
      /skipUrlPush:\s*true/,
      'popstate-driven path passes skipUrlPush to avoid double-push',
    );
  });

  it('init reads ?feedback=ID and resolves it via showDetailById', () => {
    assert.match(
      feedbackJs,
      /var initialFeedbackId\s*=\s*currentUrlParams\(\)\.get\(['"]feedback['"]\)/,
      'init reads ?feedback from the URL',
    );
    assert.match(
      feedbackJs,
      /showDetailById\(\s*initialFeedbackId\s*,\s*\{\s*skipUrlPush:\s*true\s*\}\)/,
      'init opens the detail via showDetailById with skipUrlPush=true',
    );
  });

  it('renderFeedbackNotFound preserves the URL param (D16)', () => {
    const block = feedbackJs.match(
      /function renderFeedbackNotFound\([\s\S]*?(?=\n  function )/,
    );
    assert.ok(block, 'should find renderFeedbackNotFound body');
    assert.ok(
      !/updateUrl/.test(block[0]),
      'renderFeedbackNotFound must not rewrite the URL',
    );
    assert.match(
      block[0],
      /No feedback request with id/,
      'renderFeedbackNotFound surfaces a "not found" message',
    );
  });
});

/**
 * Animator UI — static asset regression tests.
 *
 * animator.js is a vanilla-JS IIFE served from the plugin's /static/
 * route and auto-injected with oculus's shared chrome (stylesheet plus
 * the nexus-format helper). Because there is no module system in play,
 * these tests grep the source text to lock down structural invariants.
 *
 * The primary invariant this suite encodes: every cost and token
 * rendering must route through the shared `window.NexusFormat`
 * namespace. Local helpers have been removed precisely so the guild
 * can never drift back to per-dashboard precision (animator formerly
 * used toFixed(4) for cost, while every other dashboard used
 * toFixed(2)).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const animatorJs = readFileSync(resolve(__dirname, 'animator.js'), 'utf-8');

// ── Shared namespace consumption ────────────────────────────────────────

describe('animator.js cost/token formatting delegates to window.NexusFormat', () => {
  it('does not redefine formatCost locally', () => {
    assert.doesNotMatch(
      animatorJs,
      /function formatCost\(/,
      'animator.js must not redeclare formatCost — use window.NexusFormat.formatCostUsd',
    );
  });

  it('contains no toFixed(4) drift (legacy precision)', () => {
    assert.doesNotMatch(
      animatorJs,
      /toFixed\(4\)/,
      'animator.js must not use toFixed(4) — shared formatter enforces $x.yy',
    );
  });

  it('contains no raw toFixed(2) cost rendering outside the shared namespace', () => {
    assert.doesNotMatch(
      animatorJs,
      /toFixed\(2\)/,
      'animator.js must not use toFixed(2) directly — route through window.NexusFormat',
    );
  });

  it('renders session-list Cost cell via window.NexusFormat.formatCostUsd', () => {
    assert.match(
      animatorJs,
      /cost-cell[\s\S]*?window\.NexusFormat\.formatCostUsd\(s\.costUsd\)/,
      'session-list Cost cell should render via the shared formatter',
    );
  });

  it('renders detail-view Cost (USD) row via window.NexusFormat.formatCostUsd', () => {
    assert.match(
      animatorJs,
      /Cost \(USD\)[\s\S]*?window\.NexusFormat\.formatCostUsd\(session\.costUsd\)/,
      'detail-view Cost row should render via the shared formatter',
    );
  });

  it('renders tooltip token counts via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      animatorJs,
      /Input:[\s\S]*?window\.NexusFormat\.formatTokenCount\(s\.tokenUsage\.inputTokens\)/,
      'tooltip input tokens should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Output:[\s\S]*?window\.NexusFormat\.formatTokenCount\(s\.tokenUsage\.outputTokens\)/,
      'tooltip output tokens should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Cache Read:[\s\S]*?window\.NexusFormat\.formatTokenCount\(s\.tokenUsage\.cacheReadTokens\)/,
      'tooltip cache-read tokens should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Cache Write:[\s\S]*?window\.NexusFormat\.formatTokenCount\(s\.tokenUsage\.cacheWriteTokens\)/,
      'tooltip cache-write tokens should render via the shared formatter',
    );
  });

  it('renders detail-view token rows via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      animatorJs,
      /Input Tokens[\s\S]*?window\.NexusFormat\.formatTokenCount\(tu\.inputTokens\)/,
      'detail-view Input Tokens row should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Output Tokens[\s\S]*?window\.NexusFormat\.formatTokenCount\(tu\.outputTokens\)/,
      'detail-view Output Tokens row should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Cache Read Tokens[\s\S]*?window\.NexusFormat\.formatTokenCount\(tu\.cacheReadTokens\)/,
      'detail-view Cache Read Tokens row should render via the shared formatter',
    );
    assert.match(
      animatorJs,
      /Cache Write Tokens[\s\S]*?window\.NexusFormat\.formatTokenCount\(tu\.cacheWriteTokens\)/,
      'detail-view Cache Write Tokens row should render via the shared formatter',
    );
  });
});

// ── Deep-link URL state (?session=ID) ───────────────────────────────────

describe('animator.js — deep-link URL state', () => {
  it('routes URL reads/writes through window.NexusUrl (no inline helpers)', () => {
    // Inline currentUrlParams / updateUrl are gone (commission moix23w5).
    assert.ok(
      !/function\s+currentUrlParams\s*\(/.test(animatorJs),
      'inline currentUrlParams must not be redeclared',
    );
    assert.ok(
      !/function\s+updateUrl\s*\(/.test(animatorJs),
      'inline updateUrl must not be redeclared',
    );
    assert.match(
      animatorJs,
      /window\.NexusUrl\.read\(\)/,
      'animator.js should read URL state via window.NexusUrl.read',
    );
    assert.match(
      animatorJs,
      /window\.NexusUrl\.update\(/,
      'animator.js should write URL state via window.NexusUrl.update',
    );
  });

  it('showDetail pushes ?session=ID via NexusUrl with push: true (D12)', () => {
    const block = animatorJs.match(
      /function showDetail\(sessionId(?:, opts)?\)[\s\S]*?(?=\n  function )/,
    );
    assert.ok(block, 'should find showDetail body');
    assert.match(
      block[0],
      /window\.NexusUrl\.update\(\{\s*session:\s*sessionId\s*\}\s*,\s*\{\s*push:\s*true\s*\}\)/,
      'showDetail should push ?session=<id> when not skipUrlPush',
    );
    assert.match(block[0], /skipUrlPush/, 'showDetail accepts a skipUrlPush opt');
  });

  it('showList clears ?session via NexusUrl with push: true — never pops history (D11)', () => {
    const block = animatorJs.match(
      /function showList\((?:opts)?\)[\s\S]*?(?=\n  function |\n  \/\/)/,
    );
    assert.ok(block, 'should find showList body');
    assert.match(
      block[0],
      /window\.NexusUrl\.update\(\{\s*session:\s*null\s*\}\s*,\s*\{\s*push:\s*true\s*\}\)/,
      'showList should push a clean URL via NexusUrl.update with session: null',
    );
    assert.ok(
      !/window\.history\.back\s*\(/.test(block[0]),
      'showList should never invoke history.back',
    );
  });

  it('a popstate listener routes browser navigation back through the page', () => {
    assert.match(
      animatorJs,
      /window\.addEventListener\(\s*['"]popstate['"]/,
      'animator.js registers a popstate listener',
    );
    const block = animatorJs.match(
      /addEventListener\(\s*['"]popstate['"][\s\S]*?\}\)/,
    );
    assert.ok(block, 'should find popstate handler body');
    assert.match(
      block[0],
      /readUrlState\(\)/,
      'popstate handler reads URL state via the central readUrlState helper',
    );
    assert.match(
      block[0],
      /skipUrlPush:\s*true/,
      'popstate-driven path passes skipUrlPush to avoid double-push',
    );
  });

  it('init reads URL state and overlays the detail view', () => {
    assert.match(
      animatorJs,
      /var initialSessionId\s*=\s*readUrlState\(\)/,
      'init calls readUrlState before fetching the list',
    );
    assert.match(
      animatorJs,
      /showDetail\(\s*initialSessionId\s*,\s*\{\s*skipUrlPush:\s*true\s*\}\)/,
      'init opens the detail via showDetail with skipUrlPush=true',
    );
  });

  it('renderSessionDetailNotFound preserves the URL param (D16)', () => {
    const block = animatorJs.match(
      /function renderSessionDetailNotFound\([\s\S]*?(?=\n  function )/,
    );
    assert.ok(block, 'should find renderSessionDetailNotFound body');
    assert.ok(
      !/NexusUrl\.update/.test(block[0]),
      'renderSessionDetailNotFound must not rewrite the URL',
    );
    assert.match(
      block[0],
      /No session with id/,
      'renderSessionDetailNotFound surfaces a "not found" message',
    );
  });

  it('sessions filter state writes through NexusUrl.update (replace, no push: true)', () => {
    const writer = animatorJs.match(
      /function writeSessionFiltersToUrl\(\)[\s\S]*?(?=\n  function )/,
    );
    assert.ok(writer, 'writeSessionFiltersToUrl should be defined');
    assert.match(
      writer[0],
      /window\.NexusUrl\.update\(\{[\s\S]*?status:[\s\S]*?\}\s*\)/,
      'session filter must call NexusUrl.update without { push: true }',
    );
    assert.ok(
      !/push:\s*true/.test(writer[0]),
      'session filter writes must use replaceState (D5 default)',
    );
    for (const key of ['status', 'from', 'to']) {
      assert.match(
        writer[0],
        new RegExp(`${key}\\s*:`),
        `session filter writer must include the ${key} key`,
      );
    }
  });

  it('readUrlState validates ?status= against STATUS_VALUES and surfaces fail-loud errors (D6)', () => {
    const reader = animatorJs.match(
      /function readUrlState\(\)[\s\S]*?(?=\n  function )/,
    );
    assert.ok(reader, 'readUrlState should be defined');
    assert.match(
      reader[0],
      /STATUS_VALUES\.indexOf/,
      'readUrlState must validate ?status= against STATUS_VALUES',
    );
    assert.match(
      reader[0],
      /showUrlError\(/,
      'readUrlState must surface invalid values via showUrlError',
    );
  });
});

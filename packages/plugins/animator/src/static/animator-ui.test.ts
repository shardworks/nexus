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
  it('exposes currentUrlParams + updateUrl helpers (D9 — Ratchet pattern)', () => {
    assert.match(
      animatorJs,
      /function currentUrlParams\(\)\s*\{[\s\S]*?new URLSearchParams\(window\.location\.search\)/,
      'currentUrlParams reads window.location.search live',
    );
    assert.match(
      animatorJs,
      /function updateUrl\(changes\)\s*\{[\s\S]*?window\.history\.pushState/,
      'updateUrl pushes via history.pushState',
    );
  });

  it('showDetail pushes ?session=ID via the central updateUrl call (D12)', () => {
    const block = animatorJs.match(
      /function showDetail\(sessionId(?:, opts)?\)[\s\S]*?(?=\n  function )/,
    );
    assert.ok(block, 'should find showDetail body');
    assert.match(
      block[0],
      /updateUrl\(\{\s*session:\s*sessionId\s*\}\)/,
      'showDetail should push ?session=<id> when not skipUrlPush',
    );
    assert.match(block[0], /skipUrlPush/, 'showDetail accepts a skipUrlPush opt');
  });

  it('showList clears ?session via updateUrl({session: null}) — never pops history (D11)', () => {
    const block = animatorJs.match(
      /function showList\((?:opts)?\)[\s\S]*?(?=\n  function |\n  \/\/)/,
    );
    assert.ok(block, 'should find showList body');
    assert.match(
      block[0],
      /updateUrl\(\{\s*session:\s*null\s*\}\)/,
      'showList should push a clean URL via updateUrl({session: null})',
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
      /currentUrlParams\(\)\.get\(['"]session['"]\)/,
      'popstate handler reads ?session from the new URL',
    );
    assert.match(
      block[0],
      /skipUrlPush:\s*true/,
      'popstate-driven path passes skipUrlPush to avoid double-push',
    );
  });

  it('init reads ?session=ID and overlays the detail view', () => {
    assert.match(
      animatorJs,
      /var initialSessionId\s*=\s*currentUrlParams\(\)\.get\(['"]session['"]\)/,
      'init reads ?session from the URL',
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
      !/updateUrl/.test(block[0]),
      'renderSessionDetailNotFound must not rewrite the URL',
    );
    assert.match(
      block[0],
      /No session with id/,
      'renderSessionDetailNotFound surfaces a "not found" message',
    );
  });
});

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

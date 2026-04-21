/**
 * Parlour UI — static asset regression tests.
 *
 * app.js is a vanilla-JS file served from the plugin's /static/
 * route and auto-injected with oculus's shared chrome (stylesheet plus
 * the nexus-format helper). These tests validate the source text
 * directly, mirroring the pattern used by the spider and animator
 * dashboards.
 *
 * The primary invariant this suite encodes: every cost and token
 * rendering must route through the shared `window.NexusFormat`
 * namespace. Parlour formerly rendered cost via `toFixed(4)` and tokens
 * via bare `.toLocaleString()` (no locale argument), drifting from the
 * guild-wide $x.yy and en-US canon.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(resolve(__dirname, 'app.js'), 'utf-8');

// ── Shared namespace consumption ────────────────────────────────────────

describe('parlour app.js cost/token formatting delegates to window.NexusFormat', () => {
  it('contains no toFixed(4) drift (legacy precision)', () => {
    assert.doesNotMatch(
      appJs,
      /toFixed\(4\)/,
      'app.js must not use toFixed(4) — shared formatter enforces $x.yy',
    );
  });

  it('contains no toFixed(2) outside the shared namespace', () => {
    assert.doesNotMatch(
      appJs,
      /toFixed\(2\)/,
      'app.js must not use toFixed(2) directly — route through window.NexusFormat',
    );
  });

  it('contains no bare numeric .toLocaleString() calls', () => {
    // `totalInput.toLocaleString()` / `totalOutput.toLocaleString()` have
    // been replaced with window.NexusFormat.formatTokenCount calls.
    var numericLocaleMatches =
      appJs.match(/\b(?:input|output|cost|total|token)\w*\.toLocaleString\(/gi) || [];
    assert.equal(
      numericLocaleMatches.length,
      0,
      'numeric *.toLocaleString() calls must be replaced with window.NexusFormat.formatTokenCount',
    );
  });

  it('renders cost-card total cost via window.NexusFormat.formatCostUsd', () => {
    assert.match(
      appJs,
      /window\.NexusFormat\.formatCostUsd\(totalCost\)/,
      'cost-card total cost should render via the shared formatter',
    );
  });

  it('renders cost-card input tokens via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      appJs,
      /IN:[\s\S]*?window\.NexusFormat\.formatTokenCount\(totalInput\)/,
      'cost-card input-token badge should render via the shared formatter',
    );
  });

  it('renders cost-card output tokens via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      appJs,
      /OUT:[\s\S]*?window\.NexusFormat\.formatTokenCount\(totalOutput\)/,
      'cost-card output-token badge should render via the shared formatter',
    );
  });
});

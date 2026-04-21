/**
 * Shared formatter — static asset regression tests.
 *
 * `nexus-format.js` is a vanilla-JS file auto-injected into every
 * dashboard page by oculus's chrome-injection pass. It defines the
 * canonical `window.NexusFormat.*` helpers that every dashboard
 * consumes for cost and token rendering.
 *
 * These tests validate the source text directly (grep-against-source),
 * mirroring the pattern established by spider-ui.test.ts. They also
 * evaluate the module in a minimal simulated-window sandbox to pin
 * the runtime behaviour (precision, locale grouping, parenthetical
 * suppression).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const formatterJs = readFileSync(resolve(__dirname, 'nexus-format.js'), 'utf-8');

// ── Source-grep assertions ───────────────────────────────────────────

describe('nexus-format.js source structure', () => {
  it('defines formatTokenCount passing "en-US" locale explicitly', () => {
    assert.match(
      formatterJs,
      /function formatTokenCount\(n\)/,
      'should define formatTokenCount helper',
    );
    const block = formatterJs.match(
      /function formatTokenCount[\s\S]*?(?=\n  function |\n\s*global\.)/,
    );
    assert.ok(block, 'should find formatTokenCount body');
    assert.match(
      block[0],
      /toLocaleString\(['"]en-US['"]\)/,
      'formatTokenCount must pass "en-US" locale explicitly',
    );
  });

  it('defines formatCostUsd using toFixed(2) with $ prefix', () => {
    assert.match(
      formatterJs,
      /function formatCostUsd\(costUsd\)/,
      'should define formatCostUsd helper',
    );
    const block = formatterJs.match(
      /function formatCostUsd[\s\S]*?(?=\n  function |\n\s*global\.)/,
    );
    assert.ok(block, 'should find formatCostUsd body');
    assert.match(block[0], /toFixed\(2\)/, 'formatCostUsd must emit two decimals');
    assert.match(block[0], /['"]\$['"]\s*\+/, 'formatCostUsd must prefix with "$"');
    assert.match(
      block[0],
      /isFinite/,
      'formatCostUsd must apply an isFinite fallback to 0',
    );
  });

  it('defines formatCostWithTokens with parenthetical suppression on absent tokens', () => {
    assert.match(
      formatterJs,
      /function formatCostWithTokens\(costUsd, inputTokens, outputTokens\)/,
      'should define formatCostWithTokens helper',
    );
    const block = formatterJs.match(
      /function formatCostWithTokens[\s\S]*?(?=\n  function |\n\s*global\.)/,
    );
    assert.ok(block, 'should find formatCostWithTokens body');
    assert.match(
      block[0],
      /inputTokens\s*===\s*undefined\s*\|\|\s*outputTokens\s*===\s*undefined/,
      'formatCostWithTokens must omit parenthetical when either token count is undefined',
    );
    assert.match(
      block[0],
      /formatTokenCount\(inputTokens\)[\s\S]*?input[\s\S]*?formatTokenCount\(outputTokens\)[\s\S]*?output/,
      'formatCostWithTokens must render "(N input, M output)" via formatTokenCount',
    );
  });

  it('exposes the three helpers on window.NexusFormat', () => {
    assert.match(
      formatterJs,
      /global\.NexusFormat\s*=\s*\{/,
      'should assign a namespace object to window (via global parameter)',
    );
    assert.match(formatterJs, /formatCostUsd:\s*formatCostUsd/);
    assert.match(formatterJs, /formatCostWithTokens:\s*formatCostWithTokens/);
    assert.match(formatterJs, /formatTokenCount:\s*formatTokenCount/);
  });
});

// ── Runtime behaviour ────────────────────────────────────────────────

interface FormatterApi {
  formatCostUsd(n: unknown): string;
  formatCostWithTokens(
    n: unknown,
    input?: number,
    output?: number,
  ): string;
  formatTokenCount(n: unknown): string;
}

function loadFormatter(): FormatterApi {
  const sandbox: { window: { NexusFormat?: FormatterApi } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(formatterJs, sandbox);
  const api = sandbox.window.NexusFormat;
  if (!api) throw new Error('nexus-format.js did not expose window.NexusFormat');
  return api;
}

describe('NexusFormat.formatCostUsd', () => {
  const fmt = loadFormatter();
  it('formats a positive cost to two decimals with leading $', () => {
    assert.equal(fmt.formatCostUsd(1.2345), '$1.23');
    assert.equal(fmt.formatCostUsd(0.1), '$0.10');
  });

  it('returns $0.00 for null/undefined/NaN/Infinity', () => {
    assert.equal(fmt.formatCostUsd(null), '$0.00');
    assert.equal(fmt.formatCostUsd(undefined), '$0.00');
    assert.equal(fmt.formatCostUsd(NaN), '$0.00');
    assert.equal(fmt.formatCostUsd(Infinity), '$0.00');
    assert.equal(fmt.formatCostUsd(-Infinity), '$0.00');
  });

  it('coerces string numerics', () => {
    assert.equal(fmt.formatCostUsd('3.14'), '$3.14');
  });

  it('rounds to nearest cent via toFixed(2)', () => {
    // Exact two-decimal values round-trip unchanged.
    assert.equal(fmt.formatCostUsd(1.23), '$1.23');
    // Third decimal below the half-cent truncates down.
    assert.equal(fmt.formatCostUsd(1.004), '$1.00');
    // Third decimal safely above the half-cent rounds up.
    assert.equal(fmt.formatCostUsd(1.016), '$1.02');
  });
});

describe('NexusFormat.formatTokenCount', () => {
  const fmt = loadFormatter();
  it('groups thousands with commas', () => {
    assert.equal(fmt.formatTokenCount(1234), '1,234');
    assert.equal(fmt.formatTokenCount(1234567), '1,234,567');
  });

  it('renders zero as "0"', () => {
    assert.equal(fmt.formatTokenCount(0), '0');
  });
});

describe('NexusFormat.formatCostWithTokens', () => {
  const fmt = loadFormatter();
  it('renders cost alone when token counts are absent', () => {
    assert.equal(fmt.formatCostWithTokens(0.5, undefined, undefined), '$0.50');
    assert.equal(fmt.formatCostWithTokens(0.5, undefined, 100), '$0.50');
    assert.equal(fmt.formatCostWithTokens(0.5, 100, undefined), '$0.50');
  });

  it('renders cost with parenthetical when both token counts present', () => {
    assert.equal(
      fmt.formatCostWithTokens(1.25, 1000, 500),
      '$1.25 (1,000 input, 500 output)',
    );
  });

  it('applies isFinite fallback to cost portion', () => {
    assert.equal(
      fmt.formatCostWithTokens(NaN, 10, 20),
      '$0.00 (10 input, 20 output)',
    );
  });
});

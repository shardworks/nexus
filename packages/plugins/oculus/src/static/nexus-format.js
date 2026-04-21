/**
 * Nexus shared formatter helpers.
 *
 * Single source of truth for cost and token formatting across every
 * guild dashboard. Exposed on `window.NexusFormat` so each dashboard's
 * vanilla-JS IIFE can consume the same canonical helpers without having
 * to re-implement them locally (which historically caused per-dashboard
 * precision drift).
 *
 * Conventions are inherited verbatim from spider's original helpers:
 *   - Cost always renders as `$x.yy` (two decimal places); non-finite
 *     input falls back to `0`.
 *   - Cost-plus-tokens renders as `$x.yy (N input, M output)` only when
 *     BOTH token counts are defined; otherwise the parenthetical is
 *     omitted entirely.
 *   - Token counts always pass `'en-US'` to `toLocaleString` so the
 *     comma grouping is stable regardless of viewer locale.
 *
 * This file is auto-injected into every dashboard page by oculus's
 * chrome-injection pass. It must run before any dashboard IIFE, so
 * oculus injects the `<script>` tag into `<head>` while dashboard
 * scripts remain at end-of-`<body>`.
 */
(function (global) {
  'use strict';

  function formatTokenCount(n) {
    return Number(n).toLocaleString('en-US');
  }

  function formatCostUsd(costUsd) {
    var n = Number(costUsd);
    if (!isFinite(n)) n = 0;
    return '$' + n.toFixed(2);
  }

  function formatCostWithTokens(costUsd, inputTokens, outputTokens) {
    var cost = formatCostUsd(costUsd);
    if (inputTokens === undefined || outputTokens === undefined) {
      return cost;
    }
    return cost + ' (' + formatTokenCount(inputTokens) + ' input, ' + formatTokenCount(outputTokens) + ' output)';
  }

  global.NexusFormat = {
    formatCostUsd: formatCostUsd,
    formatCostWithTokens: formatCostWithTokens,
    formatTokenCount: formatTokenCount,
  };
})(typeof window !== 'undefined' ? window : globalThis);

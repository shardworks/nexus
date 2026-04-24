/**
 * Unit tests for astrolabe.js pure functions.
 *
 * Since astrolabe.js is a browser IIFE, we extract and test the pure
 * functions (esc, formatDate, statusBadge, renderMarkdown, renderScopeTable,
 * renderDecisionsTable, renderObservations) by re-defining them here in an
 * identical manner.
 *
 * This validates the rendering logic without requiring a browser environment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const astrolabeJs = readFileSync(resolve(__dirname, 'astrolabe.js'), 'utf-8');

// ── Extracted pure functions (identical to astrolabe.js) ─────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso;
  }
}

function statusBadge(status) {
  var map = {
    reading: 'badge badge--active',
    analyzing: 'badge badge--active',
    writing: 'badge badge--active',
    reviewing: 'badge badge--warning',
    completed: 'badge badge--success',
    failed: 'badge badge--error'
  };
  var cls = map[status] || 'badge';
  return '<span class="' + cls + '">' + esc(status) + '</span>';
}

function applyInline(text) {
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  return text;
}

function renderMarkdown(md) {
  if (md == null || md === '') return '';

  var text = esc(md);

  var codeBlocks = [];
  text = text.replace(/```[\s\S]*?```/g, function (match) {
    var inner = match.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    var idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + inner + '</code></pre>');
    return '\x00CODEBLOCK' + idx + '\x00';
  });

  var lines = text.split('\n');
  var result = [];
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];

    var cbMatch = line.match(/^\x00CODEBLOCK(\d+)\x00$/);
    if (cbMatch) {
      result.push(codeBlocks[parseInt(cbMatch[1], 10)]);
      i++;
      continue;
    }

    var headingMatch = line.match(/^(#{1,6}) (.+)$/);
    if (headingMatch) {
      var level = headingMatch[1].length;
      var content = applyInline(headingMatch[2]);
      result.push('<h' + level + '>' + content + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^[\-\*] /.test(line)) {
      var items = [];
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        items.push('<li>' + applyInline(lines[i].replace(/^[\-\*] /, '')) + '</li>');
        i++;
      }
      result.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    if (/^\d+\. /.test(line)) {
      var olItems = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        olItems.push('<li>' + applyInline(lines[i].replace(/^\d+\. /, '')) + '</li>');
        i++;
      }
      result.push('<ol>' + olItems.join('') + '</ol>');
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    var para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^#{1,6} /.test(lines[i]) &&
           !/^[\-\*] /.test(lines[i]) &&
           !/^\d+\. /.test(lines[i]) &&
           !/^\x00CODEBLOCK/.test(lines[i])) {
      para.push(applyInline(lines[i]));
      i++;
    }
    if (para.length > 0) {
      result.push('<p>' + para.join(' ') + '</p>');
    }
  }

  return '<div class="md-content">' + result.join('') + '</div>';
}

function renderScopeTable(scope) {
  if (!scope || scope.length === 0) return '<p class="empty-state">No scope items.</p>';
  var html = '<table class="data-table"><thead><tr>' +
    '<th>ID</th><th>Description</th><th>Status</th><th>Rationale</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < scope.length; i++) {
    var s = scope[i];
    var badge = s.included
      ? '<span class="badge badge--success">included</span>'
      : '<span class="badge badge--error">excluded</span>';
    html += '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.description) +
      '</td><td>' + badge + '</td><td>' + esc(s.rationale) + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderDecisionsTable(decisions) {
  if (!decisions || decisions.length === 0) return '<p class="empty-state">No decisions.</p>';
  var html = '<table class="data-table" id="decisions-table"><thead><tr>' +
    '<th>ID</th><th>Question</th><th>Selected</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < decisions.length; i++) {
    var d = decisions[i];
    html += '<tr class="decision-row" data-idx="' + i + '">' +
      '<td>' + esc(d.id) + '</td>' +
      '<td>' + esc(d.question) + '</td>' +
      '<td>' + esc(d.selected || '\u2014') + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return '<p class="empty-state">No observations.</p>';
  }
  var html = '<div class="observation-list">';
  for (var i = 0; i < observations.length; i++) {
    var o = observations[i];
    html += '<section class="observation-card">' +
      '<header class="observation-head">' +
        '<code class="observation-id">' + esc(o.id) + '</code>' +
        '<h3 class="observation-title">' + esc(o.title) + '</h3>' +
      '</header>' +
      '<div class="observation-body">' + renderMarkdown(o.body) + '</div>' +
      '</section>';
  }
  html += '</div>';
  return html;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('esc()', () => {
  it('returns empty string for null', () => {
    assert.equal(esc(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(esc(undefined), '');
  });

  it('escapes HTML special characters', () => {
    assert.equal(esc('<script>"&'), '&lt;script&gt;&quot;&amp;');
  });

  it('converts numbers to string', () => {
    assert.equal(esc(42), '42');
  });
});

describe('formatDate()', () => {
  it('returns empty string for falsy input', () => {
    assert.equal(formatDate(''), '');
    assert.equal(formatDate(null), '');
    assert.equal(formatDate(undefined), '');
  });

  it('formats an ISO date string', () => {
    var result = formatDate('2024-01-15T10:30:00Z');
    assert.ok(result.length > 0, 'should produce a non-empty string');
  });
});

describe('statusBadge()', () => {
  it('reading maps to badge--active', () => {
    var html = statusBadge('reading');
    assert.ok(html.includes('badge badge--active'));
    assert.ok(html.includes('reading'));
  });

  it('analyzing maps to badge--active', () => {
    assert.ok(statusBadge('analyzing').includes('badge--active'));
  });

  it('writing maps to badge--active', () => {
    assert.ok(statusBadge('writing').includes('badge--active'));
  });

  it('reviewing maps to badge--warning', () => {
    assert.ok(statusBadge('reviewing').includes('badge--warning'));
  });

  it('completed maps to badge--success', () => {
    assert.ok(statusBadge('completed').includes('badge--success'));
  });

  it('failed maps to badge--error', () => {
    assert.ok(statusBadge('failed').includes('badge--error'));
  });

  it('unknown status falls back to bare badge class', () => {
    var html = statusBadge('unknown');
    assert.equal(html, '<span class="badge">unknown</span>');
  });
});

describe('renderMarkdown()', () => {
  it('returns empty string for null', () => {
    assert.equal(renderMarkdown(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(renderMarkdown(undefined), '');
  });

  it('returns empty string for empty string', () => {
    assert.equal(renderMarkdown(''), '');
  });

  it('renders headings', () => {
    var result = renderMarkdown('# H1\n## H2\n### H3');
    assert.ok(result.includes('<h1>H1</h1>'));
    assert.ok(result.includes('<h2>H2</h2>'));
    assert.ok(result.includes('<h3>H3</h3>'));
  });

  it('renders h4, h5, h6', () => {
    var result = renderMarkdown('#### H4\n##### H5\n###### H6');
    assert.ok(result.includes('<h4>H4</h4>'));
    assert.ok(result.includes('<h5>H5</h5>'));
    assert.ok(result.includes('<h6>H6</h6>'));
  });

  it('renders bold text', () => {
    var result = renderMarkdown('some **bold** text');
    assert.ok(result.includes('<strong>bold</strong>'));
  });

  it('renders italic text with asterisks', () => {
    var result = renderMarkdown('some *italic* text');
    assert.ok(result.includes('<em>italic</em>'));
  });

  it('renders inline code', () => {
    var result = renderMarkdown('use `code` here');
    assert.ok(result.includes('<code>code</code>'));
  });

  it('renders fenced code blocks', () => {
    var result = renderMarkdown('```js\nconst x = 1;\n```');
    assert.ok(result.includes('<pre><code>'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('renders unordered lists', () => {
    var result = renderMarkdown('- item1\n- item2');
    assert.ok(result.includes('<ul>'));
    assert.ok(result.includes('<li>item1</li>'));
    assert.ok(result.includes('<li>item2</li>'));
    assert.ok(result.includes('</ul>'));
  });

  it('renders ordered lists', () => {
    var result = renderMarkdown('1. first\n2. second');
    assert.ok(result.includes('<ol>'));
    assert.ok(result.includes('<li>first</li>'));
    assert.ok(result.includes('<li>second</li>'));
    assert.ok(result.includes('</ol>'));
  });

  it('renders paragraphs', () => {
    var result = renderMarkdown('hello world');
    assert.ok(result.includes('<p>hello world</p>'));
  });

  it('wraps output in md-content div', () => {
    var result = renderMarkdown('test');
    assert.ok(result.startsWith('<div class="md-content">'));
    assert.ok(result.endsWith('</div>'));
  });

  it('prevents XSS — escapes script tags', () => {
    var result = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });

  it('prevents XSS — escapes HTML in headings', () => {
    var result = renderMarkdown('# <img onerror=alert(1)>');
    assert.ok(!result.includes('<img'));
    assert.ok(result.includes('&lt;img'));
  });

  it('renders unordered lists with * prefix', () => {
    var result = renderMarkdown('* alpha\n* beta');
    assert.ok(result.includes('<ul>'));
    assert.ok(result.includes('<li>alpha</li>'));
  });
});

describe('renderScopeTable()', () => {
  it('returns empty state for null scope', () => {
    assert.ok(renderScopeTable(null).includes('No scope items'));
  });

  it('returns empty state for empty array', () => {
    assert.ok(renderScopeTable([]).includes('No scope items'));
  });

  it('renders included item with success badge', () => {
    var scope = [
      { id: 's1', description: 'Feature A', rationale: 'Important', included: true }
    ];
    var html = renderScopeTable(scope);
    assert.ok(html.includes('badge--success'));
    assert.ok(html.includes('included'));
    assert.ok(html.includes('Feature A'));
    assert.ok(html.includes('Important'));
  });

  it('renders excluded item with error badge', () => {
    var scope = [
      { id: 's2', description: 'Feature B', rationale: 'Out of scope', included: false }
    ];
    var html = renderScopeTable(scope);
    assert.ok(html.includes('badge--error'));
    assert.ok(html.includes('excluded'));
  });

  it('renders two items correctly', () => {
    var scope = [
      { id: 's1', description: 'A', rationale: 'R1', included: true },
      { id: 's2', description: 'B', rationale: 'R2', included: false }
    ];
    var html = renderScopeTable(scope);
    assert.ok(html.includes('s1'));
    assert.ok(html.includes('s2'));
    assert.ok(html.includes('badge--success'));
    assert.ok(html.includes('badge--error'));
  });

  it('escapes HTML in scope fields', () => {
    var scope = [
      { id: '<xss>', description: '<b>evil</b>', rationale: '&test', included: true }
    ];
    var html = renderScopeTable(scope);
    assert.ok(html.includes('&lt;xss&gt;'));
    assert.ok(!html.includes('<xss>'));
  });
});

describe('renderDecisionsTable()', () => {
  it('returns empty state for null decisions', () => {
    assert.ok(renderDecisionsTable(null).includes('No decisions'));
  });

  it('returns empty state for empty array', () => {
    assert.ok(renderDecisionsTable([]).includes('No decisions'));
  });

  it('renders a decision row', () => {
    var decisions = [
      { id: 'd1', question: 'Which DB?', selected: 'postgres', options: {} }
    ];
    var html = renderDecisionsTable(decisions);
    assert.ok(html.includes('d1'));
    assert.ok(html.includes('Which DB?'));
    assert.ok(html.includes('postgres'));
    assert.ok(html.includes('decision-row'));
  });

  it('shows em-dash when no selection', () => {
    var decisions = [
      { id: 'd2', question: 'Color?', options: {} }
    ];
    var html = renderDecisionsTable(decisions);
    assert.ok(html.includes('\u2014'));
  });

  it('renders multiple decisions with correct data-idx', () => {
    var decisions = [
      { id: 'd1', question: 'Q1', selected: 'A', options: {} },
      { id: 'd2', question: 'Q2', selected: 'B', options: {} }
    ];
    var html = renderDecisionsTable(decisions);
    assert.ok(html.includes('data-idx="0"'));
    assert.ok(html.includes('data-idx="1"'));
  });

  it('escapes HTML in decision fields', () => {
    var decisions = [
      { id: '<xss>', question: '<script>', selected: '&test', options: {} }
    ];
    var html = renderDecisionsTable(decisions);
    assert.ok(html.includes('&lt;xss&gt;'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
  });
});

describe('renderObservations()', () => {
  it('returns empty state for null', () => {
    assert.ok(renderObservations(null).includes('No observations'));
  });

  it('returns empty state for undefined', () => {
    assert.ok(renderObservations(undefined).includes('No observations'));
  });

  it('returns empty state for empty array', () => {
    assert.ok(renderObservations([]).includes('No observations'));
  });

  it('returns empty state for non-array input (legacy string payload)', () => {
    // Defensive: the new contract is array-only, but a legacy plandoc
    // might still carry a prose string. Render as empty rather than
    // crashing with a .length access on a string or concatenating junk.
    var html = renderObservations('## Risks\n- Something');
    assert.ok(html.includes('No observations'));
    assert.ok(!html.includes('Risks'));
  });

  it('renders a single observation as a card with id, title, and markdown body', () => {
    var observations = [
      {
        id: 'obs-1',
        title: 'Replace deprecated helper in src/foo.ts',
        body: '`renderLegacy` in `src/foo.ts` is superseded by `renderCard`.',
      },
    ];
    var html = renderObservations(observations);
    assert.ok(html.includes('observation-list'));
    assert.ok(html.includes('observation-card'));
    assert.ok(html.includes('obs-1'));
    assert.ok(html.includes('Replace deprecated helper in src/foo.ts'));
    // Body goes through renderMarkdown, which wraps text in md-content
    assert.ok(html.includes('md-content'));
    // Inline code from the body's markdown made it through
    assert.ok(html.includes('<code>renderLegacy</code>'));
  });

  it('renders many observations as distinct cards in order', () => {
    var observations = [
      { id: 'obs-1', title: 'First concern', body: 'Body one' },
      { id: 'obs-2', title: 'Second concern', body: 'Body two' },
      { id: 'obs-3', title: 'Third concern', body: 'Body three' },
    ];
    var html = renderObservations(observations);
    var cardCount = (html.match(/observation-card/g) || []).length;
    assert.equal(cardCount, 3);
    assert.ok(html.includes('obs-1'));
    assert.ok(html.includes('obs-2'));
    assert.ok(html.includes('obs-3'));
    assert.ok(html.indexOf('First concern') < html.indexOf('Second concern'));
    assert.ok(html.indexOf('Second concern') < html.indexOf('Third concern'));
  });

  it('escapes HTML in observation id and title fields', () => {
    var observations = [
      { id: '<xss-id>', title: '<b>sneaky</b>', body: 'safe body' },
    ];
    var html = renderObservations(observations);
    assert.ok(html.includes('&lt;xss-id&gt;'));
    assert.ok(html.includes('&lt;b&gt;sneaky&lt;/b&gt;'));
    // Raw tags must not leak through
    assert.ok(!html.includes('<xss-id>'));
    assert.ok(!html.includes('<b>sneaky</b>'));
  });

  it('renders body through the markdown pipeline (lists, bold, code)', () => {
    var observations = [
      {
        id: 'obs-1',
        title: 'Refactor opportunity',
        body: '**Why:** duplication.\n\n- `src/a.ts` has the old pattern\n- `src/b.ts` mirrors it',
      },
    ];
    var html = renderObservations(observations);
    assert.ok(html.includes('<strong>Why:</strong>'));
    assert.ok(html.includes('<ul>'));
    assert.ok(html.includes('<code>src/a.ts</code>'));
  });
});

describe('astrolabe.js observations tab wiring', () => {
  // Guard that the observations tab dispatches through renderObservations,
  // not through the generic renderMarkdown. renderMarkdown on an array
  // produces "[object Object]" concatenation garbage.
  it('observations tab case calls renderObservations in astrolabe.js', () => {
    assert.match(
      astrolabeJs,
      /case 'observations':[\s\S]*?renderObservations\(currentPlan\.observations\)/,
      'observations tab must call renderObservations, not renderMarkdown',
    );
    assert.doesNotMatch(
      astrolabeJs,
      /case 'observations':[\s\S]*?renderMarkdown\(currentPlan\.observations\)/,
      'observations tab must not call renderMarkdown on the array-typed field',
    );
  });
});

describe('astrolabe.js plan-detail writ cross-link URL', () => {
  // Regression guard: the plan-detail brief-writ and mandate-writ anchors
  // historically targeted '/pages/clerk/?writ=…', but no plugin registers
  // a page with id 'clerk' — the Clerk's writs page is registered with id
  // 'writs' and served at '/pages/writs/'. That produced a bare 404 on
  // every click. Pin the canonical URL shape and forbid the broken one.

  it('writ deep-links target the canonical Clerk writs page path', () => {
    assert.match(
      astrolabeJs,
      /\/pages\/writs\/\?writ=/,
      'writ deep-links must target /pages/writs/?writ=',
    );
    assert.doesNotMatch(
      astrolabeJs,
      /\/pages\/clerk\/\?writ=/,
      'writ deep-links must NOT target the broken /pages/clerk/?writ= path',
    );
  });

  it('both plan-detail writ anchors (brief and mandate) use the canonical path', () => {
    // The plan-detail view emits two writ anchors: the brief-writ link and
    // the (optional) mandate-writ link. Both must use the canonical shape.
    var matches = astrolabeJs.match(/\/pages\/writs\/\?writ=/g) || [];
    assert.ok(
      matches.length >= 2,
      'expected at least 2 canonical /pages/writs/?writ= links (brief + mandate), found ' + matches.length,
    );
  });
});

// ── Cost table routes through shared formatter ───────────────────────

describe('astrolabe.js cost table delegates to window.NexusFormat', () => {
  // The renderCostTable helper formerly rendered cost via
  // `'$' + cost.toFixed(4)` and token counts via bare `.toLocaleString()`
  // (no locale argument). This drifted from every other dashboard's
  // two-decimal cost and US-locale token grouping. All cost/token
  // rendering must now route through the shared window.NexusFormat
  // namespace served by oculus.

  it('contains no toFixed(4) drift (legacy precision)', () => {
    assert.doesNotMatch(
      astrolabeJs,
      /toFixed\(4\)/,
      'astrolabe.js must not use toFixed(4) — shared formatter enforces $x.yy',
    );
  });

  it('contains no bare .toLocaleString() calls on token counts', () => {
    // formatDate uses toLocaleString() on a Date instance — that is fine.
    // But no numeric .toLocaleString() call should remain, because every
    // locale-formatted integer must route through the shared namespace
    // which pins 'en-US' grouping.
    var numericLocaleMatches =
      astrolabeJs.match(/\b(?:input|output|cost|total)\w*\.toLocaleString\(/gi) || [];
    assert.equal(
      numericLocaleMatches.length,
      0,
      'numeric *.toLocaleString() calls must be replaced with window.NexusFormat.formatTokenCount',
    );
  });

  it('renders per-row cost via window.NexusFormat.formatCostUsd', () => {
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatCostUsd\(cost\)/,
      'per-row cost cell should render via the shared formatter',
    );
  });

  it('renders total cost via window.NexusFormat.formatCostUsd', () => {
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatCostUsd\(totalCost\)/,
      'total cost cell should render via the shared formatter',
    );
  });

  it('renders per-row token counts via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatTokenCount\(inputTokens\)/,
      'per-row input token cell should render via the shared formatter',
    );
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatTokenCount\(outputTokens\)/,
      'per-row output token cell should render via the shared formatter',
    );
  });

  it('renders total token counts via window.NexusFormat.formatTokenCount', () => {
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatTokenCount\(totalInput\)/,
      'total input token cell should render via the shared formatter',
    );
    assert.match(
      astrolabeJs,
      /window\.NexusFormat\.formatTokenCount\(totalOutput\)/,
      'total output token cell should render via the shared formatter',
    );
  });
});

// ── Cost-panel rig lookup is not window-blind ────────────────────────

describe('astrolabe.js cost-panel rig lookup uses rig-for-writ', () => {
  // Regression guard: the cost panel historically fetched
  // `/api/rig/list?limit=100` and client-side `.find()`d the plan's rig by
  // writId. Any plan whose rig had aged out of the newest 100 silently
  // rendered "Cost data not available". The replacement endpoint
  // `/api/rig/for-writ?writId=<planId>` does a direct server-side lookup
  // with no list window. Pin the new endpoint in the cost-data function
  // and forbid the legacy list-and-find form within that same function
  // body — scoped so future legitimate list-view fetches elsewhere on
  // this page are not pre-empted.
  const fetchCostDataMatch = astrolabeJs.match(
    /function fetchCostData\([\s\S]*?\n  \}/,
  );
  const fetchCostDataBody = fetchCostDataMatch ? fetchCostDataMatch[0] : '';

  it('extracts the fetchCostData function body from source', () => {
    assert.ok(
      fetchCostDataBody,
      'should find fetchCostData function body in astrolabe.js',
    );
  });

  it('fetches the rig directly via /api/rig/for-writ with an encoded writId', () => {
    assert.match(
      fetchCostDataBody,
      /\/api\/rig\/for-writ\?writId=['"]?\s*\+\s*encodeURIComponent\(planId\)/,
      'cost-data path must fetch /api/rig/for-writ?writId=<encodeURIComponent(planId)>',
    );
  });

  it('does not fetch the windowed /api/rig/list?limit=100 in the cost path', () => {
    assert.doesNotMatch(
      fetchCostDataBody,
      /\/api\/rig\/list\?limit=100/,
      'cost-data path must not fetch the windowed rig list — it silently hides aged-out rigs',
    );
  });

  it('does not client-side .find() over an array of rigs in the cost path', () => {
    // The for-writ endpoint returns a single RigDoc | null, so there is
    // no array to scan. A defensive .find() wrapper would be cargo-cult
    // and would hide any future contract break.
    assert.doesNotMatch(
      fetchCostDataBody,
      /rigs\.find\(/,
      'cost-data path must not .find() over a rigs array — the for-writ endpoint is singular',
    );
  });
});

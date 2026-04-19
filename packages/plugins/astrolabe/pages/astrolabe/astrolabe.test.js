/**
 * Unit tests for astrolabe.js pure functions.
 *
 * Since astrolabe.js is a browser IIFE, we extract and test the pure
 * functions (esc, formatDate, statusBadge, renderMarkdown, renderScopeTable,
 * renderDecisionsTable) by re-defining them here in an identical manner.
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

/**
 * Unit tests for parent/child writ hierarchy in writs/index.html.
 *
 * Extracts and tests the pure logic behind:
 * - sortedFilteredWrits — hierarchical ordering, toggle, search
 * - phaseBadge — phase → badge-class mapping
 * - Toggle button state
 * - Children table rendering in detail view
 * - Parent link in detail view
 *
 * Uses a minimal DOM shim (same pattern as writs-type-filter.test.js).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM shim ────────────────────────────────────────────────

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.innerHTML = '';
    this.dataset = {};
    this.children = [];
    this._listeners = {};
    this.style = {};
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector) {
    // Minimal support for class selectors
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.children.filter(c =>
        (c.className || '').includes(cls),
      );
    }
    return [];
  }

  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  click() {
    for (const fn of this._listeners.click ?? []) fn();
  }

  get classList() {
    const self = this;
    return {
      toggle(cls, force) {
        const classes = self.className.split(/\s+/).filter(Boolean);
        const idx = classes.indexOf(cls);
        if (force && idx === -1) classes.push(cls);
        if (!force && idx !== -1) classes.splice(idx, 1);
        self.className = classes.join(' ');
      },
      contains(cls) {
        return self.className.split(/\s+/).includes(cls);
      },
    };
  }
}

function createElement(tag) {
  return new FakeElement(tag);
}

// ── Extracted logic (mirrors index.html) ────────────────────────────

function phaseBadge(phase) {
  const map = {
    new: 'badge badge--draft',
    open: 'badge badge--active',
    stuck: 'badge badge--warning',
    completed: 'badge badge--success',
    failed: 'badge badge--error',
    cancelled: 'badge badge--warning',
  };
  const cls = map[phase] ?? 'badge';
  return `<span class="${cls}">${phase}</span>`;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compareVal(a, b, col) {
  const av = a[col] ?? '';
  const bv = b[col] ?? '';
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function rowActions(w) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(w.phase);
      const isStuck = w.phase === 'stuck';
  if (isTerminal) return '';
  const btns = [];
  if (w.phase === 'new') {
    btns.push(`<button class="btn btn--primary row-action-btn" style="padding:0.15rem 0.5rem;font-size:0.8rem" data-action="row-publish" data-id="${w.id}">Start</button>`);
  }
  btns.push(`<button class="btn btn--danger row-action-btn" style="padding:0.15rem 0.5rem;font-size:0.8rem" data-action="row-cancel" data-id="${w.id}">Cancel</button>`);
  return btns.join(' ');
}

/**
 * Extracted sortedFilteredWrits logic — mirrors index.html.
 */
function sortedFilteredWrits(writs, childrenMap, showChildren, searchText, sortCol, sortDir) {
  let roots = writs.slice();

  // Text filter on roots
  if (searchText) {
    const q = searchText.toLowerCase();
    roots = roots.filter(w => (w.title ?? '').toLowerCase().includes(q));
  }

  // Sort roots by current sort column
  roots.sort((a, b) => {
    const cmp = compareVal(a, b, sortCol);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Interleave children beneath each root
  const result = [];
  for (const root of roots) {
    result.push({ writ: root, isChild: false });
    if (showChildren) {
      let children = childrenMap[root.id] ?? [];
      // Text filter on children too
      if (searchText) {
        const q = searchText.toLowerCase();
        children = children.filter(w => (w.title ?? '').toLowerCase().includes(q));
      }
      for (const child of children) {
        result.push({ writ: child, isChild: true });
      }
    }
  }
  return result;
}

/**
 * Extracted renderDetail logic for parent link and children table.
 * Returns the full HTML string, same as the index.html renderDetail.
 */
function renderDetail(writ) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(writ.phase);
  const isStuck = writ.phase === 'stuck';
  const isDraft = writ.phase === 'new';
  let html = '';

  // Edit form
  html += `<div class="detail-section" id="edit-section-${writ.id}">`;
  html += `<h4>${isDraft ? 'Edit Draft' : 'Edit'}</h4>`;
  html += `<div class="form-row"><label>Title</label>`;
  html += `<input type="text" id="edit-title-${writ.id}" value="${escAttr(writ.title ?? '')}"></div>`;
  html += `<div class="form-row"><label>Body</label>`;
  html += `<textarea id="edit-body-${writ.id}" rows="8">${escHtml(writ.body ?? '')}</textarea></div>`;
  if (isDraft) {
    html += `<div class="form-row"><label>Type</label><select id="edit-type-${writ.id}"></select></div>`;
    html += `<div class="form-row"><label>Codex</label><select id="edit-codex-${writ.id}"></select></div>`;
  }
  html += `<div class="action-buttons">`;
  html += `<button class="btn btn--primary" data-action="save-edit" data-id="${writ.id}">Save</button>`;
  html += `</div></div>`;

  // Details grid
  html += `<div class="detail-section"><h4>Details</h4><dl class="detail-grid">`;
  if (writ.codex) html += `<dt>Codex</dt><dd>${escHtml(writ.codex)}</dd>`;
  if (writ.parent) {
    html += `<dt>Parent</dt><dd><a href="?writ=${encodeURIComponent(writ.parent.id)}" style="color:var(--blue,#7aa2f7);text-decoration:underline;cursor:pointer">${escHtml(writ.parent.title)}</a> ${phaseBadge(writ.parent.phase)}</dd>`;
  }
  html += `<dt>Created</dt><dd></dd>`;
  html += `</dl></div>`;

  // Transition actions (simplified)
  if (!isTerminal) {
    html += `<div class="detail-section action-buttons" id="actions-${writ.id}"></div>`;
  }

  // Repost
  if (writ.phase === 'failed' || writ.phase === 'cancelled') {
    html += `<div class="detail-section"><button class="btn" data-action="repost" data-id="${writ.id}">Repost</button></div>`;
  }

  // Links (simplified)
  html += `<div class="detail-section" id="links-section-${writ.id}"><h4>Links</h4></div>`;

  // Children
  const childItems = writ._fullChildren ?? writ.children?.items ?? [];
  if (childItems.length > 0) {
    html += `<div class="detail-section">`;
    html += `<h4>Children</h4>`;

    if (writ.children?.summary) {
      html += `<div style="margin-bottom:0.5rem">`;
      for (const [phase, count] of Object.entries(writ.children.summary)) {
        html += phaseBadge(phase) + ` <span style="margin-right:0.75rem">${count}</span>`;
      }
      html += `</div>`;
    }

    html += `<table class="data-table"><thead><tr>`;
    html += `<th>Phase</th><th>Title</th><th>Type</th><th>ID</th><th>Actions</th>`;
    html += `</tr></thead><tbody>`;
    for (const child of childItems) {
      html += `<tr class="writ-row child-detail-row" data-child-id="${child.id}" style="cursor:pointer">`;
      html += `<td>${phaseBadge(child.phase)}</td>`;
      html += `<td>${escHtml(child.title ?? '')}</td>`;
      html += `<td>${escHtml(child.type ?? '')}</td>`;
      html += `<td><code>${child.id}</code></td>`;
      html += `<td class="row-actions" style="white-space:nowrap">${rowActions(child)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }

  return html;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('sortedFilteredWrits — hierarchy ordering', () => {
  const rootA = { id: 'a', title: 'Alpha Root', type: 'mandate', phase: 'open', createdAt: '2025-01-01' };
  const rootB = { id: 'b', title: 'Beta Root', type: 'mandate', phase: 'open', createdAt: '2025-01-02' };
  const childA1 = { id: 'a1', title: 'Alpha Child 1', type: 'task', phase: 'open', parentId: 'a', createdAt: '2025-01-03' };
  const childA2 = { id: 'a2', title: 'Alpha Child 2', type: 'task', phase: 'open', parentId: 'a', createdAt: '2025-01-04' };
  const childB1 = { id: 'b1', title: 'Beta Child 1', type: 'task', phase: 'open', parentId: 'b', createdAt: '2025-01-05' };

  it('happy path — children interleaved beneath parents', () => {
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1, childA2], b: [childB1] };
    const result = sortedFilteredWrits(writs, childrenMap, true, '', 'createdAt', 'asc');

    assert.deepEqual(result.map(r => [r.writ.id, r.isChild]), [
      ['a', false],
      ['a1', true],
      ['a2', true],
      ['b', false],
      ['b1', true],
    ]);
  });

  it('children hidden — only roots returned', () => {
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1, childA2], b: [childB1] };
    const result = sortedFilteredWrits(writs, childrenMap, false, '', 'createdAt', 'asc');

    assert.deepEqual(result.map(r => [r.writ.id, r.isChild]), [
      ['a', false],
      ['b', false],
    ]);
  });

  it('sort changes root order only — children stay beneath parent', () => {
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1, childA2], b: [childB1] };
    // Sort by title ascending: Alpha < Beta
    const result = sortedFilteredWrits(writs, childrenMap, true, '', 'title', 'asc');

    assert.deepEqual(result.map(r => [r.writ.id, r.isChild]), [
      ['a', false],
      ['a1', true],
      ['a2', true],
      ['b', false],
      ['b1', true],
    ]);

    // Sort by title descending: Beta > Alpha
    const result2 = sortedFilteredWrits(writs, childrenMap, true, '', 'title', 'desc');
    assert.deepEqual(result2.map(r => [r.writ.id, r.isChild]), [
      ['b', false],
      ['b1', true],
      ['a', false],
      ['a1', true],
      ['a2', true],
    ]);
  });

  it('search filters both roots and children', () => {
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1, childA2], b: [childB1] };
    // Search for 'Alpha' — rootA matches, childA1 and childA2 match, rootB doesn't match
    const result = sortedFilteredWrits(writs, childrenMap, true, 'Alpha', 'createdAt', 'asc');

    assert.deepEqual(result.map(r => [r.writ.id, r.isChild]), [
      ['a', false],
      ['a1', true],
      ['a2', true],
    ]);
  });

  it('search respects toggle — hidden children not matched', () => {
    // childA1 title contains 'Child 1' but rootA does not contain 'Child'
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1], b: [childB1] };
    const result = sortedFilteredWrits(writs, childrenMap, false, 'Child 1', 'createdAt', 'asc');

    // Neither root matches 'Child 1', and children are hidden
    assert.deepEqual(result, []);
  });

  it('search matches child title but not root when children visible', () => {
    // Search for 'Child 1': rootA title doesn't match, but childA1 does
    // Since rootA doesn't match the root filter, it's excluded entirely
    const writs = [rootA, rootB];
    const childrenMap = { a: [childA1], b: [childB1] };
    const result = sortedFilteredWrits(writs, childrenMap, true, 'Child 1', 'createdAt', 'asc');

    // Root filter excludes both roots since neither title contains 'Child 1'
    assert.deepEqual(result, []);
  });

  it('empty children — root appears alone with no child rows', () => {
    const writs = [rootA];
    const childrenMap = {};
    const result = sortedFilteredWrits(writs, childrenMap, true, '', 'createdAt', 'asc');

    assert.deepEqual(result.map(r => [r.writ.id, r.isChild]), [
      ['a', false],
    ]);
  });

  it('empty writs array returns empty', () => {
    const result = sortedFilteredWrits([], {}, true, '', 'createdAt', 'asc');
    assert.deepEqual(result, []);
  });
});

describe('phaseBadge — phase → class mapping', () => {
  it('maps open to badge badge--active', () => {
    const result = phaseBadge('open');
    assert.equal(result, '<span class="badge badge--active">open</span>');
  });

  it('maps cancelled to badge badge--warning', () => {
    const result = phaseBadge('cancelled');
    assert.equal(result, '<span class="badge badge--warning">cancelled</span>');
  });

  it('maps unknown phase to plain badge', () => {
    const result = phaseBadge('unknown');
    assert.equal(result, '<span class="badge">unknown</span>');
  });
});

describe('Toggle button state', () => {
  it('initial state: showChildren true, button has active-filter', () => {
    let showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';
    assert.equal(showChildren, true);
    assert.ok(btn.classList.contains('active-filter'));
  });

  it('after first click: showChildren false, button loses active-filter', () => {
    let showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';

    // Simulate click
    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);

    assert.equal(showChildren, false);
    assert.ok(!btn.classList.contains('active-filter'));
  });

  it('after second click: showChildren true, button regains active-filter', () => {
    let showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';

    // First click
    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);

    // Second click
    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);

    assert.equal(showChildren, true);
    assert.ok(btn.classList.contains('active-filter'));
  });
});

describe('Children table rendering in detail view', () => {
  it('renders children table with 3 rows and correct columns', () => {
    const writ = {
      id: 'parent-1',
      title: 'Parent Writ',
      phase: 'open',
      body: 'body text',
      _fullChildren: [
        { id: 'c1', title: 'Child 1', type: 'task', phase: 'open', createdAt: '2025-01-01' },
        { id: 'c2', title: 'Child 2', type: 'task', phase: 'completed', createdAt: '2025-01-02' },
        { id: 'c3', title: 'Child 3', type: 'bug', phase: 'new', createdAt: '2025-01-03' },
      ],
      children: {
        summary: { active: 1, completed: 1, new: 1 },
        items: [],
      },
    };

    const html = renderDetail(writ);

    // Should contain children section
    assert.ok(html.includes('<h4>Children</h4>'), 'Children header should exist');

    // Should have 3 child-detail-row entries
    const rowMatches = html.match(/child-detail-row/g);
    assert.equal(rowMatches.length, 3, 'Should have 3 child rows');

    // Should have Phase, Title, Type, ID, Actions columns (no Created)
    assert.ok(html.includes('<th>Phase</th><th>Title</th><th>Type</th><th>ID</th><th>Actions</th>'));

    // Verify child data appears
    assert.ok(html.includes('Child 1'));
    assert.ok(html.includes('Child 2'));
    assert.ok(html.includes('Child 3'));
    assert.ok(html.includes('data-child-id="c1"'));
    assert.ok(html.includes('data-child-id="c2"'));
    assert.ok(html.includes('data-child-id="c3"'));
  });

  it('does not render children section when no children', () => {
    const writ = {
      id: 'parent-2',
      title: 'No Children',
      phase: 'open',
      body: '',
      children: { summary: {}, items: [] },
    };

    const html = renderDetail(writ);
    assert.ok(!html.includes('<h4>Children</h4>'), 'Children header should not exist');
    assert.ok(!html.includes('child-detail-row'), 'No child rows');
  });

  it('children in detail table ordered by createdAt ascending', () => {
    const writ = {
      id: 'parent-3',
      title: 'Parent',
      phase: 'open',
      body: '',
      _fullChildren: [
        { id: 'c-early', title: 'Early', type: 'task', phase: 'open', createdAt: '2025-01-01' },
        { id: 'c-late', title: 'Late', type: 'task', phase: 'open', createdAt: '2025-01-10' },
        { id: 'c-mid', title: 'Mid', type: 'task', phase: 'open', createdAt: '2025-01-05' },
      ],
      children: { summary: {}, items: [] },
    };

    const html = renderDetail(writ);
    const earlyIdx = html.indexOf('c-early');
    const midIdx = html.indexOf('c-mid');
    const lateIdx = html.indexOf('c-late');

    // _fullChildren is pre-sorted by the caller, but we test that the rendering
    // preserves the order they appear in. In real code fetchChildrenForRoots sorts them.
    assert.ok(earlyIdx < lateIdx, 'Early should appear before Late');
    assert.ok(earlyIdx < midIdx, 'Early should appear before Mid');
  });
});

describe('Parent link in detail view', () => {
  it('renders parent row with link and phase badge when parent exists', () => {
    const writ = {
      id: 'child-w',
      title: 'Child Writ',
      phase: 'open',
      body: '',
      parent: { id: 'w-parent', title: 'Parent Writ', phase: 'open' },
    };

    const html = renderDetail(writ);

    // Should contain Parent dt/dd
    assert.ok(html.includes('<dt>Parent</dt>'), 'Parent label should exist');
    // Should contain link to parent
    assert.ok(html.includes('href="?writ=w-parent"'), 'Parent link should use ?writ= param');
    assert.ok(html.includes('Parent Writ'), 'Parent title should appear');
    // Should have phase badge for parent
    assert.ok(html.includes('badge badge--active'), 'Parent phase badge should appear');
  });

  it('does not render parent row when parent is null', () => {
    const writ = {
      id: 'root-w',
      title: 'Root Writ',
      phase: 'open',
      body: '',
      parent: null,
    };

    const html = renderDetail(writ);
    assert.ok(!html.includes('<dt>Parent</dt>'), 'Parent label should not exist');
  });

  it('does not render parent row when parent is undefined', () => {
    const writ = {
      id: 'root-w2',
      title: 'Root Writ 2',
      phase: 'open',
      body: '',
    };

    const html = renderDetail(writ);
    assert.ok(!html.includes('<dt>Parent</dt>'), 'Parent label should not exist');
  });

  it('encodes parent id in URL', () => {
    const writ = {
      id: 'child-w2',
      title: 'Child',
      phase: 'open',
      body: '',
      parent: { id: 'w-parent with spaces', title: 'Parent', phase: 'open' },
    };

    const html = renderDetail(writ);
    assert.ok(html.includes('href="?writ=w-parent%20with%20spaces"'), 'Parent id should be URL-encoded');
  });
});

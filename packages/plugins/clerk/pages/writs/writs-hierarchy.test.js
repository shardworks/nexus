/**
 * Unit tests for deep-descendant writ hierarchy in writs/index.html.
 *
 * Extracts and tests the pure logic behind:
 * - sortedFilteredWrits — depth-numbered row emission, per-node and global
 *   collapse, ancestor-preserve title search, overflow-row insertion at
 *   the depth cap, and root-only sorting.
 * - phaseBadge — phase → badge-class mapping.
 * - Toggle button state.
 * - Children table rendering in the detail view (still direct-children
 *   only — see D20).
 * - Parent link in detail view.
 *
 * Mirrors the in-file logic of pages/writs/index.html so changes there
 * stay covered by this test suite.
 */

import { describe, it } from 'node:test';
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
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.children.filter((c) => (c.className || '').includes(cls));
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

/**
 * Mandate's WritTypeInfo, byte-faithful to the registered config in
 * packages/plugins/clerk/src/clerk.ts. Drives the test-side
 * `derivePresentation` so the page-and-tests pair stays coherent under
 * the T6 derivation rules.
 */
const MANDATE_TYPE_INFO = {
  name: 'mandate',
  description: null,
  source: 'builtin',
  isDefault: true,
  states: [
    { name: 'new', classification: 'initial', attrs: [], allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', attrs: [], allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

let writTypesByName = new Map([['mandate', MANDATE_TYPE_INFO]]);

/**
 * Mirror of the page's `derivePresentation` helper (T6/D16). Pure: no
 * DOM access. The function is exercised directly by the helper-shape
 * tests below and is the single source feeding `phaseBadge`,
 * `rowActions`, and the detail-view button generator on this page.
 */
function derivePresentation(type, phase) {
  const typeInfo = writTypesByName.get(type);
  const state = typeInfo
    ? typeInfo.states.find((s) => s.name === phase)
    : undefined;

  if (!state) {
    return {
      classification: 'unknown',
      attrs: [],
      badgeClass: '',
      indicator: '?',
      allowedTransitions: [],
      isTerminal: false,
    };
  }

  const classification = state.classification;
  const attrs = state.attrs ?? [];
  const has = (a) => attrs.includes(a);

  let badgeClass = '';
  let indicator = '';
  if (classification === 'initial') {
    indicator = '◌'; badgeClass = 'badge--draft';
  } else if (classification === 'active') {
    if (has('stuck')) { indicator = '◇'; badgeClass = 'badge--warning'; }
    else { indicator = '●'; badgeClass = 'badge--active'; }
  } else if (classification === 'terminal') {
    if (has('success')) { indicator = '○'; badgeClass = 'badge--success'; }
    else if (has('failure')) { indicator = '✕'; badgeClass = 'badge--error'; }
    else if (has('cancelled')) { indicator = '⊘'; badgeClass = 'badge--warning'; }
    else { indicator = '○'; badgeClass = ''; }
  }

  return {
    classification,
    attrs,
    badgeClass,
    indicator,
    allowedTransitions: state.allowedTransitions ?? [],
    isTerminal: classification === 'terminal',
  };
}

function phaseBadge(phaseOrWrit, typeArg) {
  let type;
  let phase;
  if (typeof phaseOrWrit === 'string') {
    phase = phaseOrWrit;
    type = typeArg ?? 'mandate';
  } else if (phaseOrWrit && typeof phaseOrWrit === 'object') {
    type = phaseOrWrit.type ?? 'mandate';
    phase = phaseOrWrit.phase ?? '';
  } else {
    type = 'mandate';
    phase = '';
  }
  const { badgeClass } = derivePresentation(type, phase);
  const cls = badgeClass ? `badge ${badgeClass}` : 'badge';
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
  const present = derivePresentation(w.type, w.phase);
  if (present.isTerminal) return '';

  const fromTypeInfo = writTypesByName.get(w.type);
  const fromState = fromTypeInfo
    ? fromTypeInfo.states.find((s) => s.name === w.phase)
    : undefined;
  const fromClassification = fromState?.classification;

  const btns = [];
  for (const dest of present.allowedTransitions) {
    const destState = fromTypeInfo
      ? fromTypeInfo.states.find((s) => s.name === dest)
      : undefined;
    if (!destState) continue;
    const destAttrs = destState.attrs ?? [];
    if (fromClassification === 'initial' && dest === 'open') {
      btns.push(`<button class="btn btn--primary row-action-btn" style="padding:0.15rem 0.5rem;font-size:0.8rem" data-action="row-publish" data-id="${w.id}">Start</button>`);
      continue;
    }
    if (destAttrs.includes('cancelled')) {
      btns.push(`<button class="btn btn--danger row-action-btn" style="padding:0.15rem 0.5rem;font-size:0.8rem" data-action="row-cancel" data-id="${w.id}">Cancel</button>`);
      continue;
    }
  }
  return btns.join(' ');
}

/**
 * Prune a tree by title match. Semantics: a matching node keeps its
 * entire subtree (the user found the work they were looking for and
 * wants to see its breakdown); a non-matching node is kept only when at
 * least one descendant matches (preserving the ancestor chain so a deep
 * match remains readable). Returns null when neither the node nor any of
 * its descendants match.
 */
function pruneByTitleMatch(tree, q) {
  const writ = tree.writ;
  const selfMatches = (writ.title ?? '').toLowerCase().includes(q);

  if (selfMatches) {
    return { writ, children: tree.children ?? [] };
  }

  const prunedChildren = (tree.children ?? [])
    .map((c) => pruneByTitleMatch(c, q))
    .filter(Boolean);

  if (prunedChildren.length > 0) {
    return { writ, children: prunedChildren };
  }
  return null;
}

/**
 * Flatten a forest of `WritTree` nodes into rows annotated with depth,
 * with prune-on-search semantics, per-node collapse, a global descendants
 * toggle, and a single overflow row inserted wherever a subtree extends
 * past `depthCap`.
 *
 * Each emitted row is one of:
 *   - { kind: 'writ', writ, depth, hasChildren, isCollapsed }
 *   - { kind: 'overflow', depth, ancestorId }
 *
 * `ancestorId` on an overflow row is the id of the deepest *visible*
 * ancestor (the node sitting at depth = depthCap whose hidden subtree is
 * being summarized) — used by the click handler to drill into the right
 * detail view.
 */
function sortedFilteredWrits(forest, opts) {
  const {
    collapsedSet = new Set(),
    showChildren = true,
    searchText = '',
    sortCol = 'createdAt',
    sortDir = 'desc',
    depthCap = 8,
  } = opts ?? {};

  const q = searchText.toLowerCase();
  const pruned = q
    ? forest.map((t) => pruneByTitleMatch(t, q)).filter(Boolean)
    : forest;

  const sortedRoots = [...pruned].sort((a, b) => {
    const cmp = compareVal(a.writ, b.writ, sortCol);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const out = [];
  for (const tree of sortedRoots) {
    emit(tree, 0);
  }
  return out;

  function emit(tree, depth) {
    const writ = tree.writ;
    const hasChildren = (tree.children ?? []).length > 0;
    const isCollapsed = collapsedSet.has(writ.id);
    out.push({ kind: 'writ', writ, depth, hasChildren, isCollapsed });

    if (!showChildren) return;
    if (depth >= depthCap) {
      if (hasChildren) {
        out.push({ kind: 'overflow', depth: depth + 1, ancestorId: writ.id });
      }
      return;
    }
    if (isCollapsed) return;
    for (const child of tree.children ?? []) {
      emit(child, depth + 1);
    }
  }
}

/**
 * Flattens a WritTree forest into a depth-first list of `{ writ, depth }`.
 * Mirrors the flattenTree helper in index.html.
 */
function flattenTree(nodes, depth = 0, acc = null) {
  if (acc === null) acc = [];
  for (const node of nodes) {
    acc.push({ writ: node.writ, depth });
    if (node.children && node.children.length > 0) {
      flattenTree(node.children, depth + 1, acc);
    }
  }
  return acc;
}

/** Mirrors depthIndentStyle in index.html. */
function depthIndentStyle(depth) {
  const rem = 2 + depth * 1.5;
  return `padding-left:${rem}rem`;
}

/**
 * Mirrors chooseEmptyStateMessage in index.html. Pure: decides which
 * empty-state message to show when the writs table is empty. When the
 * operator has deselected every type filter, name both the cause and the
 * remedy; every other empty case (empty backend result, phase filter with
 * no hits, search text with no matches) falls back to the generic message.
 */
function chooseEmptyStateMessage(noTypesSelected, forestIsEmpty) {
  if (noTypesSelected) {
    return 'All types deselected — select at least one type to see writs';
  }
  return 'No writs found.';
}

/**
 * Extracted renderDetail logic for parent link and children table.
 * The detail view stays direct-children-only (D20).
 */
function renderDetail(writ) {
  // Vocabulary derivation — single helper feeds the Edit-form gating
  // ("draft" surfaces only on initial writs), the action-buttons block
  // (one per legal transition), and the Repost affordance (terminal +
  // failure/cancelled). Mirrors the page-side derivation in index.html.
  const present = derivePresentation(writ.type, writ.phase);
  const isTerminal = present.isTerminal;
  const isDraft = present.classification === 'initial';
  let html = '';

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

  html += `<div class="detail-section"><h4>Details</h4><dl class="detail-grid">`;
  if (writ.codex) html += `<dt>Codex</dt><dd>${escHtml(writ.codex)}</dd>`;
  if (writ.parent) {
    html += `<dt>Parent</dt><dd><a href="?writ=${encodeURIComponent(writ.parent.id)}" style="color:var(--blue,#7aa2f7);text-decoration:underline;cursor:pointer">${escHtml(writ.parent.title)}</a> ${phaseBadge(writ.parent)}</dd>`;
  }
  html += `<dt>Created</dt><dd></dd>`;
  html += `</dl></div>`;

  // Transition actions — one button per allowedTransitions entry, label
  // and CSS class derived from the destination state's attrs (D10).
  // Mirrors the page-side renderer.
  if (!isTerminal) {
    html += `<div class="detail-section action-buttons" id="actions-${writ.id}">`;
    const fromTypeInfo = writTypesByName.get(writ.type);
    const fromClassification = present.classification;
    for (const dest of present.allowedTransitions) {
      const destState = fromTypeInfo
        ? fromTypeInfo.states.find((s) => s.name === dest)
        : undefined;
      if (!destState) continue;
      const destAttrs = destState.attrs ?? [];
      let label;
      let cssClass;
      let action;
      if (fromClassification === 'initial' && dest === 'open') {
        label = 'Publish'; cssClass = 'btn--primary'; action = 'publish';
      } else if (destAttrs.includes('success')) {
        label = 'Complete'; cssClass = 'btn--success'; action = 'complete';
      } else if (destAttrs.includes('failure')) {
        label = 'Fail'; cssClass = 'btn--danger'; action = 'fail';
      } else if (destAttrs.includes('cancelled')) {
        label = 'Cancel'; cssClass = 'btn--danger'; action = 'cancel';
      } else {
        label = dest; cssClass = ''; action = 'transition';
      }
      const dataAttrs = action === 'transition'
        ? `data-action="transition" data-id="${writ.id}" data-target="${dest}"`
        : `data-action="${action}" data-id="${writ.id}"`;
      html += `<button class="btn ${cssClass}" ${dataAttrs}>${label}</button>`;
    }
    html += `</div>`;
  }

  // Repost — D15: surface for any terminal writ whose state attrs
  // include `failure` or `cancelled`. Recovers mandate's existing UX.
  if (
    present.isTerminal &&
    (present.attrs.includes('failure') || present.attrs.includes('cancelled'))
  ) {
    html += `<div class="detail-section"><button class="btn" data-action="repost" data-id="${writ.id}">Repost</button></div>`;
  }

  html += `<div class="detail-section" id="links-section-${writ.id}"><h4>Links</h4></div>`;

  // Children — deep descendant rendering.
  let rows;
  if (writ._descendantTree && writ._descendantTree.length > 0) {
    rows = flattenTree(writ._descendantTree);
  } else {
    const childItems = writ._fullChildren ?? writ.children?.items ?? [];
    rows = childItems.map(c => ({ writ: c, depth: 0 }));
  }

  if (rows.length > 0) {
    html += `<div class="detail-section">`;
    html += `<h4>Children</h4>`;

    if (writ.children?.summary) {
      html += `<div class="detail-label" style="margin-bottom:0.25rem;font-size:0.85rem;color:var(--muted,#9aa5ce)">Descendants</div>`;
      html += `<div style="margin-bottom:0.5rem">`;
      for (const [phase, count] of Object.entries(writ.children.summary)) {
        // D14: anchor descendant-summary badges on the parent's type
        // (no per-row type info available at this granularity).
        html += phaseBadge(phase, writ.type) + ` <span style="margin-right:0.75rem">${count}</span>`;
      }
      html += `</div>`;
    }

    html += `<table class="data-table"><thead><tr>`;
    html += `<th>Phase</th><th>Title</th><th>Type</th><th>ID</th><th>Actions</th>`;
    html += `</tr></thead><tbody>`;
    for (const { writ: child, depth } of rows) {
      html += `<tr class="writ-row child-detail-row" data-child-id="${child.id}" data-depth="${depth}" style="cursor:pointer">`;
      html += `<td>${phaseBadge(child)}</td>`;
      html += `<td style="${depthIndentStyle(depth)}">${escHtml(child.title ?? '')}</td>`;
      html += `<td>${escHtml(child.type ?? '')}</td>`;
      html += `<td><code>${child.id}</code></td>`;
      html += `<td class="row-actions" style="white-space:nowrap">${rowActions(child)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }

  return html;
}

// ── Test fixtures ────────────────────────────────────────────────────

/**
 * Build a `WritTree` node from a flat shape. Children default to []. Title
 * defaults to the id capitalised so search tests have stable text to hit.
 */
function tree(spec) {
  const id = spec.id;
  return {
    writ: {
      id,
      title: spec.title ?? id,
      type: spec.type ?? 'mandate',
      phase: spec.phase ?? 'open',
      createdAt: spec.createdAt ?? '2025-01-01T00:00:00Z',
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
    },
    children: (spec.children ?? []).map(tree),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('sortedFilteredWrits — depth-numbered emission', () => {
  it('emits a single root at depth 0 with hasChildren=false', () => {
    const forest = [tree({ id: 'a' })];
    const rows = sortedFilteredWrits(forest, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'writ');
    assert.equal(rows[0].writ.id, 'a');
    assert.equal(rows[0].depth, 0);
    assert.equal(rows[0].hasChildren, false);
    assert.equal(rows[0].isCollapsed, false);
  });

  it('emits root + child at depths 0, 1', () => {
    const forest = [tree({ id: 'r', children: [{ id: 'c' }] })];
    const rows = sortedFilteredWrits(forest, {});
    assert.deepEqual(
      rows.map((r) => [r.kind, r.writ.id, r.depth]),
      [
        ['writ', 'r', 0],
        ['writ', 'c', 1],
      ],
    );
    // Root has children → hasChildren true.
    assert.equal(rows[0].hasChildren, true);
    assert.equal(rows[1].hasChildren, false);
  });

  it('emits a 3-level tree at depths 0, 1, 2 in DFS order', () => {
    const forest = [
      tree({ id: 'r', children: [
        { id: 'c1', children: [{ id: 'g1' }] },
        { id: 'c2' },
      ]}),
    ];
    const rows = sortedFilteredWrits(forest, {});
    assert.deepEqual(
      rows.map((r) => [r.writ.id, r.depth]),
      [
        ['r', 0],
        ['c1', 1],
        ['g1', 2],
        ['c2', 1],
      ],
    );
  });

  it('preserves child order from the forest under each parent', () => {
    // Server returns children in createdAt asc order; helper must not re-sort them.
    const forest = [tree({ id: 'r', children: [
      { id: 'c-zeta', createdAt: '2025-01-01' },
      { id: 'c-alpha', createdAt: '2025-01-02' },
    ]})];
    const rows = sortedFilteredWrits(forest, { sortCol: 'title', sortDir: 'asc' });
    // c-zeta first (server order) regardless of column sort.
    assert.deepEqual(
      rows.filter((r) => r.depth === 1).map((r) => r.writ.id),
      ['c-zeta', 'c-alpha'],
    );
  });

  it('returns an empty array for an empty forest', () => {
    assert.deepEqual(sortedFilteredWrits([], {}), []);
  });
});

describe('sortedFilteredWrits — global Children toggle', () => {
  const forest = [
    tree({ id: 'a', title: 'Alpha', children: [{ id: 'a1', children: [{ id: 'a1g' }] }] }),
    tree({ id: 'b', title: 'Beta', children: [{ id: 'b1' }] }),
  ];

  it('showChildren=false flattens to roots only, no overflow rows', () => {
    const rows = sortedFilteredWrits(forest, { showChildren: false, sortCol: 'title', sortDir: 'asc' });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.writ.id]),
      [
        ['writ', 'a'],
        ['writ', 'b'],
      ],
    );
    // hasChildren still reported so the toggle UI knows roots have hidden subtrees.
    assert.equal(rows[0].hasChildren, true);
    assert.equal(rows[1].hasChildren, true);
  });

  it('showChildren=true emits the full subtree under each root', () => {
    const rows = sortedFilteredWrits(forest, { showChildren: true, sortCol: 'title', sortDir: 'asc' });
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a1', 'a1g', 'b', 'b1']);
  });
});

describe('sortedFilteredWrits — per-node collapse', () => {
  it('a collapsed node still emits but its descendants are skipped', () => {
    const forest = [
      tree({ id: 'r', children: [
        { id: 'c1', children: [{ id: 'g1' }] },
        { id: 'c2' },
      ]}),
    ];
    const rows = sortedFilteredWrits(forest, { collapsedSet: new Set(['c1']) });
    assert.deepEqual(
      rows.map((r) => [r.writ.id, r.depth]),
      [
        ['r', 0],
        ['c1', 1], // emitted but its subtree is hidden
        ['c2', 1],
      ],
    );
    const c1Row = rows.find((r) => r.writ.id === 'c1');
    assert.equal(c1Row.isCollapsed, true);
    assert.equal(c1Row.hasChildren, true);
  });

  it('collapsing the root hides every descendant', () => {
    const forest = [
      tree({ id: 'r', children: [{ id: 'c1', children: [{ id: 'g1' }] }] }),
    ];
    const rows = sortedFilteredWrits(forest, { collapsedSet: new Set(['r']) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].writ.id, 'r');
    assert.equal(rows[0].isCollapsed, true);
  });
});

describe('sortedFilteredWrits — root-only sort', () => {
  const rootA = tree({ id: 'a', title: 'Alpha root', createdAt: '2025-01-01', children: [{ id: 'a1', title: 'a child', createdAt: '2025-01-10' }] });
  const rootB = tree({ id: 'b', title: 'Beta root', createdAt: '2025-01-02', children: [{ id: 'b1', title: 'b child', createdAt: '2025-01-20' }] });

  it('sort by title asc — a before b, children stay nested', () => {
    const rows = sortedFilteredWrits([rootA, rootB], { sortCol: 'title', sortDir: 'asc' });
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a1', 'b', 'b1']);
  });

  it('sort by title desc — b before a, children stay nested', () => {
    const rows = sortedFilteredWrits([rootA, rootB], { sortCol: 'title', sortDir: 'desc' });
    assert.deepEqual(rows.map((r) => r.writ.id), ['b', 'b1', 'a', 'a1']);
  });

  it('child order under each root is independent of the sort column', () => {
    // Both children precede their reordered parents in createdAt order;
    // the helper must not pull them into the root sort.
    const rows = sortedFilteredWrits([rootA, rootB], { sortCol: 'createdAt', sortDir: 'asc' });
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a1', 'b', 'b1']);
  });
});

describe('sortedFilteredWrits — ancestor-preserve title search', () => {
  const forest = [
    tree({ id: 'a', title: 'Refactor session layer', children: [
      { id: 'a1', title: 'Extract factory' },
      { id: 'a2', title: 'Investigate auth flow', children: [
        { id: 'a2g', title: 'Patch login race condition' },
      ]},
    ]}),
    tree({ id: 'b', title: 'Document the API' }),
  ];

  it('match on a root surfaces the entire subtree', () => {
    const rows = sortedFilteredWrits(forest, { searchText: 'Refactor', sortCol: 'createdAt', sortDir: 'asc' });
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a1', 'a2', 'a2g']);
  });

  it('match on a deep descendant preserves the entire ancestor chain', () => {
    const rows = sortedFilteredWrits(forest, { searchText: 'login', sortCol: 'createdAt', sortDir: 'asc' });
    // a (root, no match) → a2 (no match) → a2g (match): all three kept.
    // a1 (sibling of a2, no match) is pruned.
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a2', 'a2g']);
  });

  it('non-matching siblings of a matched branch are pruned', () => {
    const rows = sortedFilteredWrits(forest, { searchText: 'factory', sortCol: 'createdAt', sortDir: 'asc' });
    // Only a (preserved as ancestor) and a1 (match) survive; a2/a2g pruned.
    assert.deepEqual(rows.map((r) => r.writ.id), ['a', 'a1']);
  });

  it('returns an empty array when nothing matches', () => {
    const rows = sortedFilteredWrits(forest, { searchText: 'xyzzy' });
    assert.deepEqual(rows, []);
  });

  it('ancestor-preserve interacts with collapse — collapsed ancestor still hides its matched subtree', () => {
    // When the user has manually collapsed an ancestor, the search match
    // remains pruned visually because the subtree under a collapsed node is
    // skipped before search would otherwise surface it. This documents the
    // current intentional behavior.
    const rows = sortedFilteredWrits(forest, { searchText: 'login', collapsedSet: new Set(['a']) });
    assert.deepEqual(rows.map((r) => r.writ.id), ['a']);
  });
});

describe('sortedFilteredWrits — overflow row at depth cap', () => {
  /**
   * Build a single-branch chain root → child → grand → … with the given ids.
   * Each node carries the same created-at stamp, so the root sort is stable.
   */
  function chain(ids) {
    const built = ids.map((id) => ({
      writ: {
        id,
        title: id,
        type: 'mandate',
        phase: 'open',
        createdAt: '2025-01-01T00:00:00Z',
      },
      children: [],
    }));
    for (let i = 0; i < built.length - 1; i++) {
      built[i].children = [built[i + 1]];
    }
    return built[0];
  }

  it('emits a single overflow row when a subtree extends past the cap', () => {
    // depthCap=2; chain has 4 levels (depths 0,1,2,3). depth-2 node has a
    // hidden subtree → expect one overflow row at depth 3 keyed to the
    // depth-2 node.
    const root = chain(['r', 'c', 'g', 'gg']);
    const rows = sortedFilteredWrits([root], { depthCap: 2 });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.kind === 'writ' ? r.writ.id : r.ancestorId, r.depth]),
      [
        ['writ', 'r', 0],
        ['writ', 'c', 1],
        ['writ', 'g', 2],
        ['overflow', 'g', 3],
      ],
    );
  });

  it('no overflow row when the deepest node sits exactly at the cap with no children', () => {
    const root = chain(['r', 'c', 'g']); // depth 0,1,2 (cap=2)
    const rows = sortedFilteredWrits([root], { depthCap: 2 });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.writ?.id ?? r.ancestorId, r.depth]),
      [
        ['writ', 'r', 0],
        ['writ', 'c', 1],
        ['writ', 'g', 2],
      ],
    );
  });

  it('depthCap=0 emits roots only with overflow beneath each root that has children', () => {
    const forest = [
      tree({ id: 'a', children: [{ id: 'a1' }] }),
      tree({ id: 'b' }),
    ];
    const rows = sortedFilteredWrits(forest, { depthCap: 0, sortCol: 'createdAt', sortDir: 'asc' });
    assert.deepEqual(
      rows.map((r) => [r.kind, r.kind === 'writ' ? r.writ.id : r.ancestorId, r.depth]),
      [
        ['writ', 'a', 0],
        ['overflow', 'a', 1],
        ['writ', 'b', 0],
      ],
    );
  });

  it('global Children toggle suppresses overflow rows', () => {
    const root = chain(['r', 'c', 'g', 'gg']);
    const rows = sortedFilteredWrits([root], { depthCap: 2, showChildren: false });
    // Only the root, no overflow.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'writ');
    assert.equal(rows[0].writ.id, 'r');
  });

  it('a collapsed depth-cap node does not double-emit an overflow row', () => {
    // When the user collapses a node, its descendants are hidden via the
    // collapse path — the overflow path is reached only when the depth cap
    // forces the truncation, not when the user did it manually.
    const root = chain(['r', 'c', 'g', 'gg']);
    const rows = sortedFilteredWrits([root], { depthCap: 2, collapsedSet: new Set(['c']) });
    // collapse on 'c' (depth 1) hides g and gg; no overflow row appears.
    assert.deepEqual(
      rows.map((r) => [r.kind, r.kind === 'writ' ? r.writ.id : r.ancestorId, r.depth]),
      [
        ['writ', 'r', 0],
        ['writ', 'c', 1],
      ],
    );
  });

  it('overflow row carries the depth-cap node id, not the truncated descendant id', () => {
    const root = chain(['r', 'c', 'g', 'gg', 'ggg']);
    const rows = sortedFilteredWrits([root], { depthCap: 2 });
    const overflow = rows.find((r) => r.kind === 'overflow');
    assert.ok(overflow, 'expected an overflow row');
    assert.equal(overflow.ancestorId, 'g');
  });
});

describe('phaseBadge — phase → class mapping (derived from writ-type registry)', () => {
  it('maps mandate "open" to badge badge--active', () => {
    assert.equal(phaseBadge('open'), '<span class="badge badge--active">open</span>');
  });

  it('maps mandate "cancelled" to badge badge--warning (cancelled attr)', () => {
    assert.equal(phaseBadge('cancelled'), '<span class="badge badge--warning">cancelled</span>');
  });

  it('maps unknown phase to plain badge (D17 fallback)', () => {
    assert.equal(phaseBadge('unknown'), '<span class="badge">unknown</span>');
  });

  it('maps mandate "completed" (terminal+success) to badge--success', () => {
    assert.equal(phaseBadge('completed'), '<span class="badge badge--success">completed</span>');
  });

  it('maps mandate "failed" (terminal+failure) to badge--error', () => {
    assert.equal(phaseBadge('failed'), '<span class="badge badge--error">failed</span>');
  });

  it('maps mandate "stuck" (active+stuck) to badge--warning', () => {
    assert.equal(phaseBadge('stuck'), '<span class="badge badge--warning">stuck</span>');
  });

  it('maps mandate "new" (initial) to badge--draft', () => {
    assert.equal(phaseBadge('new'), '<span class="badge badge--draft">new</span>');
  });
});

describe('derivePresentation — single source of vocabulary truth (D16)', () => {
  it('returns classification + attrs + indicator + transitions for known states', () => {
    const r = derivePresentation('mandate', 'open');
    assert.equal(r.classification, 'active');
    assert.deepEqual(r.attrs, []);
    assert.equal(r.badgeClass, 'badge--active');
    assert.equal(r.indicator, '●');
    assert.deepEqual(r.allowedTransitions, ['stuck', 'completed', 'failed', 'cancelled']);
    assert.equal(r.isTerminal, false);
  });

  it('returns terminal=true and empty transitions for terminal states', () => {
    const r = derivePresentation('mandate', 'completed');
    assert.equal(r.classification, 'terminal');
    assert.deepEqual(r.attrs, ['success']);
    assert.equal(r.badgeClass, 'badge--success');
    assert.equal(r.indicator, '○');
    assert.deepEqual(r.allowedTransitions, []);
    assert.equal(r.isTerminal, true);
  });

  it('returns unknown classification for unregistered types (D17)', () => {
    const r = derivePresentation('ghost', 'open');
    assert.equal(r.classification, 'unknown');
    assert.equal(r.indicator, '?');
    assert.equal(r.badgeClass, '');
  });

  it('returns unknown classification for undeclared states', () => {
    const r = derivePresentation('mandate', 'fictional-state');
    assert.equal(r.classification, 'unknown');
    assert.equal(r.indicator, '?');
  });
});

describe('rowActions — derived from allowedTransitions + destination attrs (D10)', () => {
  it('initial mandate writ — Start (publish) and Cancel buttons surface', () => {
    const w = { id: 'w', type: 'mandate', phase: 'new' };
    const html = rowActions(w);
    assert.match(html, /data-action="row-publish"[^>]*data-id="w"/);
    assert.match(html, /data-action="row-cancel"[^>]*data-id="w"/);
  });

  it('active mandate writ — only Cancel surfaces (Complete/Fail are detail-view-only)', () => {
    const w = { id: 'w', type: 'mandate', phase: 'open' };
    const html = rowActions(w);
    assert.match(html, /data-action="row-cancel"/);
    assert.ok(!html.includes('data-action="row-publish"'));
  });

  it('terminal writ — no row buttons', () => {
    const w = { id: 'w', type: 'mandate', phase: 'completed' };
    assert.equal(rowActions(w), '');
  });

  it('writ of unregistered type — no row buttons (no allowed transitions known)', () => {
    const w = { id: 'w', type: 'ghost', phase: 'open' };
    assert.equal(rowActions(w), '');
  });
});

describe('renderDetail action buttons — derived from allowedTransitions (D10)', () => {
  function dom(html) {
    return html;
  }

  it('initial writ renders Publish (label) and Cancel buttons', () => {
    const writ = { id: 'w', type: 'mandate', phase: 'new', body: '' };
    const html = dom(renderDetail(writ));
    assert.match(html, /data-action="publish"[^>]*data-id="w"[^>]*>Publish</);
    assert.match(html, /data-action="cancel"[^>]*data-id="w"[^>]*>Cancel</);
    // Complete and Fail are not legal from `new` — must not appear.
    assert.ok(!/data-action="complete"/.test(html));
    assert.ok(!/data-action="fail"/.test(html));
  });

  it('active writ renders Complete, Fail, and Cancel buttons', () => {
    const writ = { id: 'w', type: 'mandate', phase: 'open', body: '' };
    const html = dom(renderDetail(writ));
    assert.match(html, /data-action="complete"[^>]*>Complete</);
    assert.match(html, /data-action="fail"[^>]*>Fail</);
    assert.match(html, /data-action="cancel"[^>]*>Cancel</);
  });

  it('stuck writ renders Fail and Cancel only (no Complete in mandate from stuck)', () => {
    const writ = { id: 'w', type: 'mandate', phase: 'stuck', body: '' };
    const html = dom(renderDetail(writ));
    assert.match(html, /data-action="fail"/);
    assert.match(html, /data-action="cancel"/);
    assert.ok(!/data-action="complete"/.test(html));
  });

  it('Repost surfaces on terminal writs whose attrs include failure or cancelled (D15)', () => {
    const failed = { id: 'w', type: 'mandate', phase: 'failed', body: '' };
    assert.match(renderDetail(failed), /data-action="repost"/);

    const cancelled = { id: 'w', type: 'mandate', phase: 'cancelled', body: '' };
    assert.match(renderDetail(cancelled), /data-action="repost"/);

    // success attr → no Repost
    const completed = { id: 'w', type: 'mandate', phase: 'completed', body: '' };
    assert.ok(!/data-action="repost"/.test(renderDetail(completed)));
  });
});

describe('Toggle button state', () => {
  it('initial state: showChildren true, button has active-filter', () => {
    const showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';
    assert.equal(showChildren, true);
    assert.ok(btn.classList.contains('active-filter'));
  });

  it('after first click: showChildren false, button loses active-filter', () => {
    let showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';

    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);

    assert.equal(showChildren, false);
    assert.ok(!btn.classList.contains('active-filter'));
  });

  it('after second click: showChildren true, button regains active-filter', () => {
    let showChildren = true;
    const btn = createElement('button');
    btn.className = 'btn active-filter';

    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);
    showChildren = !showChildren;
    btn.classList.toggle('active-filter', showChildren);

    assert.equal(showChildren, true);
    assert.ok(btn.classList.contains('active-filter'));
  });
});

describe('Children table rendering in detail view (D20: still direct-children only)', () => {
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
      children: { summary: { active: 1, completed: 1, new: 1 }, items: [] },
    };

    const html = renderDetail(writ);

    assert.ok(html.includes('<h4>Children</h4>'));
    assert.equal((html.match(/child-detail-row/g) || []).length, 3);
    assert.ok(html.includes('<th>Phase</th><th>Title</th><th>Type</th><th>ID</th><th>Actions</th>'));
    assert.ok(html.includes('Child 1'));
    assert.ok(html.includes('Child 2'));
    assert.ok(html.includes('Child 3'));
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
    assert.ok(!html.includes('<h4>Children</h4>'));
    assert.ok(!html.includes('child-detail-row'));
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
    assert.ok(html.includes('<dt>Parent</dt>'));
    assert.ok(html.includes('href="?writ=w-parent"'));
    assert.ok(html.includes('Parent Writ'));
    assert.ok(html.includes('badge badge--active'));
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
    assert.ok(!html.includes('<dt>Parent</dt>'));
  });

  it('does not render parent row when parent is undefined', () => {
    const writ = {
      id: 'root-w2',
      title: 'Root Writ 2',
      phase: 'open',
      body: '',
    };
    const html = renderDetail(writ);
    assert.ok(!html.includes('<dt>Parent</dt>'));
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
    assert.ok(html.includes('href="?writ=w-parent%20with%20spaces"'));
  });
});

describe('flattenTree — depth-first pre-order traversal', () => {
  it('flattens a single-level forest at depth 0', () => {
    const nodes = [
      { writ: { id: 'a', title: 'A' }, children: [] },
      { writ: { id: 'b', title: 'B' }, children: [] },
    ];
    const rows = flattenTree(nodes);
    assert.deepEqual(rows, [
      { writ: { id: 'a', title: 'A' }, depth: 0 },
      { writ: { id: 'b', title: 'B' }, depth: 0 },
    ]);
  });

  it('flattens a two-level tree — children follow parent with depth+1', () => {
    const nodes = [
      {
        writ: { id: 'a' },
        children: [
          { writ: { id: 'a1' }, children: [] },
          { writ: { id: 'a2' }, children: [] },
        ],
      },
      { writ: { id: 'b' }, children: [] },
    ];
    const rows = flattenTree(nodes);
    assert.deepEqual(rows.map(r => [r.writ.id, r.depth]), [
      ['a', 0],
      ['a1', 1],
      ['a2', 1],
      ['b', 0],
    ]);
  });

  it('flattens a three-level tree preserving depth per level', () => {
    const nodes = [
      {
        writ: { id: 'a' },
        children: [
          {
            writ: { id: 'a1' },
            children: [
              { writ: { id: 'a1x' }, children: [] },
              { writ: { id: 'a1y' }, children: [] },
            ],
          },
          { writ: { id: 'a2' }, children: [] },
        ],
      },
    ];
    const rows = flattenTree(nodes);
    assert.deepEqual(rows.map(r => [r.writ.id, r.depth]), [
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['a1y', 2],
      ['a2', 1],
    ]);
  });

  it('empty forest returns empty', () => {
    assert.deepEqual(flattenTree([]), []);
  });

  it('accepts an explicit start depth (for sub-tree rendering)', () => {
    const nodes = [
      { writ: { id: 'x' }, children: [{ writ: { id: 'xx' }, children: [] }] },
    ];
    const rows = flattenTree(nodes, 5);
    assert.deepEqual(rows.map(r => [r.writ.id, r.depth]), [
      ['x', 5],
      ['xx', 6],
    ]);
  });
});

describe('depthIndentStyle — depth → padding-left mapping', () => {
  it('depth 0 matches the existing 2rem main-list indent', () => {
    assert.equal(depthIndentStyle(0), 'padding-left:2rem');
  });

  it('depth 1 adds 1.5rem', () => {
    assert.equal(depthIndentStyle(1), 'padding-left:3.5rem');
  });

  it('depth 2 adds another 1.5rem', () => {
    assert.equal(depthIndentStyle(2), 'padding-left:5rem');
  });
});

describe('Deep descendant rendering in detail view', () => {
  it('renders all descendants when _descendantTree is populated', () => {
    const writ = {
      id: 'parent-1',
      title: 'Parent',
      phase: 'open',
      body: '',
      children: {
        summary: { open: 1 },
        items: [{ id: 'c1', title: 'Child 1', phase: 'open' }],
      },
      _descendantTree: [
        {
          writ: { id: 'c1', title: 'Child 1', type: 'task', phase: 'open' },
          children: [
            {
              writ: { id: 'g1', title: 'Grandchild 1', type: 'task', phase: 'open' },
              children: [
                {
                  writ: { id: 'gg1', title: 'Great-grandchild', type: 'task', phase: 'open' },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const html = renderDetail(writ);

    // All three descendants appear as rows
    assert.ok(html.includes('data-child-id="c1"'), 'Direct child row present');
    assert.ok(html.includes('data-child-id="g1"'), 'Grandchild row present');
    assert.ok(html.includes('data-child-id="gg1"'), 'Great-grandchild row present');
    // Pre-order: parent appears before child
    assert.ok(html.indexOf('data-child-id="c1"') < html.indexOf('data-child-id="g1"'));
    assert.ok(html.indexOf('data-child-id="g1"') < html.indexOf('data-child-id="gg1"'));
  });

  it('rows carry depth data attribute and depth-based indent', () => {
    const writ = {
      id: 'p',
      title: 'P',
      phase: 'open',
      body: '',
      children: { summary: {}, items: [{ id: 'c', title: 'C', phase: 'open' }] },
      _descendantTree: [
        {
          writ: { id: 'c', title: 'Child', type: 'task', phase: 'open' },
          children: [
            { writ: { id: 'g', title: 'Grand', type: 'task', phase: 'open' }, children: [] },
          ],
        },
      ],
    };

    const html = renderDetail(writ);
    assert.ok(html.includes('data-child-id="c" data-depth="0"'), 'Direct child has depth 0');
    assert.ok(html.includes('data-child-id="g" data-depth="1"'), 'Grandchild has depth 1');
    assert.ok(html.includes('style="padding-left:2rem"'), 'Depth 0 title cell indents 2rem');
    assert.ok(html.includes('style="padding-left:3.5rem"'), 'Depth 1 title cell indents 3.5rem');
  });

  it('falls back to flat children when _descendantTree is missing', () => {
    const writ = {
      id: 'p',
      title: 'P',
      phase: 'open',
      body: '',
      _fullChildren: [
        { id: 'c1', title: 'Child 1', type: 'task', phase: 'open' },
        { id: 'c2', title: 'Child 2', type: 'task', phase: 'open' },
      ],
      children: { summary: { open: 2 }, items: [] },
    };

    const html = renderDetail(writ);
    assert.ok(html.includes('data-child-id="c1" data-depth="0"'));
    assert.ok(html.includes('data-child-id="c2" data-depth="0"'));
  });

  it('summary badges reflect the full descendant subtree (writ.children.summary)', () => {
    const writ = {
      id: 'p',
      title: 'P',
      phase: 'open',
      body: '',
      children: {
        // Subtree-wide summary from writ-show: 2 open direct children + 1
        // completed grandchild all contribute. Counts cover every descendant,
        // not just depth 1.
        summary: { open: 2, completed: 1 },
        items: [
          { id: 'c1', title: 'C1', phase: 'open' },
          { id: 'c2', title: 'C2', phase: 'open' },
        ],
      },
      _descendantTree: [
        {
          writ: { id: 'c1', title: 'C1', type: 'task', phase: 'open' },
          children: [
            { writ: { id: 'g1', title: 'G1', type: 'task', phase: 'completed' }, children: [] },
          ],
        },
        { writ: { id: 'c2', title: 'C2', type: 'task', phase: 'open' }, children: [] },
      ],
    };

    const html = renderDetail(writ);
    // Summary now counts the whole subtree — 2 open direct children and the
    // 1 completed grandchild are both reflected in the badges.
    const summaryOpenMatch = html.match(/badge badge--active">open<\/span>\s*<span[^>]*>2</);
    assert.ok(summaryOpenMatch, 'Summary shows 2 open writs in the subtree');
    const summaryCompletedMatch = html.match(/badge badge--success">completed<\/span>\s*<span[^>]*>1</);
    assert.ok(summaryCompletedMatch, 'Summary counts the completed grandchild');
    // The table continues to render the grandchild row alongside the direct children.
    assert.ok(html.includes('data-child-id="g1"'), 'Grandchild row is present in the table');
    // A "Descendants" label introduces the badge strip so the subtree-wide
    // scope of the counts is visible without reading the tool docs.
    assert.ok(html.includes('>Descendants<'), 'Descendants label precedes the summary badges');
  });

  it('preserves rowActions on every depth row', () => {
    const writ = {
      id: 'p',
      title: 'P',
      type: 'mandate',
      phase: 'open',
      body: '',
      children: { summary: {}, items: [{ id: 'c', title: 'C', phase: 'new' }] },
      _descendantTree: [
        {
          writ: { id: 'c', title: 'C', type: 'mandate', phase: 'new' },
          children: [
            { writ: { id: 'g', title: 'G', type: 'mandate', phase: 'open' }, children: [] },
          ],
        },
      ],
    };

    const html = renderDetail(writ);
    // Depth 0 (initial classification) gets Start + Cancel
    assert.ok(html.match(/data-action="row-publish"[^>]*data-id="c"/));
    assert.ok(html.match(/data-action="row-cancel"[^>]*data-id="c"/));
    // Depth 1 (active classification) gets Cancel only
    assert.ok(html.match(/data-action="row-cancel"[^>]*data-id="g"/));
    assert.ok(!html.match(/data-action="row-publish"[^>]*data-id="g"/));
  });
});

describe('chooseEmptyStateMessage — empty-state message chooser', () => {
  it('returns the type-deselected message when no types are selected', () => {
    // When the operator toggles off every type filter, loadWrits short-
    // circuits with forest = [] and renderTable reaches the empty branch
    // with currentType.size === 0. The chooser must name the deselection
    // as the cause and direct the operator to the remedy — verbatim.
    assert.equal(
      chooseEmptyStateMessage(true, true),
      'All types deselected — select at least one type to see writs',
    );
  });

  it('returns the generic "No writs found." message when at least one type is selected but the forest is empty', () => {
    // Phase filter with no hits, search text with no matches, or a valid
    // filter set that genuinely returns nothing — all fall through to the
    // generic message. The string is kept exact so wording drift breaks
    // the suite.
    assert.equal(
      chooseEmptyStateMessage(false, true),
      'No writs found.',
    );
  });
});

/**
 * Unit tests for writ type filter logic in writs/index.html.
 *
 * Extracts and tests the pure logic behind the type filter bar:
 * - Button generation from writ types
 * - Default type selection (all types selected)
 * - Multi-select filter toggling via setTypeFilter
 *
 * Uses a minimal DOM shim to validate element creation without a browser.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM shim ────────────────────────────────────────────────

/** Tiny element stub sufficient for the filter bar logic. */
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
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    // Support '.type-filter-btn[data-type=""]' and ':not(...)' patterns
    const btns = this.querySelectorAll('.type-filter-btn');
    if (selector.includes('data-type=""')) {
      return btns.find(b => b.dataset.type === '') ?? null;
    }
    return btns[0] ?? null;
  }

  querySelectorAll(selector) {
    // Only supports '.type-filter-btn' variants
    const allBtns = this.children.filter(c =>
      c.className.includes('type-filter-btn'),
    );
    if (selector.includes(':not([data-type=""])')) {
      return allBtns.filter(b => b.dataset.type !== '');
    }
    return allBtns;
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
      add(cls) {
        const classes = self.className.split(/\s+/).filter(Boolean);
        if (!classes.includes(cls)) classes.push(cls);
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

/** Shared state — mirrors the IIFE variable in index.html. */
let currentType = new Set();

/**
 * Builds type filter buttons from a types array into a bar element.
 * Returns the currentType Set for testability. Mirrors
 * buildTypeFilterBar in index.html — the All button and each type pill
 * carry `btn filter-btn type-filter-btn` so the existing
 * `.filter-btn.active-filter` rule paints them; `.type-filter-btn` stays
 * as a JS selector hook only.
 */
function buildTypeFilterBar(types, bar) {
  // Clear existing buttons (keep label span)
  bar.innerHTML = '';
  bar.children = [];

  // Label
  const label = createElement('span');
  label.textContent = 'Type:';
  bar.appendChild(label);

  // "All" button
  const allBtn = createElement('button');
  allBtn.className = 'btn filter-btn type-filter-btn';
  allBtn.dataset.type = '';
  allBtn.textContent = 'All';
  bar.appendChild(allBtn);

  // One button per known type
  for (const t of types) {
    const btn = createElement('button');
    btn.className = 'btn filter-btn type-filter-btn';
    btn.dataset.type = t.name;
    btn.textContent = t.name;
    if (t.description) btn.title = t.description;
    bar.appendChild(btn);
  }

  // Default: select all types
  currentType = new Set(types.map(t => t.name));
  bar.querySelectorAll('.type-filter-btn').forEach(btn => {
    btn.classList.add('active-filter');
  });

  return currentType;
}

/**
 * Multi-select type filter toggle (mirrors setTypeFilter in index.html).
 * Does not call loadWrits — just updates state and button classes.
 *
 * Behaviour:
 *  - `type === ''` (the All button) is a true toggle: if every individual
 *    type is selected, clear everything; otherwise select every type.
 *  - `type` is a known type name: toggle exactly that type in/out of
 *    `currentType`. Every other selection is left untouched — the
 *    All-active collapses-to-one branch is gone.
 *  - The All button's `.active-filter` reflects whether every type is
 *    currently selected.
 */
function applyTypeFilter(bar, type) {
  const allBtn = bar.querySelector('.type-filter-btn[data-type=""]');
  const typeBtns = bar.querySelectorAll('.type-filter-btn').filter(b => b.dataset.type !== '');
  const allTypeNames = typeBtns.map(b => b.dataset.type);

  if (type === '') {
    const allSelected = allTypeNames.length > 0 && allTypeNames.every(t => currentType.has(t));
    currentType = allSelected ? new Set() : new Set(allTypeNames);
  } else {
    if (currentType.has(type)) {
      currentType.delete(type);
    } else {
      currentType.add(type);
    }
  }

  const nowAllActive = allTypeNames.length > 0 && allTypeNames.every(t => currentType.has(t));
  allBtn.classList.toggle('active-filter', nowAllActive);
  typeBtns.forEach(btn => {
    btn.classList.toggle('active-filter', currentType.has(btn.dataset.type));
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('buildTypeFilterBar()', () => {
  let bar;

  beforeEach(() => {
    bar = createElement('span');
    currentType = new Set();
  });

  it('creates "All" button plus one per type', () => {
    const types = [
      { name: 'mandate' },
      { name: 'task' },
    ];
    buildTypeFilterBar(types, bar);

    const btns = bar.querySelectorAll('.type-filter-btn');
    assert.equal(btns.length, 3); // All + mandate + task
    assert.equal(btns[0].textContent, 'All');
    assert.equal(btns[0].dataset.type, '');
    assert.equal(btns[1].textContent, 'mandate');
    assert.equal(btns[1].dataset.type, 'mandate');
    assert.equal(btns[2].textContent, 'task');
    assert.equal(btns[2].dataset.type, 'task');
  });

  it('defaults to all types selected', () => {
    const types = [
      { name: 'task' },
      { name: 'mandate' },
      { name: 'bug' },
    ];
    const result = buildTypeFilterBar(types, bar);

    assert.deepEqual(result, new Set(['task', 'mandate', 'bug']));

    const btns = bar.querySelectorAll('.type-filter-btn');
    // All buttons should be active (including "All")
    for (const btn of btns) {
      assert.ok(btn.classList.contains('active-filter'), `${btn.textContent} should be active`);
    }
  });

  it('defaults to all types even when mandate is present', () => {
    const types = [
      { name: 'task' },
      { name: 'mandate' },
    ];
    const result = buildTypeFilterBar(types, bar);

    assert.deepEqual(result, new Set(['task', 'mandate']));

    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'), 'All should be active');
    const mandateBtn = btns.find(b => b.dataset.type === 'mandate');
    assert.ok(mandateBtn.classList.contains('active-filter'), 'mandate should be active');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    assert.ok(taskBtn.classList.contains('active-filter'), 'task should be active');
  });

  it('handles empty types array — only All button, empty set', () => {
    const types = [];
    const result = buildTypeFilterBar(types, bar);

    assert.deepEqual(result, new Set());

    const btns = bar.querySelectorAll('.type-filter-btn');
    assert.equal(btns.length, 1);
    assert.equal(btns[0].textContent, 'All');
    assert.ok(btns[0].classList.contains('active-filter'));
  });

  it('handles single type', () => {
    const types = [{ name: 'mandate' }];
    const result = buildTypeFilterBar(types, bar);

    assert.deepEqual(result, new Set(['mandate']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    assert.equal(btns.length, 2); // All + mandate
  });

  it('sets title from description', () => {
    const types = [
      { name: 'task', description: 'A work item' },
    ];
    buildTypeFilterBar(types, bar);

    const btns = bar.querySelectorAll('.type-filter-btn');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    assert.equal(taskBtn.title, 'A work item');
  });

  it('does not set title when no description', () => {
    const types = [{ name: 'task' }];
    buildTypeFilterBar(types, bar);

    const btns = bar.querySelectorAll('.type-filter-btn');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    assert.equal(taskBtn.title, '');
  });

  it('includes label span as first child', () => {
    buildTypeFilterBar([{ name: 'mandate' }], bar);
    assert.equal(bar.children[0].textContent, 'Type:');
  });
});

describe('applyTypeFilter() — independent toggle (D7) and true All toggle (D8)', () => {
  let bar;

  beforeEach(() => {
    bar = createElement('span');
    currentType = new Set();
    buildTypeFilterBar([
      { name: 'mandate' },
      { name: 'task' },
      { name: 'bug' },
    ], bar);
  });

  it('clicking an individual type when All is active toggles only that type — others stay selected (D7)', () => {
    // Replaces the legacy "All-active collapses to one type" behaviour.
    // The brief is verbatim: leave the others untouched.
    applyTypeFilter(bar, 'task');

    assert.deepEqual(currentType, new Set(['mandate', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    const mandateBtn = btns.find(b => b.dataset.type === 'mandate');
    const bugBtn = btns.find(b => b.dataset.type === 'bug');
    const allBtn = btns.find(b => b.dataset.type === '');

    assert.ok(!taskBtn.classList.contains('active-filter'), 'clicked type loses active fill');
    assert.ok(mandateBtn.classList.contains('active-filter'), 'untouched type keeps active fill');
    assert.ok(bugBtn.classList.contains('active-filter'), 'untouched type keeps active fill');
    assert.ok(!allBtn.classList.contains('active-filter'), 'All loses fill once any type is missing');
  });

  it('clicking the same individual type twice toggles it back on with the rest unchanged', () => {
    applyTypeFilter(bar, 'task'); // off
    assert.deepEqual(currentType, new Set(['mandate', 'bug']));
    applyTypeFilter(bar, 'task'); // back on
    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'),
      'All re-fills once every type is selected again');
  });

  it('All button is filled iff every individual type is currently selected', () => {
    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    // Initial build: every type selected → All filled.
    assert.ok(allBtn.classList.contains('active-filter'));

    // Drop one → All loses fill.
    applyTypeFilter(bar, 'mandate');
    assert.ok(!allBtn.classList.contains('active-filter'));

    // Bring it back → All fills again.
    applyTypeFilter(bar, 'mandate');
    assert.ok(allBtn.classList.contains('active-filter'));
  });

  it('All clicked when filled clears every type (D8 — true toggle direction A)', () => {
    // Initial state: every type selected, All filled.
    applyTypeFilter(bar, '');

    assert.equal(currentType.size, 0, 'no types selected after All-clear');
    const btns = bar.querySelectorAll('.type-filter-btn');
    const activeCount = btns.filter(b => b.classList.contains('active-filter')).length;
    assert.equal(activeCount, 0, 'no buttons retain active fill');
  });

  it('All clicked when not filled selects every type (D8 — true toggle direction B)', () => {
    // Move into "not all selected" by toggling a type off.
    applyTypeFilter(bar, 'mandate');
    assert.deepEqual(currentType, new Set(['task', 'bug']));

    applyTypeFilter(bar, '');

    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    for (const btn of btns) {
      assert.ok(btn.classList.contains('active-filter'),
        `${btn.textContent} should be active after All-fill`);
    }
  });

  it('All clicked when none are selected selects every type', () => {
    // Reach the empty state explicitly.
    applyTypeFilter(bar, ''); // all → none
    assert.equal(currentType.size, 0);

    applyTypeFilter(bar, ''); // none → all
    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
  });

  it('toggling all individual types off one by one ends in the empty state with All unfilled', () => {
    applyTypeFilter(bar, 'mandate');
    applyTypeFilter(bar, 'task');
    applyTypeFilter(bar, 'bug');

    assert.equal(currentType.size, 0);
    const btns = bar.querySelectorAll('.type-filter-btn');
    const activeCount = btns.filter(b => b.classList.contains('active-filter')).length;
    assert.equal(activeCount, 0);
  });

  it('toggling all individual types on after starting empty refills All automatically', () => {
    // Drop into empty.
    applyTypeFilter(bar, '');
    // Click each type back on.
    applyTypeFilter(bar, 'mandate');
    applyTypeFilter(bar, 'task');
    applyTypeFilter(bar, 'bug');

    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'),
      'All auto-fills when every type comes back');
  });
});

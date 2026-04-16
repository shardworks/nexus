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
 * Returns the currentType Set for testability.
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
  allBtn.className = 'btn type-filter-btn';
  allBtn.dataset.type = '';
  allBtn.textContent = 'All';
  bar.appendChild(allBtn);

  // One button per known type
  for (const t of types) {
    const btn = createElement('button');
    btn.className = 'btn type-filter-btn';
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
 */
function applyTypeFilter(bar, type) {
  const allBtn = bar.querySelector('.type-filter-btn[data-type=""]');
  const typeBtns = bar.querySelectorAll('.type-filter-btn').filter(b => b.dataset.type !== '');
  const allTypeNames = typeBtns.map(b => b.dataset.type);

  if (type === '') {
    // "All" clicked: select all individual types
    currentType = new Set(allTypeNames);
  } else {
    // Check if "All" is currently active (all types selected)
    const allActive = allTypeNames.length > 0 && allTypeNames.every(t => currentType.has(t));
    if (allActive) {
      // "All" was active — deselect everything except the clicked type
      currentType = new Set([type]);
    } else {
      // Normal toggle
      if (currentType.has(type)) {
        currentType.delete(type);
      } else {
        currentType.add(type);
      }
    }
  }

  // Update button visual state
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

describe('applyTypeFilter() — multi-select', () => {
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

  it('clicking type when All is active deselects all except clicked', () => {
    // Initially all types are selected (All is active)
    applyTypeFilter(bar, 'task');

    assert.deepEqual(currentType, new Set(['task']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    const mandateBtn = btns.find(b => b.dataset.type === 'mandate');
    const allBtn = btns.find(b => b.dataset.type === '');

    assert.ok(taskBtn.classList.contains('active-filter'));
    assert.ok(!mandateBtn.classList.contains('active-filter'));
    assert.ok(!allBtn.classList.contains('active-filter'));
  });

  it('clicking "All" selects all types', () => {
    // First deselect all by breaking the "all active" state
    applyTypeFilter(bar, 'task'); // only task selected now
    applyTypeFilter(bar, 'task'); // deselect task — empty set

    applyTypeFilter(bar, ''); // click All

    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    for (const btn of btns) {
      assert.ok(btn.classList.contains('active-filter'), `${btn.textContent} should be active`);
    }
  });

  it('toggling individual types on/off when All is not active', () => {
    // Break "All" state first
    applyTypeFilter(bar, 'mandate'); // only mandate selected
    assert.deepEqual(currentType, new Set(['mandate']));

    // Toggle on 'task'
    applyTypeFilter(bar, 'task');
    assert.deepEqual(currentType, new Set(['mandate', 'task']));

    // Toggle off 'mandate'
    applyTypeFilter(bar, 'mandate');
    assert.deepEqual(currentType, new Set(['task']));
  });

  it('auto-activates All when all types manually selected', () => {
    // Break "All" state
    applyTypeFilter(bar, 'mandate'); // only mandate
    // Add task
    applyTypeFilter(bar, 'task'); // mandate + task
    // Add bug — now all types are selected
    applyTypeFilter(bar, 'bug'); // mandate + task + bug

    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'), 'All should auto-activate');
  });

  it('empty set when all types deselected — no buttons active', () => {
    // Break "All" state by clicking one type
    applyTypeFilter(bar, 'task'); // only task
    // Deselect task
    applyTypeFilter(bar, 'task'); // empty set

    assert.equal(currentType.size, 0);
    const btns = bar.querySelectorAll('.type-filter-btn');
    const activeCount = btns.filter(b => b.classList.contains('active-filter')).length;
    assert.equal(activeCount, 0);
  });

  it('clicking All after partial selection selects all', () => {
    // Break "All" state
    applyTypeFilter(bar, 'mandate'); // only mandate
    // Add bug
    applyTypeFilter(bar, 'bug'); // mandate + bug

    // Click All
    applyTypeFilter(bar, '');
    assert.deepEqual(currentType, new Set(['mandate', 'task', 'bug']));
  });
});

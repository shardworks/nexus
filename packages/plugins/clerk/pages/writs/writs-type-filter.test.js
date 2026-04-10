/**
 * Unit tests for writ type filter logic in writs/index.html.
 *
 * Extracts and tests the pure logic behind the type filter bar:
 * - Button generation from writ types
 * - Default type selection (mandate if present, else All)
 * - Filter toggling via setTypeFilter
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

  querySelectorAll(selector) {
    // Only supports '.type-filter-btn'
    return this.children.filter(c =>
      c.className.includes('type-filter-btn'),
    );
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
 * Builds type filter buttons from a types array into a bar element.
 * Returns { bar, defaultType } for testability.
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

  // Default: select 'mandate' if present, otherwise 'All'
  const hasMandateType = types.some(t => t.name === 'mandate');
  const defaultType = hasMandateType ? 'mandate' : '';

  bar.querySelectorAll('.type-filter-btn').forEach(btn => {
    btn.classList.toggle('active-filter', btn.dataset.type === defaultType);
  });

  return defaultType;
}

/**
 * Applies a type filter selection to the bar (mirrors setTypeFilter).
 */
function applyTypeFilter(bar, type) {
  bar.querySelectorAll('.type-filter-btn').forEach(btn => {
    btn.classList.toggle('active-filter', btn.dataset.type === type);
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('buildTypeFilterBar()', () => {
  let bar;

  beforeEach(() => {
    bar = createElement('span');
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

  it('defaults to mandate when mandate is present', () => {
    const types = [
      { name: 'task' },
      { name: 'mandate' },
      { name: 'bug' },
    ];
    const defaultType = buildTypeFilterBar(types, bar);

    assert.equal(defaultType, 'mandate');

    const btns = bar.querySelectorAll('.type-filter-btn');
    // "All" should NOT be active
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(!allBtn.classList.contains('active-filter'), 'All should not be active');
    // "mandate" should be active
    const mandateBtn = btns.find(b => b.dataset.type === 'mandate');
    assert.ok(mandateBtn.classList.contains('active-filter'), 'mandate should be active');
    // others should not be active
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    assert.ok(!taskBtn.classList.contains('active-filter'), 'task should not be active');
  });

  it('defaults to All when mandate is not present', () => {
    const types = [
      { name: 'task' },
      { name: 'bug' },
    ];
    const defaultType = buildTypeFilterBar(types, bar);

    assert.equal(defaultType, '');

    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'), 'All should be active');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    assert.ok(!taskBtn.classList.contains('active-filter'), 'task should not be active');
  });

  it('handles empty types array — only All button', () => {
    const types = [];
    const defaultType = buildTypeFilterBar(types, bar);

    assert.equal(defaultType, '');

    const btns = bar.querySelectorAll('.type-filter-btn');
    assert.equal(btns.length, 1);
    assert.equal(btns[0].textContent, 'All');
    assert.ok(btns[0].classList.contains('active-filter'));
  });

  it('handles single mandate type', () => {
    const types = [{ name: 'mandate' }];
    const defaultType = buildTypeFilterBar(types, bar);

    assert.equal(defaultType, 'mandate');
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

describe('applyTypeFilter()', () => {
  let bar;

  beforeEach(() => {
    bar = createElement('span');
    buildTypeFilterBar([
      { name: 'mandate' },
      { name: 'task' },
      { name: 'bug' },
    ], bar);
  });

  it('switches active state to selected type', () => {
    applyTypeFilter(bar, 'task');

    const btns = bar.querySelectorAll('.type-filter-btn');
    const taskBtn = btns.find(b => b.dataset.type === 'task');
    const mandateBtn = btns.find(b => b.dataset.type === 'mandate');
    const allBtn = btns.find(b => b.dataset.type === '');

    assert.ok(taskBtn.classList.contains('active-filter'));
    assert.ok(!mandateBtn.classList.contains('active-filter'));
    assert.ok(!allBtn.classList.contains('active-filter'));
  });

  it('switches active state to All', () => {
    applyTypeFilter(bar, '');

    const btns = bar.querySelectorAll('.type-filter-btn');
    const allBtn = btns.find(b => b.dataset.type === '');
    assert.ok(allBtn.classList.contains('active-filter'));

    // All others should be inactive
    for (const btn of btns) {
      if (btn.dataset.type !== '') {
        assert.ok(!btn.classList.contains('active-filter'), `${btn.dataset.type} should not be active`);
      }
    }
  });

  it('only one button is active at a time', () => {
    applyTypeFilter(bar, 'bug');

    const btns = bar.querySelectorAll('.type-filter-btn');
    const activeCount = btns.filter(b => b.classList.contains('active-filter')).length;
    assert.equal(activeCount, 1);
  });
});

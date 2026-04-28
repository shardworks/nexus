/**
 * Unit tests for URL deep-link state on the Ratchet clicks page.
 *
 * Mirrors the contract of `window.NexusUrl` consumption in index.html:
 *   - status[] persists as repeated keys (D3).
 *   - status filter changes replace history; ?root= and ?click= push (D5).
 *   - Initial load with ?status= keys present applies the filter.
 *   - popstate restoration re-applies the filter and the deep-link ids.
 *   - Invalid ?status=bogus surfaces a fail-loud error (D6).
 *
 * The tests mount a minimal NexusUrl mirror onto a fake window, then
 * exercise the page-side wiring shape directly. They lock in the
 * source-text contract that filter changes flow through `update()`
 * with no `push: true`, while ?root= and ?click= use `push: true`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');

// ── Source-grep assertions ──────────────────────────────────────────

describe('clicks index.html — URL contract source assertions', () => {
  it('does not redefine currentUrlParams or updateUrl inline', () => {
    assert.ok(
      !/function\s+currentUrlParams\s*\(/.test(indexHtml),
      'inline currentUrlParams must not be redeclared',
    );
    assert.ok(
      !/function\s+updateUrl\s*\(/.test(indexHtml),
      'inline updateUrl must not be redeclared',
    );
  });

  it('routes URL writes through window.NexusUrl', () => {
    assert.match(
      indexHtml,
      /window\.NexusUrl\.update\(\{\s*root:/,
      'subtree-focus must call NexusUrl.update with root',
    );
    assert.match(
      indexHtml,
      /window\.NexusUrl\.update\(\{\s*click:/,
      'click-select must call NexusUrl.update with click',
    );
  });

  it('?root= and ?click= use push: true (navigation), status uses replace (default)', () => {
    // Push call sites — root and click navigation events.
    assert.match(
      indexHtml,
      /window\.NexusUrl\.update\(\{\s*root:[^)]*\}\s*,\s*\{\s*push:\s*true\s*\}/,
      'root deep-link must opt into push',
    );
    assert.match(
      indexHtml,
      /window\.NexusUrl\.update\(\{\s*click:[^)]*\}\s*,\s*\{\s*push:\s*true\s*\}/,
      'click deep-link must opt into push',
    );

    // Status filter must NOT carry { push: true } — replace is the default.
    const statusUpdateMatch = indexHtml.match(
      /window\.NexusUrl\.update\(\{[^}]*status:[^}]*\}[^;]*\)/,
    );
    assert.ok(statusUpdateMatch, 'status filter must call NexusUrl.update');
    assert.ok(
      !/push:\s*true/.test(statusUpdateMatch[0]),
      'status filter must not pass push: true (replace by default)',
    );
  });
});

// ── Behavioural test against a NexusUrl mirror ──────────────────────

function mountNexusUrl(w) {
  function read() { return new URLSearchParams(w.location.search); }
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (v === '') return true;
    return false;
  }
  function applyChange(p, k, v) {
    if (isEmpty(v)) { p.delete(k); return; }
    if (Array.isArray(v)) {
      p.delete(k);
      for (const x of v) {
        if (x === null || x === undefined || x === '') continue;
        p.append(k, String(x));
      }
      return;
    }
    if (typeof v === 'boolean') { p.set(k, v ? 'true' : 'false'); return; }
    p.set(k, String(v));
  }
  w.NexusUrl = {
    read,
    update(changes, opts) {
      const p = read();
      for (const k of Object.keys(changes ?? {})) applyChange(p, k, changes[k]);
      const qs = p.toString();
      const next = w.location.pathname + (qs ? '?' + qs : '');
      if (opts && opts.push) w.history.pushState({}, '', next);
      else w.history.replaceState({}, '', next);
      return p;
    },
  };
}

function makeWindow(initialSearch) {
  const w = {
    location: { pathname: '/pages/clicks/', search: initialSearch ?? '' },
    history: {
      pushed: [],
      replaced: [],
      pushState(_s, _t, url) {
        this.pushed.push(url);
        const idx = url.indexOf('?');
        w.location.search = idx === -1 ? '' : url.slice(idx);
        w.location.pathname = idx === -1 ? url : url.slice(0, idx);
      },
      replaceState(_s, _t, url) {
        this.replaced.push(url);
        const idx = url.indexOf('?');
        w.location.search = idx === -1 ? '' : url.slice(idx);
        w.location.pathname = idx === -1 ? url : url.slice(0, idx);
      },
    },
  };
  return w;
}

const ALL_STATUSES = ['live', 'parked', 'concluded', 'dropped'];

/**
 * Mirrors `writeStatusFilterToUrl` in index.html. Persists the active
 * status set to ?status= via repeated keys; omits the key when every
 * status is selected (D4).
 */
function writeStatusFilterToUrl(w, activeStatuses) {
  const allActive = activeStatuses.size === ALL_STATUSES.length;
  w.NexusUrl.update({
    status: allActive ? null : [...activeStatuses],
  });
}

/** Mirrors `readUrlState` — validates ?status= per D6. */
function readUrlState(w) {
  const errors = [];
  const params = w.NexusUrl.read();
  let activeStatuses = new Set(ALL_STATUSES);
  const statuses = params.getAll('status');
  if (statuses.length > 0) {
    const known = new Set(ALL_STATUSES);
    const unknown = statuses.filter((s) => !known.has(s));
    if (unknown.length > 0) errors.push(...unknown.map((u) => `status: "${u}"`));
    else activeStatuses = new Set(statuses);
  }
  return {
    rootId: params.get('root'),
    clickId: params.get('click'),
    activeStatuses,
    errors,
  };
}

describe('Ratchet clicks URL state — status filter persistence', () => {
  it('changing the status filter writes ?status= via repeated keys (replace, not push)', () => {
    const w = makeWindow();
    mountNexusUrl(w);
    writeStatusFilterToUrl(w, new Set(['live', 'parked']));
    assert.equal(w.history.pushed.length, 0, 'filter changes do not push');
    assert.equal(w.history.replaced.length, 1);
    const params = new URLSearchParams(w.location.search);
    assert.deepEqual(params.getAll('status'), ['live', 'parked']);
  });

  it('omits ?status= when every status is selected (default)', () => {
    const w = makeWindow();
    mountNexusUrl(w);
    writeStatusFilterToUrl(w, new Set(ALL_STATUSES));
    assert.equal(w.location.search, '');
  });

  it('initial load with ?status=live applies the status filter', () => {
    const w = makeWindow('?status=live');
    mountNexusUrl(w);
    const s = readUrlState(w);
    assert.deepEqual(s.activeStatuses, new Set(['live']));
    assert.equal(s.errors.length, 0);
  });

  it('initial load with ?status=live&status=parked applies the multi-status filter', () => {
    const w = makeWindow('?status=live&status=parked');
    mountNexusUrl(w);
    const s = readUrlState(w);
    assert.deepEqual(s.activeStatuses, new Set(['live', 'parked']));
  });

  it('absent ?status= leaves the filter at default (all statuses selected)', () => {
    const w = makeWindow('');
    mountNexusUrl(w);
    const s = readUrlState(w);
    assert.deepEqual(s.activeStatuses, new Set(ALL_STATUSES));
  });

  it('fail-loud — invalid ?status=bogus surfaces an error (D6)', () => {
    const w = makeWindow('?status=bogus');
    mountNexusUrl(w);
    const s = readUrlState(w);
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0], /status.*bogus/);
  });
});

describe('Ratchet clicks URL state — root and click deep-links', () => {
  it('?root= and ?click= survive popstate and round-trip through readUrlState', () => {
    const w = makeWindow('?root=c-abc&click=c-xyz');
    mountNexusUrl(w);
    const s = readUrlState(w);
    assert.equal(s.rootId, 'c-abc');
    assert.equal(s.clickId, 'c-xyz');
  });

  it('selecting a click pushes ?click= (navigation)', () => {
    const w = makeWindow();
    mountNexusUrl(w);
    w.NexusUrl.update({ click: 'c-1' }, { push: true });
    assert.deepEqual(w.history.pushed, ['/pages/clicks/?click=c-1']);
    assert.equal(w.history.replaced.length, 0);
  });

  it('focus subtree pushes ?root=', () => {
    const w = makeWindow();
    mountNexusUrl(w);
    w.NexusUrl.update({ root: 'c-1' }, { push: true });
    assert.deepEqual(w.history.pushed, ['/pages/clicks/?root=c-1']);
  });

  it('show-all (root: null) pushes a clean URL', () => {
    const w = makeWindow('?root=c-1&keep=me');
    mountNexusUrl(w);
    w.NexusUrl.update({ root: null }, { push: true });
    assert.equal(w.location.search, '?keep=me');
    assert.equal(w.history.pushed.length, 1);
  });
});

describe('Ratchet clicks URL state — popstate restoration', () => {
  it('popstate to ?status=live&click=c-2 restores both', () => {
    const w = makeWindow('?status=live');
    mountNexusUrl(w);

    // Initial state (status=live).
    let s = readUrlState(w);
    assert.deepEqual(s.activeStatuses, new Set(['live']));
    assert.equal(s.clickId, null);

    // Browser flips URL to a deep-linked detail with the same filter.
    w.location.search = '?status=live&click=c-2';
    s = readUrlState(w);
    assert.deepEqual(s.activeStatuses, new Set(['live']));
    assert.equal(s.clickId, 'c-2');
    // popstate-driven path must not push or replace anything itself —
    // we only read state in this code path.
    assert.equal(w.history.pushed.length, 0);
    assert.equal(w.history.replaced.length, 0);
  });
});

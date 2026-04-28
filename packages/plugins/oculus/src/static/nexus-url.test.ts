/**
 * Shared URL-state helper — static asset regression tests.
 *
 * `nexus-url.js` is a vanilla-JS file auto-injected into every
 * dashboard page by oculus's chrome-injection pass. It exposes the
 * canonical `window.NexusUrl.*` helpers that every dashboard consumes
 * for deep-linkable filter state.
 *
 * These tests validate the source text directly (grep-against-source)
 * and evaluate the module in a minimal simulated-window sandbox to
 * pin the runtime behaviour: read/update parity, replace-vs-push
 * history, omit-defaults, repeated-key array encoding, and boolean
 * coercion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const urlJs = readFileSync(resolve(__dirname, 'nexus-url.js'), 'utf-8');

// ── Source-grep assertions ───────────────────────────────────────────

describe('nexus-url.js source structure', () => {
  it('exposes the surface on global.NexusUrl', () => {
    assert.match(urlJs, /global\.NexusUrl\s*=\s*\{/);
    assert.match(urlJs, /read:\s*read/);
    assert.match(urlJs, /update:\s*update/);
    assert.match(urlJs, /onChange:\s*onChange/);
    assert.match(urlJs, /getString:\s*getString/);
    assert.match(urlJs, /getAll:\s*getAll/);
    assert.match(urlJs, /getBool:\s*getBool/);
    assert.match(urlJs, /getInt:\s*getInt/);
  });

  it('uses replaceState by default and pushState only when opts.push', () => {
    assert.match(urlJs, /history\.pushState/);
    assert.match(urlJs, /history\.replaceState/);
    // Defaults to replace: pushState is only chosen behind an `opts.push` branch.
    assert.match(urlJs, /opts && opts\.push/);
  });

  it('reads URLSearchParams from window.location.search live', () => {
    assert.match(urlJs, /new URLSearchParams\([^)]*\.search\)/);
  });
});

// ── Runtime behaviour ────────────────────────────────────────────────

interface UrlApi {
  read(): URLSearchParams;
  update(
    changes: Record<string, unknown>,
    opts?: { push?: boolean },
  ): URLSearchParams;
  onChange(cb: (params: URLSearchParams) => void): () => void;
  getString(key: string, defaultValue?: string): string;
  getAll(key: string): string[];
  getBool(key: string, defaultValue?: boolean): boolean;
  getInt(key: string, defaultValue?: number): number;
  has(key: string): boolean;
}

interface Sandbox {
  window: {
    NexusUrl?: UrlApi;
    location: { pathname: string; search: string; href: string };
    history: {
      pushState(state: unknown, title: string, url: string): void;
      replaceState(state: unknown, title: string, url: string): void;
      _pushCount: number;
      _replaceCount: number;
      _lastUrl: string | null;
    };
    addEventListener(name: string, handler: (...args: unknown[]) => void): void;
    removeEventListener(name: string, handler: (...args: unknown[]) => void): void;
    _listeners: Map<string, Array<(...args: unknown[]) => void>>;
    _firePopstate(): void;
  };
  URLSearchParams: typeof URLSearchParams;
}

function loadHelper(initialSearch = ''): UrlApi {
  const window: Sandbox['window'] = {
    NexusUrl: undefined,
    location: { pathname: '/page', search: initialSearch, href: '/page' + initialSearch },
    history: {
      _pushCount: 0,
      _replaceCount: 0,
      _lastUrl: null,
      pushState(_state, _title, url) {
        this._pushCount += 1;
        this._lastUrl = url;
        const u = new URL(url, 'http://x');
        window.location.pathname = u.pathname;
        window.location.search = u.search;
        window.location.href = u.pathname + u.search;
      },
      replaceState(_state, _title, url) {
        this._replaceCount += 1;
        this._lastUrl = url;
        const u = new URL(url, 'http://x');
        window.location.pathname = u.pathname;
        window.location.search = u.search;
        window.location.href = u.pathname + u.search;
      },
    },
    _listeners: new Map(),
    addEventListener(name, handler) {
      const list = this._listeners.get(name) ?? [];
      list.push(handler);
      this._listeners.set(name, list);
    },
    removeEventListener(name, handler) {
      const list = this._listeners.get(name) ?? [];
      this._listeners.set(name, list.filter((h) => h !== handler));
    },
    _firePopstate() {
      const list = this._listeners.get('popstate') ?? [];
      for (const h of list) h();
    },
  };
  // Aliases so Object.prototype methods resolve through the sandbox window.
  // (vm.runInContext gives us a fresh global; we mount our `window` so the
  // helper IIFE finds it and hangs `NexusUrl` off it.)
  const sandbox: Sandbox = { window, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(urlJs, sandbox);
  if (!window.NexusUrl) throw new Error('nexus-url.js did not expose window.NexusUrl');
  // Stash the sandbox's window object on the api so tests can introspect.
  (window.NexusUrl as unknown as { _window: Sandbox['window'] })._window = window;
  return window.NexusUrl;
}

function getWindow(api: UrlApi): Sandbox['window'] {
  return (api as unknown as { _window: Sandbox['window'] })._window;
}

describe('NexusUrl.read', () => {
  it('reads the live querystring snapshot', () => {
    const api = loadHelper('?type=mandate&type=bug&q=hello');
    const params = api.read();
    assert.equal(params.get('q'), 'hello');
    assert.deepEqual(params.getAll('type'), ['mandate', 'bug']);
  });

  it('returns an empty params object for no search', () => {
    const api = loadHelper('');
    assert.equal(api.read().toString(), '');
  });
});

describe('NexusUrl.update', () => {
  it('replaces by default — calls replaceState, not pushState', () => {
    const api = loadHelper('');
    api.update({ q: 'hello' });
    const w = getWindow(api);
    assert.equal(w.history._replaceCount, 1);
    assert.equal(w.history._pushCount, 0);
    assert.equal(w.location.search, '?q=hello');
  });

  it('pushes when opts.push is true', () => {
    const api = loadHelper('');
    api.update({ writ: 'w-123' }, { push: true });
    const w = getWindow(api);
    assert.equal(w.history._pushCount, 1);
    assert.equal(w.history._replaceCount, 0);
    assert.equal(w.location.search, '?writ=w-123');
  });

  it('omit-defaults — null, undefined, empty string, empty array delete the key', () => {
    const api = loadHelper('?q=hello&type=mandate&type=bug&children=true');
    api.update({ q: null, type: [], children: undefined });
    const w = getWindow(api);
    assert.equal(w.location.search, '');
  });

  it('repeated-keys array encoding — array maps to repeated params', () => {
    const api = loadHelper('');
    api.update({ status: ['open', 'pending'] });
    const w = getWindow(api);
    // Search string contains both values
    const params = new URLSearchParams(w.location.search);
    assert.deepEqual(params.getAll('status'), ['open', 'pending']);
  });

  it('boolean values encode as true/false strings', () => {
    const api = loadHelper('');
    api.update({ children: true, cancelled: false });
    const w = getWindow(api);
    const params = new URLSearchParams(w.location.search);
    assert.equal(params.get('children'), 'true');
    assert.equal(params.get('cancelled'), 'false');
  });

  it('preserves unrelated existing params', () => {
    const api = loadHelper('?writ=w-1');
    api.update({ q: 'x' });
    const w = getWindow(api);
    const params = new URLSearchParams(w.location.search);
    assert.equal(params.get('writ'), 'w-1');
    assert.equal(params.get('q'), 'x');
  });

  it('round-trips: read after update reflects the new params', () => {
    const api = loadHelper('');
    api.update({ q: 'foo', status: ['open', 'closed'] });
    const params = api.read();
    assert.equal(params.get('q'), 'foo');
    assert.deepEqual(params.getAll('status'), ['open', 'closed']);
  });
});

describe('NexusUrl.getString', () => {
  it('returns the value when present', () => {
    const api = loadHelper('?q=hello');
    assert.equal(api.getString('q'), 'hello');
  });

  it('returns the default when absent', () => {
    const api = loadHelper('');
    assert.equal(api.getString('q', 'fallback'), 'fallback');
  });

  it('default defaults to empty string', () => {
    const api = loadHelper('');
    assert.equal(api.getString('q'), '');
  });
});

describe('NexusUrl.getAll', () => {
  it('returns all values for repeated keys', () => {
    const api = loadHelper('?type=a&type=b&type=c');
    assert.deepEqual(api.getAll('type'), ['a', 'b', 'c']);
  });

  it('returns the empty array when key is absent', () => {
    const api = loadHelper('');
    assert.deepEqual(api.getAll('type'), []);
  });

  it('returns a single-element array when the key appears once', () => {
    const api = loadHelper('?type=a');
    assert.deepEqual(api.getAll('type'), ['a']);
  });
});

describe('NexusUrl.getBool', () => {
  it('parses "true" and "false" strings', () => {
    const a = loadHelper('?on=true');
    assert.equal(a.getBool('on'), true);
    const b = loadHelper('?on=false');
    assert.equal(b.getBool('on'), false);
  });

  it('also accepts 1/0 for compatibility', () => {
    const a = loadHelper('?on=1');
    assert.equal(a.getBool('on'), true);
    const b = loadHelper('?on=0');
    assert.equal(b.getBool('on'), false);
  });

  it('returns the supplied default when key is absent', () => {
    const a = loadHelper('');
    assert.equal(a.getBool('on', true), true);
    assert.equal(a.getBool('on', false), false);
  });

  it('default defaults to false', () => {
    const a = loadHelper('');
    assert.equal(a.getBool('on'), false);
  });

  it('unknown encoding falls back to the default', () => {
    const a = loadHelper('?on=maybe');
    assert.equal(a.getBool('on', true), true);
    assert.equal(a.getBool('on', false), false);
  });
});

describe('NexusUrl.getInt', () => {
  it('parses integer values', () => {
    const a = loadHelper('?offset=42');
    assert.equal(a.getInt('offset'), 42);
  });

  it('returns the default for absent keys', () => {
    const a = loadHelper('');
    assert.equal(a.getInt('offset', 10), 10);
  });

  it('returns the default for non-numeric values', () => {
    const a = loadHelper('?offset=banana');
    assert.equal(a.getInt('offset', 0), 0);
  });
});

describe('NexusUrl.has', () => {
  it('returns true when key is present', () => {
    const a = loadHelper('?x=1');
    assert.equal(a.has('x'), true);
  });
  it('returns false when key is absent', () => {
    const a = loadHelper('?x=1');
    assert.equal(a.has('y'), false);
  });
});

describe('NexusUrl.onChange', () => {
  it('fires the callback on popstate with the fresh params', () => {
    const api = loadHelper('?q=before');
    const w = getWindow(api);
    let observed: URLSearchParams | null = null;
    const off = api.onChange((p) => { observed = p; });

    // Simulate browser navigation: change location and fire popstate.
    w.location.search = '?q=after';
    w._firePopstate();

    assert.ok(observed !== null);
    assert.equal((observed as URLSearchParams).get('q'), 'after');

    off();
  });

  it('returns an unsubscribe function that detaches the listener', () => {
    const api = loadHelper('');
    const w = getWindow(api);
    let count = 0;
    const off = api.onChange(() => { count += 1; });
    w._firePopstate();
    assert.equal(count, 1);
    off();
    w._firePopstate();
    assert.equal(count, 1, 'callback should not fire after unsubscribe');
  });

  it('non-function callback is a no-op (still returns an unsubscribe)', () => {
    const api = loadHelper('');
    // @ts-expect-error — testing defensive runtime guard
    const off = api.onChange(null);
    assert.equal(typeof off, 'function');
    off();
  });
});

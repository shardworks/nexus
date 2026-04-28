/**
 * Nexus shared URL-state helpers.
 *
 * Single source of truth for reading and writing deep-linkable filter
 * state across every guild dashboard. Exposed on `window.NexusUrl` so
 * each dashboard's vanilla-JS IIFE can consume the same canonical
 * helpers without having to re-implement them locally (which
 * historically caused per-page drift and pages whose filters did not
 * round-trip through the URL at all).
 *
 * Conventions (commission moix23w5):
 *   - Live read: `read()` always returns a fresh `URLSearchParams`
 *     snapshot from `window.location.search`. Never cached.
 *   - Update: `update(changes, opts)` applies a key→value patch to the
 *     current querystring and replaces or pushes the resulting URL.
 *     The default is `replaceState` (D5). Pass `{ push: true }` to use
 *     `pushState` — reserved for navigation events (opening a detail
 *     view), never per-keystroke filter changes.
 *   - Repeated keys for arrays (D3): pass an array to set multiple
 *     values; `getAll(key)` reads them back. Round-trips cleanly
 *     through the server-side `parseQueryParams` parser.
 *   - Omit-defaults (D4): `update` with `null`, `undefined`, an empty
 *     string, or an empty array deletes the key. Typed getters take a
 *     default-value argument and return that default when the key is
 *     absent.
 *   - Boolean encoding (D7): true/false strings — `?key=true` /
 *     `?key=false`. The boolean getter accepts the string forms and
 *     legacy `1`/`0`.
 *   - onChange: registers a popstate-driven subscriber. The callback
 *     receives the fresh `URLSearchParams`.
 *
 * This file is auto-injected into every dashboard page by oculus's
 * chrome-injection pass alongside `nexus-format.js`. It must run before
 * any dashboard IIFE, so oculus injects the `<script>` tag into
 * `<head>` while dashboard scripts remain at end-of-`<body>`.
 */
(function (global) {
  'use strict';

  function read() {
    var loc = global.location || { search: '' };
    return new URLSearchParams(loc.search);
  }

  function isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (value === '') return true;
    return false;
  }

  function applyChange(params, key, value) {
    if (isEmpty(value)) {
      params.delete(key);
      return;
    }
    if (Array.isArray(value)) {
      params.delete(key);
      for (var i = 0; i < value.length; i++) {
        var v = value[i];
        if (v === null || v === undefined || v === '') continue;
        params.append(key, String(v));
      }
      return;
    }
    if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false');
      return;
    }
    params.set(key, String(value));
  }

  function update(changes, opts) {
    var params = read();
    if (changes && typeof changes === 'object') {
      var keys = Object.keys(changes);
      for (var i = 0; i < keys.length; i++) {
        applyChange(params, keys[i], changes[keys[i]]);
      }
    }
    var qs = params.toString();
    var loc = global.location || { pathname: '/' };
    var next = loc.pathname + (qs ? '?' + qs : '');
    var history = global.history;
    if (!history) return params;
    var push = !!(opts && opts.push);
    if (push) {
      history.pushState({}, '', next);
    } else {
      history.replaceState({}, '', next);
    }
    return params;
  }

  function getString(key, defaultValue) {
    var params = read();
    var value = params.get(key);
    if (value === null) {
      return defaultValue === undefined ? '' : defaultValue;
    }
    return value;
  }

  function getAll(key) {
    var params = read();
    return params.getAll(key);
  }

  function getBool(key, defaultValue) {
    var params = read();
    var value = params.get(key);
    if (value === null) {
      return defaultValue === undefined ? false : defaultValue;
    }
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    // Unknown encoding — fall back to the default.
    return defaultValue === undefined ? false : defaultValue;
  }

  function getInt(key, defaultValue) {
    var params = read();
    var value = params.get(key);
    if (value === null) {
      return defaultValue === undefined ? 0 : defaultValue;
    }
    var n = parseInt(value, 10);
    if (!isFinite(n)) {
      return defaultValue === undefined ? 0 : defaultValue;
    }
    return n;
  }

  function has(key) {
    return read().has(key);
  }

  function onChange(callback) {
    if (typeof callback !== 'function') return function () {};
    var listener = function () {
      try { callback(read()); } catch (e) { /* swallow per-page errors */ }
    };
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('popstate', listener);
    }
    return function () {
      if (typeof global.removeEventListener === 'function') {
        global.removeEventListener('popstate', listener);
      }
    };
  }

  global.NexusUrl = {
    read: read,
    update: update,
    onChange: onChange,
    getString: getString,
    getAll: getAll,
    getBool: getBool,
    getInt: getInt,
    has: has,
  };
})(typeof window !== 'undefined' ? window : globalThis);

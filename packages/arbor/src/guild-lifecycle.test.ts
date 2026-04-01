/**
 * Tests for guild-lifecycle.ts — the pure logic layer of Arbor.
 *
 * All tests use synthetic LoadedKit / LoadedApparatus fixtures.
 * No I/O, no filesystem, no dynamic imports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LoadedKit, LoadedApparatus, StartupContext } from '@shardworks/nexus-core';
import {
  validateRequires,
  topoSort,
  collectStartupWarnings,
  buildStartupContext,
  fireEvent,
} from './guild-lifecycle.ts';
import type { EventHandlerMap } from './guild-lifecycle.ts';

// ── Fixture helpers ──────────────────────────────────────────────────

function makeKit(id: string, kit: Record<string, unknown> = {}): LoadedKit {
  return {
    packageName: `@test/${id}`,
    id,
    version: '1.0.0',
    kit,
  };
}

function makeApparatus(
  id: string,
  opts: {
    requires?: string[];
    provides?: unknown;
    consumes?: string[];
    start?: (ctx: StartupContext) => void | Promise<void>;
  } = {},
): LoadedApparatus {
  return {
    packageName: `@test/${id}`,
    id,
    version: '1.0.0',
    apparatus: {
      requires: opts.requires,
      provides: opts.provides,
      consumes: opts.consumes,
      start: opts.start ?? (() => {}),
    },
  };
}

// ── validateRequires ─────────────────────────────────────────────────

describe('validateRequires', () => {
  it('passes with no plugins', () => {
    assert.doesNotThrow(() => validateRequires([], []));
  });

  it('passes with kits and apparatuses that have no requires', () => {
    const kits = [makeKit('relay-kit')];
    const apps = [makeApparatus('tools')];
    assert.doesNotThrow(() => validateRequires(kits, apps));
  });

  it('passes when apparatus requires another installed apparatus', () => {
    const apps = [
      makeApparatus('db'),
      makeApparatus('ledger', { requires: ['db'] }),
    ];
    assert.doesNotThrow(() => validateRequires([], apps));
  });

  it('passes when kit requires an installed apparatus', () => {
    const kits = [makeKit('relay-kit', { requires: ['ledger'] })];
    const apps = [makeApparatus('ledger')];
    assert.doesNotThrow(() => validateRequires(kits, apps));
  });

  it('throws when apparatus requires a missing plugin', () => {
    const apps = [makeApparatus('ledger', { requires: ['db'] })];
    assert.throws(
      () => validateRequires([], apps),
      /requires "db", which is not installed/,
    );
  });

  it('throws when kit requires a missing plugin', () => {
    const kits = [makeKit('relay-kit', { requires: ['nonexistent'] })];
    assert.throws(
      () => validateRequires(kits, []),
      /requires "nonexistent", which is not installed/,
    );
  });

  it('throws when kit requires another kit (not an apparatus)', () => {
    const kits = [
      makeKit('kit-a'),
      makeKit('kit-b', { requires: ['kit-a'] }),
    ];
    assert.throws(
      () => validateRequires(kits, []),
      /but that plugin is a kit, not an apparatus/,
    );
  });

  it('includes the dependent and dependency names in the error', () => {
    const apps = [makeApparatus('sessions', { requires: ['ledger'] })];
    assert.throws(
      () => validateRequires([], apps),
      (err: Error) => {
        return err.message.includes('"sessions"') && err.message.includes('"ledger"');
      },
    );
  });

  // ── Cycle detection ────────────────────────────────────────────────

  it('detects a direct circular dependency (A → B → A)', () => {
    const apps = [
      makeApparatus('a', { requires: ['b'] }),
      makeApparatus('b', { requires: ['a'] }),
    ];
    assert.throws(
      () => validateRequires([], apps),
      /Circular dependency detected/,
    );
  });

  it('detects a transitive circular dependency (A → B → C → A)', () => {
    const apps = [
      makeApparatus('a', { requires: ['b'] }),
      makeApparatus('b', { requires: ['c'] }),
      makeApparatus('c', { requires: ['a'] }),
    ];
    assert.throws(
      () => validateRequires([], apps),
      /Circular dependency detected/,
    );
  });

  it('includes the cycle path in the error message', () => {
    const apps = [
      makeApparatus('x', { requires: ['y'] }),
      makeApparatus('y', { requires: ['x'] }),
    ];
    assert.throws(
      () => validateRequires([], apps),
      (err: Error) => {
        // The cycle path should contain both nodes
        return err.message.includes('x') && err.message.includes('y') && err.message.includes('→');
      },
    );
  });

  it('does not false-positive on a diamond dependency', () => {
    // A → B, A → C, B → D, C → D (no cycle)
    const apps = [
      makeApparatus('d'),
      makeApparatus('b', { requires: ['d'] }),
      makeApparatus('c', { requires: ['d'] }),
      makeApparatus('a', { requires: ['b', 'c'] }),
    ];
    assert.doesNotThrow(() => validateRequires([], apps));
  });

  it('passes with a self-referencing apparatus (allowed by requires check but not cycle check)', () => {
    const apps = [makeApparatus('a', { requires: ['a'] })];
    assert.throws(
      () => validateRequires([], apps),
      /Circular dependency detected/,
    );
  });
});

// ── topoSort ─────────────────────────────────────────────────────────

describe('topoSort', () => {
  it('returns empty array for no apparatuses', () => {
    assert.deepEqual(topoSort([]), []);
  });

  it('returns a single apparatus unchanged', () => {
    const apps = [makeApparatus('a')];
    const sorted = topoSort(apps);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0]!.id, 'a');
  });

  it('preserves order when no dependencies exist', () => {
    const apps = [makeApparatus('a'), makeApparatus('b'), makeApparatus('c')];
    const sorted = topoSort(apps);
    assert.deepEqual(sorted.map((a) => a.id), ['a', 'b', 'c']);
  });

  it('places dependencies before dependents', () => {
    const apps = [
      makeApparatus('web', { requires: ['db'] }),
      makeApparatus('db'),
    ];
    const sorted = topoSort(apps);
    const ids = sorted.map((a) => a.id);
    assert.ok(ids.indexOf('db') < ids.indexOf('web'),
      `Expected db before web, got: ${ids.join(', ')}`);
  });

  it('handles a linear chain (A → B → C)', () => {
    const apps = [
      makeApparatus('a', { requires: ['b'] }),
      makeApparatus('b', { requires: ['c'] }),
      makeApparatus('c'),
    ];
    const sorted = topoSort(apps);
    const ids = sorted.map((a) => a.id);
    assert.deepEqual(ids, ['c', 'b', 'a']);
  });

  it('handles a diamond dependency', () => {
    const apps = [
      makeApparatus('top', { requires: ['left', 'right'] }),
      makeApparatus('left', { requires: ['bottom'] }),
      makeApparatus('right', { requires: ['bottom'] }),
      makeApparatus('bottom'),
    ];
    const sorted = topoSort(apps);
    const ids = sorted.map((a) => a.id);

    // bottom must be first; top must be last
    assert.equal(ids[0], 'bottom');
    assert.equal(ids[ids.length - 1], 'top');
    // left and right must both come before top
    assert.ok(ids.indexOf('left') < ids.indexOf('top'));
    assert.ok(ids.indexOf('right') < ids.indexOf('top'));
  });

  it('returns all apparatuses even when some have no deps', () => {
    const apps = [
      makeApparatus('a'),
      makeApparatus('b', { requires: ['a'] }),
      makeApparatus('c'),
    ];
    const sorted = topoSort(apps);
    assert.equal(sorted.length, 3);
    assert.ok(sorted.map((a) => a.id).indexOf('a') < sorted.map((a) => a.id).indexOf('b'));
  });
});

// ── collectStartupWarnings ───────────────────────────────────────────

describe('collectStartupWarnings', () => {
  it('returns no warnings when everything is wired correctly', () => {
    const kits = [makeKit('relay-kit', { requires: ['tools'], tools: ['relay-send'] })];
    const apps = [makeApparatus('tools', { consumes: ['tools'] })];
    const warnings = collectStartupWarnings(kits, apps);
    assert.deepEqual(warnings, []);
  });

  it('returns no warnings with no kits or apparatuses', () => {
    assert.deepEqual(collectStartupWarnings([], []), []);
  });

  it('warns when a kit recommends an apparatus that is not installed', () => {
    const kits = [makeKit('relay-kit', { recommends: ['sessions'] })];
    const warnings = collectStartupWarnings(kits, []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('recommends'));
    assert.ok(warnings[0]!.includes('sessions'));
  });

  it('does not warn when a recommended apparatus IS installed', () => {
    const kits = [makeKit('relay-kit', { recommends: ['sessions'] })];
    const apps = [makeApparatus('sessions')];
    const warnings = collectStartupWarnings(kits, apps);
    // No recommends warnings (there may be contribution warnings)
    const recommends = warnings.filter((w) => w.includes('recommends'));
    assert.equal(recommends.length, 0);
  });

  it('warns when a kit contributes a type no apparatus consumes', () => {
    const kits = [makeKit('relay-kit', { engines: ['some-engine'] })];
    const apps = [makeApparatus('tools')]; // doesn't consume 'engines'
    const warnings = collectStartupWarnings(kits, apps);
    assert.ok(warnings.some((w) => w.includes('contributes "engines"')));
  });

  it('does not warn when a kit contribution type IS consumed', () => {
    const kits = [makeKit('relay-kit', { engines: ['some-engine'] })];
    const apps = [makeApparatus('clock', { consumes: ['engines'] })];
    const warnings = collectStartupWarnings(kits, apps);
    const contribution = warnings.filter((w) => w.includes('contributes'));
    assert.equal(contribution.length, 0);
  });

  it('skips requires and recommends when checking contributions', () => {
    // requires and recommends are framework fields, not contribution types
    const kits = [makeKit('relay-kit', { requires: ['tools'], recommends: ['sessions'] })];
    const apps = [makeApparatus('tools')];
    const warnings = collectStartupWarnings(kits, apps);
    // Should not warn about 'requires' or 'recommends' as contribution types
    const contributions = warnings.filter((w) => w.includes('contributes'));
    assert.equal(contributions.length, 0);
  });

  it('returns multiple warnings for multiple issues', () => {
    const kits = [
      makeKit('kit-a', { recommends: ['missing-app'], engines: ['e1'] }),
      makeKit('kit-b', { relays: ['r1'] }),
    ];
    const warnings = collectStartupWarnings(kits, []);
    // At minimum: recommends warning + engines warning + relays warning
    assert.ok(warnings.length >= 3, `Expected at least 3 warnings, got ${warnings.length}`);
  });
});

// ── buildStartupContext + fireEvent ──────────────────────────────────

describe('buildStartupContext', () => {
  it('returns an object with an on() method', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers);
    assert.equal(typeof ctx.on, 'function');
  });

  it('registers handlers in the event handler map', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers);
    const fn = () => {};
    ctx.on('test-event', fn);
    assert.ok(handlers.has('test-event'));
    assert.equal(handlers.get('test-event')!.length, 1);
  });

  it('allows multiple handlers for the same event', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers);
    ctx.on('plugin:initialized', () => {});
    ctx.on('plugin:initialized', () => {});
    assert.equal(handlers.get('plugin:initialized')!.length, 2);
  });
});

describe('fireEvent', () => {
  it('does nothing when no handlers are registered', async () => {
    const handlers: EventHandlerMap = new Map();
    // Should not throw
    await fireEvent(handlers, 'nonexistent');
  });

  it('calls all registered handlers with the provided args', async () => {
    const handlers: EventHandlerMap = new Map();
    const calls: unknown[][] = [];
    handlers.set('test', [
      (...args: unknown[]) => { calls.push(args); },
      (...args: unknown[]) => { calls.push(args); },
    ]);

    await fireEvent(handlers, 'test', 'a', 42);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['a', 42]);
    assert.deepEqual(calls[1], ['a', 42]);
  });

  it('awaits async handlers sequentially', async () => {
    const handlers: EventHandlerMap = new Map();
    const order: number[] = [];

    handlers.set('seq', [
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      },
      async () => {
        order.push(2);
      },
    ]);

    await fireEvent(handlers, 'seq');

    // Handler 1 should complete before handler 2 starts
    assert.deepEqual(order, [1, 2]);
  });

  it('only fires handlers for the named event', async () => {
    const handlers: EventHandlerMap = new Map();
    let aCalled = false;
    let bCalled = false;
    handlers.set('a', [() => { aCalled = true; }]);
    handlers.set('b', [() => { bCalled = true; }]);

    await fireEvent(handlers, 'a');

    assert.ok(aCalled);
    assert.ok(!bCalled);
  });
});

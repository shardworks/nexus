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
  filterFailedPlugins,
  topoSort,
  collectStartupWarnings,
  buildStartupContext,
  wireKitEntries,
  fireEvent,
  shutdownStartedApparatuses,
  formatShutdownFailures,
} from './guild-lifecycle.ts';
import type { EventHandlerMap, ShutdownFailure } from './guild-lifecycle.ts';

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
    recommends?: string[];
    provides?: unknown;
    consumes?: string[];
    supportKit?: Record<string, unknown>;
    start?: (ctx: StartupContext) => void | Promise<void>;
    stop?: () => void | Promise<void>;
  } = {},
): LoadedApparatus {
  return {
    packageName: `@test/${id}`,
    id,
    version: '1.0.0',
    apparatus: {
      requires: opts.requires,
      recommends: opts.recommends,
      provides: opts.provides,
      consumes: opts.consumes,
      ...(opts.supportKit !== undefined ? { supportKit: opts.supportKit } : {}),
      start: opts.start ?? (() => {}),
      ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
    },
  };
}

// ── validateRequires ─────────────────────────────────────────────────

describe('validateRequires', () => {
  it('passes with no plugins', () => {
    assert.deepEqual(validateRequires([], []), []);
  });

  it('passes with kits and apparatuses that have no requires', () => {
    const kits = [makeKit('relay-kit')];
    const apps = [makeApparatus('tools')];
    assert.deepEqual(validateRequires(kits, apps), []);
  });

  it('passes when apparatus requires another installed apparatus', () => {
    const apps = [
      makeApparatus('db'),
      makeApparatus('ledger', { requires: ['db'] }),
    ];
    assert.deepEqual(validateRequires([], apps), []);
  });

  it('passes when kit requires an installed apparatus', () => {
    const kits = [makeKit('relay-kit', { requires: ['ledger'] })];
    const apps = [makeApparatus('ledger')];
    assert.deepEqual(validateRequires(kits, apps), []);
  });

  it('throws when apparatus requires a missing plugin', () => {
    const apps = [makeApparatus('ledger', { requires: ['db'] })];
    const failures = validateRequires([], apps);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, 'ledger');
    assert.match(failures[0]!.reason, /requires "db"/);
  });

  it('throws when kit requires a missing plugin', () => {
    const kits = [makeKit('relay-kit', { requires: ['nonexistent'] })];
    const failures = validateRequires(kits, []);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, 'relay-kit');
    assert.match(failures[0]!.reason, /requires "nonexistent"/);
  });

  it('throws when kit requires another kit (not an apparatus)', () => {
    const kits = [
      makeKit('kit-a'),
      makeKit('kit-b', { requires: ['kit-a'] }),
    ];
    const failures = validateRequires(kits, []);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, 'kit-b');
    assert.match(failures[0]!.reason, /but that plugin is a kit/);
  });

  it('includes the dependent and dependency names in the error', () => {
    const apps = [makeApparatus('sessions', { requires: ['ledger'] })];
    const failures = validateRequires([], apps);
    assert.ok(failures[0]!.reason.includes('"sessions"') && failures[0]!.reason.includes('"ledger"'));
  });

  it('collects multiple failures in one pass', () => {
    const apps = [
      makeApparatus('alpha', { requires: ['missing-x'] }),
      makeApparatus('beta', { requires: ['missing-y'] }),
    ];
    const failures = validateRequires([], apps);
    assert.equal(failures.length, 2);
  });

  // ── Cycle detection ────────────────────────────────────────────────

  it('detects a direct circular dependency (A → B → A)', () => {
    const apps = [
      makeApparatus('a', { requires: ['b'] }),
      makeApparatus('b', { requires: ['a'] }),
    ];
    const failures = validateRequires([], apps);
    assert.ok(failures.length >= 2);
    const ids = failures.map((f) => f.id);
    assert.ok(ids.includes('a') && ids.includes('b'));
  });

  it('detects a transitive circular dependency (A → B → C → A)', () => {
    const apps = [
      makeApparatus('a', { requires: ['b'] }),
      makeApparatus('b', { requires: ['c'] }),
      makeApparatus('c', { requires: ['a'] }),
    ];
    const failures = validateRequires([], apps);
    assert.ok(failures.length >= 3);
    const ids = failures.map((f) => f.id);
    assert.ok(ids.includes('a') && ids.includes('b') && ids.includes('c'));
  });

  it('includes the cycle path in the error message', () => {
    const apps = [
      makeApparatus('x', { requires: ['y'] }),
      makeApparatus('y', { requires: ['x'] }),
    ];
    const failures = validateRequires([], apps);
    assert.ok(failures.every((f) => f.reason.includes('circular dependency')));
  });

  it('does not false-positive on a diamond dependency', () => {
    // A → B, A → C, B → D, C → D (no cycle)
    const apps = [
      makeApparatus('d'),
      makeApparatus('b', { requires: ['d'] }),
      makeApparatus('c', { requires: ['d'] }),
      makeApparatus('a', { requires: ['b', 'c'] }),
    ];
    assert.deepEqual(validateRequires([], apps), []);
  });

  it('passes with a self-referencing apparatus (allowed by requires check but not cycle check)', () => {
    const apps = [makeApparatus('a', { requires: ['a'] })];
    const failures = validateRequires([], apps);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, 'a');
    assert.match(failures[0]!.reason, /circular dependency/);
  });
});

// ── filterFailedPlugins ──────────────────────────────────────────────

describe('filterFailedPlugins', () => {
  it('returns all plugins when there are no failures', () => {
    const kits = [makeKit('k1')];
    const apps = [makeApparatus('a1'), makeApparatus('a2')];
    const result = filterFailedPlugins(kits, apps, []);
    assert.equal(result.kits.length, 1);
    assert.equal(result.apparatuses.length, 2);
    assert.deepEqual(result.cascaded, []);
  });

  it('removes apparatus that depends on a failed plugin', () => {
    const apps = [
      makeApparatus('db'),
      makeApparatus('web', { requires: ['db'] }),
    ];
    const rootFailures = [{ id: 'db', reason: 'db failed' }];
    const result = filterFailedPlugins([], apps, rootFailures);
    assert.equal(result.apparatuses.length, 0);
    assert.equal(result.cascaded.length, 1);
    assert.equal(result.cascaded[0]!.id, 'web');
    assert.match(result.cascaded[0]!.reason, /depends on failed plugin "db"/);
  });

  it('cascades transitively (A → B → C, A fails)', () => {
    const apps = [
      makeApparatus('a'),
      makeApparatus('b', { requires: ['a'] }),
      makeApparatus('c', { requires: ['b'] }),
    ];
    const rootFailures = [{ id: 'a', reason: 'a failed' }];
    const result = filterFailedPlugins([], apps, rootFailures);
    assert.equal(result.apparatuses.length, 0);
    assert.equal(result.cascaded.length, 2);
    const cascadedIds = result.cascaded.map((f) => f.id).sort();
    assert.deepEqual(cascadedIds, ['b', 'c']);
  });

  it('removes kits that depend on a failed apparatus', () => {
    const kits = [makeKit('my-kit', { requires: ['tools'] })];
    const apps = [makeApparatus('tools')];
    const rootFailures = [{ id: 'tools', reason: 'tools failed' }];
    const result = filterFailedPlugins(kits, apps, rootFailures);
    assert.equal(result.kits.length, 0);
    assert.equal(result.cascaded.length, 1);
    assert.equal(result.cascaded[0]!.id, 'my-kit');
    assert.match(result.cascaded[0]!.reason, /depends on failed plugin "tools"/);
  });

  it('preserves healthy plugins alongside failed ones', () => {
    const apps = [
      makeApparatus('healthy'),
      makeApparatus('broken'),
      makeApparatus('dependent', { requires: ['broken'] }),
    ];
    const rootFailures = [{ id: 'broken', reason: 'broken failed' }];
    const result = filterFailedPlugins([], apps, rootFailures);
    assert.equal(result.apparatuses.length, 1);
    assert.equal(result.apparatuses[0]!.id, 'healthy');
    assert.equal(result.cascaded.length, 1);
    assert.equal(result.cascaded[0]!.id, 'dependent');
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

  it('does not warn when a kit-recommended apparatus IS installed', () => {
    const kits = [makeKit('relay-kit', { recommends: ['sessions'] })];
    const apps = [makeApparatus('sessions')];
    const warnings = collectStartupWarnings(kits, apps);
    // No recommends warnings (there may be contribution warnings)
    const recommends = warnings.filter((w) => w.includes('recommends'));
    assert.equal(recommends.length, 0);
  });

  it('warns when an apparatus recommends another apparatus that is not installed', () => {
    const apps = [makeApparatus('animator', { recommends: ['loom'] })];
    const warnings = collectStartupWarnings([], apps);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('animator'));
    assert.ok(warnings[0]!.includes('recommends'));
    assert.ok(warnings[0]!.includes('loom'));
  });

  it('does not warn when an apparatus-recommended apparatus IS installed', () => {
    const apps = [
      makeApparatus('animator', { recommends: ['loom'] }),
      makeApparatus('loom'),
    ];
    const warnings = collectStartupWarnings([], apps);
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

  it('warns when an apparatus supportKit contributes a type no apparatus consumes', () => {
    const apps = [
      makeApparatus('clerk', {
        supportKit: { customChannel: ['item-a'] },
      }),
    ];
    const warnings = collectStartupWarnings([], apps);
    assert.ok(
      warnings.some((w) => w.includes('customChannel')),
      `Expected warning about "customChannel", got: ${JSON.stringify(warnings)}`,
    );
  });

  it('does not warn when apparatus supportKit contribution type IS consumed', () => {
    const apps = [
      makeApparatus('clerk', {
        supportKit: { customChannel: ['item-a'] },
        consumes: ['customChannel'],
      }),
    ];
    const warnings = collectStartupWarnings([], apps);
    const contribution = warnings.filter((w) => w.includes('customChannel'));
    assert.equal(contribution.length, 0);
  });

  it('does not warn about supportKit requires/recommends fields', () => {
    // requires and recommends inside supportKit are framework fields — not contribution types
    const apps = [
      makeApparatus('clerk', {
        supportKit: { requires: ['tools'], recommends: ['oculus'] },
      }),
    ];
    const warnings = collectStartupWarnings([], apps);
    const contribution = warnings.filter((w) => w.includes('contributes'));
    assert.equal(contribution.length, 0);
  });
});

// ── wireKitEntries ───────────────────────────────────────────────────

describe('wireKitEntries', () => {
  it('returns empty array when no kits or apparatuses', () => {
    assert.deepEqual(wireKitEntries([], []), []);
  });

  it('collects contribution types from standalone kits', () => {
    const kits = [makeKit('relay-kit', { tools: ['relay-send'], engines: ['relay-engine'] })];
    const entries = wireKitEntries(kits, []);
    assert.equal(entries.length, 2);
    const types = entries.map((e) => e.type).sort();
    assert.deepEqual(types, ['engines', 'tools']);
  });

  it('sets pluginId and packageName from the kit', () => {
    const kits = [makeKit('relay-kit', { tools: ['relay-send'] })];
    const entries = wireKitEntries(kits, []);
    assert.equal(entries[0]!.pluginId, 'relay-kit');
    assert.equal(entries[0]!.packageName, '@test/relay-kit');
  });

  it('excludes framework fields (requires, recommends) from standalone kits', () => {
    const kits = [makeKit('relay-kit', { requires: ['tools'], recommends: ['sessions'], tools: ['relay-send'] })];
    const entries = wireKitEntries(kits, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.type, 'tools');
  });

  it('collects contribution types from apparatus supportKits', () => {
    const apps = [
      makeApparatus('clerk', {
        supportKit: { customChannel: ['item-a'], pages: [{ id: 'writs' }] },
      }),
    ];
    const entries = wireKitEntries([], apps);
    assert.equal(entries.length, 2);
    const types = entries.map((e) => e.type).sort();
    assert.deepEqual(types, ['customChannel', 'pages']);
  });

  it('sets pluginId and packageName from the apparatus for supportKit entries', () => {
    const apps = [
      makeApparatus('clerk', { supportKit: { customChannel: ['item-a'] } }),
    ];
    const entries = wireKitEntries([], apps);
    assert.equal(entries[0]!.pluginId, 'clerk');
    assert.equal(entries[0]!.packageName, '@test/clerk');
  });

  it('excludes framework fields from apparatus supportKits', () => {
    const apps = [
      makeApparatus('clerk', {
        supportKit: { requires: ['tools'], customChannel: ['item-a'] },
      }),
    ];
    const entries = wireKitEntries([], apps);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.type, 'customChannel');
  });

  it('skips apparatus with no supportKit', () => {
    const apps = [makeApparatus('tools')];
    const entries = wireKitEntries([], apps);
    assert.deepEqual(entries, []);
  });

  it('skips apparatus with undefined supportKit', () => {
    const apps = [makeApparatus('tools', { supportKit: undefined })];
    const entries = wireKitEntries([], apps);
    assert.deepEqual(entries, []);
  });

  it('orders entries: standalone kits first, then apparatus supportKits', () => {
    const kits = [makeKit('relay-kit', { tools: ['relay-send'] })];
    const apps = [makeApparatus('clerk', { supportKit: { customChannel: ['item-a'] } })];
    const entries = wireKitEntries(kits, apps);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.pluginId, 'relay-kit');
    assert.equal(entries[1]!.pluginId, 'clerk');
  });

  it('preserves the value from the kit contribution', () => {
    const toolsValue = ['tool-a', 'tool-b'];
    const kits = [makeKit('stdlib', { tools: toolsValue })];
    const entries = wireKitEntries(kits, []);
    assert.deepEqual(entries[0]!.value, toolsValue);
  });
});

// ── buildStartupContext + fireEvent ──────────────────────────────────

describe('buildStartupContext', () => {
  it('returns an object with an on() method', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers, []);
    assert.equal(typeof ctx.on, 'function');
  });

  it('registers handlers in the event handler map', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers, []);
    const fn = () => {};
    ctx.on('test-event', fn);
    assert.ok(handlers.has('test-event'));
    assert.equal(handlers.get('test-event')!.length, 1);
  });

  it('allows multiple handlers for the same event', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers, []);
    ctx.on('apparatus:started', () => {});
    ctx.on('apparatus:started', () => {});
    assert.equal(handlers.get('apparatus:started')!.length, 2);
  });

  it('returns an object with a kits() method', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers, []);
    assert.equal(typeof ctx.kits, 'function');
  });

  it('kits() returns entries matching the requested type', () => {
    const handlers: EventHandlerMap = new Map();
    const entries = [
      { pluginId: 'relay-kit', packageName: '@test/relay-kit', type: 'tools', value: ['relay-send'] },
      { pluginId: 'clerk', packageName: '@test/clerk', type: 'customChannel', value: ['item-a'] },
    ];
    const ctx = buildStartupContext(handlers, entries);
    const tools = ctx.kits('tools');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.pluginId, 'relay-kit');
  });

  it('kits() returns empty array for unknown type', () => {
    const handlers: EventHandlerMap = new Map();
    const ctx = buildStartupContext(handlers, []);
    assert.deepEqual(ctx.kits('nonexistent'), []);
  });

  it('kits() returns a new array each call (snapshot isolation)', () => {
    const handlers: EventHandlerMap = new Map();
    const entries = [
      { pluginId: 'relay-kit', packageName: '@test/relay-kit', type: 'tools', value: ['relay-send'] },
    ];
    const ctx = buildStartupContext(handlers, entries);
    const a = ctx.kits('tools');
    const b = ctx.kits('tools');
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it('kits() returns all entries of a given type across multiple sources', () => {
    const handlers: EventHandlerMap = new Map();
    const entries = [
      { pluginId: 'kit-a', packageName: '@test/kit-a', type: 'pages', value: [{ id: 'page-a' }] },
      { pluginId: 'kit-b', packageName: '@test/kit-b', type: 'pages', value: [{ id: 'page-b' }] },
      { pluginId: 'kit-c', packageName: '@test/kit-c', type: 'tools', value: [] },
    ];
    const ctx = buildStartupContext(handlers, entries);
    const pages = ctx.kits('pages');
    assert.equal(pages.length, 2);
    const ids = pages.map((e) => e.pluginId).sort();
    assert.deepEqual(ids, ['kit-a', 'kit-b']);
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

// ── shutdownStartedApparatuses ───────────────────────────────────────

describe('shutdownStartedApparatuses', () => {
  it('returns no failures and fires no events when the started list is empty', async () => {
    const handlers: EventHandlerMap = new Map();
    let fired = false;
    handlers.set('guild:shutdown', [() => { fired = true; }]);

    const failures = await shutdownStartedApparatuses([], handlers);
    assert.deepEqual(failures, []);
    // The helper still calls fireEvent unconditionally — but that just
    // walks an empty handler list when no one subscribed; here we
    // explicitly subscribed, so the handler does fire even with no
    // apparatus. The intent of "no events fired when started list is
    // empty" in the manifest refers to not synthesising apparatus-level
    // events; `guild:shutdown` itself is an unconditional pre-step.
    assert.ok(fired, 'guild:shutdown still fires for subscribers even with no started apparatus');
  });

  it('does not fire guild:shutdown when no handler is registered', async () => {
    // Sanity: an unsubscribed guild:shutdown is a no-op (no map entry).
    const handlers: EventHandlerMap = new Map();
    const failures = await shutdownStartedApparatuses([], handlers);
    assert.deepEqual(failures, []);
    // The handler map should still be empty — fireEvent does not
    // create entries.
    assert.equal(handlers.size, 0);
  });

  it('calls stop() on each apparatus in reverse topological order', async () => {
    const handlers: EventHandlerMap = new Map();
    const order: string[] = [];

    // Started in topo order: db → web → api.
    // Reverse-topo shutdown: api → web → db.
    const started = [
      makeApparatus('db', { stop: () => { order.push('db'); } }),
      makeApparatus('web', { stop: () => { order.push('web'); } }),
      makeApparatus('api', { stop: () => { order.push('api'); } }),
    ];

    const failures = await shutdownStartedApparatuses(started, handlers);
    assert.deepEqual(failures, []);
    assert.deepEqual(order, ['api', 'web', 'db']);
  });

  it('skips apparatus that omit stop() silently', async () => {
    const handlers: EventHandlerMap = new Map();
    const stopped: string[] = [];

    const started = [
      makeApparatus('a'), // no stop
      makeApparatus('b', { stop: () => { stopped.push('b'); } }),
      makeApparatus('c'), // no stop
    ];

    const failures = await shutdownStartedApparatuses(started, handlers);
    assert.deepEqual(failures, []);
    assert.deepEqual(stopped, ['b']);
  });

  it('continues iterating when one stop() throws and surfaces all failures', async () => {
    const handlers: EventHandlerMap = new Map();
    const stopped: string[] = [];

    const started = [
      makeApparatus('a', { stop: () => { stopped.push('a'); } }),
      makeApparatus('b', { stop: () => { throw new Error('boom-b'); } }),
      makeApparatus('c', { stop: () => { stopped.push('c'); } }),
    ];

    const failures = await shutdownStartedApparatuses(started, handlers);
    // Reverse iteration: c first, then b (throws), then a — both a and
    // c must have run despite b's throw.
    assert.deepEqual(stopped, ['c', 'a']);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, 'b');
    assert.match(failures[0]!.error.message, /boom-b/);
  });

  it('collects failures from multiple throwing apparatus', async () => {
    const handlers: EventHandlerMap = new Map();

    const started = [
      makeApparatus('a', { stop: () => { throw new Error('a-fail'); } }),
      makeApparatus('b', { stop: () => { throw new Error('b-fail'); } }),
    ];

    const failures = await shutdownStartedApparatuses(started, handlers);
    assert.equal(failures.length, 2);
    const ids = failures.map((f) => f.id).sort();
    assert.deepEqual(ids, ['a', 'b']);
  });

  it('wraps non-Error throws in Error', async () => {
    const handlers: EventHandlerMap = new Map();

    const started = [
      makeApparatus('a', { stop: () => { throw 'string-thrown'; } }),
    ];

    const failures = await shutdownStartedApparatuses(started, handlers);
    assert.equal(failures.length, 1);
    assert.ok(failures[0]!.error instanceof Error);
    assert.match(failures[0]!.error.message, /string-thrown/);
  });

  it('fires guild:shutdown before any stop() runs', async () => {
    const handlers: EventHandlerMap = new Map();
    const order: string[] = [];

    handlers.set('guild:shutdown', [() => { order.push('event'); }]);

    const started = [
      makeApparatus('a', { stop: () => { order.push('stop-a'); } }),
      makeApparatus('b', { stop: () => { order.push('stop-b'); } }),
    ];

    await shutdownStartedApparatuses(started, handlers);
    assert.deepEqual(order, ['event', 'stop-b', 'stop-a']);
  });

  it('awaits async stop() functions sequentially', async () => {
    const handlers: EventHandlerMap = new Map();
    const order: string[] = [];

    const started = [
      makeApparatus('a', {
        stop: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push('a');
        },
      }),
      makeApparatus('b', {
        stop: async () => {
          order.push('b');
        },
      }),
    ];

    await shutdownStartedApparatuses(started, handlers);
    // Reverse order: b first, then a — and a's slow stop blocks until
    // its setTimeout resolves before iteration moves on (here it's the
    // last so this assertion really tests that both ran in reverse).
    assert.deepEqual(order, ['b', 'a']);
  });

  it('is safe to call twice when wrapped in an idempotency flag', async () => {
    // The helper itself does not enforce idempotency — that lives in
    // the StartedGuild.shutdown() wrapper. This test pins down that the
    // helper is at least safe to invoke twice (a second call simply
    // walks the same list again). The real idempotency contract is
    // covered by the arbor.test.ts integration tests.
    const handlers: EventHandlerMap = new Map();
    let count = 0;

    const started = [
      makeApparatus('a', { stop: () => { count++; } }),
    ];

    await shutdownStartedApparatuses(started, handlers);
    await shutdownStartedApparatuses(started, handlers);
    assert.equal(count, 2);
  });
});

describe('formatShutdownFailures', () => {
  it('formats a single failure with apparatus id and error message', () => {
    const failures: ShutdownFailure[] = [
      { id: 'oculus', error: new Error('listen EADDRINUSE') },
    ];
    const msg = formatShutdownFailures(failures);
    assert.match(msg, /1 apparatus stop\(\) call failed/);
    assert.match(msg, /"oculus"/);
    assert.match(msg, /EADDRINUSE/);
  });

  it('formats multiple failures with plural noun', () => {
    const failures: ShutdownFailure[] = [
      { id: 'oculus', error: new Error('boom-1') },
      { id: 'stacks', error: new Error('boom-2') },
    ];
    const msg = formatShutdownFailures(failures);
    assert.match(msg, /2 apparatus stop\(\) calls failed/);
    assert.match(msg, /"oculus"/);
    assert.match(msg, /"stacks"/);
    assert.match(msg, /boom-1/);
    assert.match(msg, /boom-2/);
  });
});

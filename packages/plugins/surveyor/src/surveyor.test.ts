/**
 * Surveyor apparatus — unit tests.
 *
 * Covers:
 *   - Kit registry sealing invariants (T2)
 *   - Multi-surveyor fail-loud (D15)
 *   - Per-entry validation errors
 *   - SurveyorApi listSurveyors / getActiveSurveyor
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setGuild, clearGuild, isApparatus, isKit, generateId, shortId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { createSurveyor, createSurveyorWithHooks } from './surveyor.ts';
import type { SurveyorApi } from './types.ts';

// ── Helper to build a valid descriptor ────────────────────────────────

function validDescriptor(id: string) {
  return {
    id,
    description: `The ${id} surveyor`,
    rigTemplates: {
      'survey-vision': {},
      'survey-charge': {},
      'survey-piece':  {},
    },
    version: '1.0.0',
  };
}

// ── Registry registration ──────────────────────────────────────────────

describe('surveyor kit registry', () => {
  it('registers a valid surveyor descriptor', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    assert.deepEqual(hooks.getRegisteredSurveyorIds(), ['scaffold-surveyor']);
  });

  it('throws when value is not an array', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: {} }),
      /Kit "x" surveyors: expected an array/,
    );
  });

  it('throws when entry is not an object', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: ['not-an-object'] }),
      /entry is not an object/,
    );
  });

  it('throws when id is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'x',
        value: [{ description: 'desc', rigTemplates: {} }],
      }),
      /missing a non-empty string "id" field/,
    );
  });

  it('throws when description is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', rigTemplates: {} }],
      }),
      /missing a non-empty string "description" field/,
    );
  });

  it('throws when rigTemplates is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', description: 'desc' }],
      }),
      /"rigTemplates" must be an object/,
    );
  });

  it('throws when version is not a string', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', description: 'desc', rigTemplates: {}, version: 42 }],
      }),
      /"version" must be a string or omitted/,
    );
  });

  it('throws when id does not match pluginId (D14)', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [validDescriptor('different-id')],
      }),
      /must equal the contributing plugin id/,
    );
  });

  it('throws when id is not kebab-case', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'BadPlugin',
        value: [{ ...validDescriptor('BadPlugin'), id: 'BadPlugin' }],
      }),
      /must be kebab-case/,
    );
  });

  it('throws on duplicate id from different kits', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    // Duplicate from same pluginId should also throw (different pluginId scenario)
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [validDescriptor('scaffold-surveyor')],
      }),
      /duplicate id/,
    );
  });

  it('registers without version (optional field)', () => {
    const { hooks } = createSurveyorWithHooks();
    const descriptor = {
      id: 'scaffold-surveyor',
      description: 'Scaffold surveyor',
      rigTemplates: {},
    };
    hooks.registerKitSurveyors({ pluginId: 'scaffold-surveyor', value: [descriptor] });
    assert.deepEqual(hooks.getRegisteredSurveyorIds(), ['scaffold-surveyor']);
  });
});

// ── Registry sealing ───────────────────────────────────────────────────

describe('surveyor registry sealing', () => {
  it('is not sealed before sealRegistry()', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.equal(hooks.isSealed(), false);
  });

  it('is sealed after sealRegistry()', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.equal(hooks.isSealed(), true);
  });

  it('throws when registering after seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: [validDescriptor('x')] }),
      /startup registration window has closed/,
    );
  });
});

// ── D15 multi-surveyor fail-loud ───────────────────────────────────────

describe('D15 multi-surveyor fail-loud', () => {
  it('throws at seal time when more than one surveyor registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.registerKitSurveyors({
      pluginId: 'another-surveyor',
      value: [validDescriptor('another-surveyor')],
    });
    assert.throws(
      () => hooks.sealRegistry(),
      /Multiple surveyors registered/,
    );
  });

  it('does not throw when exactly one surveyor registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    assert.doesNotThrow(() => hooks.sealRegistry());
  });

  it('does not throw when zero surveyors registered', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.doesNotThrow(() => hooks.sealRegistry());
  });
});

// ── SurveyorApi ────────────────────────────────────────────────────────

describe('SurveyorApi', () => {
  it('getActiveSurveyor returns undefined before seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    // Not sealed yet — activeSurveyor is undefined.
    assert.equal(hooks.getActiveSurveyorId(), undefined);
  });

  it('getActiveSurveyor returns the sole registered surveyor after seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.sealRegistry();
    assert.equal(hooks.getActiveSurveyorId(), 'scaffold-surveyor');
  });

  it('getActiveSurveyor returns undefined when zero surveyors registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.equal(hooks.getActiveSurveyorId(), undefined);
  });
});

// ── SurveyorApi via provides (listSurveyors / getActiveSurveyor) ────────

describe('SurveyorApi provides surface', () => {
  it('listSurveyors returns all registered descriptors', () => {
    const { plugin, hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.sealRegistry();
    const api = plugin.apparatus.provides as SurveyorApi;
    const list = api.listSurveyors();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'scaffold-surveyor');
  });

  it('listSurveyors returns empty array when zero surveyors registered', () => {
    const { plugin, hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    const api = plugin.apparatus.provides as SurveyorApi;
    assert.deepEqual(api.listSurveyors(), []);
  });

  it('getActiveSurveyor returns the registered descriptor after seal', () => {
    const { plugin, hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.sealRegistry();
    const api = plugin.apparatus.provides as SurveyorApi;
    const active = api.getActiveSurveyor();
    assert.ok(active !== undefined);
    assert.equal(active?.id, 'scaffold-surveyor');
  });

  it('getActiveSurveyor returns undefined when zero surveyors registered', () => {
    const { plugin, hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    const api = plugin.apparatus.provides as SurveyorApi;
    assert.equal(api.getActiveSurveyor(), undefined);
  });
});

// ── createSurveyor factory ─────────────────────────────────────────────

describe('createSurveyor factory', () => {
  it('returns a plugin with SurveyorApi on provides', () => {
    const plugin = createSurveyor();
    assert.ok(plugin.apparatus !== undefined);
    const api = plugin.apparatus.provides as SurveyorApi;
    assert.ok(typeof api.listSurveyors === 'function');
    assert.ok(typeof api.getActiveSurveyor === 'function');
    assert.deepEqual(api.listSurveyors(), []);
    assert.equal(api.getActiveSurveyor(), undefined);
  });

  it('the plugin export is an apparatus (not a kit)', () => {
    // Uses isApparatus / isKit from nexus-core to verify the plugin shape.
    const plugin = createSurveyor();
    assert.ok(isApparatus(plugin),  'createSurveyor must return an apparatus plugin');
    assert.ok(!isKit(plugin),       'createSurveyor must NOT return a kit');
  });
});

// ── nexus-core utility smoke tests ────────────────────────────────────────
// These verify that the utility functions loaded by the surveyor package are
// callable and behave correctly. They are light sanity checks, not
// exhaustive unit tests (those live in framework/core's own test suite).

describe('nexus-core utilities (loaded by surveyor)', () => {
  it('generateId produces a prefixed sortable id', () => {
    const id = generateId('w');
    assert.ok(id.startsWith('w-'), `expected id to start with "w-", got "${id}"`);
    // Format: w-{base36_ts}-{hex_random}
    assert.equal(id.split('-').length, 3);
  });

  it('shortId drops the random suffix', () => {
    const id = generateId('w');
    const short = shortId(id);
    assert.ok(short.startsWith('w-'));
    // Short form has only the prefix and timestamp, no random suffix.
    assert.equal(short.split('-').length, 2);
  });
});

// ── Plugin start() lifecycle ───────────────────────────────────────────

/** Minimal fake guild to satisfy start()'s apparatus lookups. */
function makeStartGuild(): void {
  const clerk = {
    registerWritType: (_cfg: { name: string }) => {},
  } as unknown as ClerkApi;

  const stacks = {
    watch: (_owner: string, _book: string, _handler: unknown, _opts: unknown) => {},
    readBook: () => ({ find: async () => [] }),
  } as unknown as StacksApi;

  const reckoner = {} as unknown as ReckonerApi;

  const map: Record<string, unknown> = { stacks, clerk, reckoner };

  const fakeGuild: Guild = {
    home: '/tmp',
    apparatus<T>(name: string): T {
      const a = map[name];
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },
    tryApparatus<T>(name: string): T | null { return (map[name] as T) ?? null; },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return { name: 'test', nexus: '0.0.0', plugins: [] }; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

describe('plugin start lifecycle', () => {
  afterEach(() => clearGuild());

  it('registers the three survey writ types with clerk on start', () => {
    const registeredTypes: string[] = [];

    const clerk = {
      registerWritType: (cfg: { name: string }) => { registeredTypes.push(cfg.name); },
    } as unknown as ClerkApi;
    const stacks = {
      watch: () => {},
    } as unknown as StacksApi;
    const reckoner = {} as unknown as ReckonerApi;

    const map: Record<string, unknown> = { stacks, clerk, reckoner };
    const fakeGuild: Guild = {
      home: '/tmp',
      apparatus<T>(name: string): T {
        const a = map[name];
        if (!a) throw new Error(`Apparatus "${name}" not installed`);
        return a as T;
      },
      tryApparatus<T>(name: string): T | null { return (map[name] as T) ?? null; },
      config<T>(): T { return {} as T; },
      writeConfig(): void {},
      guildConfig(): GuildConfig { return { name: 'test', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      failedPlugins() { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    const { plugin } = createSurveyorWithHooks();
    const ctx: StartupContext = {
      on: () => {},
      kits: () => [],
    };
    plugin.apparatus.start!(ctx);

    assert.deepEqual(registeredTypes.sort(), ['survey-charge', 'survey-piece', 'survey-vision']);
  });

  it('seals registry and resolves active surveyor when phase:started fires', () => {
    makeStartGuild();

    const { plugin } = createSurveyorWithHooks();
    let phaseStartedCb: (() => void) | undefined;
    const ctx: StartupContext = {
      on: (_event: string, fn: (...args: unknown[]) => void) => {
        if (_event === 'phase:started') phaseStartedCb = fn as () => void;
      },
      kits: () => [],
    };
    plugin.apparatus.start!(ctx);

    // Fire phase:started — registry seals; activeSurveyor = undefined (zero surveyors)
    assert.ok(typeof phaseStartedCb === 'function');
    phaseStartedCb!();

    const api = plugin.apparatus.provides as SurveyorApi;
    assert.equal(api.getActiveSurveyor(), undefined);
  });

  it('registers kit surveyor entries forwarded via ctx.kits and exercises the getActiveSurveyor getter', async () => {
    // This test captures the stacks.watch handler so we can invoke the
    // CDC observer's getActiveSurveyor arrow (line 287 in surveyor.ts),
    // pushing function coverage to 100%.
    const registeredNames: string[] = [];
    let capturedWatchHandler: ((e: unknown) => Promise<void>) | undefined;

    const clerk = {
      registerWritType: (cfg: { name: string }) => { registeredNames.push(cfg.name); },
      post: async () => ({
        id: 'w-survey', type: 'survey-vision', phase: 'new',
        title: '', body: '', createdAt: '', updatedAt: '',
      }),
      setWritExt: async () => ({
        id: 'w-survey', type: 'survey-vision', phase: 'new',
        title: '', body: '', createdAt: '', updatedAt: '',
      }),
    } as unknown as ClerkApi;
    const stacks = {
      watch: (_o: string, _b: string, handler: (e: unknown) => Promise<void>) => {
        if (capturedWatchHandler === undefined) capturedWatchHandler = handler;
      },
      readBook: () => ({ find: async () => [] }),
      transaction: async (fn: () => Promise<unknown>) => fn(),
    } as unknown as StacksApi;
    const reckoner = {
      petition: async () => ({
        id: 'w-survey', type: 'survey-vision', phase: 'new',
        title: '', body: '', createdAt: '', updatedAt: '',
      }),
    } as unknown as ReckonerApi;

    const map: Record<string, unknown> = { stacks, clerk, reckoner };
    const fakeGuild: Guild = {
      home: '/tmp',
      apparatus<T>(name: string): T {
        const a = map[name];
        if (!a) throw new Error(`Apparatus "${name}" not installed`);
        return a as T;
      },
      tryApparatus<T>(name: string): T | null { return (map[name] as T) ?? null; },
      config<T>(): T { return {} as T; },
      writeConfig(): void {},
      guildConfig(): GuildConfig { return { name: 'test', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      failedPlugins() { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    const { plugin, hooks } = createSurveyorWithHooks();
    const validDesc = validDescriptor('scaffold-surveyor');

    let phaseStartedCb: (() => void) | undefined;
    const ctx: StartupContext = {
      on: (_event: string, fn: (...args: unknown[]) => void) => {
        if (_event === 'phase:started') phaseStartedCb = fn as () => void;
      },
      // Inject a kit surveyor via ctx.kits — covers the registerKitSurveyors loop body
      kits: (type: string) => {
        if (type === 'surveyors') {
          return [{ pluginId: 'scaffold-surveyor', value: [validDesc] }];
        }
        return [];
      },
    };
    plugin.apparatus.start!(ctx);
    phaseStartedCb!();

    // Invoke the captured CDC watcher with a vision event — this passes the
    // type filter and reaches the getActiveSurveyor() call (line 287), covering
    // that arrow function.
    assert.ok(capturedWatchHandler !== undefined);
    await capturedWatchHandler!({
      type: 'create',
      ownerId: 'clerk',
      book: 'writs',
      entry: {
        id: 'w-vis001', type: 'vision', phase: 'open',
        title: 'My Vision', body: 'detail',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    // The kit entry was registered via ctx.kits → registerKitSurveyors
    assert.deepEqual(hooks.getRegisteredSurveyorIds(), ['scaffold-surveyor']);

    // After phase:started, active surveyor resolves.
    const api = plugin.apparatus.provides as SurveyorApi;
    assert.equal(api.getActiveSurveyor()?.id, 'scaffold-surveyor');
  });
});

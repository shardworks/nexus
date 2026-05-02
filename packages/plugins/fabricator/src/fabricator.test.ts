/**
 * Fabricator — unit tests.
 *
 * Tests engine design registration from kits and apparatus supportKits,
 * and FabricatorApi.getEngineDesign() lookup. Uses a mock guild() singleton
 * to simulate the plugin environment.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  KitEntry,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import {
  createFabricator,
  type FabricatorApi,
  type EngineDesign,
} from './fabricator.ts';

// ── Test helpers ──────────────────────────────────────────────────────

/** Create a minimal valid engine design for testing. */
function mockEngine(id: string): EngineDesign {
  return {
    id,
    async run(_givens, _ctx) {
      return { status: 'completed', yields: null };
    },
  };
}

/** Build a mock LoadedKit with engine contributions. */
function mockKit(id: string, engines: Record<string, unknown>): LoadedKit {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    kit: { engines },
  };
}

/** Build a mock LoadedApparatus with optional supportKit engines. */
function mockApparatus(
  id: string,
  supportKitEngines?: Record<string, unknown>,
): LoadedApparatus {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    apparatus: {
      start() {},
      ...(supportKitEngines ? { supportKit: { engines: supportKitEngines } } : {}),
    },
  };
}

/** Wire a mock Guild into the singleton. */
function wireGuild(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];

  const mockGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() {},
    guildConfig() {
      return { name: 'test', nexus: '0.0.0', workshops: {}, plugins: [] };
    },
    kits() { return [...kits]; },
    apparatuses() { return [...apparatuses]; },
    startupWarnings() { return []; },
  };

  setGuild(mockGuild);
}

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[]): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

/**
 * Build a StartupContext that captures event subscriptions.
 * Returns both the context and a fire() function to trigger events.
 */
function buildTestContext(kitEntries: KitEntry[] = []): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();

  const ctx: StartupContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    kits(type: string): KitEntry[] { return [...kitEntries.filter(e => e.type === type)]; },
  };

  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }

  return { ctx, fire };
}

/** Start the Fabricator and return its API. */
function startFabricator(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
}): { api: FabricatorApi } {
  wireGuild(opts);
  const kitEntries = buildKitEntries(opts.kits ?? [], opts.apparatuses ?? []);

  const plugin = createFabricator();
  const api = ('apparatus' in plugin ? plugin.apparatus.provides : null) as FabricatorApi;
  assert.ok(api, 'Fabricator must expose provides');

  const { ctx } = buildTestContext(kitEntries);
  if ('apparatus' in plugin) {
    plugin.apparatus.start(ctx);
  }

  return { api };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Fabricator', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('getEngineDesign()', () => {
    it('returns undefined for an unknown engine ID', () => {
      const { api } = startFabricator({});
      assert.equal(api.getEngineDesign('nonexistent'), undefined);
    });

    it('finds an engine registered from a kit', () => {
      const engine = mockEngine('draft');
      const kit = mockKit('my-kit', { draft: engine });
      const { api } = startFabricator({ kits: [kit] });

      const found = api.getEngineDesign('draft');
      assert.ok(found, 'engine should be found');
      assert.equal(found.id, 'draft');
      assert.equal(found, engine);
    });

    it('registers engines from multiple kits', () => {
      const alpha = mockEngine('alpha');
      const beta = mockEngine('beta');
      const { api } = startFabricator({
        kits: [
          mockKit('kit-a', { alpha }),
          mockKit('kit-b', { beta }),
        ],
      });

      assert.equal(api.getEngineDesign('alpha'), alpha);
      assert.equal(api.getEngineDesign('beta'), beta);
    });

    it('throws when two kits contribute the same engine-design id (kit-vs-kit collision is fatal)', () => {
      const engine1 = mockEngine('draft');
      const engine2 = mockEngine('draft');
      assert.throws(
        () =>
          startFabricator({
            kits: [
              mockKit('kit-1', { draft: engine1 }),
              mockKit('kit-2', { draft: engine2 }),
            ],
          }),
        (err: Error) => {
          // Error must name both contributing plugins and the conflicting engine-design id.
          return (
            /engines/.test(err.message) &&
            /draft/.test(err.message) &&
            /kit-1/.test(err.message) &&
            /kit-2/.test(err.message)
          );
        },
        'kit-vs-kit engine-design collision must throw and name both plugins + the engine id',
      );
    });

    it('registers engines from apparatus supportKit (via Wire phase)', () => {
      const engine = mockEngine('implement');
      const app = mockApparatus('my-apparatus', { implement: engine });

      const { api } = startFabricator({ apparatuses: [app] });

      const found = api.getEngineDesign('implement');
      assert.ok(found, 'engine should be found');
      assert.equal(found.id, 'implement');
      assert.equal(found, engine);
    });

    it('skips entries missing the id field silently', () => {
      const kit = mockKit('messy-kit', {
        noId: { run: async () => ({ status: 'completed', yields: null }) },
      });
      // Should not throw
      const { api } = startFabricator({ kits: [kit] });
      assert.equal(api.getEngineDesign('noId'), undefined);
    });

    it('skips entries missing the run field silently', () => {
      const kit = mockKit('messy-kit', {
        noRun: { id: 'draft' },
      });
      const { api } = startFabricator({ kits: [kit] });
      assert.equal(api.getEngineDesign('draft'), undefined);
    });

    it('skips null and primitive entries silently, keeps valid ones', () => {
      const valid = mockEngine('valid');
      const kit = mockKit('messy-kit', {
        a: null,
        b: 'not-an-engine',
        c: 42,
        d: valid,
      });
      const { api } = startFabricator({ kits: [kit] });

      assert.equal(api.getEngineDesign('valid'), valid);
      assert.equal(api.getEngineDesign('a'), undefined);
    });

    it('ignores a kit with no engines field', () => {
      const kit: LoadedKit = {
        packageName: '@test/no-engines',
        id: 'no-engines',
        version: '0.0.0',
        kit: {},
      };
      // Should not throw
      const { api } = startFabricator({ kits: [kit] });
      assert.equal(api.getEngineDesign('anything'), undefined);
    });

    it('ignores an apparatus with no supportKit', () => {
      const app = mockApparatus('bare-apparatus');
      // Should not throw
      const { api } = startFabricator({ apparatuses: [app] });
      assert.equal(api.getEngineDesign('anything'), undefined);
    });

    it('ignores an apparatus supportKit with no engines field', () => {
      const app: LoadedApparatus = {
        packageName: '@test/bare',
        id: 'bare',
        version: '0.0.0',
        apparatus: {
          start() {},
          supportKit: {},
        },
      };
      // Should not throw
      const { api } = startFabricator({ apparatuses: [app] });
      assert.equal(api.getEngineDesign('anything'), undefined);
    });

  });

  describe('listEngineDesigns()', () => {
    it('returns empty array before registering anything', () => {
      const { api } = startFabricator({});
      const result = api.listEngineDesigns();
      assert.deepEqual(result, []);
    });

    it('returns correct EngineDesignInfo for two designs from different plugins', () => {
      const engineA = mockEngine('alpha');
      const engineB = mockEngine('beta');
      const { api } = startFabricator({
        kits: [
          mockKit('plugin-a', { alpha: engineA }),
          mockKit('plugin-b', { beta: engineB }),
        ],
      });

      const result = api.listEngineDesigns();
      assert.equal(result.length, 2);

      const alpha = result.find((d) => d.id === 'alpha');
      assert.ok(alpha, 'alpha should be in list');
      assert.equal(alpha.pluginId, 'plugin-a');
      assert.equal(alpha.hasCollect, false);

      const beta = result.find((d) => d.id === 'beta');
      assert.ok(beta, 'beta should be in list');
      assert.equal(beta.pluginId, 'plugin-b');
      assert.equal(beta.hasCollect, false);
    });

    it('reports hasCollect: true for engine with collect method', () => {
      const engineWithCollect: EngineDesign = {
        id: 'quick-engine',
        async run() { return { status: 'completed', yields: null }; },
        async collect() { return { result: 'done' }; },
      };
      const engineWithoutCollect = mockEngine('plain-engine');

      const { api } = startFabricator({
        kits: [
          mockKit('my-kit', { quick: engineWithCollect, plain: engineWithoutCollect }),
        ],
      });

      const result = api.listEngineDesigns();
      const quick = result.find((d) => d.id === 'quick-engine');
      assert.ok(quick, 'quick-engine should be in list');
      assert.equal(quick.hasCollect, true);

      const plain = result.find((d) => d.id === 'plain-engine');
      assert.ok(plain, 'plain-engine should be in list');
      assert.equal(plain.hasCollect, false);
    });

    it('throws on duplicate engine-design id during startup (kit-vs-kit collision is fatal)', () => {
      // Sibling of the throw-on-collision test in getEngineDesign() — pinned
      // here to keep listEngineDesigns()'s contract aligned: duplicate ids
      // never reach the list because startup refuses to complete.
      const engine1 = mockEngine('shared');
      const engine2 = mockEngine('shared');
      assert.throws(
        () =>
          startFabricator({
            kits: [
              mockKit('plugin-1', { e: engine1 }),
              mockKit('plugin-2', { e: engine2 }),
            ],
          }),
        (err: Error) => {
          return (
            /engines/.test(err.message) &&
            /shared/.test(err.message) &&
            /plugin-1/.test(err.message) &&
            /plugin-2/.test(err.message)
          );
        },
        'duplicate engine-design id must throw at startup',
      );
    });
  });
});

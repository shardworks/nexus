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
  };

  setGuild(mockGuild);
}

/**
 * Build a StartupContext that captures event subscriptions.
 * Returns both the context and a fire() function to trigger events.
 */
function buildTestContext(): {
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
  };

  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }

  return { ctx, fire };
}

/** Start the Fabricator and return its API and event-firing capability. */
function startFabricator(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
}): { api: FabricatorApi; fire: (event: string, ...args: unknown[]) => Promise<void> } {
  wireGuild(opts);

  const plugin = createFabricator();
  const api = ('apparatus' in plugin ? plugin.apparatus.provides : null) as FabricatorApi;
  assert.ok(api, 'Fabricator must expose provides');

  const { ctx, fire } = buildTestContext();
  if ('apparatus' in plugin) {
    plugin.apparatus.start(ctx);
  }

  return { api, fire };
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

    it('last-write-wins for duplicate engine IDs across kits', () => {
      const engine1 = mockEngine('draft');
      const engine2 = mockEngine('draft');
      const { api } = startFabricator({
        kits: [
          mockKit('kit-1', { draft: engine1 }),
          mockKit('kit-2', { draft: engine2 }),
        ],
      });

      assert.equal(api.getEngineDesign('draft'), engine2);
    });

    it('registers engines from apparatus supportKit via plugin:initialized', async () => {
      const engine = mockEngine('implement');
      const app = mockApparatus('my-apparatus', { implement: engine });

      const { api, fire } = startFabricator({});
      assert.equal(api.getEngineDesign('implement'), undefined);

      await fire('plugin:initialized', app);

      const found = api.getEngineDesign('implement');
      assert.ok(found, 'engine should be found after apparatus initialized');
      assert.equal(found.id, 'implement');
      assert.equal(found, engine);
    });

    it('ignores kits fired via plugin:initialized (kits are scanned at startup only)', async () => {
      const engine = mockEngine('late');
      const kit = mockKit('late-kit', { late: engine });

      const { api, fire } = startFabricator({});
      await fire('plugin:initialized', kit);

      // Kits fired after startup are intentionally skipped
      assert.equal(api.getEngineDesign('late'), undefined);
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

    it('ignores an apparatus with no supportKit', async () => {
      const app = mockApparatus('bare-apparatus');
      const { api, fire } = startFabricator({});
      // Should not throw
      await fire('plugin:initialized', app);
      assert.equal(api.getEngineDesign('anything'), undefined);
    });

    it('ignores an apparatus supportKit with no engines field', async () => {
      const app: LoadedApparatus = {
        packageName: '@test/bare',
        id: 'bare',
        version: '0.0.0',
        apparatus: {
          start() {},
          supportKit: {},
        },
      };
      const { api, fire } = startFabricator({});
      // Should not throw
      await fire('plugin:initialized', app);
      assert.equal(api.getEngineDesign('anything'), undefined);
    });

    it('handles engines from both kits and apparatus supportKits together', async () => {
      const kitEngine = mockEngine('kit-engine');
      const apparatusEngine = mockEngine('apparatus-engine');

      const { api, fire } = startFabricator({
        kits: [mockKit('my-kit', { kitEngine })],
      });
      await fire('plugin:initialized', mockApparatus('my-apparatus', { apparatusEngine }));

      assert.equal(api.getEngineDesign('kit-engine'), kitEngine);
      assert.equal(api.getEngineDesign('apparatus-engine'), apparatusEngine);
    });
  });
});

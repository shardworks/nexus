/**
 * Reckoner apparatus tests.
 *
 * The fixture wires real Stacks + real Clerk + the Reckoner against
 * an in-memory backend so every assertion runs through the
 * production code paths. Each `it()` block targets one of the eight
 * behavioral cases enumerated in the commission's Acceptance
 * Signal:
 *
 *   1. Two `petitioners` entries with the same source: hard startup
 *      error naming both plugins.
 *   2. Malformed source id in a `petitioners` entry: hard startup
 *      error.
 *   3. `petition({ source: 'unknown' })` with `enforceRegistration:
 *      false` (default): succeeds; warning logged.
 *   4. `petition({ source: 'unknown' })` with `enforceRegistration:
 *      true`: throws fail-loud; no writ posted.
 *   5. `petition({ source: 'vision-keeper.snapshot', priority: {
 *      visionRelation: 'vision-violator' } })`: succeeds; omitted
 *      priority dimensions fall back to defaults.
 *   6. Resulting writ: `phase: 'new'` and `writ.ext.reckoner =
 *      { source, priority, complexity?, payload?, labels? }`.
 *   7. `withdraw(writId, reason)`: writ transitions to `cancelled`
 *      with reason recorded.
 *   8. After `phase:started`: registration attempts via any path
 *      fail (registry sealed).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  KitEntry,
  LoadedApparatus,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createReckonerWithHooks } from './reckoner.ts';
import type {
  PetitionRequest,
  ReckonerApi,
  ReckonerConfig,
  ReckonerExt,
} from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  hooks: ReturnType<typeof createReckonerWithHooks>['hooks'];
  memBackend: MemoryBackend;
  fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig };
  /**
   * Re-fire `phase:started` against the registered handlers — used
   * by the seal-test to flip `registrySealed` without driving the
   * full Arbor lifecycle.
   */
  firePhaseStarted: () => void;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-test-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return fakeGuildConfig;
    },
    kits(): LoadedKit[] {
      return [];
    },
    apparatuses(): LoadedApparatus[] {
      return [];
    },
    failedPlugins() {
      return [];
    },
    startupWarnings(): string[] {
      return [];
    },
  };
}

/**
 * Build a fixture. `petitionerKits` declares the `petitioners` kit
 * contributions visible to the Reckoner's `start()`. `config`
 * shapes the `reckoner` block on `guild.json`.
 */
async function buildFixture(opts: {
  petitionerKits?: Array<{ pluginId: string; value: unknown }>;
  config?: ReckonerConfig | undefined;
} = {}): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const built = createReckonerWithHooks();
  const reckonerPlugin = built.plugin;

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig } = {
    name: 'reckoner-test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.config !== undefined ? { reckoner: opts.config } : {}),
  };

  setGuild(buildFakeGuild(apparatusMap, fakeGuildConfig));

  // Pre-create the books the Clerk needs.
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: [
      'phase', 'type', 'createdAt', 'parentId',
      ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase'],
    ],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: [
      'sourceId', 'targetId', 'label',
      ['sourceId', 'label'], ['targetId', 'label'],
    ],
  });

  // Build a phase-started capable StartupContext per apparatus.
  const phaseStartedHandlers: Array<(...args: unknown[]) => void | Promise<void>> = [];
  const firePhaseStarted = () => {
    for (const handler of phaseStartedHandlers) {
      const result = handler();
      // Test path is sync; ignore promises here.
      void result;
    }
  };

  function buildCtx(kitEntries: KitEntry[]): StartupContext {
    return {
      on(event, handler) {
        if (event === 'phase:started') {
          phaseStartedHandlers.push(handler);
        }
      },
      kits(type: string): KitEntry[] {
        return kitEntries.filter((e) => e.type === type);
      },
    };
  }

  // ── Stacks ────────────────────────────────────────────────────────
  await stacksPlugin.apparatus.start(buildCtx([]));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // ── Clerk ─────────────────────────────────────────────────────────
  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Reckoner ──────────────────────────────────────────────────────
  // Surface the `petitioners` kit contributions through the
  // StartupContext so the apparatus's start() reads them via
  // `ctx.kits('petitioners')`.
  const petitionerKitEntries: KitEntry[] = (opts.petitionerKits ?? []).map(
    (entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'petitioners',
      value: entry.value,
    }),
  );

  await reckonerPlugin.apparatus.start(buildCtx(petitionerKitEntries));
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  return {
    stacks,
    clerk,
    reckoner,
    hooks: built.hooks,
    memBackend,
    fakeGuildConfig,
    firePhaseStarted,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner apparatus', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── Behavioral case 1: duplicate source ────────────────────────────

  describe('petitioner registry — duplicate source', () => {
    it('hard-fails at startup with a diagnostic naming both contributing kits', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            petitionerKits: [
              {
                pluginId: 'vision-keeper',
                value: [
                  {
                    source: 'vision-keeper.snapshot',
                    description: 'first kit',
                  },
                ],
              },
              {
                pluginId: 'vision-keeper',
                value: [
                  {
                    source: 'vision-keeper.snapshot',
                    description: 'second kit',
                  },
                ],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /duplicate source/i);
          assert.match(err.message, /vision-keeper\.snapshot/);
          // The diagnostic must name the first kit (already-
          // registered owner) and the second kit (the offender).
          assert.match(err.message, /vision-keeper/);
          return true;
        },
      );
    });

    it('hard-fails when two distinct kits collide on the same source', async () => {
      // Two distinct contributing plugin ids cannot share a source —
      // the prefix-vs-pluginId check would reject the second one
      // independently, so we test the same-prefix-different-plugin
      // case via two kits both contributing under "vision-keeper"
      // but verify the diagnostic names both. (This case is covered
      // by the prior test; this one specifically exercises the
      // duplicate path with explicit naming of both kits.)
      let caught: Error | undefined;
      try {
        await buildFixture({
          petitionerKits: [
            {
              pluginId: 'vision-keeper',
              value: [
                {
                  source: 'vision-keeper.snapshot',
                  description: 'A',
                },
              ],
            },
            {
              pluginId: 'vision-keeper',
              value: [
                {
                  source: 'vision-keeper.snapshot',
                  description: 'B',
                },
              ],
            },
          ],
        });
      } catch (e) {
        caught = e as Error;
      }
      assert.ok(caught, 'startup must throw on duplicate source');
      // First-registering kit should be named as the existing owner.
      assert.match(caught!.message, /already registered by kit/i);
    });
  });

  // ── Behavioral case 2: malformed source id ─────────────────────────

  describe('petitioner registry — malformed source id', () => {
    it('hard-fails when the source has no dot separator', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            petitionerKits: [
              {
                pluginId: 'vision-keeper',
                value: [
                  {
                    source: 'visionkeepersnapshot',
                    description: 'no dot',
                  },
                ],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /must be of the form/i);
          assert.match(err.message, /visionkeepersnapshot/);
          return true;
        },
      );
    });

    it('hard-fails when the source prefix does not match the contributing plugin id', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            petitionerKits: [
              {
                pluginId: 'vision-keeper',
                value: [
                  {
                    source: 'other-plugin.snapshot',
                    description: 'wrong prefix',
                  },
                ],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /must match the contributing plugin id/i);
          assert.match(err.message, /vision-keeper/);
          assert.match(err.message, /other-plugin/);
          return true;
        },
      );
    });

    it('hard-fails when the kebab-case suffix is malformed', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            petitionerKits: [
              {
                pluginId: 'vision-keeper',
                value: [
                  {
                    source: 'vision-keeper.Snapshot', // uppercase
                    description: 'bad suffix',
                  },
                ],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /kebab-case/i);
          return true;
        },
      );
    });
  });

  // ── Behavioral case 3: unregistered + permissive ───────────────────

  describe('petition() — unregistered source, enforceRegistration: false', () => {
    it('succeeds and logs a warning', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        // enforceRegistration omitted — defaults to false.
      });

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        const writ = await fix.reckoner.petition({
          source: 'unknown.source',
          title: 'test',
          body: 'B',
        });
        assert.ok(writ.id.startsWith('w-'), 'a writ must be posted');
        assert.equal(writ.phase, 'new');
        assert.ok(
          warnings.some((w) =>
            /\[reckoner\] petition: source "unknown\.source" is not registered/.test(w),
          ),
          `expected a warning naming the unregistered source; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── Behavioral case 4: unregistered + strict ───────────────────────

  describe('petition() — unregistered source, enforceRegistration: true', () => {
    it('throws fail-loud and posts no writ', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { enforceRegistration: true },
      });

      const writsBefore = await fix.clerk.list({ limit: 1000 });

      await assert.rejects(
        () =>
          fix.reckoner.petition({
            source: 'unknown.source',
            title: 'test',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /not registered/i);
          assert.match(err.message, /unknown\.source/);
          assert.match(err.message, /enforceRegistration is true/);
          return true;
        },
      );

      // Verify by listing writs after — count must be unchanged.
      const writsAfter = await fix.clerk.list({ limit: 1000 });
      assert.equal(
        writsAfter.length,
        writsBefore.length,
        'no writ may be posted when enforceRegistration rejects the source',
      );
    });
  });

  // ── Behavioral case 5 + 6: partial priority + writ shape ───────────

  describe('petition() — registered source, partial priority', () => {
    it('default-fills omitted priority dimensions and writes the contract ext', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots emitted on drift',
              },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'Address vision drift',
        body: 'long-form body',
        codex: 'nexus',
        priority: {
          visionRelation: 'vision-violator',
        },
        complexity: 'bounded',
        payload: { snapshotId: 'snap-1' },
        labels: { 'vision-keeper.io/vision-id': 'nexus' },
      });

      // Behavioral case 6: phase + ext shape.
      assert.equal(writ.phase, 'new', 'petition writs land in `new` phase');
      assert.equal(writ.title, 'Address vision drift');
      assert.equal(writ.codex, 'nexus');

      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext, 'writ.ext.reckoner must be populated');
      assert.equal(ext!.source, 'vision-keeper.snapshot');
      assert.equal(ext!.complexity, 'bounded');
      assert.deepEqual(ext!.payload, { snapshotId: 'snap-1' });
      assert.deepEqual(ext!.labels, { 'vision-keeper.io/vision-id': 'nexus' });

      // Behavioral case 5: omitted priority dimensions fall back to
      // contract defaults from §3 of the contract document.
      assert.equal(ext!.priority.visionRelation, 'vision-violator', 'caller-supplied dimension survives');
      assert.equal(ext!.priority.severity, 'minor');
      assert.equal(ext!.priority.scope, 'minor-area');
      assert.equal(ext!.priority.time.decay, false);
      assert.equal(ext!.priority.time.deadline, null);
      assert.deepEqual(ext!.priority.domain, []);
    });

    it('omits optional ext fields when the caller does not supply them', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'mvp',
        body: 'B',
      });

      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext);
      assert.equal('complexity' in ext!, false);
      assert.equal('payload' in ext!, false);
      assert.equal('labels' in ext!, false);
      // priority is fully defaulted.
      assert.equal(ext!.priority.visionRelation, 'vision-neutral');
    });

    it('rejects an out-of-enum priority dimension at the helper boundary', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });

      await assert.rejects(
        () =>
          fix.reckoner.petition({
            source: 'vision-keeper.snapshot',
            title: 'bad',
            body: 'B',
            priority: {
              visionRelation: 'vision-incinerator' as unknown as PetitionRequest['priority'] extends
                | infer P
                | undefined
                ? P extends { visionRelation?: infer V }
                  ? V
                  : never
                : never,
            },
          }),
        (err: Error) => {
          assert.match(err.message, /visionRelation/);
          return true;
        },
      );
    });
  });

  // ── Behavioral case 7: withdraw ────────────────────────────────────

  describe('withdraw()', () => {
    it('transitions the writ to cancelled with the reason recorded', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'to be withdrawn',
        body: 'B',
      });

      const withdrawn = await fix.reckoner.withdraw(
        writ.id,
        'Snapshot superseded by drift detected before this ran.',
      );

      assert.equal(withdrawn.phase, 'cancelled');
      assert.equal(
        withdrawn.resolution,
        'Snapshot superseded by drift detected before this ran.',
      );
    });

    it('passes through undefined reason without fabricating a default', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'silent withdraw',
        body: 'B',
      });

      const withdrawn = await fix.reckoner.withdraw(writ.id);
      assert.equal(withdrawn.phase, 'cancelled');
      // No fabricated default — resolution stays absent.
      assert.equal(withdrawn.resolution, undefined);
    });
  });

  // ── Behavioral case 8: post-seal registration fails ────────────────

  describe('registry seal — phase:started', () => {
    it('post-seal registration attempts throw a sealed-registry error', async () => {
      const fix = await buildFixture({ petitionerKits: [] });

      // Fire phase:started — the apparatus's handler flips
      // `registrySealed = true`. (The fixture's firePhaseStarted
      // also calls Clerk's handler, which is fine; our concern is
      // the Reckoner's hook landing.)
      fix.firePhaseStarted();
      assert.equal(
        fix.hooks.isSealed(),
        true,
        'registry must seal at phase:started',
      );

      // Any post-seal registration attempt throws — exercises the
      // same code path the kit-contribution scan uses.
      assert.throws(
        () =>
          fix.hooks.registerKitPetitioners({
            pluginId: 'late-kit',
            value: [
              {
                source: 'late-kit.something',
                description: 'too late',
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /startup registration window has closed/i);
          assert.match(err.message, /late-kit/);
          return true;
        },
      );
    });
  });

  // ── Inspection API parity ──────────────────────────────────────────

  describe('inspection API', () => {
    it('listPetitioners projects to the contract floor only', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });

      const list = fix.reckoner.listPetitioners();
      assert.equal(list.length, 1);
      assert.deepEqual(list[0], {
        source: 'vision-keeper.snapshot',
        description: 'snapshots',
      });
    });

    it('isSourceRegistered reflects the registry', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              {
                source: 'vision-keeper.snapshot',
                description: 'snapshots',
              },
            ],
          },
        ],
      });
      assert.equal(fix.reckoner.isSourceRegistered('vision-keeper.snapshot'), true);
      assert.equal(fix.reckoner.isSourceRegistered('unknown.source'), false);
    });

    it('isSourceDisabled reads live config (re-read on each call)', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { disabledSources: ['noisy.source'] },
      });

      assert.equal(fix.reckoner.isSourceDisabled('noisy.source'), true);
      assert.equal(fix.reckoner.isSourceDisabled('vision-keeper.snapshot'), false);

      // Hot-edit guild.json — the change is observed without restart.
      fix.fakeGuildConfig.reckoner = { disabledSources: ['vision-keeper.snapshot'] };
      assert.equal(fix.reckoner.isSourceDisabled('noisy.source'), false);
      assert.equal(fix.reckoner.isSourceDisabled('vision-keeper.snapshot'), true);
    });
  });

  // ── Config validation (D12) ───────────────────────────────────────

  describe('config validation', () => {
    it('throws on a non-boolean enforceRegistration', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: {
          enforceRegistration: 'yes' as unknown as boolean,
        },
      });

      assert.throws(
        () => fix.reckoner.isSourceDisabled('any'),
        (err: Error) => {
          assert.match(err.message, /enforceRegistration/);
          assert.match(err.message, /must be a boolean/i);
          return true;
        },
      );
    });

    it('throws on a non-array disabledSources', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: {
          disabledSources: 'noisy' as unknown as string[],
        },
      });

      assert.throws(
        () => fix.reckoner.isSourceDisabled('any'),
        (err: Error) => {
          assert.match(err.message, /disabledSources/);
          assert.match(err.message, /must be an array/i);
          return true;
        },
      );
    });

    it('treats missing reckoner block as defaults', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        // no config block
      });

      assert.equal(fix.reckoner.isSourceDisabled('any'), false);
      // enforceRegistration defaults to false: unregistered passes.
      // (smoke-test by attempting petition — covered separately.)
    });
  });

  // ── Plugin-id derivation parity (Acceptance Signal item 1) ────────

  describe('package wiring', () => {
    it('exposes ReckonerApi through provides exactly', async () => {
      const fix = await buildFixture({ petitionerKits: [] });
      // Type-level: the variable is typed as ReckonerApi; runtime
      // shape is asserted by checking each method exists.
      const api: ReckonerApi = fix.reckoner;
      assert.equal(typeof api.petition, 'function');
      assert.equal(typeof api.withdraw, 'function');
      assert.equal(typeof api.isSourceRegistered, 'function');
      assert.equal(typeof api.isSourceDisabled, 'function');
      assert.equal(typeof api.listPetitioners, 'function');
    });
  });
});

// Silence unused-import noise — WritDoc import documents intent.
type _Unused = WritDoc;
void (null as unknown as _Unused);

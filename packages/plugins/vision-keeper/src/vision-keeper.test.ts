/**
 * Vision-keeper apparatus — per-case unit tests.
 *
 * Fixture mirrors `packages/plugins/reckoner/src/reckoner.test.ts`:
 * fake guild via `setGuild` / `clearGuild`, MemoryBackend stacks, real
 * Clerk, real Reckoner, vision-keeper under test, drive `phase:started`
 * at the end of the boot to seal the petitioner registry. No
 * Reckoner-stubbing — every assertion runs through the production
 * petition / withdraw paths (D18, D28).
 *
 * The assertions line up with the behavioral cases enumerated in the
 * commission's Acceptance Signal:
 *
 *   1. Drift petition produces a writ in `phase: 'new'` with the
 *      brief-default drift dimensions, the typed payload (with auto-
 *      filled `snapshotTimestamp`/`visionId`), the
 *      `vision-keeper.io/vision-id` label, and
 *      `ext.reckoner.source === 'vision-keeper.snapshot'`.
 *   2. Elaboration nudge does the same with the elaboration-default
 *      dimensions and complexity omitted.
 *   3. Explicit `superseded(visionId)` call withdraws the outstanding
 *      writ.
 *   4. Emitting on top of an outstanding petition auto-supersedes
 *      (prior writ ends `cancelled`, new writ posted in `new`).
 *   5. Per-call overrides for `severity` / `scope` / `complexity` /
 *      `codex` / `parentId` reach the resulting writ.
 *   6. Multi-vision label discrimination — two petitions with
 *      different visionIds carry different label values and the
 *      keeper's outstanding map tracks each independently.
 *   7. Kit-declaration round-trip — after `phase:started` the
 *      petitioner registry contains the vision-keeper.snapshot entry
 *      with the verbatim description.
 *   8. Decline-feedback relay handler reacts to a synthetic CDC
 *      payload representing a transition into `cancelled` for a
 *      vision-keeper.snapshot writ but not to the negative cases.
 */

import { describe, it, afterEach } from 'node:test';
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

import { createReckoner } from '@shardworks/reckoner-apparatus';
import type {
  PetitionerDescriptor,
  ReckonerApi,
  ReckonerExt,
} from '@shardworks/reckoner-apparatus';

import {
  DECLINE_RELAY_NAME,
  VISION_ID_LABEL_KEY,
  VISION_KEEPER_SOURCE,
  createVisionKeeper,
} from './index.ts';
import { __internal } from './vision-keeper.ts';
import type { VisionKeeperApi, VisionSnapshotPayload } from './types.ts';
import { createDeclineRelay, matchVisionKeeperDecline } from './decline-relay.ts';

// ── Fixture helpers ──────────────────────────────────────────────────

/** Read the apparatus's supportKit. The keeper has both `petitioners` and `relays`. */
function readSupportKit(plugin: { apparatus: { supportKit?: unknown } }): {
  petitioners: PetitionerDescriptor[];
  relayName: string;
} {
  const kit = plugin.apparatus.supportKit as
    | { petitioners?: unknown; relays?: unknown }
    | undefined;
  if (!kit) throw new Error('vision-keeper: supportKit missing');
  if (!Array.isArray(kit.petitioners) || kit.petitioners.length === 0) {
    throw new Error('vision-keeper: supportKit.petitioners missing');
  }
  if (!Array.isArray(kit.relays) || kit.relays.length === 0) {
    throw new Error('vision-keeper: supportKit.relays missing');
  }
  return {
    petitioners: kit.petitioners as PetitionerDescriptor[],
    relayName: (kit.relays[0] as { name: string }).name,
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  keeper: VisionKeeperApi;
  /** Manually re-fire `phase:started` against every registered handler. */
  firePhaseStarted: () => void;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/vision-keeper-test-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
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

async function buildFixture(): Promise<Fixture> {
  const memBackend = new MemoryBackend();

  const stacksPlugin = createStacksApparatus(memBackend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks plugin shape');

  const clerkPlugin = createClerk();
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk plugin shape');

  const reckonerPlugin = createReckoner();
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner plugin shape');

  const keeperPlugin = createVisionKeeper();
  if (!('apparatus' in keeperPlugin)) throw new Error('vision-keeper plugin shape');

  const apparatusMap = new Map<string, unknown>();
  const fakeGuildConfig: GuildConfig = {
    name: 'vision-keeper-test-guild',
    nexus: '0.0.0',
    plugins: [],
  };
  setGuild(buildFakeGuild(apparatusMap, fakeGuildConfig));

  // Pre-create the books the Clerk needs.
  memBackend.ensureBook(
    { ownerId: 'clerk', book: 'writs' },
    {
      indexes: [
        'phase',
        'type',
        'createdAt',
        'parentId',
        ['phase', 'type'],
        ['phase', 'createdAt'],
        ['parentId', 'phase'],
      ],
    },
  );
  memBackend.ensureBook(
    { ownerId: 'clerk', book: 'links' },
    {
      indexes: [
        'sourceId',
        'targetId',
        'label',
        ['sourceId', 'label'],
        ['targetId', 'label'],
      ],
    },
  );

  // Track phase:started handlers so the test can drive seal manually.
  const phaseStartedHandlers: Array<(...args: unknown[]) => void | Promise<void>> = [];
  const firePhaseStarted = () => {
    for (const handler of phaseStartedHandlers) {
      const result = handler();
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

  // Stacks
  await stacksPlugin.apparatus.start(buildCtx([]));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Clerk
  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Reckoner — wire vision-keeper's supportKit.petitioners through as
  // a KitEntry so the registration runs against the production code
  // path. We build the kit entries from the keeper plugin's
  // supportKit, mirroring what the real Wire phase does.
  const keeperSupport = readSupportKit(keeperPlugin);
  const petitionerKitEntries: KitEntry[] = [
    {
      pluginId: 'vision-keeper',
      packageName: '@shardworks/vision-keeper-apparatus',
      type: 'petitioners',
      value: keeperSupport.petitioners,
    },
  ];
  await reckonerPlugin.apparatus.start(buildCtx(petitionerKitEntries));
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  // Vision-keeper — start last; resolves the Reckoner handle.
  await keeperPlugin.apparatus.start(buildCtx([]));
  const keeper = keeperPlugin.apparatus.provides as VisionKeeperApi;
  apparatusMap.set('vision-keeper', keeper);

  // Seal by firing phase:started so the petitioner registry locks down.
  firePhaseStarted();

  return { stacks, clerk, reckoner, keeper, firePhaseStarted };
}

afterEach(() => clearGuild());

// ── Behavioral cases ─────────────────────────────────────────────────

describe('Vision-keeper apparatus', () => {
  // Case 1 + 7: drift petition produces correct writ; kit declaration
  // round-trips through the Reckoner registry.

  describe('submitDriftSnapshot()', () => {
    it('posts a writ in phase:new with the drift-default dimensions and the typed payload', async () => {
      const fix = await buildFixture();

      const before = new Date().toISOString();
      const writ = await fix.keeper.submitDriftSnapshot({
        visionId: 'product-vision',
        title: 'API drift',
        body: 'three calls instead of one',
        visionVsRealityDelta: { promised: 'one call', observed: 'three' },
        metricValues: { p95: 410 },
      });
      const after = new Date().toISOString();

      assert.equal(writ.phase, 'new');
      assert.equal(writ.title, 'API drift');
      assert.equal(writ.body, 'three calls instead of one');

      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext, 'writ.ext.reckoner must be populated');
      assert.equal(ext!.source, VISION_KEEPER_SOURCE);
      assert.equal(ext!.complexity, 'bounded');

      // Drift-default dimensions (D6).
      assert.equal(ext!.priority.visionRelation, 'vision-violator');
      assert.equal(ext!.priority.severity, 'serious');
      assert.equal(ext!.priority.scope, 'major-area');
      assert.equal(ext!.priority.time.decay, true);
      assert.equal(ext!.priority.time.deadline, null);
      assert.deepEqual(ext!.priority.domain, ['quality']);

      // Typed payload — keeper auto-fills `visionId` and timestamp.
      const payload = ext!.payload as VisionSnapshotPayload;
      assert.equal(payload.visionId, 'product-vision');
      assert.deepEqual(payload.visionVsRealityDelta, {
        promised: 'one call',
        observed: 'three',
      });
      assert.deepEqual(payload.metricValues, { p95: 410 });
      assert.ok(payload.snapshotTimestamp >= before);
      assert.ok(payload.snapshotTimestamp <= after);

      // Vision-id label is stamped.
      assert.deepEqual(ext!.labels, {
        [VISION_ID_LABEL_KEY]: 'product-vision',
      });
    });

    it('rejects an empty visionId fail-loud', async () => {
      const fix = await buildFixture();

      await assert.rejects(
        () =>
          fix.keeper.submitDriftSnapshot({
            visionId: '',
            title: 't',
            body: 'b',
            visionVsRealityDelta: null,
            metricValues: null,
          }),
        (err: Error) => {
          assert.match(err.message, /visionId is required/i);
          return true;
        },
      );
    });
  });

  // Case 2: elaboration nudge with elaboration-default dimensions and
  // complexity omitted.

  describe('submitElaborationNudge()', () => {
    it('posts a writ with the elaboration-default dimensions and omits complexity', async () => {
      const fix = await buildFixture();

      const writ = await fix.keeper.submitElaborationNudge({
        visionId: 'product-vision',
        title: 'Saved presets nudge',
        body: 'one-click reorder is unrealized',
        visionVsRealityDelta: { promised: 'one click', observed: 'no UI' },
        metricValues: { reorderRate: 0.04 },
      });

      assert.equal(writ.phase, 'new');
      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext);
      assert.equal(ext!.source, VISION_KEEPER_SOURCE);

      assert.equal(ext!.priority.visionRelation, 'vision-advancer');
      assert.equal(ext!.priority.severity, 'moderate');
      assert.equal(ext!.priority.scope, 'minor-area');
      assert.equal(ext!.priority.time.decay, false);
      assert.equal(ext!.priority.time.deadline, null);
      assert.deepEqual(ext!.priority.domain, ['feature']);

      // Elaboration: no complexity field by default.
      assert.equal('complexity' in ext!, false, 'complexity must be omitted on elaboration nudges');
    });
  });

  // Case 3: explicit superseded() call withdraws.

  describe('superseded()', () => {
    it('withdraws the outstanding petition for a vision', async () => {
      const fix = await buildFixture();

      const writ = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 't',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      const withdrawn = await fix.keeper.superseded(
        'v1',
        'drift was resolved out-of-band',
      );

      assert.ok(withdrawn, 'a writ must have been withdrawn');
      assert.equal(withdrawn!.id, writ.id);
      assert.equal(withdrawn!.phase, 'cancelled');
      assert.equal(withdrawn!.resolution, 'drift was resolved out-of-band');
    });

    it('returns null when there is no outstanding petition for the vision', async () => {
      const fix = await buildFixture();

      const result = await fix.keeper.superseded('absent-vision');
      assert.equal(result, null);
    });

    it('clears the outstanding-petition map so a re-emit does not auto-supersede', async () => {
      const fix = await buildFixture();
      // Emit, withdraw, re-emit. The re-emit must not look up a stale
      // entry and try to withdraw an already-cancelled writ.
      const first = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 't1',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      await fix.keeper.superseded('v1');
      const second = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 't2',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      assert.notEqual(first.id, second.id);
      // First writ stayed cancelled; second is new.
      const firstReread = await fix.clerk.show(first.id);
      assert.equal(firstReread.phase, 'cancelled');
      assert.equal(second.phase, 'new');
    });
  });

  // Case 4: auto-supersede when emitting over an outstanding petition.

  describe('auto-supersede on consecutive emits', () => {
    it('cancels the prior writ before posting the new one', async () => {
      const fix = await buildFixture();

      const first = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 'first',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      const second = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 'second',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      assert.notEqual(first.id, second.id);
      const firstReread = await fix.clerk.show(first.id);
      assert.equal(firstReread.phase, 'cancelled');
      assert.match(
        String(firstReread.resolution),
        /superseded by newer snapshot/i,
      );
      assert.equal(second.phase, 'new');
    });
  });

  // Case 5: per-call overrides reach the resulting writ.

  describe('per-call overrides', () => {
    it('caller-supplied severity / scope / complexity / codex / parentId reach the writ', async () => {
      const fix = await buildFixture();

      // Need a parent writ to reference via parentId.
      const parent = await fix.clerk.post({ title: 'parent', body: 'b' });

      const writ = await fix.keeper.submitDriftSnapshot({
        visionId: 'v1',
        title: 'override drift',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
        severity: 'critical',
        scope: 'whole-product',
        complexity: 'open-ended',
        codex: 'nexus',
        parentId: parent.id,
      });

      assert.equal(writ.codex, 'nexus');
      assert.equal(writ.parentId, parent.id);

      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext);
      assert.equal(ext!.priority.severity, 'critical');
      assert.equal(ext!.priority.scope, 'whole-product');
      assert.equal(ext!.complexity, 'open-ended');
      // visionRelation / time / domain still come from the drift preset.
      assert.equal(ext!.priority.visionRelation, 'vision-violator');
      assert.deepEqual(ext!.priority.domain, ['quality']);
    });

    it('elaboration nudge with explicit complexity stamps it', async () => {
      const fix = await buildFixture();

      const writ = await fix.keeper.submitElaborationNudge({
        visionId: 'v1',
        title: 'elaborate',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
        complexity: 'mechanical',
      });
      const ext = writ.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext);
      assert.equal(ext!.complexity, 'mechanical');
    });
  });

  // Case 6: multi-vision discrimination.

  describe('multi-vision label discrimination', () => {
    it('petitions for distinct visionIds carry distinct label values and the keeper tracks each independently', async () => {
      const fix = await buildFixture();

      const a = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-a',
        title: 'a',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      const b = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-b',
        title: 'b',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      const aExt = a.ext?.reckoner as ReckonerExt | undefined;
      const bExt = b.ext?.reckoner as ReckonerExt | undefined;
      assert.equal(aExt?.labels?.[VISION_ID_LABEL_KEY], 'vision-a');
      assert.equal(bExt?.labels?.[VISION_ID_LABEL_KEY], 'vision-b');

      // Withdrawing one vision's outstanding petition leaves the other
      // intact — confirms the keeper tracks them independently.
      const withdrawnA = await fix.keeper.superseded('vision-a');
      assert.ok(withdrawnA, 'vision-a outstanding petition must be withdrawn');
      assert.equal(withdrawnA!.id, a.id);

      const bReread = await fix.clerk.show(b.id);
      assert.equal(bReread.phase, 'new', 'vision-b petition must not be touched');
    });
  });

  // Case 7: kit declaration round-trip.

  describe('kit declaration round-trip', () => {
    it('after phase:started the petitioner registry contains the vision-keeper.snapshot entry with the verbatim brief description', async () => {
      const fix = await buildFixture();

      const list = fix.reckoner.listPetitioners();
      const entry = list.find((p) => p.source === VISION_KEEPER_SOURCE);
      assert.ok(entry, 'vision-keeper.snapshot must be registered');
      assert.equal(
        entry!.description,
        'Vision-vs-reality snapshots emitted when the keeper observes drift worth surfacing.',
      );

      // Source is reachable through isSourceRegistered too.
      assert.equal(fix.reckoner.isSourceRegistered(VISION_KEEPER_SOURCE), true);
    });
  });

  // Case 8: decline-feedback relay handler reactions.

  describe('decline-feedback relay', () => {
    it('logs a line for a vision-keeper.snapshot writ transitioning into cancelled', () => {
      const def = createDeclineRelay();
      assert.equal(def.name, DECLINE_RELAY_NAME);

      const event = {
        id: 'e-1',
        name: 'book.clerk.writs.updated',
        payload: {
          type: 'update',
          ownerId: 'clerk',
          book: 'writs',
          entry: {
            id: 'w-1',
            type: 'mandate',
            phase: 'cancelled',
            title: 't',
            body: 'b',
            createdAt: 'now',
            updatedAt: 'now',
            resolution: 'declined by reckoner',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
          prev: {
            id: 'w-1',
            type: 'mandate',
            phase: 'new',
            title: 't',
            body: 'b',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
        },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      };

      const captured: string[] = [];
      const originalLog = console.log;
      console.log = (msg: unknown) => {
        captured.push(String(msg));
      };
      try {
        // Invoke twice — idempotency check (re-invocation is observable
        // only via additional log lines; no other side effects).
        def.handler(event, { home: '/tmp', params: {} });
        def.handler(event, { home: '/tmp', params: {} });
      } finally {
        console.log = originalLog;
      }

      assert.equal(captured.length, 2, 'matching event produces one log line per invocation');
      for (const line of captured) {
        assert.match(line, /\[vision-keeper\] decline-feedback/);
        assert.match(line, /w-1/);
        assert.match(line, /declined by reckoner/);
      }
    });

    it('does not log for an update without a phase change', () => {
      const event = {
        id: 'e-2',
        name: 'book.clerk.writs.updated',
        payload: {
          type: 'update',
          ownerId: 'clerk',
          book: 'writs',
          entry: {
            id: 'w-2',
            type: 'mandate',
            phase: 'new',
            title: 't',
            body: 'edited',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
          prev: {
            id: 'w-2',
            type: 'mandate',
            phase: 'new',
            title: 't',
            body: 'original',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
        },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      };
      assert.equal(matchVisionKeeperDecline(event), null);
    });

    it('does not log for an other-source writ transitioning into cancelled', () => {
      const event = {
        id: 'e-3',
        name: 'book.clerk.writs.updated',
        payload: {
          type: 'update',
          ownerId: 'clerk',
          book: 'writs',
          entry: {
            id: 'w-3',
            type: 'mandate',
            phase: 'cancelled',
            title: 't',
            body: 'b',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: 'other.source' } },
          },
          prev: {
            id: 'w-3',
            type: 'mandate',
            phase: 'open',
            title: 't',
            body: 'b',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: 'other.source' } },
          },
        },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      };
      assert.equal(matchVisionKeeperDecline(event), null);
    });

    it('does not log for a create CDC change (no transition)', () => {
      const event = {
        id: 'e-4',
        name: 'book.clerk.writs.created',
        payload: {
          type: 'create',
          ownerId: 'clerk',
          book: 'writs',
          entry: {
            id: 'w-4',
            type: 'mandate',
            phase: 'cancelled',
            title: 't',
            body: 'b',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
        },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      };
      assert.equal(matchVisionKeeperDecline(event), null);
    });

    it('does not log for a writ already cancelled before the update (no transition into cancelled)', () => {
      const event = {
        id: 'e-5',
        name: 'book.clerk.writs.updated',
        payload: {
          type: 'update',
          ownerId: 'clerk',
          book: 'writs',
          entry: {
            id: 'w-5',
            type: 'mandate',
            phase: 'cancelled',
            title: 't',
            body: 'updated body',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
          prev: {
            id: 'w-5',
            type: 'mandate',
            phase: 'cancelled',
            title: 't',
            body: 'body',
            createdAt: 'now',
            updatedAt: 'now',
            ext: { reckoner: { source: VISION_KEEPER_SOURCE } },
          },
        },
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      };
      assert.equal(matchVisionKeeperDecline(event), null);
    });
  });

  // Plugin shape sanity (D29).

  describe('plugin wiring', () => {
    it('default export is a constructed Plugin with correct apparatus declarations', async () => {
      const mod = await import('./index.ts');
      const plugin = mod.default;
      assert.ok('apparatus' in plugin, 'default export is an apparatus plugin');
      assert.deepEqual(plugin.apparatus.requires, ['reckoner']);
      assert.deepEqual(plugin.apparatus.recommends, ['clockworks']);
    });

    it('supportKit declares the petitioner descriptor and the decline relay', () => {
      const plugin = createVisionKeeper();
      if (!('apparatus' in plugin)) throw new Error('expected apparatus shape');
      const support = readSupportKit(plugin);
      assert.equal(support.petitioners.length, 1);
      assert.equal(support.petitioners[0]?.source, VISION_KEEPER_SOURCE);
      assert.equal(support.relayName, DECLINE_RELAY_NAME);
    });

    it('__internal exposes the dimension-preset builders', () => {
      // Sanity: tests can drive the builders without booting an apparatus.
      const drift = (
        __internal as unknown as {
          driftDimensionPreset: () => { visionRelation: string };
        }
      ).driftDimensionPreset();
      assert.equal(drift.visionRelation, 'vision-violator');
      const elab = (
        __internal as unknown as {
          elaborationDimensionPreset: () => { visionRelation: string };
        }
      ).elaborationDimensionPreset();
      assert.equal(elab.visionRelation, 'vision-advancer');
    });
  });
});

// Silence unused-import noise — WritDoc is referenced via type annotations.
type _Unused = WritDoc;
void (null as unknown as _Unused);

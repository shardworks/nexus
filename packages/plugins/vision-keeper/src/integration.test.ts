/**
 * Vision-keeper end-to-end integration test.
 *
 * Boots Stacks + Clerk + Reckoner + Clockworks + Vision-keeper in one
 * harness — no apparatus is stubbed, no Reckoner is mocked, no relay
 * is hand-rolled. Asserts every behavioral case from the brief against
 * a live stack:
 *
 *   1. A drift snapshot lands a writ in `phase: 'new'` carrying the
 *      contract's `ext.reckoner` slot (registered source, drift
 *      dimensions, typed payload, vision-id label).
 *   2. A second snapshot for the same vision auto-supersedes the
 *      first — the prior writ ends in `cancelled`.
 *   3. `superseded(visionId)` cancels the outstanding writ for a
 *      different vision, leaving the first vision's writ untouched.
 *   4. Two visions in flight carry distinct `vision-keeper.io/vision-id`
 *      label values at the writs-book level.
 *   5. The decline-feedback relay is invoked end-to-end via the
 *      Clockworks dispatch sweep when a `vision-keeper.snapshot` writ
 *      transitions into `cancelled` (synthesised here by calling
 *      `clerk.transition(writId, 'cancelled')` directly — the real
 *      Reckoner CDC approval handler that would do this is owned by
 *      a separate commission).
 *   6. The petitioner kit declaration round-trips through the
 *      Reckoner registry as in production.
 *
 * The fixture mirrors the structural pattern from the Sentinel
 * integration test (`packages/plugins/sentinel/src/integration.test.ts`)
 * — book pre-creation, kit-entry surfacing, capture-logger plumbing.
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
import type { ReckonerApi, ReckonerExt } from '@shardworks/reckoner-apparatus';

import { createClockworks } from '@shardworks/clockworks-apparatus';
import type {
  ClockworksApi,
  RelayDefinition,
  StandingOrder,
} from '@shardworks/clockworks-apparatus';

import {
  DECLINE_RELAY_NAME,
  VISION_ID_LABEL_KEY,
  VISION_KEEPER_SOURCE,
  createVisionKeeper,
} from './index.ts';
import type { VisionKeeperApi, VisionSnapshotPayload } from './types.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  clockworks: ClockworksApi;
  keeper: VisionKeeperApi;
  /** Captured `console.log` lines from this test scope. */
  capturedLogs: string[];
  /** Restore captured `console.log`. */
  restoreLog: () => void;
}

function buildCtx(kitEntries: KitEntry[]): StartupContext {
  // Track phase:started handlers for a manual seal at the end of boot.
  return {
    on(event, handler) {
      if (event === 'phase:started') {
        // The fixture fires phase:started after every apparatus is
        // started — see buildGuild() below.
        phaseStartedHandlers.push(handler);
      }
    },
    kits(type: string): KitEntry[] {
      return kitEntries.filter((e) => e.type === type);
    },
  };
}

// Module-scoped so the buildCtx closure can see the same array. Reset
// at the start of each `buildGuild()` call.
let phaseStartedHandlers: Array<(...args: unknown[]) => void | Promise<void>> = [];

async function buildGuild(opts: {
  standingOrders?: StandingOrder[];
} = {}): Promise<Fixture> {
  phaseStartedHandlers = [];

  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');

  const clerkPlugin = createClerk();
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');

  const reckonerPlugin = createReckoner();
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner');

  const clockworksPlugin = createClockworks();
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks');

  const keeperPlugin = createVisionKeeper();
  if (!('apparatus' in keeperPlugin)) throw new Error('vision-keeper');

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'vision-keeper-integration',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.standingOrders !== undefined
      ? {
          clockworks: { standingOrders: opts.standingOrders },
        }
      : {}),
  };

  const fakeGuild: Guild = {
    home: '/tmp/vision-keeper-integration',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },
    config<T>() {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return guildConfig;
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

  setGuild(fakeGuild);

  // Pre-create the books the apparatuses expect (Arbor would do this
  // from supportKit declarations in production).
  backend.ensureBook(
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
  backend.ensureBook(
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
  backend.ensureBook(
    { ownerId: 'clockworks', book: 'events' },
    { indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']] },
  );
  backend.ensureBook(
    { ownerId: 'clockworks', book: 'event_dispatches' },
    { indexes: ['eventId', 'status', ['eventId', 'status']] },
  );

  // ── Stacks ─────────────────────────────────────────────────────────
  await stacksPlugin.apparatus.start(buildCtx([]));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // ── Clerk ──────────────────────────────────────────────────────────
  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Reckoner ──────────────────────────────────────────────────────
  // Surface the keeper's `petitioners` supportKit through the kit-entry
  // wire path so the registration runs against the production code.
  const keeperSupport = keeperPlugin.apparatus.supportKit as
    | { petitioners: Array<{ source: string; description: string }>; relays: RelayDefinition[] }
    | undefined;
  if (!keeperSupport) throw new Error('vision-keeper supportKit missing');

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

  // ── Clockworks ────────────────────────────────────────────────────
  // Surface kit contributions that the live Wire phase would surface:
  //   - `events` kit from Clockworks itself (own framework-event vocab),
  //   - `books` kit from Clerk so the CDC auto-wiring registers the
  //     writs book and `book.clerk.writs.updated` fires for transitions,
  //   - `books` kit from Clockworks itself so the CDC carve-out for
  //     the events book is in place,
  //   - `relays` kit from Vision-keeper so the decline relay is
  //     registered under the standing-order's `run:` name.
  const clockworksEvents = (clockworksPlugin.apparatus.supportKit as
    | { events?: unknown }
    | undefined)?.events;
  const clockworksBooks = (clockworksPlugin.apparatus.supportKit as
    | { books?: unknown }
    | undefined)?.books;
  const clerkBooks = (clerkPlugin.apparatus.supportKit as
    | { books?: unknown }
    | undefined)?.books;

  const clockworksKitEntries: KitEntry[] = [];
  if (clockworksEvents !== undefined) {
    clockworksKitEntries.push({
      pluginId: 'clockworks',
      packageName: '@shardworks/clockworks-apparatus',
      type: 'events',
      value: clockworksEvents,
    });
  }
  if (clockworksBooks !== undefined) {
    clockworksKitEntries.push({
      pluginId: 'clockworks',
      packageName: '@shardworks/clockworks-apparatus',
      type: 'books',
      value: clockworksBooks,
    });
  }
  if (clerkBooks !== undefined) {
    clockworksKitEntries.push({
      pluginId: 'clerk',
      packageName: '@shardworks/clerk-apparatus',
      type: 'books',
      value: clerkBooks,
    });
  }
  // Vision-keeper's relay declared via its supportKit.relays.
  clockworksKitEntries.push({
    pluginId: 'vision-keeper',
    packageName: '@shardworks/vision-keeper-apparatus',
    type: 'relays',
    value: keeperSupport.relays,
  });

  await clockworksPlugin.apparatus.start(buildCtx(clockworksKitEntries));
  const clockworks = clockworksPlugin.apparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  // ── Vision-keeper ─────────────────────────────────────────────────
  await keeperPlugin.apparatus.start(buildCtx([]));
  const keeper = keeperPlugin.apparatus.provides as VisionKeeperApi;
  apparatusMap.set('vision-keeper', keeper);

  // Seal — run any registered phase:started handlers.
  for (const handler of phaseStartedHandlers) {
    const result = handler();
    void result;
  }

  // Capture console.log so the integration test can assert on the
  // decline-relay's log line. Restored in the per-test teardown.
  const capturedLogs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: unknown) => {
    capturedLogs.push(String(msg));
  };

  return {
    stacks,
    clerk,
    reckoner,
    clockworks,
    keeper,
    capturedLogs,
    restoreLog: () => {
      console.log = originalLog;
    },
  };
}

async function teardown(fix: Fixture): Promise<void> {
  fix.restoreLog();
  clearGuild();
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Vision-keeper — end-to-end', () => {
  afterEach(() => clearGuild());

  it('drift snapshot lands a writ visible in the writs book with the contract ext slot', async () => {
    const fix = await buildGuild();
    try {
      const writ = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-1',
        title: 'drift detected',
        body: 'b',
        visionVsRealityDelta: { gap: 'observed' },
        metricValues: { metricA: 1 },
      });

      // Re-read through Clerk to confirm the row is persisted.
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'new');
      const ext = reread.ext?.reckoner as ReckonerExt | undefined;
      assert.ok(ext);
      assert.equal(ext!.source, VISION_KEEPER_SOURCE);
      assert.equal(ext!.priority.visionRelation, 'vision-violator');
      assert.equal(ext!.complexity, 'bounded');
      const payload = ext!.payload as VisionSnapshotPayload;
      assert.equal(payload.visionId, 'vision-1');
      assert.deepEqual(payload.metricValues, { metricA: 1 });
      assert.equal(ext!.labels?.[VISION_ID_LABEL_KEY], 'vision-1');

      // The kit declaration round-trips through the Reckoner registry.
      const list = fix.reckoner.listPetitioners();
      assert.ok(list.some((p) => p.source === VISION_KEEPER_SOURCE));
    } finally {
      await teardown(fix);
    }
  });

  it('emitting a competing snapshot for the same vision auto-supersedes the prior writ end-to-end', async () => {
    const fix = await buildGuild();
    try {
      const first = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-1',
        title: 'first',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      const second = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-1',
        title: 'second',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      const firstReread = await fix.clerk.show(first.id);
      assert.equal(firstReread.phase, 'cancelled');
      assert.match(
        String(firstReread.resolution),
        /superseded by newer snapshot/i,
      );

      const secondReread = await fix.clerk.show(second.id);
      assert.equal(secondReread.phase, 'new');
    } finally {
      await teardown(fix);
    }
  });

  it('explicit superseded() withdraws one vision\'s outstanding petition without touching the other', async () => {
    const fix = await buildGuild();
    try {
      const a = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-a',
        title: 'a',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });
      const b = await fix.keeper.submitElaborationNudge({
        visionId: 'vision-b',
        title: 'b',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      // Withdraw vision-b's outstanding petition explicitly.
      const withdrawn = await fix.keeper.superseded(
        'vision-b',
        'context shifted; nudge no longer relevant',
      );
      assert.ok(withdrawn);
      assert.equal(withdrawn!.id, b.id);
      const bReread = await fix.clerk.show(b.id);
      assert.equal(bReread.phase, 'cancelled');
      assert.equal(
        bReread.resolution,
        'context shifted; nudge no longer relevant',
      );

      // Vision-a's petition stays in `new`.
      const aReread = await fix.clerk.show(a.id);
      assert.equal(aReread.phase, 'new');
    } finally {
      await teardown(fix);
    }
  });

  it('two visions in flight carry distinct vision-id label values at the writs-book level', async () => {
    const fix = await buildGuild();
    try {
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

      // List the writs and confirm the labels are distinct.
      const all = await fix.clerk.list({ limit: 100 });
      const aWrit = all.find((w: WritDoc) => w.id === a.id);
      const bWrit = all.find((w: WritDoc) => w.id === b.id);
      assert.ok(aWrit && bWrit);
      const aExt = aWrit!.ext?.reckoner as ReckonerExt | undefined;
      const bExt = bWrit!.ext?.reckoner as ReckonerExt | undefined;
      assert.equal(aExt?.labels?.[VISION_ID_LABEL_KEY], 'vision-a');
      assert.equal(bExt?.labels?.[VISION_ID_LABEL_KEY], 'vision-b');
    } finally {
      await teardown(fix);
    }
  });

  it('decline-feedback relay fires through Clockworks when a vision-keeper.snapshot writ transitions into cancelled', async () => {
    const fix = await buildGuild({
      standingOrders: [
        { on: 'book.clerk.writs.updated', run: DECLINE_RELAY_NAME },
      ],
    });
    try {
      // Emit a petition.
      const writ = await fix.keeper.submitDriftSnapshot({
        visionId: 'vision-1',
        title: 'drift to be declined',
        body: 'b',
        visionVsRealityDelta: null,
        metricValues: null,
      });

      // Synthesise the decline transition. The Reckoner CDC approval
      // handler is out of scope; we drive the writ to `cancelled`
      // directly via Clerk so the CDC observer fires its update event.
      await fix.clerk.transition(writ.id, 'cancelled', {
        resolution: 'declined by reckoner — vision misalignment',
      });

      // Drain the Clockworks event sweep — the relay handler is invoked
      // synchronously here.
      const summary = await fix.clockworks.processEvents();

      // At least one dispatch landed against the decline relay.
      assert.ok(
        summary.dispatches >= 1,
        `expected at least one dispatch; got ${summary.dispatches}`,
      );

      // Captured log carries our decline line.
      const declineLines = fix.capturedLogs.filter((l) =>
        /\[vision-keeper\] decline-feedback/.test(l),
      );
      assert.equal(declineLines.length, 1, 'exactly one decline log line');
      assert.match(declineLines[0]!, /declined by reckoner — vision misalignment/);
      assert.match(declineLines[0]!, new RegExp(writ.id));
    } finally {
      await teardown(fix);
    }
  });

  it('decline-feedback relay does NOT fire for an other-source writ transitioning into cancelled', async () => {
    const fix = await buildGuild({
      standingOrders: [
        { on: 'book.clerk.writs.updated', run: DECLINE_RELAY_NAME },
      ],
    });
    try {
      // Post a writ via Clerk directly (no Reckoner ext slot).
      const writ = await fix.clerk.post({
        title: 'unrelated writ',
        body: 'b',
      });
      await fix.clerk.transition(writ.id, 'cancelled', {
        resolution: 'unrelated cancellation',
      });

      const summary = await fix.clockworks.processEvents();
      // Dispatches may still happen (the standing order matches the
      // event name regardless of payload) but the relay's filter must
      // reject this case — no log line.
      void summary;
      const declineLines = fix.capturedLogs.filter((l) =>
        /\[vision-keeper\] decline-feedback/.test(l),
      );
      assert.equal(
        declineLines.length,
        0,
        'no decline log line for non-vision-keeper writs',
      );
    } finally {
      await teardown(fix);
    }
  });
});

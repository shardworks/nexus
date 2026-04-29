/**
 * Reckoner — staleness-snapshot CDC integration test.
 *
 * Drives the apparatus's `stacks.watch` subscription end-to-end
 * against `MemoryBackend`: every Reckoner tick produces Reckonings
 * rows that flow through the Phase-2 CDC handler, which derives the
 * `ReckonerStatus` snapshot and writes it back to
 * `writ.status['reckoner']`.
 *
 * The fixture mirrors `reckoner-depends-on.test.ts` byte-for-byte
 * (Stacks + Clerk + Reckoner against `MemoryBackend`, Clerk's
 * `linkKinds` surfaced through `ctx.kits('linkKinds')`, the standard
 * `tester.dep` petitioner) so the integration ground here is the
 * same shape the dependency-aware-consideration commission validated
 * its own end-to-end behavior against.
 *
 * Coverage targets the originating brief's Acceptance Signal:
 *   1. dependency_failed defer row → snapshot has decision=deferred,
 *      stalled=true, stalledReason=dependency_failed, stalledSince
 *      matching the row's consideredAt, deferCount=1.
 *   2. dependency_pending row following a dependency_failed row
 *      clears the stalled flag while preserving deferCount.
 *   3. accepted row following a deferred sequence preserves the
 *      running counters verbatim and flips decision to 'accepted'.
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
import type {
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createReckonerWithHooks } from './reckoner.ts';
import { alwaysApproveScheduler } from './schedulers/always-approve.ts';
import { RECKONER_STATUS_SLOT } from './types.ts';
import type {
  ReckoningDoc,
  ReckonerApi,
  ReckonerConfig,
  ReckonerStatus,
} from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  hooks: ReturnType<typeof createReckonerWithHooks>['hooks'];
  memBackend: MemoryBackend;
  fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig };
  reckoningsBook: ReadOnlyBook<ReckoningDoc>;
  firePhaseStarted: () => Promise<void>;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-staleness-test-guild',
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

interface FixtureOptions {
  petitionerKits?: Array<{ pluginId: string; value: unknown }>;
  config?: ReckonerConfig | undefined;
}

async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const built = createReckonerWithHooks();
  const reckonerPlugin = built.plugin;

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig } = {
    name: 'reckoner-staleness-test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.config !== undefined ? { reckoner: opts.config } : {}),
  };

  setGuild(buildFakeGuild(apparatusMap, fakeGuildConfig));

  // Pre-create the books the Clerk needs — Stacks' Wire phase would
  // do this in production from the supportKit declarations.
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
  memBackend.ensureBook(
    { ownerId: 'reckoner', book: 'reckonings' },
    {
      indexes: [
        'writId',
        'consideredAt',
        'outcome',
        'source',
        'visionRelation',
        'severity',
        'declineReason',
        ['outcome', 'consideredAt'],
        ['visionRelation', 'consideredAt'],
        ['severity', 'consideredAt'],
        ['writId', 'consideredAt'],
      ],
    },
  );

  // Build a phase-started capable StartupContext per apparatus.
  const phaseStartedHandlers: Array<(...args: unknown[]) => void | Promise<void>> = [];
  const firePhaseStarted = async (): Promise<void> => {
    for (const handler of phaseStartedHandlers) {
      await handler();
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
  // Surface Clerk's own supportKit `linkKinds` through `ctx.kits('linkKinds')`
  // so the dep gate's `clerk.link(..., 'depends-on')` calls succeed.
  const clerkLinkKindEntries: KitEntry[] = [
    {
      pluginId: 'clerk',
      packageName: '@shardworks/clerk-apparatus',
      type: 'linkKinds',
      value: [
        {
          id: 'depends-on',
          description:
            'The source writ is a precedence-successor of the target.',
        },
      ],
    },
  ];
  await clerkPlugin.apparatus.start(buildCtx(clerkLinkKindEntries));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Reckoner ──────────────────────────────────────────────────────
  const petitionerKitEntries: KitEntry[] = (opts.petitionerKits ?? []).map(
    (entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'petitioners',
      value: entry.value,
    }),
  );
  const schedulerKitEntries: KitEntry[] = [
    {
      pluginId: 'reckoner',
      packageName: '@shardworks/reckoner-apparatus',
      type: 'schedulers',
      value: [alwaysApproveScheduler],
    },
  ];

  await reckonerPlugin.apparatus.start(
    buildCtx([...petitionerKitEntries, ...schedulerKitEntries]),
  );
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  await firePhaseStarted();

  return {
    stacks,
    clerk,
    reckoner,
    hooks: built.hooks,
    memBackend,
    fakeGuildConfig,
    reckoningsBook: stacks.readBook<ReckoningDoc>('reckoner', 'reckonings'),
    firePhaseStarted,
  };
}

const TESTER_KIT = {
  pluginId: 'tester',
  value: [{ source: 'tester.dep', description: 'staleness-snapshot test source' }],
};

/**
 * Fetch the Reckoner-owned snapshot from the writ's status sub-slot.
 * Returns `undefined` when the slot is absent.
 */
async function readSnapshot(
  fix: Fixture,
  writId: string,
): Promise<ReckonerStatus | undefined> {
  const writ = await fix.clerk.show(writId);
  const slot = writ.status?.[RECKONER_STATUS_SLOT];
  return slot as ReckonerStatus | undefined;
}

afterEach(() => {
  clearGuild();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner staleness-snapshot CDC integration', () => {
  it('flags stalled on the first dependency_failed defer row', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Stand up a failed dependency target.
    const dep = await fix.clerk.post({ title: 'failed-dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {});
    await fix.clerk.transition(dep.id, 'failed', { resolution: 'oops' });

    // Post the held petition and run the dep-gate tick.
    const writ = await fix.clerk.post({ title: 'held', body: 'b' });
    await fix.clerk.link(writ.id, dep.id, 'depends-on', 'depends-on');
    await fix.reckoner.petition(writ.id, { source: 'tester.dep' });
    await fix.hooks.runTick();

    // The dep-gate writes one deferred row. The Phase-2 CDC handler
    // derives the snapshot from that row.
    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'deferred');
    assert.equal(rows[0]!.deferReason, 'dependency_failed');

    const snapshot = await readSnapshot(fix, writ.id);
    assert.ok(snapshot, 'snapshot must be present after the deferred row');
    assert.equal(snapshot.decision, 'deferred');
    assert.equal(snapshot.deferReason, 'dependency_failed');
    assert.equal(snapshot.deferCount, 1);
    assert.equal(snapshot.firstDeferredAt, rows[0]!.consideredAt);
    assert.equal(snapshot.lastDeferredAt, rows[0]!.consideredAt);
    assert.equal(snapshot.stalled, true);
    assert.equal(snapshot.stalledReason, 'dependency_failed');
    assert.equal(snapshot.stalledSince, rows[0]!.consideredAt);
    assert.equal(snapshot.lastEvaluatedAt, rows[0]!.consideredAt);
  });

  it('clears stalled while preserving deferCount when dep set transitions failed → pending', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Failed-dep first, then we'll resurrect a gating-dep.
    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {});
    await fix.clerk.transition(dep.id, 'failed', { resolution: 'oops' });

    const writ = await fix.clerk.post({ title: 'held', body: 'b' });
    await fix.clerk.link(writ.id, dep.id, 'depends-on', 'depends-on');
    await fix.reckoner.petition(writ.id, { source: 'tester.dep' });
    await fix.hooks.runTick();

    // Snapshot after the dependency_failed row.
    const snap1 = await readSnapshot(fix, writ.id);
    assert.ok(snap1);
    assert.equal(snap1.stalled, true);
    assert.equal(snap1.deferCount, 1);

    // Swap the dep into a gating state. We can't transition `failed`
    // back to `open`, so the cleanest path is to delete the failed
    // dep and link to a fresh gating dep on the same writ. The dep
    // gate's failed-precedence aggregation produced
    // `dependency_failed`; with that target removed and a gating one
    // attached, the gate produces `dependency_pending`.
    await fix.clerk.unlink(writ.id, dep.id, 'depends-on');
    const gatingDep = await fix.clerk.post({ title: 'gating-dep', body: 'b' });
    await fix.clerk.transition(gatingDep.id, 'open', {});
    await fix.clerk.link(writ.id, gatingDep.id, 'depends-on', 'depends-on');

    await fix.hooks.runTick();

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 2, 'shape change → fresh deferred row');
    const pendingRow = rows.find((r) => r.deferReason === 'dependency_pending');
    assert.ok(pendingRow, 'second row carries dependency_pending');

    const snap2 = await readSnapshot(fix, writ.id);
    assert.ok(snap2);
    assert.equal(snap2.decision, 'deferred');
    assert.equal(snap2.deferReason, 'dependency_pending');
    // stalled cleared
    assert.equal(snap2.stalled, undefined);
    assert.equal(snap2.stalledReason, undefined);
    assert.equal(snap2.stalledSince, undefined);
    // deferCount preserved + advanced
    assert.equal(snap2.deferCount, 2);
    // firstDeferredAt preserved across the transition
    assert.equal(snap2.firstDeferredAt, snap1.firstDeferredAt);
  });

  it('preserves running counters across the deferred → accepted transition', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Gating dep so the first tick defers.
    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {}); // active, gating

    const writ = await fix.clerk.post({ title: 'held', body: 'b' });
    await fix.clerk.link(writ.id, dep.id, 'depends-on', 'depends-on');
    await fix.reckoner.petition(writ.id, { source: 'tester.dep' });
    await fix.hooks.runTick();

    const snap1 = await readSnapshot(fix, writ.id);
    assert.ok(snap1);
    assert.equal(snap1.decision, 'deferred');
    assert.equal(snap1.deferCount, 1);
    const firstDeferredAt = snap1.firstDeferredAt;

    // Clear the dep — the next tick accepts.
    await fix.clerk.transition(dep.id, 'completed', { resolution: 'ok' });
    await fix.hooks.runTick();

    const reread = await fix.clerk.show(writ.id);
    assert.equal(
      reread.phase,
      'open',
      'dep cleared → writ accepted (transitioned to active)',
    );

    const snap2 = await readSnapshot(fix, writ.id);
    assert.ok(snap2);
    assert.equal(snap2.decision, 'accepted');
    // Counters preserved verbatim — the historical "deferred N times"
    // signal is load-bearing for downstream consumers.
    assert.equal(snap2.deferCount, 1);
    assert.equal(snap2.firstDeferredAt, firstDeferredAt);
    // stalled cleared (was already false on the dependency_pending row)
    assert.equal(snap2.stalled, undefined);
    // deferReason cleared on a non-deferred row
    assert.equal(snap2.deferReason, undefined);
    // lastEvaluatedAt advances to the accepted row's consideredAt
    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    const acceptedRow = rows.find((r) => r.outcome === 'accepted');
    assert.ok(acceptedRow);
    assert.equal(snap2.lastEvaluatedAt, acceptedRow.consideredAt);
  });
});

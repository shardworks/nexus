/**
 * Reckoner end-to-end integration test.
 *
 * Apparatus-isolated counterpart to the vision-keeper integration
 * test (`packages/plugins/vision-keeper/src/integration.test.ts`).
 * Spins up Stacks + Clerk + Reckoner against the in-memory backend
 * and exercises the public `petition()` helper through the full
 * lifecycle:
 *
 *   1. A petition lands as a held writ in `new` carrying
 *      `ext['reckoner']`.
 *   2. A periodic tick fires (driven directly through the
 *      test-only `runTick` hook with a synthetic `clockworks.timer`
 *      event) and runs the per-fire sequence.
 *   3. The accept-path transitions the writ from `new` to the
 *      type's active state (`open` for mandate).
 *   4. A Reckonings row is appended carrying `outcome: 'accepted'`,
 *      the lean projection (`source`, `visionRelation`, `severity`),
 *      the dedupe-discriminating `(writId, writUpdatedAt)` pair,
 *      and a populated `tickEventId` matching the synthetic
 *      timer-event id.
 *
 * Mirrors the structural pattern from
 * `packages/plugins/sentinel/src/integration.test.ts` for fixture
 * scaffolding (book pre-creation, kit-entry surfacing).
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
import type { ReadOnlyBook, StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createReckonerWithHooks } from './reckoner.ts';
import { alwaysApproveScheduler } from './schedulers/always-approve.ts';
import type { ReckoningDoc, ReckonerApi } from './types.ts';

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  hooks: ReturnType<typeof createReckonerWithHooks>['hooks'];
  reckoningsBook: ReadOnlyBook<ReckoningDoc>;
}

async function buildGuild(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const built = createReckonerWithHooks();
  const reckonerPlugin = built.plugin;

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'reckoner-integration',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/reckoner-integration',
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

  // Pre-create the books the apparatuses expect (Wire phase would do
  // this in production from supportKit declarations).
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

  const phaseStartedHandlers: Array<(...args: unknown[]) => void | Promise<void>> = [];
  const firePhaseStarted = async (): Promise<void> => {
    for (const handler of phaseStartedHandlers) {
      await handler();
    }
  };

  function buildCtx(kitEntries: KitEntry[]): StartupContext {
    return {
      on(event, handler): void {
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
  // One petitioner pre-registered through the kit-contribution wire
  // path so the integration exercises the registered-source accept
  // branch end-to-end. The Reckoner's own supportKit `schedulers`
  // contribution (the always-approve instance) is mirrored by hand
  // because this test fixture does not drive Arbor.
  const reckonerKitEntries: KitEntry[] = [
    {
      pluginId: 'tester',
      packageName: '@test/tester',
      type: 'petitioners',
      value: [
        {
          source: 'tester.kind',
          description: 'a tester petitioner',
        },
      ],
    },
    {
      pluginId: 'reckoner',
      packageName: '@shardworks/reckoner-apparatus',
      type: 'schedulers',
      value: [alwaysApproveScheduler],
    },
  ];
  await reckonerPlugin.apparatus.start(buildCtx(reckonerKitEntries));
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  // Fire phase:started so the registry seals and the active scheduler
  // resolves — the real Arbor lifecycle does this in production.
  await firePhaseStarted();

  return {
    stacks,
    clerk,
    reckoner,
    hooks: built.hooks,
    reckoningsBook: stacks.readBook<ReckoningDoc>('reckoner', 'reckonings'),
  };
}

describe('Reckoner — end-to-end', () => {
  afterEach(() => clearGuild());

  it('petition → tick → transition → reckonings row flows end-to-end', async () => {
    const fix = await buildGuild();

    const writ = await fix.reckoner.petition({
      source: 'tester.kind',
      title: 'integration petition',
      body: 'b',
      priority: {
        visionRelation: 'vision-violator',
        severity: 'serious',
      },
    });

    // Petition lands the writ in `new`. The tick is the only path
    // that drives evaluation — fire one with a synthetic
    // `clockworks.timer` event so the resulting row stamps a
    // populated `tickEventId`.
    const tickEventId = 'e-integration-tick-1';
    await fix.hooks.runTick({
      id: tickEventId,
      name: 'clockworks.timer',
      payload: null,
      emitter: 'framework',
      firedAt: new Date().toISOString(),
    });

    // Re-read to confirm the writ is in the type's active state
    // (`open` for mandate).
    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'open', 'held petition becomes active after tick');
    assert.equal(reread.type, 'mandate');
    // The ext stays in place across the transition.
    assert.ok(reread.ext?.reckoner, 'ext.reckoner survives the transition');

    // Targeted query exercises the dedupe-discriminating compound
    // index — the row is filterable by writId via the bare-key index
    // and ordered by consideredAt via the [writId, consideredAt]
    // compound.
    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1, 'exactly one Reckonings row per acceptance');
    const row = rows[0]!;
    assert.equal(row.outcome, 'accepted');
    assert.equal(row.writId, writ.id);
    assert.equal(typeof row.writUpdatedAt, 'string');
    assert.equal(typeof row.consideredAt, 'string');
    assert.equal(row.source, 'tester.kind');
    assert.equal(row.visionRelation, 'vision-violator');
    assert.equal(row.severity, 'serious');
    // Accepted rows carry no decline / defer metadata.
    assert.equal(row.declineReason, undefined);
    assert.equal(row.deferReason, undefined);
    // The tick stamped the triggering event id onto the row.
    assert.equal(row.tickEventId, tickEventId);
  });

  it('emits one row per acceptance even when ticks repeat after the writ has moved out of new', async () => {
    const fix = await buildGuild();

    const writ = await fix.reckoner.petition({
      source: 'tester.kind',
      title: 'idempotent integration',
      body: 'b',
    });
    // First tick auto-approves.
    await fix.hooks.runTick();

    // Subsequent ticks observe no candidate — the writ is no
    // longer in `new`, so the tick's held-petition query produces
    // an empty set. No second row.
    await fix.hooks.runTick();
    await fix.hooks.runTick();

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
  });
});

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
 *   2. The Phase 2 CDC handler observes the setWritExt update
 *      event and runs the rule sequence.
 *   3. The accept-path transitions the writ from `new` to the
 *      type's active state (`open` for mandate).
 *   4. A Reckonings row is appended carrying `outcome: 'accepted'`,
 *      the lean projection (`source`, `visionRelation`, `severity`),
 *      and the dedupe-discriminating `(writId, writUpdatedAt)`
 *      pair.
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

import { createReckoner } from './reckoner.ts';
import type { ReckoningDoc, ReckonerApi } from './types.ts';

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  reckoningsBook: ReadOnlyBook<ReckoningDoc>;
}

async function buildGuild(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const reckonerPlugin = createReckoner();

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

  function buildCtx(kitEntries: KitEntry[]): StartupContext {
    return {
      on(): void {},
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
  // branch end-to-end.
  const petitionerKitEntries: KitEntry[] = [
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
  ];
  await reckonerPlugin.apparatus.start(buildCtx(petitionerKitEntries));
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  return {
    stacks,
    clerk,
    reckoner,
    reckoningsBook: stacks.readBook<ReckoningDoc>('reckoner', 'reckonings'),
  };
}

describe('Reckoner — end-to-end', () => {
  afterEach(() => clearGuild());

  it('petition → consideration → transition → reckonings row flows end-to-end', async () => {
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

    // The CDC handler ran during setWritExt's Phase 2 dispatch and
    // approved the petition. Re-read to confirm the writ is in the
    // type's active state (`open` for mandate).
    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'open', 'held petition becomes active');
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
    // No scheduled-tick id for v0 (CDC-driven only).
    assert.equal(row.tickEventId, undefined);
  });

  it('emits one row per acceptance even when the handler is re-driven on the same writ-version', async () => {
    const fix = await buildGuild();

    const writ = await fix.reckoner.petition({
      source: 'tester.kind',
      title: 'idempotent integration',
      body: 'b',
    });

    // Drive a benign edit through Clerk so a fresh CDC update event
    // fires for the writ. ext.reckoner did not change and phase did
    // not change since the accept transition, so the re-firing gate
    // (D14) rejects it before the dedupe lookup; either way the
    // assertion is the same: exactly one row per acceptance.
    await fix.clerk.edit({ id: writ.id, body: 'b' });

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
  });
});

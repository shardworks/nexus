/**
 * Reckoner — dependency-aware consideration gate.
 *
 * Covers the behavioral cases enumerated in the dependency-aware-
 * consideration commission's Acceptance Signal:
 *
 *   1. all deps cleared → proceed (accepted).
 *   2. one dep gating  → defer with `dependency_pending`.
 *   3. one dep failed  → defer with `dependency_failed`.
 *   4. mix of failed + gating → `dependency_failed` (failed-precedence).
 *   5. dangling target → `dependency_pending`.
 *   6. no `depends-on` links → no defer (accepted).
 *   7. two-writ cycle  → both deferred indefinitely; neither accepted.
 *   8. dep clears between ticks → accepted on the next tick.
 *   9. cancelled dependency → cleared (success-equivalent).
 *  10. every dependency-defer outcome emits a Reckonings row with the
 *      right `deferReason` and a `deferNote` listing the gating /
 *      failed dep writ ids.
 *  11. no-op-row suppression — re-evaluating a deferred writ at the
 *      same outcome on the next tick does not write a duplicate row.
 *  12. a registered + non-disabled source still receives a deferred
 *      row when its dep gate fires (rule ordering check: disabled-
 *      source skip and registration enforcement run *before* the
 *      dependency check).
 *
 * The fixture mirrors `reckoner-cdc.test.ts` — real Stacks + Clerk +
 * Reckoner against MemoryBackend — and additionally surfaces the
 * Clerk's own `supportKit.linkKinds` through `ctx.kits('linkKinds')`
 * so tests can create real `kind: 'depends-on'` links via
 * `clerk.link(source, target, label, 'depends-on')`. The dep gate
 * filters outbound links by `link.kind === 'depends-on'`, so the
 * kind plumbing is load-bearing.
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
import type {
  ReckoningDoc,
  ReckonerApi,
  ReckonerConfig,
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
  /**
   * Re-fire `phase:started` against the registered handlers. The
   * Reckoner's seal handler runs the catch-up scan — calling this
   * again is the v0 way to simulate a tick (D7 of the commission).
   */
  firePhaseStarted: () => Promise<void>;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-depends-on-test-guild',
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
    name: 'reckoner-depends-on-test-guild',
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
  // so the dep gate's `clerk.link(..., 'depends-on')` calls succeed. In
  // production Arbor's `buildKitEntries` walks every apparatus's
  // `supportKit` and surfaces it; the test fixture has to mirror that
  // by hand for the kits the Clerk consumes.
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

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Standard petitioner kit entry the dep-gate tests use. Registering
 * a real source isolates these tests from the
 * source-unregistered-decline path so failures cleanly surface as
 * dep-gate behaviour rather than registration regressions.
 */
const TESTER_KIT = {
  pluginId: 'tester',
  value: [{ source: 'tester.dep', description: 'dep-gate test source' }],
};

/**
 * Post a held petition without consideration firing. We post the
 * underlying writ via `clerk.post()` (no ext), wire any depends-on
 * links to existing targets, then stamp `ext.reckoner` last —
 * stamping is the moment the CDC handler considers the writ. By
 * routing all stamps through `reckoner.petition(writId, ext)` we
 * exercise the same code path operators use for the draft-then-
 * publish idiom.
 */
async function postHeld(
  fix: Fixture,
  opts: { title?: string; dependsOn?: string[] } = {},
): Promise<WritDoc> {
  const writ = await fix.clerk.post({
    title: opts.title ?? 'dep-gate test writ',
    body: 'b',
  });
  if (opts.dependsOn) {
    for (const targetId of opts.dependsOn) {
      await fix.clerk.link(writ.id, targetId, 'depends-on', 'depends-on');
    }
  }
  await fix.reckoner.petition(writ.id, {
    source: 'tester.dep',
  });
  return writ;
}

afterEach(() => {
  clearGuild();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner dependency-aware consideration gate', () => {
  // ── Case 1: all deps cleared → proceed ─────────────────────────────

  it('proceeds (accepts) when every dependency target is cleared (terminal+success)', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Two cleared dep targets — both completed.
    const dep1 = await fix.clerk.post({ title: 'dep1', body: 'b' });
    const dep2 = await fix.clerk.post({ title: 'dep2', body: 'b' });
    await fix.clerk.transition(dep1.id, 'open', {});
    await fix.clerk.transition(dep1.id, 'completed', { resolution: 'ok' });
    await fix.clerk.transition(dep2.id, 'open', {});
    await fix.clerk.transition(dep2.id, 'completed', { resolution: 'ok' });

    const writ = await postHeld(fix, { dependsOn: [dep1.id, dep2.id] });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'open', 'cleared deps → accepted (transitioned to open)');

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'accepted');
  });

  // ── Case 6: no `depends-on` links → no defer ──────────────────────

  it('proceeds (accepts) when there are no depends-on links at all', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const writ = await postHeld(fix, { dependsOn: [] });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'open');

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'accepted');
  });

  // ── Case 2: one dep gating → defer with dependency_pending ─────────

  it('defers with dependency_pending when a single dep is non-terminal (gating)', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {}); // active, gating
    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'new', 'gated writ stays in new');

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.outcome, 'deferred');
    assert.equal(row.deferReason, 'dependency_pending');
    assert.equal(row.deferNote, `gating: ${dep.id}`);
    // v0 carve-out: deferUntil/deferSignal/counters absent.
    assert.equal(row.deferUntil, undefined);
    assert.equal(row.deferSignal, undefined);
    assert.equal(row.deferCount, undefined);
    assert.equal(row.firstDeferredAt, undefined);
    assert.equal(row.lastDeferredAt, undefined);
  });

  // ── Case 3: one dep failed → defer with dependency_failed ──────────

  it('defers with dependency_failed when a single dep is in a failed terminal state', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {});
    await fix.clerk.transition(dep.id, 'failed', { resolution: 'oops' });
    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(reread.phase, 'new', 'failed-dep writ stays in new');

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.outcome, 'deferred');
    assert.equal(row.deferReason, 'dependency_failed');
    assert.equal(row.deferNote, `failed: ${dep.id}`);
  });

  // ── Case 4: mix of failed + gating → dependency_failed (failed wins) ─

  it('emits dependency_failed when both failed and gating deps are present (failed-precedence)', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const failedDep = await fix.clerk.post({ title: 'failed-dep', body: 'b' });
    await fix.clerk.transition(failedDep.id, 'open', {});
    await fix.clerk.transition(failedDep.id, 'failed', { resolution: 'oops' });

    const gatingDep = await fix.clerk.post({ title: 'gating-dep', body: 'b' });
    await fix.clerk.transition(gatingDep.id, 'open', {});

    const writ = await postHeld(fix, {
      dependsOn: [failedDep.id, gatingDep.id],
    });

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.outcome, 'deferred');
    assert.equal(row.deferReason, 'dependency_failed');
    // deferNote names only the failed dep; the gating dep is captured
    // by the `dependency_failed` reason at this layer (the staleness
    // diagnostic is the named consumer of richer per-target audit).
    assert.equal(row.deferNote, `failed: ${failedDep.id}`);
  });

  // ── Case 5: dangling target → dependency_pending ──────────────────

  it('treats a dangling depends-on target as gating (dependency_pending)', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Create a real dep we'll unlink, then create the held writ with
    // a depends-on link to a separately-created-and-deleted writ.
    // MemoryBackend doesn't expose delete-writ, so the simplest
    // dangling shape is to create the writ, link to it, then delete
    // the row in the writs book directly.
    const ghost = await fix.clerk.post({ title: 'ghost', body: 'b' });
    const writ = await postHeld(fix, { dependsOn: [ghost.id] });

    // Tear out the ghost — book.get(ghost.id) will return undefined.
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    await writsBook.delete(ghost.id);

    // Re-run the catch-up scan to re-evaluate the held writ at the
    // dangling-target shape.
    await fix.hooks.runCatchUpScan();

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    // The first consideration (during postHeld) saw a non-terminal
    // ghost (gating, since ghost was in `new`); the second
    // consideration after deletion still produces "gating: <ghostId>"
    // because dangling targets are treated as gating per the
    // commission's classifier. Same outcome shape → no second row.
    assert.equal(rows.length, 1, 'dangling-and-gating share the dependency_pending shape');
    const row = rows[0]!;
    assert.equal(row.outcome, 'deferred');
    assert.equal(row.deferReason, 'dependency_pending');
    assert.equal(row.deferNote, `gating: ${ghost.id}`);
  });

  // ── Case 9: cancelled dependency → cleared (success-equivalent) ───

  it('treats a cancelled dep as cleared (success-equivalent)', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'cancelled-dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'cancelled', { resolution: 'never mind' });

    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(
      reread.phase,
      'open',
      'cancelled dep counts as cleared → writ accepted',
    );

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'accepted');
  });

  // ── Case 8: dep clears between ticks → accepted on the next tick ──

  it('accepts a previously-deferred writ when its dep clears on the next tick', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {}); // active, gating

    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    // First tick: deferred.
    let rereadAfterDefer = await fix.clerk.show(writ.id);
    assert.equal(rereadAfterDefer.phase, 'new');
    let rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'deferred');
    assert.equal(rows[0]!.deferReason, 'dependency_pending');

    // Clear the dep between ticks.
    await fix.clerk.transition(dep.id, 'completed', { resolution: 'ok' });

    // Tick again — re-run the catch-up scan, which re-considers every
    // held petition. With the dep cleared, the gate proceeds and the
    // scheduler accepts.
    await fix.hooks.runCatchUpScan();

    const rereadAfterTick = await fix.clerk.show(writ.id);
    assert.equal(
      rereadAfterTick.phase,
      'open',
      'dep cleared → accepted on next tick',
    );

    rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(
      rows.length,
      2,
      'one deferred row + one accepted row after the dep clears',
    );
    const outcomes = rows.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ['accepted', 'deferred']);
  });

  // ── Case 11: no-op-row suppression ────────────────────────────────

  it('does not write a duplicate row when the dep gate re-evaluates at the same outcome', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {});
    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    // First defer row.
    let rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'deferred');

    // Re-run the catch-up scan twice without changing dep state.
    // Each tick must run the dep gate but suppress the row write.
    await fix.hooks.runCatchUpScan();
    await fix.hooks.runCatchUpScan();

    rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(
      rows.length,
      1,
      'no-op-row suppression: same outcome shape produces no new row',
    );
  });

  // ── State-change re-emit: gating → failed produces a new row ─────

  it('writes a fresh row when the dep set transitions from gating to failed', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {});
    const writ = await postHeld(fix, { dependsOn: [dep.id] });

    let rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.deferReason, 'dependency_pending');

    // Fail the dep — outcome shape changes (pending → failed).
    await fix.clerk.transition(dep.id, 'failed', { resolution: 'oops' });

    await fix.hooks.runCatchUpScan();

    rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(
      rows.length,
      2,
      'shape change → new row appended (pending → failed)',
    );
    const failedRow = rows.find((r) => r.deferReason === 'dependency_failed');
    assert.ok(failedRow, 'second row carries dependency_failed');
    assert.equal(failedRow!.outcome, 'deferred');
    assert.equal(failedRow!.deferNote, `failed: ${dep.id}`);
  });

  // ── Case 7: two-writ cycle → both deferred indefinitely ───────────

  it('defers both halves of a two-writ cycle indefinitely; neither is accepted', async () => {
    const fix = await buildFixture({ petitionerKits: [TESTER_KIT] });

    // Post both writs without ext, wire the cycle, then stamp both.
    const a = await fix.clerk.post({ title: 'A', body: 'b' });
    const b = await fix.clerk.post({ title: 'B', body: 'b' });
    await fix.clerk.link(a.id, b.id, 'depends-on', 'depends-on');
    await fix.clerk.link(b.id, a.id, 'depends-on', 'depends-on');

    await fix.reckoner.petition(a.id, { source: 'tester.dep' });
    await fix.reckoner.petition(b.id, { source: 'tester.dep' });

    // Re-run the catch-up scan a few times to confirm the cycle
    // doesn't drift toward an accept on either side.
    await fix.hooks.runCatchUpScan();
    await fix.hooks.runCatchUpScan();

    const rereadA = await fix.clerk.show(a.id);
    const rereadB = await fix.clerk.show(b.id);
    assert.equal(rereadA.phase, 'new', 'cycle half A stays in new');
    assert.equal(rereadB.phase, 'new', 'cycle half B stays in new');

    const rowsA = await fix.reckoningsBook.find({
      where: [['writId', '=', a.id]],
    });
    const rowsB = await fix.reckoningsBook.find({
      where: [['writId', '=', b.id]],
    });
    assert.ok(rowsA.length >= 1, 'cycle half A has at least one row');
    assert.ok(rowsB.length >= 1, 'cycle half B has at least one row');
    for (const row of [...rowsA, ...rowsB]) {
      assert.equal(
        row.outcome,
        'deferred',
        'cycle members never produce an accepted row',
      );
      assert.equal(row.deferReason, 'dependency_pending');
    }
  });

  // ── Case 12: rule ordering — disabled-source skip wins over dep gate ─

  it('rule ordering: a disabled source produces no row even when its deps would defer', async () => {
    const fix = await buildFixture({
      petitionerKits: [TESTER_KIT],
      config: { disabledSources: ['tester.dep'] },
    });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {}); // gating

    const originalDebug = console.debug;
    console.debug = () => {};
    try {
      const writ = await postHeld(fix, { dependsOn: [dep.id] });
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(
        rows.length,
        0,
        'disabled-source skip runs before the dep gate; no row',
      );
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'new');
    } finally {
      console.debug = originalDebug;
    }
  });

  // ── Case 12b: rule ordering — registration enforce → decline (no defer) ─

  it('rule ordering: registration enforcement declines (no dep-gate defer) for an unregistered source', async () => {
    const fix = await buildFixture({
      petitionerKits: [TESTER_KIT],
      config: { enforceRegistration: true },
    });

    const dep = await fix.clerk.post({ title: 'dep', body: 'b' });
    await fix.clerk.transition(dep.id, 'open', {}); // gating

    // Bypass the helper's registry guard by stamping ext via Clerk
    // directly with an unregistered source. The CDC handler then
    // takes the decline path before reaching the dep gate.
    const writ = await fix.clerk.post({ title: 't', body: 'b' });
    await fix.clerk.link(writ.id, dep.id, 'depends-on', 'depends-on');
    await fix.clerk.setWritExt(writ.id, 'reckoner', {
      source: 'unknown.source',
      priority: {
        visionRelation: 'vision-neutral',
        severity: 'minor',
        scope: 'minor-area',
        time: { decay: false, deadline: null },
        domain: [],
      },
    });

    const reread = await fix.clerk.show(writ.id);
    assert.equal(
      reread.phase,
      'cancelled',
      'registration-enforce decline runs before the dep gate',
    );

    const rows = await fix.reckoningsBook.find({
      where: [['writId', '=', writ.id]],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'declined');
    assert.equal(rows[0]!.declineReason, 'source_unregistered');
  });
});

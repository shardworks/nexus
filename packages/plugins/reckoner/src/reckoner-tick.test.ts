/**
 * Reckoner periodic-tick handler tests.
 *
 * Replaces the prior CDC-handler test file. Covers the behavioral
 * matrix the brief enumerates, every case driven through
 * `hooks.runTick()`:
 *
 *   1. Empty-candidate ticks — no rows, no errors.
 *   2. First tick after start picks up pre-existing held writs.
 *   3. `evaluate` throw isolation — apparatus stays up; no rows
 *      written; no transitions.
 *   4. Disabled-source mid-flight — the gate produces a `declined`
 *      row (`declineReason: 'source_banned'`) and a `cancelled`
 *      transition.
 *   5. Repeated-tick idempotency at unchanged updatedAt.
 *   6. Type-aware target-phase resolution against a non-mandate type
 *      whose active state is named differently.
 *   7. Withdrawal-mid-flight — the held writ has already moved out
 *      of `new` before the tick fires; no row is written.
 *   8. `defer` outcome writes a row with no transition; the row
 *      carries `deferReason: 'other'` and the decision's reason in
 *      `deferNote`.
 *   9. Pre-seal tick — the handler throws fail-loud naming the
 *      unresolved active scheduler.
 *  10. The unregistered-strict path still produces a decline row
 *      with `declineReason: 'source_unregistered'`.
 *
 * The fixture mirrors the scaffolding in `reckoner.test.ts`: real
 * Stacks + Clerk + Reckoner against `MemoryBackend`, with explicit
 * book pre-creation. Tests do not boot the Clockworks apparatus —
 * the tick handler's pure helper is driven directly through
 * `hooks.runTick`.
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
import type { ClerkApi, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createReckonerWithHooks } from './reckoner.ts';
import { alwaysApproveScheduler } from './schedulers/always-approve.ts';
import type {
  ReckoningDoc,
  ReckonerApi,
  ReckonerConfig,
  Scheduler,
  SchedulerDecision,
  SchedulerInput,
} from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  hooks: ReturnType<typeof createReckonerWithHooks>['hooks'];
  reckoningsBook: ReadOnlyBook<ReckoningDoc>;
  fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig };
  /**
   * Re-fire `phase:started` against the registered handlers. Awaits
   * any async handlers (the Reckoner's seal handler resolves the
   * active scheduler synchronously now that the catch-up scan is
   * gone, but `firePhaseStarted` is still awaited so the helper's
   * shape remains compatible with future async handlers).
   */
  firePhaseStarted: () => Promise<void>;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-tick-test-guild',
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
  schedulerKits?: Array<{ pluginId: string; value: Scheduler[] }>;
  config?: ReckonerConfig | undefined;
  writTypes?: WritTypeConfig[];
  /** When true, do not fire phase:started (pre-seal tests). */
  skipPhaseStarted?: boolean;
  /**
   * Optional seed callback run after Stacks + Clerk start but
   * before the Reckoner's start. Used by the catch-up tests to
   * pre-populate held writs that `phase:started` would normally
   * never have observed.
   */
  preStart?: (deps: { stacks: StacksApi; clerk: ClerkApi }) => Promise<void>;
}

async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const built = createReckonerWithHooks();
  const reckonerPlugin = built.plugin;

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig } = {
    name: 'reckoner-tick-test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.config !== undefined ? { reckoner: opts.config } : {}),
  };

  setGuild(buildFakeGuild(apparatusMap, fakeGuildConfig));

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

  await stacksPlugin.apparatus.start(buildCtx([]));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  if (opts.writTypes) {
    for (const config of opts.writTypes) {
      clerk.registerWritType(config);
    }
  }

  if (opts.preStart) {
    await opts.preStart({ stacks, clerk });
  }

  const petitionerKitEntries: KitEntry[] = (opts.petitionerKits ?? []).map(
    (entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'petitioners',
      value: entry.value,
    }),
  );

  // The fixture surfaces the Reckoner's own supportKit-contributed
  // schedulers entry (the always-approve instance) alongside any
  // test-provided schedulers. Arbor synthesises kit entries from
  // each apparatus's supportKit in production; the test mirrors
  // that responsibility by hand.
  const schedulerKitEntries: KitEntry[] = [
    {
      pluginId: 'reckoner',
      packageName: '@shardworks/reckoner-apparatus',
      type: 'schedulers',
      value: [alwaysApproveScheduler],
    },
    ...(opts.schedulerKits ?? []).map((entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'schedulers',
      value: entry.value,
    })),
  ];

  await reckonerPlugin.apparatus.start(
    buildCtx([...petitionerKitEntries, ...schedulerKitEntries]),
  );
  const reckoner = reckonerPlugin.apparatus.provides as ReckonerApi;
  apparatusMap.set('reckoner', reckoner);

  if (!opts.skipPhaseStarted) {
    await firePhaseStarted();
  }

  return {
    stacks,
    clerk,
    reckoner,
    hooks: built.hooks,
    reckoningsBook: stacks.readBook<ReckoningDoc>('reckoner', 'reckonings'),
    fakeGuildConfig,
    firePhaseStarted,
  };
}

const REGISTERED_PETITIONER = {
  pluginId: 'tester',
  value: [{ source: 'tester.kind', description: 'tester' }],
};

const VK_PETITIONER = {
  pluginId: 'vision-keeper',
  value: [{ source: 'vision-keeper.snapshot', description: 'snapshots' }],
};

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner periodic tick', () => {
  afterEach(() => clearGuild());

  // ── 1: empty-candidate tick ───────────────────────────────────────

  describe('empty candidate set', () => {
    it('writes nothing and throws nothing when no held writs are present', async () => {
      const fix = await buildFixture({ petitionerKits: [VK_PETITIONER] });
      // No writs posted yet.
      await fix.hooks.runTick();
      const allRows = await fix.reckoningsBook.find({});
      assert.equal(allRows.length, 0);
    });
  });

  // ── 2: first tick after start picks up pre-existing held writs ────

  describe('first tick after start', () => {
    it('processes held writs that pre-date the apparatus start', async () => {
      const fix = await buildFixture({
        petitionerKits: [VK_PETITIONER],
        async preStart({ clerk }) {
          // Seed a held writ before the Reckoner starts. Without a
          // catch-up scan, the writ remains in `new` until the
          // first tick fires.
          const w = await clerk.post({ title: 'pre-start', body: 'b' });
          await clerk.setWritExt(w.id, 'reckoner', {
            source: 'vision-keeper.snapshot',
            priority: {
              visionRelation: 'vision-neutral',
              severity: 'minor',
              scope: 'minor-area',
              time: { decay: false, deadline: null },
              domain: [],
            },
          });
        },
      });

      // The first tick after `phase:started` (fired during
      // buildFixture) auto-approves the writ.
      const allBefore = await fix.clerk.list({ limit: 100 });
      assert.equal(allBefore.length, 1);
      assert.equal(allBefore[0]!.phase, 'new', 'no transition yet — start does not auto-tick');

      await fix.hooks.runTick();

      const all = await fix.clerk.list({ limit: 100 });
      assert.equal(all.length, 1);
      const writ = all[0]!;
      assert.equal(writ.phase, 'open', 'first tick after start auto-approves the writ');

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'accepted');
    });
  });

  // ── 3: evaluate throw isolation ───────────────────────────────────

  describe('evaluate throw isolation', () => {
    it('logs fail-loud, leaves the writ in new, writes no row', async () => {
      const scheduler: Scheduler = {
        id: 'kit-a.bad-evaluate',
        description: 'throws on evaluate',
        async evaluate(): Promise<readonly SchedulerDecision[]> {
          throw new Error('evaluate deliberately threw');
        },
      };

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.bad-evaluate' },
      });

      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      // Guard: writ stays in `new` immediately after petition (no
      // CDC handler fires synchronously now).
      assert.equal((await fix.clerk.show(writ.id)).phase, 'new');

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        await fix.hooks.runTick();
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'new');
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 0);
        assert.ok(
          warnings.some(
            (w) =>
              /\[reckoner\] scheduler:/.test(w) &&
              /evaluate threw/.test(w) &&
              /skipping tick/.test(w),
          ),
          `expected fail-loud log line; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── 4: disabled-source mid-flight ─────────────────────────────────

  describe('disabled-source mid-flight', () => {
    it('produces a declined row with declineReason: source_banned and transitions to cancelled', async () => {
      const fix = await buildFixture({
        petitionerKits: [VK_PETITIONER],
      });

      // Step 1: petition with the source NOT yet in disabledSources.
      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'mid-flight ban',
        body: 'b',
      });
      assert.equal((await fix.clerk.show(writ.id)).phase, 'new');

      // Step 2: operator bans the source. The writ is still held in
      // `new`. The next tick should observe the disabled gate and
      // decline the writ.
      fix.fakeGuildConfig.reckoner = {
        ...fix.fakeGuildConfig.reckoner,
        disabledSources: ['vision-keeper.snapshot'],
      };

      await fix.hooks.runTick();

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'cancelled');
      assert.match(
        String(reread.resolution),
        /vision-keeper\.snapshot.*disabledSources/,
      );

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'declined');
      assert.equal(rows[0]!.declineReason, 'source_banned');
      assert.equal(rows[0]!.remediationHint, 'vision-keeper.snapshot');
    });
  });

  // ── 5: repeated-tick idempotency ──────────────────────────────────

  describe('repeated-tick idempotency', () => {
    it('produces exactly one row across multiple ticks at unchanged updatedAt', async () => {
      const fix = await buildFixture({
        petitionerKits: [VK_PETITIONER],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 'idempotent',
        body: 'b',
      });
      // First tick — auto-approves.
      await fix.hooks.runTick();
      const rowsAfterFirst = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rowsAfterFirst.length, 1);
      assert.equal(rowsAfterFirst[0]!.outcome, 'accepted');

      // Second + third ticks — no candidates remain (the writ has
      // moved to `open`). Idempotent at the writ-set level.
      await fix.hooks.runTick();
      await fix.hooks.runTick();
      const rowsAfterRepeat = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rowsAfterRepeat.length, 1);
    });
  });

  // ── 6: type-aware target-phase resolution ─────────────────────────

  describe('target-phase resolution', () => {
    it('picks `open` for mandate writs', async () => {
      const fix = await buildFixture({
        petitionerKits: [VK_PETITIONER],
      });
      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'open');
      assert.equal(reread.type, 'mandate');
    });

    it('picks the registered active state for a non-mandate type', async () => {
      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        writTypes: [
          {
            name: 'task',
            states: [
              {
                name: 'new',
                classification: 'initial',
                allowedTransitions: ['running', 'cancelled'],
              },
              {
                name: 'running',
                classification: 'active',
                allowedTransitions: ['done', 'cancelled'],
              },
              {
                name: 'done',
                classification: 'terminal',
                attrs: ['success'],
                allowedTransitions: [],
              },
              {
                name: 'cancelled',
                classification: 'terminal',
                attrs: ['cancelled'],
                allowedTransitions: [],
              },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        type: 'task',
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.type, 'task');
      assert.equal(
        reread.phase,
        'running',
        'non-mandate type lands in its registered active state, not `open`',
      );
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'accepted');
    });
  });

  // ── 7: withdrawal mid-flight ──────────────────────────────────────

  describe('withdrawal mid-flight', () => {
    it('produces no Reckonings row when the petitioner withdraws before the next tick', async () => {
      const fix = await buildFixture({
        petitionerKits: [VK_PETITIONER],
        config: { disabledSources: ['vision-keeper.snapshot'] },
      });

      // Disabled source: petition lands in `new`, no row, no
      // transition. Then the petitioner withdraws — moving the writ
      // out of `new` before the next tick fires. The tick must
      // observe no candidate (`phase !== 'new'`).
      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      await fix.reckoner.withdraw(writ.id, 'no longer relevant');
      await fix.hooks.runTick();

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 0, 'no row written for a withdrawn writ');

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'cancelled');
    });
  });

  // ── 8: defer outcome writes a row with no transition ──────────────

  describe('defer outcome', () => {
    it('writes a deferred row with deferReason: other and the decision reason in deferNote', async () => {
      const reason = 'capacity hold';
      const scheduler: Scheduler = {
        id: 'kit-a.deferer',
        description: 'always defers',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          return input.candidates.map((w) => ({
            writId: w.id,
            outcome: 'defer' as const,
            reason,
          }));
        },
      };

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.deferer' },
      });

      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'new', 'defer leaves writ in new');

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1, 'defer writes one row in the tick model');
      assert.equal(rows[0]!.outcome, 'deferred');
      assert.equal(rows[0]!.deferReason, 'other');
      assert.equal(rows[0]!.deferNote, reason);
    });
  });

  // ── 9: pre-seal tick fail-loud ────────────────────────────────────

  describe('pre-seal tick', () => {
    it('throws fail-loud when activeScheduler has not yet resolved', async () => {
      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        skipPhaseStarted: true,
      });
      assert.equal(fix.hooks.getActiveSchedulerId(), undefined);

      await assert.rejects(
        () => fix.hooks.runTick(),
        (err: Error) => {
          assert.match(err.message, /\[reckoner\] tick: activeScheduler not resolved/);
          assert.match(err.message, /phase:started has not fired/);
          return true;
        },
      );
    });
  });

  // ── 10: unregistered-strict decline ───────────────────────────────

  describe('unregistered + enforceRegistration: true', () => {
    it('declines the writ with declineReason: source_unregistered and a structured resolution', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { enforceRegistration: true },
      });

      // Bypass the petition helper's own strict check by writing
      // the ext directly via Clerk — the tick is what we're testing.
      const writ = await fix.clerk.post({ title: 't', body: 'b' });
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

      await fix.hooks.runTick();

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'cancelled');
      assert.match(
        String(reread.resolution),
        /\[reckoner\] declined: source 'unknown\.source' is not registered \(enforceRegistration: true\)\./,
      );

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'declined');
      assert.equal(rows[0]!.declineReason, 'source_unregistered');
      assert.equal(rows[0]!.remediationHint, 'unknown.source');
    });
  });

  // ── tickEventId stamping ──────────────────────────────────────────

  describe('tickEventId stamping', () => {
    it('stamps tickEventId from the triggering event id when present', async () => {
      const fix = await buildFixture({ petitionerKits: [VK_PETITIONER] });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      // Synthetic GuildEvent — only `id` is consulted by the
      // tick handler.
      await fix.hooks.runTick({
        id: 'e-test-tick-1',
        name: 'clockworks.timer',
        payload: null,
        emitter: 'framework',
        firedAt: new Date().toISOString(),
      });

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.tickEventId, 'e-test-tick-1');
    });

    it('omits tickEventId when no event is supplied', async () => {
      const fix = await buildFixture({ petitionerKits: [VK_PETITIONER] });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal('tickEventId' in rows[0]!, false);
    });
  });
});

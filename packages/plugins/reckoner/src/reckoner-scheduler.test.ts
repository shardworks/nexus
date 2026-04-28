/**
 * Reckoner scheduler-registry tests.
 *
 * Companion to `reckoner.test.ts` and `reckoner-tick.test.ts`. Targets
 * the registry-resolved scheduler call site driven by the tick
 * handler, and the kit-static scheduler registry. Covers every entry
 * in the commission's Acceptance Signal:
 *
 *   - duplicate scheduler id across two kits → fail-loud naming both
 *     kits;
 *   - malformed scheduler id (missing dot, wrong prefix, bad kebab) →
 *     fail-loud;
 *   - post-seal registration → throws sealed-registry error;
 *   - unset `reckoner.scheduler` → defaults to `reckoner.always-approve`
 *     with one info log;
 *   - set-but-unregistered `reckoner.scheduler` → fail-loud at startup
 *     listing every registered id;
 *   - `validateConfig` throw → log + skip, no row, no transition;
 *   - `evaluate` throw → log + skip;
 *   - multiple decisions for one writ id → log + skip;
 *   - non-candidate decisions → log + ignore;
 *   - pre-seal ticks → fail-loud throw (the silent-skip the v0
 *     CDC path used has been replaced with the loud guard);
 *   - approve / defer / decline outcomes map to the prescribed
 *     transitions and Reckonings rows (per the new tick model
 *     `defer` writes a row with `deferReason: 'other'`);
 *   - `weight` is threaded from a `SchedulerDecision` to the
 *     Reckonings row when present.
 *
 * The fixture mirrors the one in `reckoner-tick.test.ts`: real Stacks
 * + Clerk + Reckoner against `MemoryBackend`, with explicit book
 * pre-creation and a phase-started capable StartupContext. Every
 * "petition then observe outcome" entry now drives the tick path
 * via `hooks.runTick()`.
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
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

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

interface FixtureOptions {
  petitionerKits?: Array<{ pluginId: string; value: unknown }>;
  schedulerKits?: Array<{ pluginId: string; value: unknown }>;
  /** When true, do not include the built-in always-approve scheduler. */
  omitDefaultScheduler?: boolean;
  /** When true, do not fire phase:started after start (pre-seal tests). */
  skipPhaseStarted?: boolean;
  config?: ReckonerConfig | undefined;
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  hooks: ReturnType<typeof createReckonerWithHooks>['hooks'];
  reckoningsBook: ReadOnlyBook<ReckoningDoc>;
  fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig };
  firePhaseStarted: () => Promise<void>;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-scheduler-test-guild',
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

async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const built = createReckonerWithHooks();
  const reckonerPlugin = built.plugin;

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig & { reckoner?: ReckonerConfig } = {
    name: 'reckoner-scheduler-test-guild',
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

  await stacksPlugin.apparatus.start(buildCtx([]));
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  const petitionerKitEntries: KitEntry[] = (opts.petitionerKits ?? []).map(
    (entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'petitioners',
      value: entry.value,
    }),
  );

  const schedulerKitEntries: KitEntry[] = [];
  if (!opts.omitDefaultScheduler) {
    schedulerKitEntries.push({
      pluginId: 'reckoner',
      packageName: '@shardworks/reckoner-apparatus',
      type: 'schedulers',
      value: [alwaysApproveScheduler],
    });
  }
  for (const entry of opts.schedulerKits ?? []) {
    schedulerKitEntries.push({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'schedulers',
      value: entry.value,
    });
  }

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

/**
 * Compose a fully-typed scheduler instance from a partial; the
 * non-overridden fields default to the always-approve shape so each
 * test can replace exactly the surface it cares about.
 */
function makeScheduler(partial: Partial<Scheduler> & Pick<Scheduler, 'id'>): Scheduler {
  return {
    description: 'test scheduler',
    async evaluate(): Promise<readonly SchedulerDecision[]> {
      return [];
    },
    ...partial,
  };
}

const REGISTERED_PETITIONER = {
  pluginId: 'tester',
  value: [{ source: 'tester.kind', description: 'tester' }],
};

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner scheduler registry', () => {
  afterEach(() => clearGuild());

  // ── Validation: duplicate id across two kits ───────────────────────

  describe('duplicate id', () => {
    it('hard-fails at startup naming both contributing kits', async () => {
      // Suppress the petition-helper warning when the tester source
      // is unregistered (not relevant here).
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'kit-a.dup' })],
              },
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'kit-a.dup' })],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /duplicate id/i);
          assert.match(err.message, /kit-a\.dup/);
          assert.match(err.message, /already registered by kit/i);
          return true;
        },
      );
    });
  });

  // ── Validation: malformed id grammar ───────────────────────────────

  describe('malformed id grammar', () => {
    it('hard-fails when the id has no dot separator', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'no-dot' })],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /must be of the form/i);
          return true;
        },
      );
    });

    it('hard-fails when the prefix does not match the contributing plugin id', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'kit-b.something' })],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /must match the contributing plugin id/i);
          return true;
        },
      );
    });

    it('hard-fails when the kebab suffix is malformed', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'kit-a.Bad-Suffix' })],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /kebab-case/i);
          return true;
        },
      );
    });

    it('hard-fails when evaluate is missing', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [{ id: 'kit-a.broken', description: 'no eval' }],
              },
            ],
          }),
        (err: Error) => {
          assert.match(err.message, /"evaluate" must be a function/i);
          return true;
        },
      );
    });
  });

  // ── Post-seal registration ─────────────────────────────────────────

  describe('post-seal registration', () => {
    it('throws sealed-registry error when registerKitSchedulers runs after seal', async () => {
      const fix = await buildFixture({});
      // The fixture defaults to firing phase:started → registry sealed.
      assert.throws(
        () =>
          fix.hooks.registerKitSchedulers({
            pluginId: 'late-kit',
            value: [makeScheduler({ id: 'late-kit.tardy' })],
          }),
        (err: Error) => {
          assert.match(err.message, /startup registration window has closed/i);
          assert.match(err.message, /late-kit/);
          return true;
        },
      );
    });
  });

  // ── Selector: unset → defaults to always-approve ──────────────────

  describe('unset reckoner.scheduler', () => {
    it('defaults to reckoner.always-approve and emits one info log line', async () => {
      const originalInfo = console.info;
      const infoLines: string[] = [];
      console.info = (msg: unknown) => {
        infoLines.push(String(msg));
      };
      try {
        const fix = await buildFixture({});
        assert.equal(fix.hooks.getActiveSchedulerId(), 'reckoner.always-approve');
        assert.ok(
          infoLines.some(
            (l) =>
              l.includes('reckoner.always-approve') &&
              l.includes('no reckoner.scheduler configured'),
          ),
          `expected one info-level log line referencing the always-approve default; got: ${JSON.stringify(infoLines)}`,
        );
      } finally {
        console.info = originalInfo;
      }
    });
  });

  // ── Selector: set-but-unregistered → fail-loud ────────────────────

  describe('set-but-unregistered reckoner.scheduler', () => {
    it('fail-loud at startup with the offending id and every registered id', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            config: {
              scheduler: 'no-such.scheduler',
            },
          }),
        (err: Error) => {
          assert.match(err.message, /no-such\.scheduler/);
          assert.match(err.message, /not registered/i);
          assert.match(err.message, /reckoner\.always-approve/);
          return true;
        },
      );
    });

    it('fail-loud names every registered id when several are present', async () => {
      await assert.rejects(
        () =>
          buildFixture({
            schedulerKits: [
              {
                pluginId: 'kit-a',
                value: [makeScheduler({ id: 'kit-a.one' })],
              },
              {
                pluginId: 'kit-b',
                value: [makeScheduler({ id: 'kit-b.two' })],
              },
            ],
            config: {
              scheduler: 'no-such.scheduler',
            },
          }),
        (err: Error) => {
          assert.match(err.message, /kit-a\.one/);
          assert.match(err.message, /kit-b\.two/);
          assert.match(err.message, /reckoner\.always-approve/);
          return true;
        },
      );
    });
  });

  // ── Selector: explicit valid selector resolves ────────────────────

  describe('explicit valid reckoner.scheduler', () => {
    it('resolves to the named scheduler', async () => {
      const fix = await buildFixture({
        schedulerKits: [
          {
            pluginId: 'kit-a',
            value: [makeScheduler({ id: 'kit-a.custom' })],
          },
        ],
        config: {
          scheduler: 'kit-a.custom',
        },
      });
      assert.equal(fix.hooks.getActiveSchedulerId(), 'kit-a.custom');
      const ids = fix.hooks.getRegisteredSchedulerIds();
      assert.deepEqual(ids, ['kit-a.custom', 'reckoner.always-approve']);
    });
  });

  // ── runScheduler: validateConfig throw ────────────────────────────

  describe('validateConfig throw', () => {
    it('logs fail-loud and skips evaluation (no row, no transition)', async () => {
      const calls: unknown[] = [];
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.bad-validate',
        validateConfig(_raw: unknown): unknown {
          throw new Error('validateConfig deliberately threw');
        },
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          calls.push(input);
          return input.candidates.map((w) => ({
            writId: w.id,
            outcome: 'approve' as const,
            reason: 'should not be reached',
          }));
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.bad-validate' },
      });

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        const writ = await fix.reckoner.petition({
          source: 'tester.kind',
          title: 't',
          body: 'b',
        });
        await fix.hooks.runTick();
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'new', 'writ stays in new on validateConfig throw');
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 0, 'no row written on validateConfig throw');
        assert.equal(calls.length, 0, 'evaluate must not be called');
        assert.ok(
          warnings.some(
            (w) =>
              /\[reckoner\] scheduler:/.test(w) &&
              /validateConfig threw/.test(w),
          ),
          `expected fail-loud log line; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── tick: evaluate throw ──────────────────────────────────────────

  describe('evaluate throw', () => {
    it('logs fail-loud and skips evaluation', async () => {
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.bad-evaluate',
        async evaluate(): Promise<readonly SchedulerDecision[]> {
          throw new Error('evaluate deliberately threw');
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.bad-evaluate' },
      });

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        const writ = await fix.reckoner.petition({
          source: 'tester.kind',
          title: 't',
          body: 'b',
        });
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
              /evaluate threw/.test(w),
          ),
          `expected fail-loud log line; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── tick: multi-decision per writ id ──────────────────────────────

  describe('multi-decision per writ id', () => {
    it('logs fail-loud and skips applying any decision', async () => {
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.dupes',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          const id = input.candidates[0]!.id;
          return [
            { writId: id, outcome: 'approve', reason: 'first' },
            { writId: id, outcome: 'approve', reason: 'second' },
          ];
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.dupes' },
      });

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        const writ = await fix.reckoner.petition({
          source: 'tester.kind',
          title: 't',
          body: 'b',
        });
        await fix.hooks.runTick();
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'new', 'writ untouched on multi-decision');
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 0);
        assert.ok(
          warnings.some(
            (w) =>
              /\[reckoner\] scheduler:/.test(w) &&
              /returned 2 decisions/.test(w),
          ),
          `expected fail-loud log line; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── tick: stranger writId ─────────────────────────────────────────

  describe('non-candidate writ id in decisions', () => {
    it('warns and ignores the stranger decision while applying the in-scope one', async () => {
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.strangers',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          const id = input.candidates[0]!.id;
          return [
            { writId: 'w-stranger', outcome: 'approve', reason: 'not in candidates' },
            { writId: id, outcome: 'approve', reason: 'kit-a.strangers' },
          ];
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.strangers' },
      });

      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        const writ = await fix.reckoner.petition({
          source: 'tester.kind',
          title: 't',
          body: 'b',
        });
        await fix.hooks.runTick();
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'open', 'in-scope decision is applied');
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.outcome, 'accepted');
        assert.ok(
          warnings.some(
            (w) =>
              /\[reckoner\] scheduler:/.test(w) &&
              /w-stranger/.test(w) &&
              /not in the candidate set/.test(w),
          ),
          `expected stranger-decision warning; got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── Pre-seal tick fail-loud ────────────────────────────────────────

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
          return true;
        },
      );
    });

    it('the first tick after phase:started reprocesses pre-seal held writs', async () => {
      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        skipPhaseStarted: true,
      });
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        const writ = await fix.clerk.post({ title: 't', body: 'b' });
        await fix.clerk.setWritExt(writ.id, 'reckoner', {
          source: 'tester.kind',
          priority: {
            visionRelation: 'vision-neutral',
            severity: 'minor',
            scope: 'minor-area',
            time: { decay: false, deadline: null },
            domain: [],
          },
        });
        // Fire phase:started → registry seals, active scheduler
        // resolves. Then the first tick auto-approves the writ.
        await fix.firePhaseStarted();
        await fix.hooks.runTick();
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'open', 'first post-seal tick auto-approves the writ');
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.outcome, 'accepted');
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── Outcome mapping: approve ──────────────────────────────────────

  describe('outcome: approve', () => {
    it('transitions to active target and writes accepted row', async () => {
      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
      });
      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'open');
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'accepted');
    });
  });

  // ── Outcome mapping: defer ────────────────────────────────────────

  describe('outcome: defer', () => {
    it('leaves writ in new and writes a deferred row carrying deferReason: other (D3)', async () => {
      const reason = 'capacity hold';
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.defer',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          return input.candidates.map((w) => ({
            writId: w.id,
            outcome: 'defer' as const,
            reason,
          }));
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.defer' },
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
      assert.equal(rows.length, 1, 'defer writes a row in the tick model');
      assert.equal(rows[0]!.outcome, 'deferred');
      assert.equal(rows[0]!.deferReason, 'other');
      assert.equal(rows[0]!.deferNote, reason);
    });
  });

  // ── Outcome mapping: decline ──────────────────────────────────────

  describe('outcome: decline', () => {
    it('transitions to cancelled with reason; row carries declineReason: other and remediationHint', async () => {
      const reason = 'priority below floor';
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.decliner',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          return input.candidates.map((w) => ({
            writId: w.id,
            outcome: 'decline' as const,
            reason,
          }));
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.decliner' },
      });

      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'cancelled');
      assert.equal(reread.resolution, reason);

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'declined');
      assert.equal(rows[0]!.declineReason, 'other');
      assert.equal(rows[0]!.remediationHint, reason);
    });
  });

  // ── weight threading ──────────────────────────────────────────────

  describe('weight threading', () => {
    it('threads weight onto an accepted row when the decision carries it', async () => {
      const scheduler: Scheduler = makeScheduler({
        id: 'kit-a.weighted',
        async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
          return input.candidates.map((w) => ({
            writId: w.id,
            outcome: 'approve' as const,
            reason: 'weighted',
            weight: 4.2,
          }));
        },
      });

      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
        schedulerKits: [{ pluginId: 'kit-a', value: [scheduler] }],
        config: { scheduler: 'kit-a.weighted' },
      });

      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'accepted');
      assert.equal(rows[0]!.weight, 4.2);
    });

    it('omits weight on the row when the decision did not carry one', async () => {
      const fix = await buildFixture({
        petitionerKits: [REGISTERED_PETITIONER],
      });
      const writ = await fix.reckoner.petition({
        source: 'tester.kind',
        title: 't',
        body: 'b',
      });
      await fix.hooks.runTick();
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal('weight' in rows[0]!, false);
    });
  });
});

// Silence unused-import noise — WritDoc import documents intent.
type _Unused = WritDoc;
void (null as unknown as _Unused);

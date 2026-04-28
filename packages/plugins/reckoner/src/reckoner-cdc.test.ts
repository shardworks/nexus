/**
 * Reckoner CDC handler tests.
 *
 * Covers the eleven behavioral cases enumerated in the commission's
 * Acceptance Signal:
 *
 *   1. skip-not-in-new — the handler ignores writs whose phase is not
 *      `new`.
 *   2. skip-no-ext — the handler ignores writs lacking a reckoner ext.
 *   3. disabled-source debug-skip — no Reckonings row, no transition.
 *   4. unregistered-strict decline — emits a `'declined'` row with
 *      `declineReason: 'source_unregistered'` and a structured
 *      resolution string.
 *   5. unregistered-non-strict approve — accepts the petition.
 *   6. registered-source approve — accepts the petition; the row
 *      carries the lean projection.
 *   7. ext re-stamp re-evaluation gate — a meaningful ext change while
 *      still in `new` triggers a second consideration.
 *   8. CDC re-delivery idempotency — the same (writId, writUpdatedAt)
 *      pair produces exactly one row and one transition.
 *   9. startup catch-up scan — held writs pre-dating apparatus start
 *      are processed at boot.
 *  10. withdrawal-mid-flight — a petitioner-initiated cancellation
 *      produces no Reckonings row.
 *  11. type-aware target-phase resolution — the handler uses the
 *      writ-type config to pick the active target. Tested with
 *      `mandate` (target `'open'`) and a custom non-mandate type
 *      whose active state is named differently.
 *
 * The fixture mirrors the scaffolding in `reckoner.test.ts` — real
 * Stacks + Clerk + Reckoner against MemoryBackend, with explicit
 * book pre-creation for the books the apparatuses expect. The CDC
 * handler is invoked end-to-end through `clerk.setWritExt()`'s Phase 2
 * dispatch in most cases; the dedupe and re-delivery cases drive the
 * handler directly via `hooks.handleWritsChange()` to assert the
 * idempotency contract without racing against Stacks' coalescer.
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
  ChangeEvent,
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createReckonerWithHooks } from './reckoner.ts';
import { alwaysApproveScheduler } from './schedulers/always-approve.ts';
import type {
  ReckoningDoc,
  ReckonerApi,
  ReckonerConfig,
  Scheduler,
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
   * Re-fire `phase:started` against the registered handlers. Awaits
   * any async handlers (the Reckoner's seal handler runs the
   * catch-up scan async).
   */
  firePhaseStarted: () => Promise<void>;
}

function buildFakeGuild(
  apparatusMap: Map<string, unknown>,
  fakeGuildConfig: GuildConfig,
): Guild {
  return {
    home: '/tmp/reckoner-cdc-test-guild',
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
  /**
   * Additional `schedulers` kit contributions visible to the
   * Reckoner's `start()`, on top of the built-in
   * `reckoner.always-approve` instance the apparatus contributes
   * from its own supportKit. Tests that need to exercise a non-
   * default scheduler (decline / defer / weight / validateConfig)
   * supply their scheduler here.
   */
  schedulerKits?: Array<{ pluginId: string; value: Scheduler[] }>;
  config?: ReckonerConfig | undefined;
  /**
   * Optional writ types to register on the Clerk before the Reckoner
   * starts. Used to test type-aware target-phase resolution against a
   * non-mandate type.
   */
  writTypes?: WritTypeConfig[];
  /**
   * When set, callers can pre-seed writs into the writs book before
   * the Reckoner's `start()` runs — used to exercise the catch-up
   * scan path.
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
    name: 'reckoner-cdc-test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.config !== undefined ? { reckoner: opts.config } : {}),
  };

  setGuild(buildFakeGuild(apparatusMap, fakeGuildConfig));

  // Pre-create the books the Clerk needs — Stacks' Wire phase would do
  // this in production from the supportKit declarations.
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
  // Pre-create the Reckoner's reckonings book with the contract index
  // set so the handler's queries (and the dedupe lookup) hit indexed
  // columns the same way they would in production.
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
  await clerkPlugin.apparatus.start(buildCtx([]));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Register optional writ types before the Reckoner starts so the
  // type config is visible during catch-up scan and CDC dispatch.
  if (opts.writTypes) {
    for (const config of opts.writTypes) {
      clerk.registerWritType(config);
    }
  }

  // Optional pre-start seed (catch-up scan tests).
  if (opts.preStart) {
    await opts.preStart({ stacks, clerk });
  }

  // ── Reckoner ──────────────────────────────────────────────────────
  const petitionerKitEntries: KitEntry[] = (opts.petitionerKits ?? []).map(
    (entry) => ({
      pluginId: entry.pluginId,
      packageName: `@test/${entry.pluginId}`,
      type: 'petitioners',
      value: entry.value,
    }),
  );

  // Surface the Reckoner's own supportKit `schedulers` contribution
  // (the built-in always-approve instance) plus any test-supplied
  // schedulers. Arbor synthesises kit entries from each apparatus's
  // supportKit in production; the test fixture mirrors that
  // responsibility by hand.
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

  // Fire `phase:started` so the registry seals, the active
  // scheduler resolves, and the catch-up scan runs — the real Arbor
  // lifecycle does this for us in production. Tests that need to
  // exercise pre-seal behavior (CDC events arriving before
  // phase:started, etc.) call `hooks.handleWritsChange` against a
  // fresh fixture and rely on the activeScheduler-undefined guard.
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

// ── Tests ────────────────────────────────────────────────────────────

describe('Reckoner CDC handler', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── 1: skip-not-in-new ─────────────────────────────────────────────

  describe('rule: phase gate', () => {
    it('ignores writs whose phase is not `new`', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
      });

      // Post a writ via the petition helper to trigger the CDC
      // handler, then immediately drive it to a terminal state. The
      // CDC handler will fire on the post (via setWritExt), accept
      // it, and write a row. After the terminal transition fires
      // again, the handler must skip — no second row.
      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });

      // Row count after the auto-accept.
      const rowsAfterAccept = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(
        rowsAfterAccept.length,
        1,
        'auto-accept should produce exactly one row',
      );

      // Now transition the writ to a terminal state (cancelled). The
      // CDC handler should observe the update event but skip because
      // `phase !== 'new'`.
      await fix.clerk.transition(writ.id, 'cancelled', { resolution: 'r' });

      const rowsAfterCancel = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(
        rowsAfterCancel.length,
        1,
        'phase-gate skip must not write a second row',
      );
    });
  });

  // ── 2: skip-no-ext ─────────────────────────────────────────────────

  describe('rule: ext gate', () => {
    it('ignores writs that carry no reckoner ext slot', async () => {
      const fix = await buildFixture({ petitionerKits: [] });

      // Post a bare writ via Clerk (no Reckoner ext at all). Then
      // edit the title to fire an update CDC event with no ext
      // change — gate must reject (no row, no transition).
      const writ = await fix.clerk.post({ title: 't', body: 'b' });
      await fix.clerk.edit({ id: writ.id, title: 't2' });

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 0, 'no-ext writs must not produce rows');

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'new', 'no-ext writ stays in new');
    });
  });

  // ── 3: disabled-source debug-skip ──────────────────────────────────

  describe('rule: disabled-source skip', () => {
    it('does not write a row or transition when the source is disabled', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
        config: {
          disabledSources: ['vision-keeper.snapshot'],
        },
      });

      const originalDebug = console.debug;
      const debugLines: string[] = [];
      console.debug = (msg: unknown) => {
        debugLines.push(String(msg));
      };

      try {
        const writ = await fix.reckoner.petition({
          source: 'vision-keeper.snapshot',
          title: 't',
          body: 'b',
        });

        // No transition: writ stays in new.
        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'new', 'disabled-source writ stays in new');

        // No Reckonings row.
        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 0, 'disabled-source skip writes no row');

        // A debug log line must surface the skip.
        assert.ok(
          debugLines.some((l) =>
            /\[reckoner\] cdc:.*disabledSources/.test(l) &&
              l.includes('vision-keeper.snapshot'),
          ),
          `expected a debug-log line naming the disabled source; got: ${JSON.stringify(debugLines)}`,
        );
      } finally {
        console.debug = originalDebug;
      }
    });
  });

  // ── 4: unregistered-strict decline ────────────────────────────────

  describe('rule: enforceRegistration: true', () => {
    it('declines unregistered sources with source_unregistered and a structured resolution', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { enforceRegistration: true },
      });

      // The petition helper itself fail-loud rejects unregistered
      // sources under strict registration; to drive the CDC path,
      // post the writ + ext via Clerk's post-extension fast path so
      // the handler sees the held petition without going through
      // the helper's gate.
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

      // The CDC handler fired during setWritExt's Phase 2 dispatch.
      // The writ should now be cancelled with a structured
      // resolution.
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'cancelled');
      assert.match(
        String(reread.resolution),
        /\[reckoner\] declined: source 'unknown\.source' is not registered \(enforceRegistration: true\)\./,
      );

      // Reckonings row carries outcome + decline reason.
      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'declined');
      assert.equal(rows[0]!.declineReason, 'source_unregistered');
      assert.equal(rows[0]!.remediationHint, 'unknown.source');
      assert.equal(rows[0]!.source, 'unknown.source');
      assert.equal(rows[0]!.visionRelation, 'vision-neutral');
      assert.equal(rows[0]!.severity, 'minor');
      assert.equal(typeof rows[0]!.consideredAt, 'string');
      assert.equal(typeof rows[0]!.writUpdatedAt, 'string');
      assert.ok(rows[0]!.id.startsWith('rk-'));
    });
  });

  // ── 5: unregistered-non-strict approve ────────────────────────────

  describe('rule: enforceRegistration: false', () => {
    it('approves unregistered sources when registration is permissive', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { enforceRegistration: false },
      });

      // Suppress the petition helper's expected warning about an
      // unregistered source — keeps the test output clean without
      // changing behaviour.
      const originalWarn = console.warn;
      console.warn = () => {};

      try {
        const writ = await fix.reckoner.petition({
          source: 'unknown.source',
          title: 't',
          body: 'b',
        });

        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'open', 'permissive mode auto-approves');

        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.outcome, 'accepted');
        assert.equal(rows[0]!.source, 'unknown.source');
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ── 6: registered-source approve ──────────────────────────────────

  describe('rule: registered source', () => {
    it('approves registered sources and writes a lean Reckonings row', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
        priority: {
          visionRelation: 'vision-violator',
          severity: 'serious',
        },
      });

      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'open');

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.outcome, 'accepted');
      assert.equal(row.source, 'vision-keeper.snapshot');
      assert.equal(row.visionRelation, 'vision-violator');
      assert.equal(row.severity, 'serious');
      assert.equal(typeof row.consideredAt, 'string');
      assert.equal(typeof row.writUpdatedAt, 'string');
      assert.ok(row.id.startsWith('rk-'));
      // No reason metadata on accepted rows.
      assert.equal(row.declineReason, undefined);
      assert.equal(row.deferReason, undefined);
    });
  });

  // ── 7: ext re-stamp re-evaluation gate ─────────────────────────────

  describe('rule: re-firing gate (D14)', () => {
    it('re-evaluates a held writ when its ext.reckoner changes meaningfully', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'tester',
            value: [{ source: 'tester.kind', description: 'tester' }],
          },
        ],
        // First ext stamp will use a disabled source — the handler
        // skips at the disabled gate (no row, no transition). Second
        // ext stamp swaps the source to a registered one, which the
        // re-firing gate must observe as a meaningful change so the
        // accept path runs.
        config: { disabledSources: ['blocked.kind'] },
      });

      // Suppress the petition helper's expected unregistered warning
      // for the first stamp.
      const originalWarn = console.warn;
      console.warn = () => {};
      const originalDebug = console.debug;
      console.debug = () => {};

      try {
        // Post a writ and stamp an ext with a disabled source. The
        // CDC handler runs but skips at the disabled-source gate.
        const writ = await fix.clerk.post({ title: 't', body: 'b' });
        await fix.clerk.setWritExt(writ.id, 'reckoner', {
          source: 'blocked.kind',
          priority: {
            visionRelation: 'vision-neutral',
            severity: 'minor',
            scope: 'minor-area',
            time: { decay: false, deadline: null },
            domain: [],
          },
        });

        // No row, no transition — writ stays in `new`.
        const afterFirstStamp = await fix.clerk.show(writ.id);
        assert.equal(afterFirstStamp.phase, 'new');
        const rowsAfterFirstStamp = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rowsAfterFirstStamp.length, 0);

        // Re-stamp ext with a registered source. The CDC handler
        // observes a meaningful ext change while phase is still
        // `new`, runs the rule sequence again, and approves.
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

        const afterSecondStamp = await fix.clerk.show(writ.id);
        assert.equal(
          afterSecondStamp.phase,
          'open',
          'meaningful ext change re-fires the rule sequence',
        );
        const rowsAfterSecond = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rowsAfterSecond.length, 1);
        assert.equal(rowsAfterSecond[0]!.outcome, 'accepted');
        assert.equal(rowsAfterSecond[0]!.source, 'tester.kind');
      } finally {
        console.warn = originalWarn;
        console.debug = originalDebug;
      }
    });

    it('does not re-fire when neither phase nor ext.reckoner changes', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
      });

      // Post + auto-accept.
      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      const accepted = await fix.clerk.show(writ.id);
      assert.equal(accepted.phase, 'open');

      const rowsAfterAccept = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rowsAfterAccept.length, 1);

      // Synthesise an unrelated update event — phase unchanged,
      // ext.reckoner unchanged. Handler must short-circuit at the
      // gate.
      const evt: ChangeEvent<WritDoc> = {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        prev: accepted,
        entry: { ...accepted, title: 'edited' },
      };
      await fix.hooks.handleWritsChange(evt);

      const rowsAfter = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rowsAfter.length, 1, 'unrelated update must not produce a row');
    });
  });

  // ── 8: CDC re-delivery idempotency ─────────────────────────────────

  describe('idempotency: same (writId, writUpdatedAt) twice', () => {
    it('produces exactly one row and one transition under same-event replay', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });

      // The CDC handler fired during setWritExt's Phase 2 dispatch
      // and accepted the writ. Re-deliver the same update event by
      // hand — synthesised against the writ's pre-handler snapshot
      // so the gate observes a meaningful ext change but the dedupe
      // identity (writId, writUpdatedAt) matches the row we already
      // wrote.
      const evt: ChangeEvent<WritDoc> = {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        prev: { ...writ, ext: undefined },
        entry: writ,
      };
      await fix.hooks.handleWritsChange(evt);

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1, 'replay must dedupe on (writId, writUpdatedAt)');

      const reread = await fix.clerk.show(writ.id);
      assert.equal(
        reread.phase,
        'open',
        'replay must not produce a second transition (which would fail anyway)',
      );
    });
  });

  // ── 9: startup catch-up scan ───────────────────────────────────────

  describe('startup catch-up scan', () => {
    it('processes held writs that pre-date apparatus startup', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
        // Seed a held writ before the Reckoner starts. The handler
        // is not yet registered, so the post + setWritExt's Phase 2
        // dispatch finds zero subscribers and the writ remains in
        // `new` until the catch-up scan runs during start().
        async preStart({ clerk }) {
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

      // After start(), the catch-up scan has run; the held writ
      // should be transitioned and a row should exist.
      const all = await fix.clerk.list({ limit: 100 });
      assert.equal(all.length, 1);
      const writ = all[0]!;
      assert.equal(writ.phase, 'open', 'catch-up scan auto-approves the writ');

      const rows = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'accepted');

      // Re-running the catch-up scan must not produce a second row —
      // the writ's phase is no longer `new`, so it short-circuits at
      // the phase gate.
      await fix.hooks.runCatchUpScan();
      const rowsAfter = await fix.reckoningsBook.find({
        where: [['writId', '=', writ.id]],
      });
      assert.equal(rowsAfter.length, 1, 'idempotent across repeated scans');
    });
  });

  // ── 10: withdrawal-mid-flight ──────────────────────────────────────

  describe('withdrawal mid-flight', () => {
    it('produces no Reckonings row when the petitioner cancels a held writ before the handler runs', async () => {
      const fix = await buildFixture({
        petitionerKits: [],
        config: { disabledSources: ['vision-keeper.snapshot'] },
      });

      // Suppress the disabled-source debug log line.
      const originalDebug = console.debug;
      console.debug = () => {};

      try {
        const writ = await fix.reckoner.petition({
          source: 'vision-keeper.snapshot',
          title: 't',
          body: 'b',
        });

        // The handler skipped at the disabled-source gate, so the
        // writ remains in `new`. Now have the petitioner withdraw
        // it — the handler observes the update event but skips
        // because phase is no longer `new`, and writes no row.
        await fix.reckoner.withdraw(writ.id, 'no longer relevant');

        const rows = await fix.reckoningsBook.find({
          where: [['writId', '=', writ.id]],
        });
        assert.equal(rows.length, 0, 'no row on withdrawal-mid-flight');

        const reread = await fix.clerk.show(writ.id);
        assert.equal(reread.phase, 'cancelled');
      } finally {
        console.debug = originalDebug;
      }
    });
  });

  // ── 11: type-aware target-phase resolution ─────────────────────────

  describe('target-phase resolution', () => {
    it('picks `open` for mandate writs', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'vision-keeper',
            value: [
              { source: 'vision-keeper.snapshot', description: 'snapshots' },
            ],
          },
        ],
      });

      const writ = await fix.reckoner.petition({
        source: 'vision-keeper.snapshot',
        title: 't',
        body: 'b',
      });
      const reread = await fix.clerk.show(writ.id);
      assert.equal(reread.phase, 'open');
      assert.equal(reread.type, 'mandate');
    });

    it('picks the registered active state for a non-mandate type', async () => {
      const fix = await buildFixture({
        petitionerKits: [
          {
            pluginId: 'tester',
            value: [{ source: 'tester.kind', description: 'tester' }],
          },
        ],
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
});

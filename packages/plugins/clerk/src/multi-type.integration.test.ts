/**
 * Multi-type writ machinery — end-to-end integration test.
 *
 * Canonical reference for plugin authors adding a new writ type. Registers
 * a deliberately divergent test-only `task` type via the production-mirror
 * registration path (`makeWritTypeApparatus` fed through
 * `extraApparatuses`) and exercises the full multi-type lifecycle against
 * a real Clerk, real Stacks, and real writ documents in an in-memory
 * guild. Mandate is not the special case the abstraction was built around;
 * `task` proves that.
 *
 * Coverage checklist (one passing test per scenario):
 *
 *   1. Type registration + writ acceptance — `clerk.post({ type: 'task' })`
 *      lands the writ in the declared initial state `pending`.
 *   2. Legal transition — `pending → running` via `clerk.transition()`
 *      succeeds and the returned doc reflects the new phase.
 *   3. Illegal transition — `pending → done` (skipping `running`) is
 *      rejected with the T2 rejection-message shape: writ id, current
 *      state, attempted target, and the literal legal-target list.
 *   4. allSuccess cascade — every child reaches `done`; parent lifts to
 *      `done` and (negative assertion) parent's `resolution` is undefined
 *      because the test type's `allSuccess` action omits `copyResolution`.
 *   5. anyFailure cascade with copyResolution — one child enters `errored`
 *      with a known resolution; parent lifts to `errored` carrying the
 *      child's resolution string verbatim.
 *   6. anyFailure short-circuits allSuccess — two children commit in a
 *      single `stacks.transaction(...)`, one to `done` and one to
 *      `errored`; parent ends `errored`, not `done`, with the failing
 *      child's resolution copied.
 *   7. Idempotency no-op — parent is driven directly into `errored`; a
 *      subsequent terminal child event neither throws nor overwrites the
 *      parent's phase or resolution.
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

import { createClerk } from './clerk.ts';
import type { ClerkApi, WritDoc } from './types.ts';
import type { WritTypeConfig } from './writ-type-config.ts';
import { makeWritTypeApparatus } from './testing.ts';

// ── Test-only writ type ──────────────────────────────────────────────
//
// `task` is the lab specimen for this file. Its vocabulary is
// deliberately divergent from mandate's so that nothing in the
// multi-type machinery can secretly key on mandate state names: the
// state machine declares `pending`/`running`/`done`/`errored` (no
// `new`/`open`/`completed`/`failed`/`stuck`/`cancelled`).
//
// childrenBehavior is also deliberately divergent from mandate's:
//   - allSuccess fires `transition: 'done'` *without* `copyResolution`,
//     exercising the no-copy path that mandate's MANDATE_CONFIG never
//     reaches.
//   - anyFailure fires `transition: 'errored'` *with*
//     `copyResolution: true`, mirroring the standard upward-cascade
//     semantics.
//
// Reachability: both cascade targets (`done`, `errored`) are reachable
// from every non-terminal state (`pending`, `running`) via the declared
// `allowedTransitions`, so the validator's reachability check accepts
// the configuration. `pending → done` is *not* a direct edge —
// `pending` may only enter `running` or `errored` directly. That gap is
// exactly what scenario 3 (the illegal-transition test) exercises.
const TASK_CONFIG: WritTypeConfig = {
  name: 'task',
  states: [
    {
      name: 'pending',
      classification: 'initial',
      allowedTransitions: ['running', 'errored'],
    },
    {
      name: 'running',
      classification: 'active',
      allowedTransitions: ['done', 'errored'],
    },
    {
      name: 'done',
      classification: 'terminal',
      attrs: ['success'],
      allowedTransitions: [],
    },
    {
      name: 'errored',
      classification: 'terminal',
      attrs: ['failure'],
      allowedTransitions: [],
    },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'done' },
    anyFailure: { transition: 'errored', copyResolution: true },
  },
};

// ── Fixture ──────────────────────────────────────────────────────────
//
// Self-contained boot of a real MemoryBackend, real Stacks apparatus,
// and real Clerk apparatus, trimmed to the minimum the test type needs:
// just stacks + clerk + the test-only `task` apparatus. Type registration
// goes through `makeWritTypeApparatus(...)` fed in via `extraApparatuses`,
// which is the production-mirror path a real plugin author would follow.
//
// `phase:started` is intentionally not fired — none of the seven
// scenarios depend on the registration window having sealed.

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(
  apparatuses: LoadedApparatus[] = [],
): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({
        pluginId: app.id,
        packageName: app.packageName,
        type,
        value,
      });
    }
  }
  return entries;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
}

async function buildFixture(): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');

  // The `task` writ type is registered via the production-mirror path: a
  // tiny `LoadedApparatus` whose `start()` calls
  // `clerk.registerWritType(TASK_CONFIG)`. This is the contract a future
  // plugin author will follow when introducing a new writ type.
  const taskTypeApparatus: LoadedApparatus = makeWritTypeApparatus(
    [TASK_CONFIG],
    { id: 'multi-type-test-fixture' },
  );

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'multi-type-test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/multi-type-test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
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
      return [taskTypeApparatus];
    },
    failedPlugins() {
      return [];
    },
    startupWarnings(): string[] {
      return [];
    },
  };
  setGuild(fakeGuild);

  // ── Stacks ─────────────────────────────────────────────────────
  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the books the Clerk's start() expects. Indexes mirror
  // the supportKit shape declared on the Clerk apparatus so the in-
  // memory backend agrees with the production wiring.
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

  // ── Clerk ──────────────────────────────────────────────────────
  // Wire-phase kit entries derived from the test-type apparatus's
  // supportKit (it has none today, but the helper is shaped to flow
  // them through if a future test type adds them).
  const clerkKitEntries = buildKitEntries([taskTypeApparatus]);
  await clerkPlugin.apparatus.start(buildCtx(clerkKitEntries));
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Test-type apparatus (production-mirror registration path) ─
  // The Clerk's registration window is open from the end of clerk's
  // own start() until `phase:started` fires. We never fire that event
  // (D10), so calling registerWritType from the apparatus's start()
  // here registers the type before any test runs.
  await taskTypeApparatus.apparatus.start(buildCtx());

  return { stacks, clerk };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('multi-type writ machinery — task-type integration', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Scenario 1: type registration + writ acceptance ─────────────
  it('accepts a writ of the registered task type and lands it in the declared initial state', async () => {
    const writ: WritDoc = await fix.clerk.post({
      type: 'task',
      title: 'do a thing',
      body: 'detail',
    });

    assert.equal(writ.type, 'task');
    assert.equal(writ.phase, 'pending');
    assert.equal(writ.resolution, undefined);
    assert.equal(writ.resolvedAt, undefined);

    // The type is also visible through the registry projection — confirms
    // the registration apparatus actually plumbed through the production
    // path, not a bypass route.
    const types = fix.clerk.listWritTypes();
    const taskType = types.find((t) => t.name === 'task');
    assert.ok(taskType, 'task type must appear in listWritTypes() projection');
    assert.equal(taskType.source, 'plugin');
  });

  // ── Scenario 2: legal transition ────────────────────────────────
  it('accepts a legal transition (pending → running) and reflects the new phase on the returned doc', async () => {
    const writ = await fix.clerk.post({
      type: 'task',
      title: 'do a thing',
      body: 'detail',
    });

    const after = await fix.clerk.transition(writ.id, 'running');
    assert.equal(after.id, writ.id);
    assert.equal(after.phase, 'running');
    // running is non-terminal — no resolvedAt should be set.
    assert.equal(after.resolvedAt, undefined);
  });

  // ── Scenario 3: illegal transition rejected with the T2 shape ───
  it('rejects an illegal transition (pending → done, skipping running) with the T2 rejection-message shape', async () => {
    const writ = await fix.clerk.post({
      type: 'task',
      title: 'skip a state',
      body: 'detail',
    });

    await assert.rejects(
      () => fix.clerk.transition(writ.id, 'done'),
      (err: Error) => {
        // The Clerk's `transition()` produces a precisely-shaped error
        // (see clerk.ts) — assert it literally so the new test wedges
        // against any drift in the rejection vocabulary.
        const expected =
          `Cannot transition writ "${writ.id}" from "pending" to "done": ` +
          `legal transitions from "pending" are "running", "errored".`;
        assert.equal(err.message, expected);
        return true;
      },
    );

    // The rejection must be observable on the writ — pending stays pending.
    const after = await fix.clerk.show(writ.id);
    assert.equal(after.phase, 'pending');
  });

  // ── Scenario 4: allSuccess cascade — every child reaches `done` ─
  //
  // The test-only `task` type's `allSuccess` action declares
  // `transition: 'done'` *without* `copyResolution` — the negative
  // assertion (parent.resolution === undefined) is the contract this
  // scenario was designed to surface. Mandate's MANDATE_CONFIG sets
  // `copyResolution: true` on its allSuccess trigger, so the no-copy
  // path was previously untested.
  //
  // The parent is moved to `running` before the cascade fires because
  // the test type only declares `running → done` as a direct edge —
  // the cascade engine drives the parent through `transition()`, which
  // enforces single-step `allowedTransitions` per the writ-type config.
  it('lifts the parent task to `done` (no resolution copied) when every child reaches a success-attr terminal state', async () => {
    const parent = await fix.clerk.post({
      type: 'task',
      title: 'parent',
      body: 'B',
    });
    const c1 = await fix.clerk.post({
      type: 'task',
      title: 'C1',
      body: 'B',
      parentId: parent.id,
    });
    const c2 = await fix.clerk.post({
      type: 'task',
      title: 'C2',
      body: 'B',
      parentId: parent.id,
    });

    // Move the parent into `running` so the cascade engine's eventual
    // `running → done` transition is a legal single-step edge.
    await fix.clerk.transition(parent.id, 'running');

    // Drive the children through running → done. The first child's
    // completion alone does not lift the parent — the second is still
    // active.
    await fix.clerk.transition(c1.id, 'running');
    await fix.clerk.transition(c1.id, 'done', { resolution: 'first-done' });
    const mid = await fix.clerk.show(parent.id);
    assert.equal(mid.phase, 'running', 'parent stays running while a sibling is still active');

    await fix.clerk.transition(c2.id, 'running');
    await fix.clerk.transition(c2.id, 'done', { resolution: 'second-done' });

    const after = await fix.clerk.show(parent.id);
    assert.equal(after.phase, 'done', 'allSuccess fires when every child carries the success attr');
    // Negative assertion (D11) — the test type's allSuccess action
    // omits copyResolution, so the parent's resolution must remain
    // undefined even though the triggering child carried one.
    assert.equal(after.resolution, undefined,
      'allSuccess without copyResolution must leave parent.resolution unset');
  });

  // ── Scenario 5: anyFailure cascade with copyResolution ──────────
  it('lifts the parent task to `errored` and copies the failing child resolution onto the parent', async () => {
    const parent = await fix.clerk.post({
      type: 'task',
      title: 'parent',
      body: 'B',
    });
    const c1 = await fix.clerk.post({
      type: 'task',
      title: 'C1',
      body: 'B',
      parentId: parent.id,
    });
    // A second child stays in `pending` — the test asserts that
    // anyFailure fires on the first failure regardless of sibling
    // state. The test type's anyFailure carries copyResolution: true,
    // so the failing child's resolution string must end up on the
    // parent verbatim.
    await fix.clerk.post({
      type: 'task',
      title: 'C2',
      body: 'B',
      parentId: parent.id,
    });

    await fix.clerk.transition(c1.id, 'errored', { resolution: 'kaboom' });

    const after = await fix.clerk.show(parent.id);
    assert.equal(after.phase, 'errored');
    assert.equal(after.resolution, 'kaboom',
      'anyFailure with copyResolution must propagate the triggering child\'s resolution string');
  });

  // ── Scenario 6: anyFailure short-circuits allSuccess in one tx ──
  //
  // Two terminal child transitions committed inside one Stacks
  // transaction. Whichever order the underlying CDC fires, anyFailure
  // must win — the parent ends `errored`, not `done`, and the failing
  // child's resolution is the one that survives. Single-transaction
  // commit is strictly stronger than sequential commits because both
  // outcomes become visible inside the same atomic boundary.
  //
  // Both children are moved to `running` first because the test type
  // declares `done` as reachable only from `running`. The parent stays
  // in `pending` — the cascade target `errored` is reachable directly
  // from `pending`, which exercises the engine's pending-state cascade
  // path.
  it('anyFailure wins over allSuccess when mixed terminal events commit in the same transaction', async () => {
    const parent = await fix.clerk.post({
      type: 'task',
      title: 'parent',
      body: 'B',
    });
    const c1 = await fix.clerk.post({
      type: 'task',
      title: 'C1',
      body: 'B',
      parentId: parent.id,
    });
    const c2 = await fix.clerk.post({
      type: 'task',
      title: 'C2',
      body: 'B',
      parentId: parent.id,
    });

    // Children must be `running` before they can reach `done`.
    await fix.clerk.transition(c1.id, 'running');
    await fix.clerk.transition(c2.id, 'running');

    await fix.stacks.transaction(async () => {
      await fix.clerk.transition(c1.id, 'done', { resolution: 'success-bro' });
      await fix.clerk.transition(c2.id, 'errored', { resolution: 'crashed' });
    });

    const after = await fix.clerk.show(parent.id);
    assert.equal(after.phase, 'errored',
      'anyFailure precedence — parent must end errored, not done');
    assert.equal(after.resolution, 'crashed',
      'parent must carry the failing child\'s resolution, not the succeeding one\'s');
  });

  // ── Scenario 7: idempotent no-op on already-terminal parent ─────
  //
  // Drive the parent into a terminal state directly (D8) so the
  // subsequent terminal-child event hits the engine's "parent is
  // already terminal" short-circuit (rule 8). The parent must remain
  // unchanged — same phase, same resolution, no thrown error — and
  // the child must still terminate normally.
  //
  // The child is moved through `running → done` so the success-attr
  // cascade path runs; the parent's already-terminal short-circuit
  // (engine rule 8) keeps it unchanged.
  it('is idempotent — child terminal events on an already-terminal parent are no-ops', async () => {
    const parent = await fix.clerk.post({
      type: 'task',
      title: 'parent',
      body: 'B',
    });
    const c1 = await fix.clerk.post({
      type: 'task',
      title: 'C1',
      body: 'B',
      parentId: parent.id,
    });

    // Manual terminal — pending → errored is a legal direct edge;
    // no cascade fires at this point (no terminating children yet).
    await fix.clerk.transition(parent.id, 'errored', { resolution: 'manual-fail' });

    // Subsequent terminal child event must NOT throw and must NOT
    // overwrite the parent's phase or resolution. The child still
    // needs to traverse `running → done` because pending → done is
    // not a direct edge.
    await fix.clerk.transition(c1.id, 'running');
    await fix.clerk.transition(c1.id, 'done', { resolution: 'late-win' });

    const afterParent = await fix.clerk.show(parent.id);
    assert.equal(afterParent.phase, 'errored',
      'already-terminal parent phase must survive subsequent child terminal events');
    assert.equal(afterParent.resolution, 'manual-fail',
      'already-terminal parent resolution must survive subsequent child terminal events');

    const afterChild = await fix.clerk.show(c1.id);
    assert.equal(afterChild.phase, 'done', 'child still terminates normally');
    assert.equal(afterChild.resolution, 'late-win');
  });
});

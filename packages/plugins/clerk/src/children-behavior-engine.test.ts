/**
 * Direct unit tests for `createChildrenBehaviorEngine`.
 *
 * These tests construct the engine factory with minimal in-memory fakes for
 * the writs book and the registry accessor, exercise the handler against
 * synthetic CDC events, and assert directly against the resulting calls
 * into `transition`. No Clerk fixture is booted — the unit boundary is
 * the factory, the CDC event shape, and the four injected callbacks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ChangeEvent, Book, BookQuery } from '@shardworks/stacks-apparatus';

import { createChildrenBehaviorEngine } from './children-behavior-engine.ts';
import type { WritDoc, WritPhase } from './types.ts';
import type { WritTypeConfig } from './writ-type-config.ts';

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * A mandate-shaped writ-type config that opts into both childrenBehavior
 * triggers with `copyResolution: true`. Used as the default parent type.
 */
const MANDATE_TYPE: WritTypeConfig = {
  name: 'mandate',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'completed', copyResolution: true },
    anyFailure: { transition: 'failed', copyResolution: true },
  },
};

/**
 * A type identical in shape to mandate but declaring no childrenBehavior.
 * Used to verify the silent no-op when the parent type opts out.
 */
const NO_CASCADE_TYPE: WritTypeConfig = {
  name: 'no-cascade',
  states: MANDATE_TYPE.states,
};

interface TransitionCall {
  id: string;
  to: WritPhase;
  fields?: Partial<WritDoc>;
}

interface SetWritStatusCall {
  writId: string;
  pluginId: string;
  value: unknown;
}

/**
 * Unified call log entry. The engine harness records transition and
 * setWritStatus calls into a single ordered list so tests can assert the
 * relative ordering between the two (the dedupe-key invariant — the
 * Reckoner reads `status['clerk']` from the post-commit snapshot of the
 * terminal-transition CDC event, so the status write must precede the
 * transition).
 */
type EngineCall =
  | ({ kind: 'transition' } & TransitionCall)
  | ({ kind: 'setWritStatus' } & SetWritStatusCall);

interface Harness {
  writsById: Map<string, WritDoc>;
  configByName: Map<string, WritTypeConfig>;
  /**
   * All engine-driven mutation calls in the order they were issued. Allows
   * tests to assert the engine's status-write precedes the transition (the
   * dedupe-key invariant: the Reckoner reads `status['clerk']` from the
   * post-commit snapshot of the terminal-transition CDC event).
   */
  calls: EngineCall[];
  /** Convenience projection — the transition calls only, in order. */
  transitionCalls: TransitionCall[];
  /** Convenience projection — the setWritStatus calls only, in order. */
  statusCalls: SetWritStatusCall[];
  handle: (event: ChangeEvent<WritDoc>) => Promise<void>;
}

function makeWrit(partial: Partial<WritDoc> & { id: string; type: string; phase: string }): WritDoc {
  return {
    title: 'Test',
    body: 'Body',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...partial,
  } as WritDoc;
}

function makeUpdateEvent(
  entry: WritDoc,
  prev: WritDoc,
): ChangeEvent<WritDoc> {
  return {
    type: 'update',
    ownerId: 'clerk',
    book: 'writs',
    entry,
    prev,
  };
}

/**
 * Build a minimal harness: an in-memory writs map (with a `Book`-shaped
 * surface that supports `get` and a `parentId =` find), a registry map,
 * and a transition recorder. The returned `handle` is the engine handler.
 */
function makeHarness(opts: {
  writs: WritDoc[];
  configs: WritTypeConfig[];
}): Harness {
  const writsById = new Map<string, WritDoc>();
  for (const w of opts.writs) writsById.set(w.id, w);

  const configByName = new Map<string, WritTypeConfig>();
  for (const c of opts.configs) configByName.set(c.name, c);

  const calls: EngineCall[] = [];

  const writsBook = {
    async get(id: string) {
      return writsById.get(id) ?? null;
    },
    async find(query: BookQuery) {
      // Engine only ever calls with [['parentId', '=', parentId]].
      const where = query.where;
      if (!Array.isArray(where)) return [];
      const parentClause = where.find(
        (c: unknown) => Array.isArray(c) && (c as unknown[])[0] === 'parentId' && (c as unknown[])[1] === '=',
      ) as [string, string, string] | undefined;
      if (!parentClause) return [];
      const parentId = parentClause[2];
      return [...writsById.values()].filter((w) => w.parentId === parentId);
    },
  } as unknown as Book<WritDoc>;

  function isTerminal(writ: WritDoc): boolean {
    const config = configByName.get(writ.type);
    if (!config) {
      throw new Error(`type "${writ.type}" not registered`);
    }
    const state = config.states.find((s) => s.name === writ.phase);
    if (!state) {
      throw new Error(`state "${writ.phase}" not declared`);
    }
    return state.classification === 'terminal';
  }

  const handle = createChildrenBehaviorEngine({
    writs: writsBook,
    getWritTypeConfig(name: string) {
      return configByName.get(name);
    },
    isTerminal,
    async transition(id, to, fields) {
      calls.push({ kind: 'transition', id, to, fields } as EngineCall);
      const existing = writsById.get(id);
      if (!existing) throw new Error(`transition: writ "${id}" missing`);
      const next: WritDoc = {
        ...existing,
        phase: to,
        ...(fields ?? {}),
      };
      writsById.set(id, next);
      return next;
    },
    async setWritStatus(writId, pluginId, value) {
      calls.push({ kind: 'setWritStatus', writId, pluginId, value } as EngineCall);
      const existing = writsById.get(writId);
      if (!existing) throw new Error(`setWritStatus: writ "${writId}" missing`);
      const prevStatus = (existing.status ?? {}) as Record<string, unknown>;
      const nextStatus: Record<string, unknown> = { ...prevStatus, [pluginId]: value };
      const next: WritDoc = { ...existing, status: nextStatus };
      writsById.set(writId, next);
      return next;
    },
  });

  // Lazy projections — the tests assert on `transitionCalls`/`statusCalls`
  // after `handle()` has run, so each access re-filters the unified `calls`
  // array. Exposed through getters so the existing test syntax
  // (`h.transitionCalls.length`) continues to read the latest state.
  return {
    writsById,
    configByName,
    calls,
    get transitionCalls(): TransitionCall[] {
      return calls
        .filter((c) => c.kind === 'transition')
        .map((c) => {
          const t = c as { id: string; to: WritPhase; fields?: Partial<WritDoc> };
          return { id: t.id, to: t.to, fields: t.fields };
        });
    },
    get statusCalls(): SetWritStatusCall[] {
      return calls
        .filter((c) => c.kind === 'setWritStatus')
        .map((c) => {
          const s = c as { writId: string; pluginId: string; value: unknown };
          return { writId: s.writId, pluginId: s.pluginId, value: s.value };
        });
    },
    handle,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('createChildrenBehaviorEngine() — firing rule short-circuits', () => {
  it('ignores create events', async () => {
    const h = makeHarness({ writs: [], configs: [MANDATE_TYPE] });
    await h.handle({
      type: 'create',
      ownerId: 'clerk',
      book: 'writs',
      entry: makeWrit({ id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1' }),
    });
    assert.equal(h.transitionCalls.length, 0);
  });

  it('ignores update events whose phase did not change', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const child = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1' });
    const h = makeHarness({ writs: [parent, child], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(child, child));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('ignores update events to a non-terminal state', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'stuck', parentId: 'w-p1' });
    const h = makeHarness({ writs: [parent, childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('ignores update events on writs with no parent', async () => {
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open' });
    const childNext = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'completed' });
    const h = makeHarness({ writs: [childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('is a silent no-op when the parent type omits childrenBehavior', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'no-cascade', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'kaboom',
    });
    const h = makeHarness({
      writs: [parent, childNext],
      configs: [MANDATE_TYPE, NO_CASCADE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('short-circuits when the parent is already terminal', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'failed' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    const h = makeHarness({ writs: [parent, childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });
});

describe('createChildrenBehaviorEngine() — anyFailure trigger', () => {
  it('fires anyFailure when the triggering child carries the failure attr', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const otherChild = makeWrit({ id: 'w-c2', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'crashed',
    });
    const h = makeHarness({
      writs: [parent, otherChild, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.deepEqual(h.transitionCalls, [
      { id: 'w-p1', to: 'failed', fields: { resolution: 'crashed' } },
    ]);
  });

  it('precedence: anyFailure short-circuits allSuccess even when both could plausibly fire', async () => {
    // Even if every other sibling were already success-terminal, the
    // triggering child carrying `failure` must drive the parent to
    // anyFailure's target — never allSuccess. We assert that the harness
    // never enumerates siblings to evaluate allSuccess by checking that
    // the only transition recorded is the anyFailure one.
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const sibSuccess = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'ok',
    });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'kaboom',
    });
    const h = makeHarness({
      writs: [parent, sibSuccess, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.deepEqual(h.transitionCalls, [
      { id: 'w-p1', to: 'failed', fields: { resolution: 'kaboom' } },
    ]);
  });

  it('does not copy resolution when copyResolution is false', async () => {
    const tweaked: WritTypeConfig = {
      ...MANDATE_TYPE,
      childrenBehavior: {
        anyFailure: { transition: 'failed', copyResolution: false },
        allSuccess: { transition: 'completed', copyResolution: false },
      },
    };
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'crashed',
    });
    const h = makeHarness({ writs: [parent, childNext], configs: [tweaked] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 1);
    assert.equal(h.transitionCalls[0].id, 'w-p1');
    assert.equal(h.transitionCalls[0].to, 'failed');
    assert.deepEqual(h.transitionCalls[0].fields, {});
  });
});

describe('createChildrenBehaviorEngine() — allSuccess trigger', () => {
  it('does not fire when at least one sibling is still active', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const stillOpen = makeWrit({ id: 'w-c2', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    const h = makeHarness({
      writs: [parent, stillOpen, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('fires when every sibling is in a success-attr terminal state', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const sibA = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'a',
    });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'b',
    });
    const h = makeHarness({
      writs: [parent, sibA, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.deepEqual(h.transitionCalls, [
      { id: 'w-p1', to: 'completed', fields: { resolution: 'b' } },
    ]);
  });

  it('does not fire when a sibling is terminal but lacks the success attr', async () => {
    // A sibling in `cancelled` (terminal, attr: ['cancelled']) blocks
    // allSuccess — the trigger requires every sibling to carry `success`.
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const cancelled = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'cancelled', parentId: 'w-p1', resolution: 'aborted',
    });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    const h = makeHarness({
      writs: [parent, cancelled, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('enumerates more than 20 siblings (bypasses api.list pagination cap)', async () => {
    // Construct 30 success-terminal siblings plus the triggering child.
    // If the engine had quietly used `api.list`, the default 20-row cap
    // would have hidden siblings 21..30 and the predicate would still
    // evaluate true (so this test would look fine). The real defense
    // is that the engine sees every sibling — we assert allSuccess fires
    // (every sibling is success), and then re-run with one of those
    // beyond-20 siblings flipped to a non-terminal state to confirm the
    // predicate sees it.
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const siblings: WritDoc[] = [];
    for (let i = 0; i < 30; i += 1) {
      siblings.push(makeWrit({
        id: `w-s${i}`,
        type: 'mandate',
        phase: 'completed',
        parentId: 'w-p1',
        resolution: `s${i}`,
      }));
    }
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'last',
    });

    const h1 = makeHarness({
      writs: [parent, ...siblings, childNext],
      configs: [MANDATE_TYPE],
    });
    await h1.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h1.transitionCalls.length, 1, 'allSuccess should fire when every sibling is success');
    assert.equal(h1.transitionCalls[0].to, 'completed');

    // Now flip a sibling beyond the 20-cap to non-terminal and re-run.
    const flipped = [...siblings];
    flipped[25] = makeWrit({ id: 'w-s25', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h2 = makeHarness({
      writs: [parent, ...flipped, childNext],
      configs: [MANDATE_TYPE],
    });
    await h2.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h2.transitionCalls.length, 0, 'allSuccess must NOT fire when a sibling beyond 20 is still active');
  });

  it('single-child case: parent transitions when the only child completes', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'only',
    });
    const h = makeHarness({ writs: [parent, childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.deepEqual(h.transitionCalls, [
      { id: 'w-p1', to: 'completed', fields: { resolution: 'only' } },
    ]);
  });
});

describe("createChildrenBehaviorEngine() — status['clerk'] write", () => {
  it('writes the triggering child id under status.clerk before the anyFailure transition', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'kaboom',
    });
    const h = makeHarness({ writs: [parent, childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));

    // Both calls fired, and the status write came first.
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0]?.kind, 'setWritStatus', 'status write must precede transition');
    assert.equal(h.calls[1]?.kind, 'transition');

    // status['clerk'] carries the triggering child id, keyed under the
    // 'clerk' plugin id, on the parent writ.
    const status = h.calls[0] as { writId: string; pluginId: string; value: unknown };
    assert.equal(status.writId, 'w-p1');
    assert.equal(status.pluginId, 'clerk');
    assert.deepEqual(status.value, { triggeringChildId: 'w-c1' });
  });

  it('writes the triggering child id under status.clerk before the allSuccess transition', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const sibA = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'a',
    });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'b',
    });
    const h = makeHarness({
      writs: [parent, sibA, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));

    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0]?.kind, 'setWritStatus', 'status write must precede transition');
    assert.equal(h.calls[1]?.kind, 'transition');

    const status = h.calls[0] as { writId: string; pluginId: string; value: unknown };
    assert.equal(status.writId, 'w-p1');
    assert.equal(status.pluginId, 'clerk');
    assert.deepEqual(status.value, { triggeringChildId: 'w-c1' });
  });

  it('does NOT write status.clerk on the firing-rule short-circuit branches', async () => {
    // Six firing-rule short-circuits are exercised in earlier suites; pick
    // a representative one (parent already terminal) and verify no status
    // write fires.
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'failed' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    const h = makeHarness({ writs: [parent, childNext], configs: [MANDATE_TYPE] });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.calls.length, 0, 'no engine writes when the parent is already terminal');
  });

  it('does NOT write status.clerk when allSuccess is gated by a still-active sibling', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const stillOpen = makeWrit({ id: 'w-c2', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    const h = makeHarness({
      writs: [parent, stillOpen, childNext],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(childNext, childPrev));
    assert.equal(h.calls.length, 0, 'allSuccess did not fire — no status or transition writes');
  });
});

// ── Downward branch (parentTerminal) ─────────────────────────────────

/**
 * Mandate-shaped config that opts into both upward triggers AND the new
 * downward `parentTerminal` cascade. This is the primary fixture for the
 * downward branch tests below.
 */
const MANDATE_WITH_DOWNWARD: WritTypeConfig = {
  ...MANDATE_TYPE,
  childrenBehavior: {
    allSuccess: { transition: 'completed', copyResolution: true },
    anyFailure: { transition: 'failed', copyResolution: true },
    parentTerminal: {
      transition: 'cancelled',
      resolution: 'Automatically cancelled due to parent termination',
    },
  },
};

/**
 * A heterogeneous-child fixture: same lifecycle as mandate but a distinct
 * type name. Used to verify the downward cascade handles children of
 * arbitrary types as long as each type accepts the configured target
 * transition (here: `cancelled`).
 */
const STEP_TYPE: WritTypeConfig = {
  name: 'step',
  states: MANDATE_TYPE.states,
};

/**
 * A child type that does NOT declare `cancelled` as a reachable state.
 * Used to exercise the fail-loud rollback when a child type cannot accept
 * the parent's configured cascade target.
 */
const NO_CANCEL_TYPE: WritTypeConfig = {
  name: 'no-cancel',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['done', 'failed'] },
    { name: 'done', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
  ],
};

describe('createChildrenBehaviorEngine() — parentTerminal trigger', () => {
  it('fires when parent transitions to a failure-attr terminal state', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'failed', resolution: 'parent kaboom',
    });
    const childA = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childB = makeWrit({ id: 'w-c2', type: 'mandate', phase: 'stuck', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, childA, childB],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));

    // Both non-terminal children should be cancelled with the canonical
    // resolution string. Order matches the iteration order of writs.find.
    const callsById = new Map(h.transitionCalls.map((c) => [c.id, c]));
    assert.equal(h.transitionCalls.length, 2, 'both children should be cancelled');
    assert.deepEqual(callsById.get('w-c1'), {
      id: 'w-c1',
      to: 'cancelled',
      fields: { resolution: 'Automatically cancelled due to parent termination' },
    });
    assert.deepEqual(callsById.get('w-c2'), {
      id: 'w-c2',
      to: 'cancelled',
      fields: { resolution: 'Automatically cancelled due to parent termination' },
    });
  });

  it('fires when parent transitions to a cancelled-attr terminal state', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const child = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, child],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.deepEqual(h.transitionCalls, [
      {
        id: 'w-c1',
        to: 'cancelled',
        fields: { resolution: 'Automatically cancelled due to parent termination' },
      },
    ]);
  });

  it('skips already-terminal children', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const completedChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'shipped',
    });
    const failedChild = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'failed', parentId: 'w-p1', resolution: 'oops',
    });
    const openChild = makeWrit({ id: 'w-c3', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, completedChild, failedChild, openChild],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 1);
    assert.equal(h.transitionCalls[0].id, 'w-c3');
    assert.equal(h.transitionCalls[0].to, 'cancelled');
  });

  it('does not fire on success-attr terminal transitions when descendants are quiesced', async () => {
    // Verifies the downward branch's `failure | cancelled` attr gate: a
    // success-attr terminal must not drive children through the
    // `parentTerminal` action. With every descendant already terminal,
    // the tripwire branch is also a no-op (no non-terminal descendants
    // to flag), so the handler runs to completion with zero transition
    // calls. Exercising this with a non-terminal descendant is now the
    // tripwire's domain — see the dedicated tripwire suite below.
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'completed', resolution: 'done',
    });
    const terminatedChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1',
      resolution: 'done',
    });
    const h = makeHarness({
      writs: [parentNext, terminatedChild],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('does not fire on non-terminal parent transitions', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'stuck' });
    const child = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, child],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('does not fire when the parent type omits parentTerminal', async () => {
    // Use the standard MANDATE_TYPE which only opts into upward triggers.
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const child = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, child],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
  });

  it('is idempotent when re-fired on an already-terminal parent', async () => {
    // Simulate a re-fire of the same terminal-transition event after the
    // children have already been cancelled. With the children now
    // already-terminal, the loop should skip every child and produce no
    // further transitions.
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const childA = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'cancelled', parentId: 'w-p1',
      resolution: 'Automatically cancelled due to parent termination',
    });
    const childB = makeWrit({
      id: 'w-c2', type: 'mandate', phase: 'cancelled', parentId: 'w-p1',
      resolution: 'Automatically cancelled due to parent termination',
    });
    const h = makeHarness({
      writs: [parentNext, childA, childB],
      configs: [MANDATE_WITH_DOWNWARD],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0, 're-fire should be a no-op');
  });

  it('three-level hierarchy: grandchildren are cancelled via natural CDC re-fire', async () => {
    // The handler does NOT walk the tree itself. When the engine cancels
    // a child, the harness's `transition` mock updates the writ but does
    // not synthesize a follow-up CDC event. We simulate the natural
    // re-fire by invoking `handle` again with an update event for the
    // newly-terminal child as the entry. This matches what the real
    // stacks book does on writs.patch.
    const grandpaPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const grandpaNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const parentOpen = makeWrit({ id: 'w-p2', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const grandchild = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p2' });
    const h = makeHarness({
      writs: [grandpaNext, parentOpen, grandchild],
      configs: [MANDATE_WITH_DOWNWARD],
    });

    // First fire: grandpa terminal → cancel parent (the only direct child).
    await h.handle(makeUpdateEvent(grandpaNext, grandpaPrev));
    assert.equal(h.transitionCalls.length, 1);
    assert.equal(h.transitionCalls[0].id, 'w-p2');

    // Re-fire on parent's newly-terminal transition (natural CDC) →
    // grandchild cancelled.
    const parentNext = h.writsById.get('w-p2')!;
    await h.handle(makeUpdateEvent(parentNext, parentOpen));
    assert.equal(h.transitionCalls.length, 2);
    assert.equal(h.transitionCalls[1].id, 'w-c1');
    assert.equal(h.transitionCalls[1].to, 'cancelled');
  });

  it('heterogeneous children: cancels mandate parent\'s step and observation-set children', async () => {
    // A mandate parent with two children of different types — both types
    // independently declare `cancelled` reachable from `open`. The cascade
    // should drive both children into cancelled regardless of their type.
    const obsSetType: WritTypeConfig = {
      name: 'observation-set',
      states: MANDATE_TYPE.states,
    };
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const stepChild = makeWrit({ id: 'w-s1', type: 'step', phase: 'open', parentId: 'w-p1' });
    const obsChild = makeWrit({
      id: 'w-o1', type: 'observation-set', phase: 'open', parentId: 'w-p1',
    });
    const h = makeHarness({
      writs: [parentNext, stepChild, obsChild],
      configs: [MANDATE_WITH_DOWNWARD, STEP_TYPE, obsSetType],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    const callsById = new Map(h.transitionCalls.map((c) => [c.id, c]));
    assert.equal(h.transitionCalls.length, 2);
    assert.equal(callsById.get('w-s1')?.to, 'cancelled');
    assert.equal(callsById.get('w-o1')?.to, 'cancelled');
  });

  it('throws (rolling back) when a child type lacks the configured target', async () => {
    // The `no-cancel` type declares only `done` and `failed` as terminals;
    // it cannot transition into `cancelled` from any state. The cascade
    // must throw, mirroring the engine's existing fail-loud convention.
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'cancelled' });
    const child = makeWrit({ id: 'w-c1', type: 'no-cancel', phase: 'new', parentId: 'w-p1' });

    // Build a harness where the transition fake validates target reachability
    // against the child's type config — mirrors the runtime behaviour.
    const writsById = new Map<string, WritDoc>();
    writsById.set(parentNext.id, parentNext);
    writsById.set(child.id, child);
    const configByName = new Map<string, WritTypeConfig>();
    configByName.set(MANDATE_WITH_DOWNWARD.name, MANDATE_WITH_DOWNWARD);
    configByName.set(NO_CANCEL_TYPE.name, NO_CANCEL_TYPE);

    const writsBook = {
      async get(id: string) {
        return writsById.get(id) ?? null;
      },
      async find() {
        return [...writsById.values()].filter((w) => w.parentId === parentNext.id);
      },
    } as unknown as Book<WritDoc>;

    function isTerminal(writ: WritDoc): boolean {
      const config = configByName.get(writ.type);
      const state = config?.states.find((s) => s.name === writ.phase);
      return state?.classification === 'terminal';
    }

    const handle = createChildrenBehaviorEngine({
      writs: writsBook,
      getWritTypeConfig(name) {
        return configByName.get(name);
      },
      isTerminal,
      async transition(id, to) {
        const existing = writsById.get(id);
        if (!existing) throw new Error(`transition: writ "${id}" missing`);
        const config = configByName.get(existing.type);
        const currentState = config?.states.find((s) => s.name === existing.phase);
        if (!currentState?.allowedTransitions.includes(to)) {
          throw new Error(
            `Cannot transition writ "${id}" from "${existing.phase}" to "${to}".`,
          );
        }
        const next: WritDoc = { ...existing, phase: to };
        writsById.set(id, next);
        return next;
      },
    });

    await assert.rejects(
      () => handle(makeUpdateEvent(parentNext, parentPrev)),
      /Cannot transition writ "w-c1" from "new" to "cancelled"/,
    );
  });

  it('supports copyResolution on parentTerminal: child inherits the parent\'s resolution', async () => {
    const copyType: WritTypeConfig = {
      ...MANDATE_TYPE,
      childrenBehavior: {
        parentTerminal: { transition: 'cancelled', copyResolution: true },
      },
    };
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'cancelled', resolution: 'parent reason',
    });
    const child = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const h = makeHarness({
      writs: [parentNext, child],
      configs: [copyType],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.deepEqual(h.transitionCalls, [
      { id: 'w-c1', to: 'cancelled', fields: { resolution: 'parent reason' } },
    ]);
  });
});

// ── Tripwire branch (success-attr terminal + non-terminal descendant) ──
//
// The tripwire enforces an invariant that the cascade engine itself
// can never violate (allSuccess enumerates every direct sibling and
// requires terminal-success): a writ whose type opts into
// `childrenBehavior` cannot reach a `success`-attr terminal state
// while any non-terminal descendant remains. The branch throws inside
// the firing transaction so the parent's offending transition rolls
// back via Phase 1 atomicity. These tests exercise the throw on
// direct-child and grandchild violations, the success path with all
// descendants terminated, the no-op on declining types, and idempotent
// re-fire.

describe('createChildrenBehaviorEngine() — tripwire (success-attr + non-terminal descendant)', () => {
  // (a) parent of cascade-opt-in type driven directly to a success-attr
  //     terminal with at least one non-terminal direct child throws.
  it('throws when a cascade-opt-in writ reaches a success-attr terminal with a non-terminal direct child', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'completed', resolution: 'forced',
    });
    const openChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1',
    });
    const h = makeHarness({
      writs: [parentNext, openChild],
      configs: [MANDATE_TYPE],
    });
    await assert.rejects(
      () => h.handle(makeUpdateEvent(parentNext, parentPrev)),
      (err: Error) => {
        assert.match(err.message, /writ "w-p1" cannot reach success-attr terminal state "completed"/);
        assert.match(err.message, /"w-c1" \(phase "open"\)/);
        return true;
      },
    );
    // No transition should have fired before the throw — Phase 1
    // atomicity rolls the parent's transition back, but at the engine
    // unit level the harness only records what the engine called.
    assert.equal(h.transitionCalls.length, 0);
  });

  // (b) same shape with a non-terminal grandchild (descendant, not
  //     direct child) throws. The parent's direct child is already
  //     terminal (cancelled — no upward cascade fires from the
  //     `cancelled` attr), but a grandchild remains open.
  it('throws when a cascade-opt-in writ reaches a success-attr terminal with a non-terminal grandchild', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'completed', resolution: 'forced',
    });
    const cancelledChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'cancelled', parentId: 'w-p1',
      resolution: 'preempt',
    });
    const openGrandchild = makeWrit({
      id: 'w-g1', type: 'mandate', phase: 'open', parentId: 'w-c1',
    });
    const h = makeHarness({
      writs: [parentNext, cancelledChild, openGrandchild],
      configs: [MANDATE_TYPE],
    });
    await assert.rejects(
      () => h.handle(makeUpdateEvent(parentNext, parentPrev)),
      (err: Error) => {
        assert.match(err.message, /writ "w-p1" cannot reach success-attr terminal state "completed"/);
        // The non-terminal descendant named in the message must be the
        // grandchild — the cancelled child does not flag.
        assert.match(err.message, /"w-g1" \(phase "open"\)/);
        assert.ok(!err.message.includes('"w-c1"'),
          'cancelled (terminal) child must not appear in the descendant list');
        return true;
      },
    );
  });

  // (c) same shape with all descendants already terminal does NOT
  //     throw — the tripwire is satisfied and the upward branch can
  //     proceed normally. Here the parent has no parent of its own, so
  //     the upward branch is a silent no-op too; the assertion is that
  //     no transition or status writes fire.
  it('does not throw when every descendant is already terminal', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'completed', resolution: 'all done',
    });
    const completedChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1',
      resolution: 'a',
    });
    const completedGrandchild = makeWrit({
      id: 'w-g1', type: 'mandate', phase: 'completed', parentId: 'w-c1',
      resolution: 'b',
    });
    const h = makeHarness({
      writs: [parentNext, completedChild, completedGrandchild],
      configs: [MANDATE_TYPE],
    });
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
    assert.equal(h.statusCalls.length, 0);
  });

  // (d) same shape on a writ whose type declines childrenBehavior is a
  //     no-op — the policy is implicit in opting into childrenBehavior,
  //     and types that decline have announced they do not couple parent
  //     and child outcomes.
  it('is a no-op when the writ\'s type declines childrenBehavior, even with non-terminal descendants', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'no-cascade', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'no-cascade', phase: 'completed', resolution: 'forced',
    });
    const openChild = makeWrit({
      id: 'w-c1', type: 'no-cascade', phase: 'open', parentId: 'w-p1',
    });
    const h = makeHarness({
      writs: [parentNext, openChild],
      configs: [NO_CASCADE_TYPE],
    });
    // No throw; no transition or status writes fire either.
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
    assert.equal(h.statusCalls.length, 0);
  });

  // (e) re-firing the cascade engine on the now-terminal parent (the
  //     idempotency invariant) does not re-throw or duplicate work.
  //     The simulated re-fire delivers the same terminal-transition
  //     event a second time after the descendants have been
  //     terminated; the tripwire walks the subtree again, finds no
  //     non-terminal descendants, and is a no-op. The downward branch
  //     similarly skips already-terminal descendants and produces no
  //     duplicate transition calls.
  it('is idempotent under CDC re-fire — once descendants are terminal the tripwire is a no-op', async () => {
    const parentPrev = makeWrit({ id: 'w-p1', type: 'mandate', phase: 'open' });
    const parentNext = makeWrit({
      id: 'w-p1', type: 'mandate', phase: 'completed', resolution: 'all done',
    });
    const completedChild = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1',
      resolution: 'one',
    });
    const h = makeHarness({
      writs: [parentNext, completedChild],
      configs: [MANDATE_TYPE],
    });
    // First fire: tripwire is satisfied, no calls.
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
    assert.equal(h.statusCalls.length, 0);

    // Re-fire the same terminal-transition event — the tripwire's
    // walk re-runs but the subtree is unchanged, so it remains a
    // no-op. No throw, no duplicate work.
    await h.handle(makeUpdateEvent(parentNext, parentPrev));
    assert.equal(h.transitionCalls.length, 0);
    assert.equal(h.statusCalls.length, 0);
  });
});

describe('createChildrenBehaviorEngine() — fail-loud surface', () => {
  it('throws when the child references a parentId that does not exist', async () => {
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-missing' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-missing', resolution: 'done',
    });
    const h = makeHarness({ writs: [childNext], configs: [MANDATE_TYPE] });
    await assert.rejects(
      () => h.handle(makeUpdateEvent(childNext, childPrev)),
      /references parent "w-missing" which does not exist/,
    );
  });

  it('throws when the parent writ\'s type is not registered', async () => {
    const parent = makeWrit({ id: 'w-p1', type: 'phantom-type', phase: 'open' });
    const childPrev = makeWrit({ id: 'w-c1', type: 'mandate', phase: 'open', parentId: 'w-p1' });
    const childNext = makeWrit({
      id: 'w-c1', type: 'mandate', phase: 'completed', parentId: 'w-p1', resolution: 'done',
    });
    // Don't register `phantom-type` in the harness, but DO put `parent`
    // into the writs map so the engine reaches the type lookup. We have
    // to use a custom isTerminal that does not throw on the unregistered
    // type — but the engine reaches `getWritTypeConfig` before it would
    // call `isTerminal` on the parent.
    const writsById = new Map<string, WritDoc>();
    writsById.set(parent.id, parent);
    writsById.set(childNext.id, childNext);
    const writsBook = {
      async get(id: string) {
        return writsById.get(id) ?? null;
      },
      async find(_query: BookQuery) {
        return [...writsById.values()].filter((w) => w.parentId === parent.id);
      },
    } as unknown as Book<WritDoc>;
    const handle = createChildrenBehaviorEngine({
      writs: writsBook,
      getWritTypeConfig(name) {
        if (name === 'mandate') return MANDATE_TYPE;
        return undefined;
      },
      isTerminal(w) {
        // Only used for the child here — child is mandate, completed terminal.
        return MANDATE_TYPE.states.find((s) => s.name === w.phase)?.classification === 'terminal';
      },
      async transition() { throw new Error('should not reach transition'); },
      async setWritStatus() { throw new Error('should not reach setWritStatus'); },
    });
    await assert.rejects(
      () => handle(makeUpdateEvent(childNext, childPrev)),
      /carries type "phantom-type" which is not registered/,
    );
  });
});

/**
 * CDC observer #1 tests (T4).
 *
 * Covers:
 *   - Emission produces a survey writ with the correct shape
 *   - Replay is idempotent (D24 dedupe)
 *   - Zero-surveyor: silent skip
 *   - Only vision/charge/piece types trigger emission
 *   - survey-* types do not trigger emission (no loop)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCartographObserver } from './cdc.ts';
import type { SurveyorDescriptor } from './types.ts';
import { defaultPriority } from './priority.ts';
import type { StacksApi, ChangeEvent } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';

const SURVEYOR_PLUGIN_ID = 'surveyor';

// ── Test fixtures ──────────────────────────────────────────────────────

function makeVisionWrit(overrides: Partial<WritDoc> = {}): WritDoc {
  return {
    id: 'w-vis001',
    type: 'vision',
    phase: 'open',
    title: 'Cake Bakery',
    body: 'A bakery vision',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeCreateEvent(writ: WritDoc): ChangeEvent<WritDoc> {
  return { type: 'create', ownerId: 'clerk', book: 'writs', entry: writ };
}

function makeUpdateEvent(writ: WritDoc, prev: WritDoc): ChangeEvent<WritDoc> {
  return { type: 'update', ownerId: 'clerk', book: 'writs', entry: writ, prev };
}

function makeActiveSurveyor(): SurveyorDescriptor {
  return {
    id: 'scaffold-surveyor',
    description: 'Scaffold surveyor',
    rigTemplates: {},
    version: '1.0.0',
  };
}

// ── Mock factories ─────────────────────────────────────────────────────

interface MockState {
  posted: WritDoc[];
  extSet: Array<{ writId: string; pluginId: string; value: unknown }>;
  petitioned: Array<{ writId: string; ext: unknown }>;
  transactionCount: number;
  existingSurveys: WritDoc[];
}

function makeMocks(state: MockState) {
  const stacks = {
    readBook: () => ({
      find: async () => state.existingSurveys,
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as unknown as StacksApi;

  const clerk = {
    post: async (req: { type?: string; title: string; body: string; parentId?: string; codex?: string }) => {
      const writ: WritDoc = {
        id: `w-survey-${state.posted.length}`,
        type: req.type ?? 'mandate',
        phase: 'new',
        title: req.title,
        body: req.body,
        parentId: req.parentId,
        ...(req.codex !== undefined ? { codex: req.codex } : {}),
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      };
      state.posted.push(writ);
      return writ;
    },
    setWritExt: async (writId: string, pluginId: string, value: unknown) => {
      state.extSet.push({ writId, pluginId, value });
      const stub: WritDoc = {
        id: writId, type: 'survey-vision', phase: 'new',
        title: '', body: '', createdAt: '', updatedAt: '',
      };
      return stub;
    },
  } as unknown as ClerkApi;

  const reckoner = {
    petition: async (writId: string, ext: unknown) => {
      state.petitioned.push({ writId, ext });
      return { id: writId } as WritDoc;
    },
  } as unknown as ReckonerApi;

  return { stacks, clerk, reckoner };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('cartograph CDC observer — emission', () => {
  it('emits a survey-vision writ for a vision create event', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();

    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(makeVisionWrit()));

    assert.equal(state.posted.length, 1);
    assert.equal(state.posted[0].type, 'survey-vision');
    assert.equal(state.posted[0].title, 'Survey vision: Cake Bakery');
    assert.equal(state.posted[0].body, '');
    assert.equal(state.posted[0].parentId, 'w-vis001');
  });

  it('sets ext[surveyor] with surveyorId and parentUpdatedAt', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();

    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(makeVisionWrit()));

    assert.equal(state.extSet.length, 1);
    const ext = state.extSet[0].value as Record<string, unknown>;
    assert.equal(ext.surveyorId, 'scaffold-surveyor');
    assert.equal(ext.rigVersion, '1.0.0');
    assert.equal(ext.parentUpdatedAt, '2026-01-02T00:00:00.000Z');
  });

  it('calls reckoner.petition stamp-only with correct source', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();

    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(makeVisionWrit()));

    assert.equal(state.petitioned.length, 1);
    const petExt = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(petExt.source, 'scaffold-surveyor.survey-vision');
  });

  it('emits survey-charge for a charge create event', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();
    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const chargeWrit = makeVisionWrit({ type: 'charge', id: 'w-ch001', title: 'Browse + order' });
    await observer(makeCreateEvent(chargeWrit));

    assert.equal(state.posted[0].type, 'survey-charge');
    assert.equal(state.posted[0].title, 'Survey charge: Browse + order');
    const petExt = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(petExt.source, 'scaffold-surveyor.survey-charge');
  });

  it('emits survey-piece for a piece create event', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();
    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const pieceWrit = makeVisionWrit({ type: 'piece', id: 'w-pc001', title: 'Stripe integration' });
    await observer(makeCreateEvent(pieceWrit));

    assert.equal(state.posted[0].type, 'survey-piece');
    const petExt = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(petExt.source, 'scaffold-surveyor.survey-piece');
  });

  it('fires on update events too', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const surveyor = makeActiveSurveyor();
    const observer = createCartographObserver({
      getActiveSurveyor: () => surveyor,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const v1 = makeVisionWrit({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const v2 = makeVisionWrit({ updatedAt: '2026-01-02T00:00:00.000Z' });
    await observer(makeUpdateEvent(v2, v1));
    assert.equal(state.posted.length, 1);
  });
});

describe('cartograph CDC observer — silent skip cases', () => {
  it('does nothing when activeSurveyor is undefined (zero-surveyor case)', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);

    const observer = createCartographObserver({
      getActiveSurveyor: () => undefined,
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(makeVisionWrit()));
    assert.equal(state.posted.length, 0);
    assert.equal(state.petitioned.length, 0);
  });

  it('ignores delete events', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const deleteEvent: ChangeEvent<WritDoc> = {
      type: 'delete',
      ownerId: 'clerk',
      book: 'writs',
      id: 'w-vis001',
      prev: makeVisionWrit(),
    };
    await observer(deleteEvent);
    assert.equal(state.posted.length, 0);
  });

  it('ignores non-cartograph writ types (mandate)', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const mandateWrit = makeVisionWrit({ type: 'mandate' });
    await observer(makeCreateEvent(mandateWrit));
    assert.equal(state.posted.length, 0);
  });

  it('ignores survey-* writ types to prevent loops', async () => {
    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0, existingSurveys: [],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    const surveyWrit = makeVisionWrit({ type: 'survey-vision' });
    await observer(makeCreateEvent(surveyWrit));
    assert.equal(state.posted.length, 0);
  });
});

describe('cartograph CDC observer — D24 idempotency', () => {
  it('skips emission when non-terminal survey writ exists with same parentUpdatedAt', async () => {
    const parentWrit = makeVisionWrit({ updatedAt: '2026-01-02T00:00:00.000Z' });
    // Pre-existing non-terminal survey writ with matching envelope.
    const existingSurvey: WritDoc = {
      id: 'w-surv001',
      type: 'survey-vision',
      phase: 'open',
      title: 'Survey vision: Cake Bakery',
      body: '',
      parentId: parentWrit.id,
      createdAt: '2026-01-02T01:00:00.000Z',
      updatedAt: '2026-01-02T01:00:00.000Z',
      ext: {
        surveyor: {
          surveyorId: 'scaffold-surveyor',
          parentUpdatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    };

    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0,
      existingSurveys: [existingSurvey],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(parentWrit));
    // Should be deduplicated — no new survey writ.
    assert.equal(state.posted.length, 0);
  });

  it('emits when existing survey writ is terminal (new survey for same version is OK)', async () => {
    const parentWrit = makeVisionWrit({ updatedAt: '2026-01-02T00:00:00.000Z' });
    // Terminal survey writ — should not block new emission.
    const existingSurvey: WritDoc = {
      id: 'w-surv001',
      type: 'survey-vision',
      phase: 'completed',    // terminal
      title: 'Survey vision: Cake Bakery',
      body: 'Notes',
      parentId: parentWrit.id,
      createdAt: '2026-01-01T01:00:00.000Z',
      updatedAt: '2026-01-02T01:00:00.000Z',
      ext: {
        surveyor: {
          surveyorId: 'scaffold-surveyor',
          parentUpdatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    };

    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0,
      existingSurveys: [existingSurvey],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(parentWrit));
    // Terminal existing → emit new.
    assert.equal(state.posted.length, 1);
  });

  it('emits when parentUpdatedAt differs (updated vision)', async () => {
    const oldUpdatedAt = '2026-01-01T00:00:00.000Z';
    const newUpdatedAt = '2026-01-02T00:00:00.000Z';
    const parentWrit = makeVisionWrit({ updatedAt: newUpdatedAt });

    // Existing survey for old version.
    const existingSurvey: WritDoc = {
      id: 'w-surv001',
      type: 'survey-vision',
      phase: 'open',
      title: 'Survey vision: Cake Bakery',
      body: '',
      parentId: parentWrit.id,
      createdAt: '2026-01-01T01:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z',
      ext: {
        surveyor: {
          surveyorId: 'scaffold-surveyor',
          parentUpdatedAt: oldUpdatedAt, // different updatedAt
        },
      },
    };

    const state: MockState = {
      posted: [], extSet: [], petitioned: [],
      transactionCount: 0,
      existingSurveys: [existingSurvey],
    };
    const { stacks, clerk, reckoner } = makeMocks(state);
    const observer = createCartographObserver({
      getActiveSurveyor: () => makeActiveSurveyor(),
      stacks, clerk, reckoner,
      defaultPriority,
      SURVEYOR_PLUGIN_ID,
    });

    await observer(makeCreateEvent(parentWrit));
    // Different parentUpdatedAt → emit new survey.
    assert.equal(state.posted.length, 1);
  });
});

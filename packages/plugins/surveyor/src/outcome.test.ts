/**
 * CDC observer #2 tests — survey-completion outcome stamping (T5).
 *
 * Covers:
 *   - Three terminal phases (completed, failed, cancelled) each produce a stamp
 *   - childCount aggregation across cartograph types
 *   - Non-terminal phases do not trigger a stamp
 *   - Non-survey writ types are ignored
 *   - Re-fire on already-terminal writ is ignored
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomeObserver } from './outcome.ts';
import type { StacksApi, ChangeEvent } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

const SURVEYOR_PLUGIN_ID = 'surveyor';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeSurveyWrit(overrides: Partial<WritDoc & { resolvedAt?: string }> = {}): WritDoc & { resolvedAt?: string } {
  return {
    id: 'w-surv001',
    type: 'survey-vision',
    phase: 'completed',
    title: 'Survey vision: Cake Bakery',
    body: 'Notes',
    parentId: 'w-vis001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: '2026-01-02T12:00:00.000Z',
    ...overrides,
  };
}

function makeUpdateEvent(entry: WritDoc, prev: WritDoc): ChangeEvent<WritDoc> {
  return { type: 'update', ownerId: 'clerk', book: 'writs', entry, prev };
}

function makePrevOpenWrit(overrides: Partial<WritDoc> = {}): WritDoc {
  return {
    id: 'w-surv001',
    type: 'survey-vision',
    phase: 'open',
    title: 'Survey vision: Cake Bakery',
    body: '',
    parentId: 'w-vis001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

// ── Mock factories ─────────────────────────────────────────────────────

interface MockState {
  statusSet: Array<{ writId: string; pluginId: string; value: unknown }>;
  childrenInBook: WritDoc[];
}

function makeMocks(state: MockState) {
  const stacks = {
    readBook: () => ({
      find: async () => state.childrenInBook,
    }),
  } as unknown as StacksApi;

  const clerk = {
    setWritStatus: async (writId: string, pluginId: string, value: unknown) => {
      state.statusSet.push({ writId, pluginId, value });
      return { id: writId } as WritDoc;
    },
  } as unknown as ClerkApi;

  return { stacks, clerk };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('outcome observer — terminal transitions', () => {
  it('stamps status[surveyor] when survey-vision completes', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'completed' });
    const prev = makePrevOpenWrit();
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 1);
    assert.equal(state.statusSet[0].writId, 'w-surv001');
    assert.equal(state.statusSet[0].pluginId, SURVEYOR_PLUGIN_ID);
    const status = state.statusSet[0].value as Record<string, unknown>;
    assert.equal(status.terminal, 'success');
    assert.equal(status.surveyedAt, '2026-01-02T12:00:00.000Z');
    assert.equal(status.childCount, 0);
  });

  it('stamps terminal: failure when survey writ fails', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'failed' });
    const prev = makePrevOpenWrit();
    await observer(makeUpdateEvent(writ, prev));

    const status = state.statusSet[0].value as Record<string, unknown>;
    assert.equal(status.terminal, 'failure');
  });

  it('stamps terminal: cancelled when survey writ is cancelled', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'cancelled' });
    const prev = makePrevOpenWrit();
    await observer(makeUpdateEvent(writ, prev));

    const status = state.statusSet[0].value as Record<string, unknown>;
    assert.equal(status.terminal, 'cancelled');
  });

  it('handles survey-charge type', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ type: 'survey-charge', phase: 'completed' });
    const prev = makePrevOpenWrit({ type: 'survey-charge' });
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 1);
  });

  it('handles survey-piece type', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ type: 'survey-piece', phase: 'completed' });
    const prev = makePrevOpenWrit({ type: 'survey-piece' });
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 1);
  });
});

describe('outcome observer — childCount aggregation', () => {
  it('counts cartograph children created at or after survey writ creation', async () => {
    const surveyCreatedAt = '2026-01-01T10:00:00.000Z';
    const children: WritDoc[] = [
      // Created after survey writ — should count.
      {
        id: 'w-ch001', type: 'charge', phase: 'new', title: 'Ch1', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T11:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z',
      },
      {
        id: 'w-ch002', type: 'charge', phase: 'new', title: 'Ch2', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z',
      },
      // Created before survey writ — should NOT count.
      {
        id: 'w-ch000', type: 'charge', phase: 'new', title: 'Old', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z',
      },
    ];

    const state: MockState = { statusSet: [], childrenInBook: children };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'completed', createdAt: surveyCreatedAt });
    const prev = makePrevOpenWrit({ createdAt: surveyCreatedAt });
    await observer(makeUpdateEvent(writ, prev));

    const status = state.statusSet[0].value as Record<string, unknown>;
    assert.equal(status.childCount, 2);
  });

  it('only counts cartograph types (vision/charge/piece), not mandate or survey-*', async () => {
    const surveyCreatedAt = '2026-01-01T00:00:00.000Z';
    const children: WritDoc[] = [
      {
        id: 'w-ch001', type: 'charge', phase: 'new', title: 'Charge', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T01:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z',
      },
      // mandate — should NOT count
      {
        id: 'w-m001', type: 'mandate', phase: 'new', title: 'Mandate', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T01:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z',
      },
      // survey-vision — should NOT count
      {
        id: 'w-s001', type: 'survey-vision', phase: 'new', title: 'Survey', body: '',
        parentId: 'w-vis001', createdAt: '2026-01-01T01:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z',
      },
    ];

    const state: MockState = { statusSet: [], childrenInBook: children };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'completed', createdAt: surveyCreatedAt });
    const prev = makePrevOpenWrit({ createdAt: surveyCreatedAt });
    await observer(makeUpdateEvent(writ, prev));

    const status = state.statusSet[0].value as Record<string, unknown>;
    assert.equal(status.childCount, 1);
  });
});

describe('outcome observer — non-triggering cases', () => {
  it('does not stamp when writ is not a survey type', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ: WritDoc = {
      id: 'w-vis001', type: 'vision', phase: 'completed',
      title: 'Vision', body: '', createdAt: '', updatedAt: '',
    };
    const prev: WritDoc = { ...writ, phase: 'open' };
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 0);
  });

  it('does not stamp when phase is not terminal', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'stuck' });
    const prev = makePrevOpenWrit();
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 0);
  });

  it('does not stamp when previous phase was already terminal (no re-fire)', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const writ = makeSurveyWrit({ phase: 'completed' });
    const prev: WritDoc = { ...makePrevOpenWrit(), phase: 'completed' }; // already terminal
    await observer(makeUpdateEvent(writ, prev));

    assert.equal(state.statusSet.length, 0);
  });

  it('ignores create events (only update transitions count)', async () => {
    const state: MockState = { statusSet: [], childrenInBook: [] };
    const { stacks, clerk } = makeMocks(state);
    const observer = createOutcomeObserver({ clerk, stacks, SURVEYOR_PLUGIN_ID });

    const event: ChangeEvent<WritDoc> = {
      type: 'create',
      ownerId: 'clerk',
      book: 'writs',
      entry: makeSurveyWrit({ phase: 'completed' }),
    };
    await observer(event);
    assert.equal(state.statusSet.length, 0);
  });
});

/**
 * Surveyor anima tool handler tests.
 *
 * Covers the six tools (create-charge[s], create-piece[s], create-mandate[s]):
 *   - Happy path with minimal required params
 *   - Optional hints branch (stamped when present, skipped when absent)
 *   - Optional supersedes branch (link recorded when present, skipped when absent)
 *   - Batch tools: all items processed; per-item hints/supersedes handled
 *     independently; correct return length
 *   - Optional codex forwarded when provided
 *   - Mandate tools: source / priority / complexity forwarded correctly
 *
 * All tests use a lightweight fake guild injected via setGuild / clearGuild
 * so no real apparatus or filesystem is required.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { CartographApi } from '@shardworks/cartograph-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';

import createChargeTool    from './surveyor-create-charge.ts';
import createChargesTool   from './surveyor-create-charges.ts';
import createPieceTool     from './surveyor-create-piece.ts';
import createPiecesTool    from './surveyor-create-pieces.ts';
import createMandateTool   from './surveyor-create-mandate.ts';
import createMandatesTool  from './surveyor-create-mandates.ts';

// ── Mock state ────────────────────────────────────────────────────────────

interface MockState {
  chargesCreated: Array<{ parentId: string; title: string; body: string; codex?: string }>;
  piecesCreated:  Array<{ parentId: string; title: string; body: string; codex?: string }>;
  mandatesPosted: Array<{ type: string; title: string; body: string; parentId: string; codex?: string }>;
  extSet:         Array<{ writId: string; pluginId: string; value: unknown }>;
  linked:         Array<{ sourceId: string; targetId: string; relation: string; kind: string }>;
  petitioned:     Array<{ writId: string; ext: unknown }>;
  nextId:         number;
}

function makeState(): MockState {
  return {
    chargesCreated: [], piecesCreated: [], mandatesPosted: [],
    extSet: [], linked: [], petitioned: [], nextId: 1,
  };
}

function fakeWrit(state: MockState, type: string, title: string, parentId: string): WritDoc {
  return {
    id:        `w-${type.replace(/[^a-z]/g, '-')}-${state.nextId++}`,
    type,
    phase:     'new',
    title,
    body:      '',
    parentId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ── Guild setup ───────────────────────────────────────────────────────────

function setupGuild(state: MockState): void {
  const cartograph = {
    createCharge: async (req: { parentId: string; title: string; body: string; codex?: string }) => {
      state.chargesCreated.push(req);
      return fakeWrit(state, 'charge', req.title, req.parentId);
    },
    createPiece: async (req: { parentId: string; title: string; body: string; codex?: string }) => {
      state.piecesCreated.push(req);
      return fakeWrit(state, 'piece', req.title, req.parentId);
    },
  } as unknown as CartographApi;

  const clerk = {
    setWritExt: async (writId: string, pluginId: string, value: unknown) => {
      state.extSet.push({ writId, pluginId, value });
      return fakeWrit(state, 'charge', '', '');
    },
    link: async (sourceId: string, targetId: string, relation: string, kind: string) => {
      state.linked.push({ sourceId, targetId, relation, kind });
    },
    post: async (req: { type: string; title: string; body: string; parentId: string; codex?: string }) => {
      state.mandatesPosted.push(req);
      return fakeWrit(state, req.type, req.title, req.parentId);
    },
  } as unknown as ClerkApi;

  const reckoner = {
    petition: async (writId: string, ext: unknown) => {
      state.petitioned.push({ writId, ext });
      return fakeWrit(state, 'mandate', '', '');
    },
  } as unknown as ReckonerApi;

  const stacks = {
    transaction: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as StacksApi;

  const map: Record<string, unknown> = { cartograph, clerk, reckoner, stacks };

  const fakeGuild: Guild = {
    home: '/tmp',
    apparatus<T>(name: string): T {
      const a = map[name];
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },
    tryApparatus<T>(name: string): T | null { return (map[name] as T) ?? null; },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return { name: 'test', nexus: '0.0.0', plugins: [] }; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

afterEach(() => clearGuild());

// ── surveyor-create-charge ────────────────────────────────────────────────

describe('surveyor-create-charge', () => {
  it('creates a charge with minimal params (no hints, no supersedes)', async () => {
    const state = makeState();
    setupGuild(state);

    const result = await createChargeTool.handler({
      parentId: 'w-vis001',
      title:    'Browse catalogue',
      body:     'Allow users to browse products.',
    }) as WritDoc;

    assert.equal(state.chargesCreated.length, 1);
    assert.equal(state.chargesCreated[0].parentId, 'w-vis001');
    assert.equal(state.chargesCreated[0].title, 'Browse catalogue');
    assert.equal(state.chargesCreated[0].codex, undefined);
    assert.equal(state.extSet.length, 0,   'no ext set without hints');
    assert.equal(state.linked.length, 0,   'no link without supersedes');
    assert.ok(result.id.startsWith('w-charge-'));
  });

  it('stamps ext[surveyor] when hints are provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargeTool.handler({
      parentId: 'w-vis001',
      title:    'Browse catalogue',
      body:     'Detail.',
      hints:    { severity: 'serious', decay: true },
    });

    assert.equal(state.extSet.length, 1);
    assert.equal(state.extSet[0].pluginId, 'surveyor');
    const hints = state.extSet[0].value as Record<string, unknown>;
    assert.equal(hints.severity, 'serious');
    assert.equal(hints.decay, true);
  });

  it('records a supersedes link when supersedes is provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargeTool.handler({
      parentId:   'w-vis001',
      title:      'Revised charge',
      body:       'Detail.',
      supersedes: 'w-old-charge',
    });

    assert.equal(state.linked.length, 1);
    assert.equal(state.linked[0].targetId, 'w-old-charge');
    assert.equal(state.linked[0].kind, 'surveyor.supersedes');
  });

  it('forwards codex to cartograph when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargeTool.handler({
      parentId: 'w-vis001',
      title:    'Charge',
      body:     'Body',
      codex:    'my-codex',
    });

    assert.equal(state.chargesCreated[0].codex, 'my-codex');
  });
});

// ── surveyor-create-charges ───────────────────────────────────────────────

describe('surveyor-create-charges', () => {
  it('creates multiple charges in one transaction, returning all results', async () => {
    const state = makeState();
    setupGuild(state);

    const results = await createChargesTool.handler({
      parentId: 'w-vis001',
      charges: [
        { title: 'Charge A', body: 'Body A' },
        { title: 'Charge B', body: 'Body B' },
      ],
    }) as WritDoc[];

    assert.equal(state.chargesCreated.length, 2);
    assert.equal(state.chargesCreated[0].title, 'Charge A');
    assert.equal(state.chargesCreated[1].title, 'Charge B');
    assert.equal(results.length, 2);
  });

  it('stamps hints only for items that include them', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargesTool.handler({
      parentId: 'w-vis001',
      charges: [
        { title: 'A', body: 'a', hints: { severity: 'critical' } },
        { title: 'B', body: 'b' },
      ],
    });

    assert.equal(state.extSet.length, 1);
    const hints = state.extSet[0].value as Record<string, unknown>;
    assert.equal(hints.severity, 'critical');
  });

  it('records supersedes links per item independently', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargesTool.handler({
      parentId: 'w-vis001',
      charges: [
        { title: 'New A', body: 'a', supersedes: 'w-old-a' },
        { title: 'New B', body: 'b' },
      ],
    });

    assert.equal(state.linked.length, 1);
    assert.equal(state.linked[0].targetId, 'w-old-a');
  });

  it('forwards codex per item when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createChargesTool.handler({
      parentId: 'w-vis001',
      charges: [
        { title: 'A', body: 'a', codex: 'cx-1' },
        { title: 'B', body: 'b' },
      ],
    });

    assert.equal(state.chargesCreated[0].codex, 'cx-1');
    assert.equal(state.chargesCreated[1].codex, undefined);
  });
});

// ── surveyor-create-piece ─────────────────────────────────────────────────

describe('surveyor-create-piece', () => {
  it('creates a piece with minimal params (no hints, no supersedes)', async () => {
    const state = makeState();
    setupGuild(state);

    const result = await createPieceTool.handler({
      parentId: 'w-ch001',
      title:    'Stripe integration',
      body:     'Add Stripe payment.',
    }) as WritDoc;

    assert.equal(state.piecesCreated.length, 1);
    assert.equal(state.piecesCreated[0].parentId, 'w-ch001');
    assert.equal(state.extSet.length, 0);
    assert.equal(state.linked.length, 0);
    assert.ok(result.id.startsWith('w-piece-'));
  });

  it('stamps ext[surveyor] when hints are provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createPieceTool.handler({
      parentId: 'w-ch001',
      title:    'Stripe integration',
      body:     'Detail.',
      hints:    { complexity: 'bounded', deadline: '2026-12-31' },
    });

    assert.equal(state.extSet.length, 1);
    assert.equal(state.extSet[0].pluginId, 'surveyor');
    const hints = state.extSet[0].value as Record<string, unknown>;
    assert.equal(hints.complexity, 'bounded');
    assert.equal(hints.deadline, '2026-12-31');
  });

  it('records a supersedes link when supersedes is provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createPieceTool.handler({
      parentId:   'w-ch001',
      title:      'Revised piece',
      body:       'Detail.',
      supersedes: 'w-old-piece',
    });

    assert.equal(state.linked.length, 1);
    assert.equal(state.linked[0].targetId, 'w-old-piece');
    assert.equal(state.linked[0].kind, 'surveyor.supersedes');
  });

  it('forwards codex to cartograph when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createPieceTool.handler({
      parentId: 'w-ch001',
      title:    'Piece',
      body:     'Body',
      codex:    'piece-codex',
    });

    assert.equal(state.piecesCreated[0].codex, 'piece-codex');
  });
});

// ── surveyor-create-pieces ────────────────────────────────────────────────

describe('surveyor-create-pieces', () => {
  it('creates multiple pieces in one transaction, returning all results', async () => {
    const state = makeState();
    setupGuild(state);

    const results = await createPiecesTool.handler({
      parentId: 'w-ch001',
      pieces: [
        { title: 'Piece A', body: 'Body A' },
        { title: 'Piece B', body: 'Body B' },
        { title: 'Piece C', body: 'Body C' },
      ],
    }) as WritDoc[];

    assert.equal(state.piecesCreated.length, 3);
    assert.equal(results.length, 3);
  });

  it('applies hints and supersedes per item independently', async () => {
    const state = makeState();
    setupGuild(state);

    await createPiecesTool.handler({
      parentId: 'w-ch001',
      pieces: [
        { title: 'A', body: 'a', hints: { severity: 'serious' }, supersedes: 'w-old-a' },
        { title: 'B', body: 'b' },
      ],
    });

    assert.equal(state.extSet.length, 1);
    const hints = state.extSet[0].value as Record<string, unknown>;
    assert.equal(hints.severity, 'serious');
    assert.equal(state.linked.length, 1);
    assert.equal(state.linked[0].targetId, 'w-old-a');
  });
});

// ── surveyor-create-mandate ───────────────────────────────────────────────

describe('surveyor-create-mandate', () => {
  it('posts a mandate and petitions reckoner with minimal params', async () => {
    const state = makeState();
    setupGuild(state);

    const result = await createMandateTool.handler({
      parentId: 'w-pc001',
      title:    'Implement Stripe webhook',
      body:     'Handle subscription events.',
      source:   'scaffold-surveyor.survey-piece',
    }) as WritDoc;

    assert.equal(state.mandatesPosted.length, 1);
    assert.equal(state.mandatesPosted[0].type, 'mandate');
    assert.equal(state.mandatesPosted[0].title, 'Implement Stripe webhook');
    assert.equal(state.petitioned.length, 1);
    const ext = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(ext.source, 'scaffold-surveyor.survey-piece');
    assert.ok(result.id.startsWith('w-mandate-'));
  });

  it('includes priority when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandateTool.handler({
      parentId: 'w-pc001',
      title:    'Implement webhook',
      body:     'Detail.',
      source:   'scaffold-surveyor.survey-piece',
      priority: { severity: 'critical', scope: 'major-area' },
    });

    const ext = state.petitioned[0].ext as Record<string, unknown>;
    const priority = ext.priority as Record<string, unknown>;
    assert.equal(priority.severity, 'critical');
    assert.equal(priority.scope, 'major-area');
  });

  it('includes complexity when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandateTool.handler({
      parentId:   'w-pc001',
      title:      'Implement webhook',
      body:       'Detail.',
      source:     'scaffold-surveyor.survey-piece',
      complexity: 'exploratory',
    });

    const ext = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(ext.complexity, 'exploratory');
  });

  it('omits priority and complexity when not provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandateTool.handler({
      parentId: 'w-pc001',
      title:    'M',
      body:     'B',
      source:   'scaffold-surveyor.survey-piece',
    });

    const ext = state.petitioned[0].ext as Record<string, unknown>;
    assert.equal(ext.priority, undefined);
    assert.equal(ext.complexity, undefined);
  });

  it('forwards codex to clerk when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandateTool.handler({
      parentId: 'w-pc001',
      title:    'M',
      body:     'B',
      source:   'scaffold-surveyor.survey-piece',
      codex:    'mandate-codex',
    });

    assert.equal(state.mandatesPosted[0].codex, 'mandate-codex');
  });
});

// ── surveyor-create-mandates ──────────────────────────────────────────────

describe('surveyor-create-mandates', () => {
  it('creates multiple mandates and petitions each to reckoner', async () => {
    const state = makeState();
    setupGuild(state);

    const results = await createMandatesTool.handler({
      parentId: 'w-pc001',
      source:   'scaffold-surveyor.survey-piece',
      mandates: [
        { title: 'Mandate A', body: 'Body A' },
        { title: 'Mandate B', body: 'Body B' },
      ],
    }) as WritDoc[];

    assert.equal(state.mandatesPosted.length, 2);
    assert.equal(state.petitioned.length, 2);
    assert.equal(results.length, 2);
    // All petitions share the same source.
    for (const p of state.petitioned) {
      const ext = p.ext as Record<string, unknown>;
      assert.equal(ext.source, 'scaffold-surveyor.survey-piece');
    }
  });

  it('forwards per-item priority and complexity independently', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandatesTool.handler({
      parentId: 'w-pc001',
      source:   'scaffold-surveyor.survey-piece',
      mandates: [
        { title: 'A', body: 'a', priority: { severity: 'critical' }, complexity: 'bounded' },
        { title: 'B', body: 'b' },
      ],
    });

    const ext0 = state.petitioned[0].ext as Record<string, unknown>;
    const ext1 = state.petitioned[1].ext as Record<string, unknown>;
    assert.equal((ext0.priority as Record<string, unknown>).severity, 'critical');
    assert.equal(ext0.complexity, 'bounded');
    assert.equal(ext1.priority, undefined);
    assert.equal(ext1.complexity, undefined);
  });

  it('forwards codex per item when provided', async () => {
    const state = makeState();
    setupGuild(state);

    await createMandatesTool.handler({
      parentId: 'w-pc001',
      source:   'scaffold-surveyor.survey-piece',
      mandates: [
        { title: 'M1', body: 'B1', codex: 'my-codex' },
        { title: 'M2', body: 'B2' },
      ],
    });

    assert.equal(state.mandatesPosted[0].codex, 'my-codex');
    assert.equal(state.mandatesPosted[1].codex, undefined);
  });
});

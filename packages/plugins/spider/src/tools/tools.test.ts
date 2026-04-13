/**
 * Crawl tool tests — unit tests for the crawl-one and crawl-continual tools.
 *
 * Tests handler logic directly (no full Spider apparatus needed), with a
 * minimal guild mock that provides a controllable SpiderApi stub.
 *
 * Uses the native Node test runner consistent with the rest of the package.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import type { SpiderApi, SpiderConfig, CrawlResult } from '../types.ts';

import crawlOneTool from './crawl-one.ts';
import crawlContinualTool from './crawl-continual.ts';
import rigCancelTool from './rig-cancel.ts';
import type { RigDoc } from '../types.ts';

// ── Helpers ────────────────────────────────────────────────────────────

/** Returns a minimal guild with a controllable SpiderApi mock. */
function makeGuild(
  crawlFn: () => Promise<CrawlResult | null>,
  spiderConfig: Partial<SpiderConfig> = {},
): Guild {
  const mockSpider: SpiderApi = {
    crawl: crawlFn,
    show: async () => { throw new Error('not implemented'); },
    list: async () => [],
    forWrit: async () => null,
    resume: async () => {},
    cancel: async () => ({ id: 'rig-1', writId: 'writ-1', status: 'cancelled', engines: [], createdAt: '' } as RigDoc),
    getBlockType: () => undefined,
    listBlockTypes: () => [],
    listTemplates: () => [],
    listTemplateMappings: () => ({}),
  };

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    spider: spiderConfig as SpiderConfig,
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      if (name === 'spider') return mockSpider as unknown as T;
      throw new Error(`Apparatus "${name}" not found`);
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    startupWarnings() { return []; },
  };

  return fakeGuild;
}

/** Returns a crawl() stub that cycles through the given sequence, then hangs. */
function makeCyclingCrawl(
  sequence: Array<CrawlResult | null>,
  onComplete?: () => void,
): () => Promise<CrawlResult | null> {
  let index = 0;
  return async () => {
    if (index < sequence.length) {
      const item = sequence[index++];
      if (index === sequence.length && onComplete) onComplete();
      return item;
    }
    // Hang the loop so tests can exit via Promise.race or similar
    return new Promise<CrawlResult | null>(() => {});
  };
}

/** A sample CrawlResult for use as a non-null "work was done" sentinel. */
const SPAWNED: CrawlResult = { action: 'rig-spawned', rigId: 'rig-1', writId: 'writ-1' };
const COMPLETED: CrawlResult = { action: 'engine-completed', rigId: 'rig-1', engineId: 'draft' };

// ── crawl-one ──────────────────────────────────────────────────────────

describe('crawl-one tool', () => {
  afterEach(() => clearGuild());

  it('has name "crawl-one"', () => {
    assert.equal(crawlOneTool.name, 'crawl-one');
  });

  it('has the correct description', () => {
    assert.equal(crawlOneTool.description, "Execute one step of the Spider's crawl loop");
  });

  it('requires write permission', () => {
    assert.equal(crawlOneTool.permission, 'write');
  });

  it('returns a CrawlResult when work is available', async () => {
    setGuild(makeGuild(async () => SPAWNED));
    const result = await crawlOneTool.handler({});
    assert.deepEqual(result, SPAWNED);
  });

  it('returns null when there is nothing to do', async () => {
    setGuild(makeGuild(async () => null));
    const result = await crawlOneTool.handler({});
    assert.equal(result, null);
  });

  it('delegates directly to spider.crawl() with no transformation', async () => {
    const expected: CrawlResult = { action: 'engine-started', rigId: 'rig-2', engineId: 'implement' };
    setGuild(makeGuild(async () => expected));
    const result = await crawlOneTool.handler({});
    assert.deepEqual(result, expected);
  });
});

// ── crawl-continual — metadata ─────────────────────────────────────────

describe('crawl-continual tool metadata', () => {
  it('has name "crawl-continual"', () => {
    assert.equal(crawlContinualTool.name, 'crawl-continual');
  });

  it('has description without "until idle" qualifier', () => {
    assert.equal(crawlContinualTool.description, "Run the Spider's crawl loop continuously");
    assert.ok(
      !crawlContinualTool.description.includes('until idle'),
      'description must not contain "until idle"',
    );
  });

  it('requires write permission', () => {
    assert.equal(crawlContinualTool.permission, 'write');
  });

  it('maxIdleCycles defaults to 0 (indefinite)', () => {
    const parsed = crawlContinualTool.params.parse({});
    assert.equal(parsed.maxIdleCycles, 0);
  });

  it('instructions explain indefinite default', () => {
    const instructions = crawlContinualTool.instructions ?? '';
    assert.ok(
      instructions.includes('indefinitely'),
      'instructions must mention "indefinitely"',
    );
    assert.ok(
      instructions.includes('maxIdleCycles'),
      'instructions must mention "maxIdleCycles"',
    );
  });

  it('maxIdleCycles param describes auto-stop behavior', () => {
    // In Zod v4, .description is a top-level property on the schema
    const shape = crawlContinualTool.params.shape as Record<string, { description?: string }>;
    const desc = shape['maxIdleCycles']?.description ?? '';
    assert.ok(
      desc.includes('auto-stop') || desc.includes('runs indefinitely'),
      `maxIdleCycles description should mention auto-stop or runs indefinitely, got: "${desc}"`,
    );
  });
});

// ── crawl-continual — indefinite mode ─────────────────────────────────

describe('crawl-continual — indefinite mode (maxIdleCycles: 0)', () => {
  afterEach(() => clearGuild());

  it('does not stop after many consecutive idle cycles', async () => {
    // After 15 null returns, hang forever — if the loop stopped due to
    // idle count, the handler would resolve before the proof fires.
    let callCount = 0;
    let resolveProof!: (val: string) => void;
    const proof = new Promise<string>(r => { resolveProof = r; });

    setGuild(makeGuild(async () => {
      callCount++;
      if (callCount === 15) {
        resolveProof('still-running');
        // Hang the loop so it never resolves naturally
        return new Promise<CrawlResult | null>(() => {});
      }
      return null;
    }));

    const winner = await Promise.race([
      proof,
      crawlContinualTool.handler({ maxIdleCycles: 0, pollIntervalMs: 0 })
        .then(() => 'handler-resolved'),
    ]);

    assert.equal(winner, 'still-running', 'loop must still be running after 15 idle cycles');
    assert.equal(callCount, 15);
  });

  it('does not stop during alternating idle and work cycles', async () => {
    // idle, work, idle, work, idle ... verifies counter resets don't cause
    // premature termination even with many alternations.
    const sequence: Array<CrawlResult | null> = [
      null, SPAWNED, null, COMPLETED, null, SPAWNED, null, COMPLETED, null, SPAWNED,
    ];

    let resolveProof!: (val: string) => void;
    const proof = new Promise<string>(r => { resolveProof = r; });

    setGuild(makeGuild(makeCyclingCrawl(sequence, () => resolveProof('still-running'))));

    const winner = await Promise.race([
      proof,
      crawlContinualTool.handler({ maxIdleCycles: 0, pollIntervalMs: 0 })
        .then(() => 'handler-resolved'),
    ]);

    assert.equal(winner, 'still-running', 'indefinite loop must not resolve on alternating idle/work');
  });
});

// ── crawl-continual — auto-stop mode ──────────────────────────────────

describe('crawl-continual — auto-stop mode (positive maxIdleCycles)', () => {
  afterEach(() => clearGuild());

  it('stops after maxIdleCycles=2 consecutive idles', async () => {
    setGuild(makeGuild(async () => null));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 2, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.deepEqual(result, { actions: [], totalActions: 0 });
  });

  it('stops after maxIdleCycles=1 (single idle)', async () => {
    setGuild(makeGuild(async () => null));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 1, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.deepEqual(result, { actions: [], totalActions: 0 });
  });

  it('collects action results in the returned summary', async () => {
    // Two work results followed by enough idles to stop
    let callCount = 0;
    setGuild(makeGuild(async () => {
      callCount++;
      if (callCount === 1) return SPAWNED;
      if (callCount === 2) return COMPLETED;
      return null; // Will idle to stop
    }));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 2, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.equal(result.totalActions, 2);
    assert.deepEqual(result.actions, [SPAWNED, COMPLETED]);
  });

  it('resets idle counter on work and stops after trailing idles (idle, idle, work, idle, idle, idle)', async () => {
    // Sequence: null, null, SPAWNED, null, null, null
    // With maxIdleCycles=3:
    //   - cycle 1: null → idleCount=1
    //   - cycle 2: null → idleCount=2
    //   - cycle 3: SPAWNED → idleCount=0 (reset)
    //   - cycle 4: null → idleCount=1
    //   - cycle 5: null → idleCount=2
    //   - cycle 6: null → idleCount=3 → exit (idleCount >= maxIdle)
    const sequence: Array<CrawlResult | null> = [null, null, SPAWNED, null, null, null];
    let callCount = 0;

    setGuild(makeGuild(async () => {
      const item = sequence[callCount++] ?? null;
      return item;
    }));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 3, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.equal(callCount, 6, 'must process all 6 cycles before stopping');
    assert.equal(result.totalActions, 1);
    assert.deepEqual(result.actions, [SPAWNED]);
  });

  it('does not terminate early when work resets idle count below threshold', async () => {
    // Sequence: null, work, null, work, null, null → maxIdleCycles=2 → stops after trailing 2 idles
    const sequence: Array<CrawlResult | null> = [null, SPAWNED, null, COMPLETED, null, null];
    let callCount = 0;

    setGuild(makeGuild(async () => {
      return sequence[callCount++] ?? null;
    }));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 2, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.equal(callCount, 6);
    assert.equal(result.totalActions, 2);
    assert.deepEqual(result.actions, [SPAWNED, COMPLETED]);
  });
});

// ── crawl-continual — error handling ──────────────────────────────────

describe('crawl-continual — error handling', () => {
  let originalConsoleError: typeof console.error;
  let errorLogs: string[];

  beforeEach(() => {
    errorLogs = [];
    originalConsoleError = console.error;
    // Capture console.error calls without printing them
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    clearGuild();
  });

  it('logs [crawl-continual] tag when crawl() throws an Error', async () => {
    setGuild(makeGuild(async () => { throw new Error('boom'); }));

    await crawlContinualTool.handler({ maxIdleCycles: 1, pollIntervalMs: 0 });

    assert.ok(
      errorLogs.some(l => l.includes('[crawl-continual]')),
      `expected [crawl-continual] in console.error, got: ${JSON.stringify(errorLogs)}`,
    );
  });

  it('includes the error message in the log output', async () => {
    setGuild(makeGuild(async () => { throw new Error('specific error message'); }));

    await crawlContinualTool.handler({ maxIdleCycles: 1, pollIntervalMs: 0 });

    assert.ok(
      errorLogs.some(l => l.includes('specific error message')),
      `expected error message in log, got: ${JSON.stringify(errorLogs)}`,
    );
  });

  it('handles non-Error throws (strings, objects)', async () => {
    setGuild(makeGuild(async () => { throw 'string error'; }));  // eslint-disable-line @typescript-eslint/no-throw-literal

    await crawlContinualTool.handler({ maxIdleCycles: 1, pollIntervalMs: 0 });

    assert.ok(
      errorLogs.some(l => l.includes('string error')),
      `expected stringified error in log, got: ${JSON.stringify(errorLogs)}`,
    );
  });

  it('increments idle count on error and stops after maxIdleCycles errors', async () => {
    let callCount = 0;
    setGuild(makeGuild(async () => {
      callCount++;
      throw new Error(`error #${callCount}`);
    }));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 2, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.equal(callCount, 2, 'must call crawl() exactly maxIdleCycles times before stopping');
    assert.deepEqual(result, { actions: [], totalActions: 0 });
  });

  it('resets idle count on success after errors', async () => {
    // error, error, work, error, error → with maxIdleCycles=2
    // after 2 errors idleCount=2 = maxIdle, but that triggers the EXIT condition...
    // Wait, with: error (idleCount=1), error (idleCount=2) → exits. So this won't reach work.
    // Instead test: error, work, error, error → maxIdleCycles=2
    // error: idleCount=1, work: idleCount=0, error: idleCount=1, error: idleCount=2 → exit
    let callCount = 0;
    const sequence: Array<'error' | CrawlResult | null> = ['error', SPAWNED, 'error', 'error'];
    setGuild(makeGuild(async () => {
      const item = sequence[callCount++];
      if (item === 'error') throw new Error(`error at #${callCount}`);
      return item as CrawlResult | null;
    }));

    const result = await crawlContinualTool.handler({ maxIdleCycles: 2, pollIntervalMs: 0 }) as {
      actions: unknown[];
      totalActions: number;
    };

    assert.equal(callCount, 4);
    assert.equal(result.totalActions, 1);
    assert.deepEqual(result.actions, [SPAWNED]);
  });
});

// ── crawl-continual — poll interval ───────────────────────────────────

describe('crawl-continual — poll interval configuration', () => {
  afterEach(() => clearGuild());

  it('uses pollIntervalMs param over guild config', async () => {
    // We verify this indirectly: if the tool runs without error and the
    // param is accepted, the interval is being used. We set pollIntervalMs: 0
    // to avoid real delays and confirm the run completes quickly.
    setGuild(makeGuild(async () => null, { pollIntervalMs: 999999 }));

    const start = Date.now();
    await crawlContinualTool.handler({ maxIdleCycles: 1, pollIntervalMs: 0 });
    const elapsed = Date.now() - start;

    // With pollIntervalMs: 0, should complete near-instantly (well under 500ms)
    assert.ok(elapsed < 500, `expected fast completion with pollIntervalMs:0, took ${elapsed}ms`);
  });

  it('uses guild config pollIntervalMs when param is not provided', async () => {
    // Not providing pollIntervalMs param — guild config has pollIntervalMs:0
    // so it still completes quickly.
    setGuild(makeGuild(async () => null, { pollIntervalMs: 0 }));

    const start = Date.now();
    await crawlContinualTool.handler({ maxIdleCycles: 1 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 500, `expected fast completion with config pollIntervalMs:0, took ${elapsed}ms`);
  });
});

// ── rig-cancel ────────────────────────────────────────────────────────────

describe('rig-cancel tool', () => {
  afterEach(() => clearGuild());

  it('has name "rig-cancel"', () => {
    assert.equal(rigCancelTool.name, 'rig-cancel');
  });

  it('requires write permission', () => {
    assert.equal(rigCancelTool.permission, 'write');
  });

  it('params schema has required rigId and optional reason', () => {
    const parsed = rigCancelTool.params.parse({ rigId: 'rig-123' });
    assert.equal(parsed.rigId, 'rig-123');
    assert.equal(parsed.reason, undefined);

    const parsedWithReason = rigCancelTool.params.parse({ rigId: 'rig-456', reason: 'No longer needed' });
    assert.equal(parsedWithReason.rigId, 'rig-456');
    assert.equal(parsedWithReason.reason, 'No longer needed');
  });

  it('handler delegates to SpiderApi.cancel()', async () => {
    let cancelCalledWith: { rigId: string; options?: { reason?: string } } | null = null;
    const cancelledRig = { id: 'rig-1', writId: 'writ-1', status: 'cancelled', engines: [], createdAt: '' } as RigDoc;

    const mockSpider: SpiderApi = {
      crawl: async () => null,
      show: async () => { throw new Error('not implemented'); },
      list: async () => [],
      forWrit: async () => null,
      resume: async () => {},
      cancel: async (rigId, options) => {
        cancelCalledWith = { rigId, options };
        return cancelledRig;
      },
      getBlockType: () => undefined,
      listBlockTypes: () => [],
      listTemplates: () => [],
      listTemplateMappings: () => ({}),
    };

    const fakeGuild = {
      home: '/tmp/test-guild',
      apparatus<T>(name: string): T {
        if (name === 'spider') return mockSpider as unknown as T;
        throw new Error(`Apparatus "${name}" not found`);
      },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 'test-guild', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };

    setGuild(fakeGuild as any);

    const result = await rigCancelTool.handler({ rigId: 'rig-1', reason: 'Test reason' });
    assert.deepEqual(result, cancelledRig);
    assert.ok(cancelCalledWith !== null, 'cancel should have been called');
    assert.equal(cancelCalledWith!.rigId, 'rig-1');
    assert.deepEqual(cancelCalledWith!.options, { reason: 'Test reason' });
  });

  it('handler omits options when reason is not provided', async () => {
    let cancelCalledWith: { rigId: string; options?: { reason?: string } } | null = null;
    const cancelledRig = { id: 'rig-2', writId: 'writ-2', status: 'cancelled', engines: [], createdAt: '' } as RigDoc;

    const mockSpider: SpiderApi = {
      crawl: async () => null,
      show: async () => { throw new Error('not implemented'); },
      list: async () => [],
      forWrit: async () => null,
      resume: async () => {},
      cancel: async (rigId, options) => {
        cancelCalledWith = { rigId, options };
        return cancelledRig;
      },
      getBlockType: () => undefined,
      listBlockTypes: () => [],
      listTemplates: () => [],
      listTemplateMappings: () => ({}),
    };

    const fakeGuild = {
      home: '/tmp/test-guild',
      apparatus<T>(name: string): T {
        if (name === 'spider') return mockSpider as unknown as T;
        throw new Error(`Apparatus "${name}" not found`);
      },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 'test-guild', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };

    setGuild(fakeGuild as any);

    await rigCancelTool.handler({ rigId: 'rig-2' });
    assert.ok(cancelCalledWith !== null);
    assert.equal(cancelCalledWith!.options, undefined);
  });
});

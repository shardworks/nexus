/**
 * Spider — template dispatch, variable resolution, startup validation,
 * resolutionEngineId, CDC resolution fallback, STANDARD_TEMPLATE givens,
 * full pipeline integration, and kit-contributed rig templates / mappings.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild } from '@shardworks/nexus-core';
import type { GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';

import { createSpider } from './spider.ts';
import type { RigTemplate, EngineInstance } from './types.ts';

import {
  STANDARD_TEMPLATE,
  buildFixture,
  rigsBook,
  mandateLikeWritType,
} from './spider-test-fixture.ts';

// ── In-file helpers ────────────────────────────────────────────────────

/** Assert that buildFixture throws a `[spider]` error containing `fragment`. */
function expectStartupError(
  spiderConfig: NonNullable<GuildConfig['spider']>,
  fragment: string,
) {
  assert.throws(
    () => buildFixture({ spider: spiderConfig }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('[spider]'), err.message);
      assert.ok(err.message.includes(fragment), err.message);
      return true;
    },
  );
}

/** Assert that buildFixture starts cleanly with the given spiderConfig. */
function expectStartupOk(spiderConfig: NonNullable<GuildConfig['spider']>) {
  assert.doesNotThrow(() => buildFixture({ spider: spiderConfig }));
}

/** Run `fn`; return any console.warn output it emitted. */
function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** Build a single-engine seal-only template (the most common test shape). */
const sealOnly = (id: string, givens: Record<string, unknown> = {}): RigTemplate => ({
  engines: [{ id, designId: 'seal', givens }],
});

/** Build a LoadedKit with the given kit contributions. */
function makeKit(id: string, kit: Record<string, unknown>): LoadedKit {
  return { packageName: `@test/${id}`, id, version: '0.0.0', kit };
}

const SIMPLE_TEMPLATE: RigTemplate = {
  engines: [{ id: 'step1', designId: 'draft', givens: { writ: '${writ}' } }],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('Spider — template dispatch', () => {
  afterEach(() => { clearGuild(); });

  it('spawns a rig using the type-specific template when writ type matches', async () => {
    const mandateTemplate: RigTemplate = {
      engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'step2', designId: 'seal', upstream: ['step1'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { mandate: mandateTemplate }, rigTemplateMappings: { mandate: 'mandate' } },
    });

    await fix.clerk.post({ title: 'Mandate writ', body: 'test', type: 'mandate' });
    const result = await fix.spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 2);
    assert.equal(rigs[0].engines[0].id, 'step1');
    assert.equal(rigs[0].engines[1].id, 'step2');
  });

  it('dispatches a writ via an explicit rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. A writ type must have an explicit
    // mapping in `rigTemplateMappings` (config or kit) to be dispatched;
    // there is no "default template catches all" fallback.
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
        { id: 'c', designId: 'implement', upstream: ['b'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { default: defaultTemplate }, rigTemplateMappings: { mandate: 'default' } },
    });

    await fix.clerk.post({ title: 'Task writ', body: 'test', type: 'mandate' });
    const result = await fix.spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 3);
  });

  it('uses type-specific template over default when both exist', async () => {
    const mandateTemplate: RigTemplate = sealOnly('only');
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: {
        rigTemplates: { mandate: mandateTemplate, default: defaultTemplate },
        rigTemplateMappings: { mandate: 'mandate' },
      },
    });

    await fix.clerk.post({ title: 'Mandate', body: 'test', type: 'mandate' });
    await fix.spider.crawl();

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 1);
    assert.equal(rigs[0].engines[0].id, 'only');
  });

  it('leaves a writ in open when its type has no rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. An unmapped writ type is inert — the
    // crawl loop skips it and the writ stays in `open`. We use a custom
    // `triage` writ rather than `mandate` because the registry's narrow
    // mandate-builtin fallback (mandate → default/spider.default) would
    // otherwise dispatch.
    const fix = buildFixture(
      { spider: { rigTemplates: { hotfix: sealOnly('x') } } },
      { status: 'completed' },
      { extraWritTypes: [mandateLikeWritType('triage')] },
    );

    const posted = await fix.clerk.post({ title: 'Triage writ', body: 'test', type: 'triage' });
    const result = await fix.spider.crawl();
    assert.equal(result, null);

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs.length, 0);

    const writ = await fix.clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });

  it('dispatches a mandate writ via the mandate-builtin fallback', async () => {
    // Registry's narrow mandate-builtin fallback resolves mandate →
    // default when a `default` template is registered and no explicit
    // mapping exists. The default fixture registers STANDARD_TEMPLATE
    // as config-level `default`.
    const fix = buildFixture();
    await fix.clerk.post({ title: 'Test', body: 'test' });
    const result = await fix.spider.crawl();
    assert.equal(result?.action, 'rig-spawned');
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 5);
  });

  it('leaves a writ in open when no rigTemplates are configured at all', async () => {
    // Override the fixture's default rigTemplates injection. With no
    // templates and no mappings for this writ type, an un-mapped writ
    // is inert. We use `triage` rather than `mandate` because the
    // registry's mandate-builtin fallback would otherwise dispatch when
    // the spider.default kit template is registered.
    const fix = buildFixture(
      { spider: { rigTemplates: undefined } },
      { status: 'completed' },
      { extraWritTypes: [mandateLikeWritType('triage')] },
    );

    const posted = await fix.clerk.post({ title: 'Test writ', body: 'test', type: 'triage' });
    const result = await fix.spider.crawl();
    assert.equal(result, null);

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs.length, 0);

    const writ = await fix.clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });
});

describe('Spider — variable resolution', () => {
  afterEach(() => { clearGuild(); });

  it('${writ} resolves to the full WritDoc object', async () => {
    const fix = buildFixture({ spider: { rigTemplates: { default: sealOnly('only', { w: '${writ}' }) } } });
    const writ = await fix.clerk.post({ title: 'My writ', body: 'test body' });
    await fix.spider.crawl();

    const rigs = await rigsBook(fix.stacks).list();
    const resolved = rigs[0].engines[0].givensSpec.w as { id: string; title: string };
    assert.equal(resolved.id, writ.id);
    assert.equal(resolved.title, writ.title);
  });

  it('${vars.<key>} resolves to the value from spiderConfig.variables', async () => {
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: sealOnly('only', { cmd: '${vars.buildCommand}' }) } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.cmd, 'make build');
  });

  it('${vars.<key>} resolves non-string value types correctly', async () => {
    const fix = buildFixture({ spider: { variables: { count: 42 }, rigTemplates: { default: sealOnly('only', { n: '${vars.count}' }) } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.n, 42);
  });

  it('${vars.<key>} omits the key when the variable is absent from variables dict', async () => {
    const fix = buildFixture({ spider: { variables: {}, rigTemplates: { default: sealOnly('only', { cmd: '${vars.testCommand}' }) } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec));
  });

  it('${vars.<key>} omits the key when the variables dict itself is absent from config', async () => {
    const fix = buildFixture({ spider: { rigTemplates: { default: sealOnly('only', { cmd: '${vars.testCommand}' }) } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec));
  });

  it('literal string without $ prefix is passed through unchanged', async () => {
    const fix = buildFixture({ spider: { rigTemplates: { default: sealOnly('only', { role: 'reviewer', count: 5 }) } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.role, 'reviewer');
    assert.equal(rigs[0].engines[0].givensSpec.count, 5);
  });

  it('mixed literals and ${...} expressions resolve correctly together', async () => {
    const fix = buildFixture({ spider: { variables: { buildCommand: 'pnpm build' }, rigTemplates: { default: sealOnly('only', { writ: '${writ}', role: 'reviewer', cmd: '${vars.buildCommand}' }) } } });
    const writ = await fix.clerk.post({ title: 'Mixed test', body: 'mixed body' });
    await fix.spider.crawl();

    const rigs = await rigsBook(fix.stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    assert.equal((givens.writ as { id: string }).id, writ.id);
    assert.equal(givens.role, 'reviewer');
    assert.equal(givens.cmd, 'pnpm build');
  });

  it('engine with no givens field produces empty givensSpec', async () => {
    const fix = buildFixture({ spider: { rigTemplates: { default: { engines: [{ id: 'only', designId: 'seal' }] } } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.deepEqual(rigs[0].engines[0].givensSpec, {});
  });

  it('${writ} and ${vars.<key>} resolve to their respective values', async () => {
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: sealOnly('only', { w: '${writ}', cmd: '${vars.buildCommand}' }) } } });
    const writ = await fix.clerk.post({ title: 'Curly brace test', body: 'test body' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    assert.equal((givens.w as { id: string }).id, writ.id);
    assert.equal(givens.cmd, 'make build');
  });
});

describe('Spider — startup validation', () => {
  afterEach(() => { clearGuild(); });

  it('throws [spider] error for unknown designId', () => {
    expectStartupError(
      { rigTemplates: { mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] } } },
      'unknown designId "nonexistent"',
    );
  });

  it('accepts Spider builtin designIds (draft, implement, review, revise, seal)', () => {
    expectStartupOk({
      rigTemplates: {
        default: {
          engines: [
            { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
            { id: 'b', designId: 'implement', upstream: ['a'], givens: { writ: '${writ}', role: '${vars.role}' } },
            { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
          ],
        },
      },
    });
  });

  it('throws [spider] error for unknown upstream reference', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', upstream: ['ghost'] }] } } },
      'unknown upstream "ghost"',
    );
  });

  it('throws [spider] error for duplicate engine ids', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'step1', designId: 'seal', givens: {} },
      ] } } },
      'duplicate engine id "step1"',
    );
  });

  it('throws [spider] error for dependency cycle', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [
        { id: 'a', designId: 'draft', upstream: ['c'], givens: { writ: '${writ}' } },
        { id: 'b', designId: 'implement', upstream: ['a'], givens: {} },
        { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
      ] } } },
      'cycle detected',
    );
  });

  it('throws [spider] error for self-referencing upstream', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'self', designId: 'seal', upstream: ['self'], givens: {} }] } } },
      'cycle detected',
    );
  });

  it('throws [spider] error for invalid resolutionEngine', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: {} }], resolutionEngine: 'absent' } } },
      'resolutionEngine "absent"',
    );
  });

  it('throws [spider] error for unrecognized expression (${buildCommand})', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${buildCommand}' } }] } } },
      'unrecognized expression',
    );
  });

  it('throws [spider] error for unrecognized expression (${role})', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { r: '${role}' } }] } } },
      'unrecognized expression',
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.buildCommand})', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.buildCommand}' } }] } } },
      'unrecognized expression',
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.a.b})', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.a.b}' } }] } } },
      'unrecognized expression',
    );
  });

  it('accepts ${vars.a.b} as a valid expression (dot-path traversal)', () => {
    expectStartupOk({ rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.a.b}' } }] } } });
  });

  it('accepts ${vars.buildCommand} as a valid expression', () => {
    expectStartupOk({ rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.buildCommand}' } }] } } });
  });

  it('bare $vars.buildCommand (no ${...}) is treated as a literal string without error', () => {
    expectStartupOk({ rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$vars.buildCommand' } }] } } });
  });

  it('accepts ${writ}, ${vars.<key>} curly-brace forms without throwing', () => {
    expectStartupOk({ rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }] } } });
  });

  it('throws [spider] error for invalid curly-brace variable, error includes original ${...} form', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [{ id: 'x', designId: 'seal', givens: { x: '${badVar}' } }] } } },
      '"${badVar}"',
    );
  });

  it('throws [spider] error for empty engines array', () => {
    expectStartupError(
      { rigTemplates: { default: { engines: [] } } },
      'has no engines',
    );
  });

  it('error messages include the template key', () => {
    assert.throws(
      () => buildFixture({ spider: { rigTemplates: { mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] } } } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('rigTemplates.mandate'), err.message);
        return true;
      },
    );
  });
});

describe('Spider — resolutionEngineId', () => {
  afterEach(() => { clearGuild(); });

  it('sets resolutionEngineId on RigDoc when template has resolutionEngine', async () => {
    const template: RigTemplate = { engines: [{ id: 'only', designId: 'seal', givens: {} }], resolutionEngine: 'only' };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].resolutionEngineId, 'only');
  });

  it('omits resolutionEngineId from RigDoc when template has no resolutionEngine', async () => {
    const fix = buildFixture({ spider: { rigTemplates: { default: sealOnly('only') } } });
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();
    const rigs = await rigsBook(fix.stacks).list();
    assert.ok(!('resolutionEngineId' in rigs[0]) || rigs[0].resolutionEngineId === undefined);
  });
});

describe('Spider — CDC resolution fallback', () => {
  afterEach(() => { clearGuild(); });

  it('uses resolutionEngineId engine yields when present', async () => {
    const fix = buildFixture();
    const writ = await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();

    const book = rigsBook(fix.stacks);
    const [rig] = await book.list();
    const customYields = { result: 'custom-resolution' };
    await book.patch(rig.id, {
      resolutionEngineId: 'implement',
      engines: rig.engines.map((e: EngineInstance) =>
        e.id === 'implement'
          ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: customYields }] }
          : { ...e, status: 'completed' as const },
      ),
      status: 'completed',
    });

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(customYields));
  });

  it('falls back to seal engine when no resolutionEngineId', async () => {
    const fix = buildFixture();
    const writ = await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();

    const book = rigsBook(fix.stacks);
    const [rig] = await book.list();
    const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 1 };
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) =>
        e.id === 'seal'
          ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: sealYields }] }
          : { ...e, status: 'completed' as const },
      ),
      status: 'completed',
    });

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields));
  });

  it('falls back to last completed engine when no resolutionEngineId and no seal', async () => {
    const template: RigTemplate = {
      engines: [
        { id: 'draft', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'], givens: { writ: '${writ}', role: '${vars.role}' } },
      ],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const writ = await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();

    const book = rigsBook(fix.stacks);
    const [rig] = await book.list();
    const implementYields = { sessionId: 'ses-1', sessionStatus: 'completed' };
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1' } }] };
        if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: implementYields }] };
        return e;
      }),
      status: 'completed',
    });

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(implementYields));
  });

  it('uses "Rig completed" when no engine has yields', async () => {
    const fix = buildFixture();
    const writ = await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();

    const book = rigsBook(fix.stacks);
    const [rig] = await book.list();
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => ({ ...e, status: 'completed' as const })),
      status: 'completed',
    });

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.resolution, 'Rig completed');
  });

  it('pre-existing rig without resolutionEngineId falls through to seal then last completed', async () => {
    // Simulate a rig created before the resolutionEngineId feature — no
    // resolutionEngineId at all. The CDC handler must degrade gracefully.
    const fix = buildFixture();
    const writ = await fix.clerk.post({ title: 'pre-existing rig', body: 'test' });
    await fix.spider.crawl();

    const book = rigsBook(fix.stacks);
    const [rig] = await book.list();
    const sealYields = { sealedCommit: 'legacy-abc', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 3 };
    const { resolutionEngineId: _removed, ...rigWithoutResolutionEngineId } = rig as typeof rig & { resolutionEngineId?: string };

    await book.patch(rig.id, {
      ...rigWithoutResolutionEngineId,
      engines: rig.engines.map((e: EngineInstance) =>
        e.id === 'seal'
          ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: sealYields }] }
          : { ...e, status: 'completed' as const },
      ),
      status: 'completed',
    });

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields));
  });
});

describe('Spider — STANDARD_TEMPLATE full pipeline givens', () => {
  afterEach(() => { clearGuild(); });

  it('STANDARD_TEMPLATE spawns a 5-engine rig with correct givens (using ${vars.role})', async () => {
    const fix = buildFixture(); // STANDARD_TEMPLATE with variables: { role: 'artificer' }
    await fix.clerk.post({ title: 'test', body: 'test' });
    await fix.spider.crawl();

    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 5);

    const implement = rigs[0].engines.find((e: EngineInstance) => e.id === 'implement');
    const revise = rigs[0].engines.find((e: EngineInstance) => e.id === 'revise');
    const review = rigs[0].engines.find((e: EngineInstance) => e.id === 'review');

    assert.equal(implement?.givensSpec.role, 'artificer');
    assert.equal(revise?.givensSpec.role, 'artificer');
    assert.equal(review?.givensSpec.role, 'reviewer');
    assert.ok(!('buildCommand' in (review?.givensSpec ?? {})));
    assert.ok(!('testCommand' in (review?.givensSpec ?? {})));
  });
});

describe('Spider — full pipeline integration', () => {
  afterEach(() => { clearGuild(); });

  it('custom 2-engine template (draft → seal): crawls spawn → both engines complete → writ completed', async () => {
    const twoEngineTemplate: RigTemplate = {
      engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'step2', designId: 'seal', upstream: ['step1'], givens: {} },
      ],
      resolutionEngine: 'step2',
    };
    const step1Yields = { draftComplete: true };
    const step2Yields = { sealedCommit: 'custom-sha', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 };

    const fix = buildFixture(
      { spider: { rigTemplates: { default: twoEngineTemplate } } },
      { status: 'completed' },
      {
        customEngines: {
          draft: { id: 'draft', async run() { return { status: 'completed' as const, yields: step1Yields }; } },
          seal:  { id: 'seal',  async run() { return { status: 'completed' as const, yields: step2Yields }; } },
        },
      },
    );

    const writ = await fix.clerk.post({ title: '2-engine writ', body: 'custom pipeline' });

    const r1 = await fix.spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const rigs = await rigsBook(fix.stacks).list();
    assert.equal(rigs[0].engines.length, 2);
    assert.equal(rigs[0].resolutionEngineId, 'step2');

    const r2 = await fix.spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'step1');

    const r3 = await fix.spider.crawl();
    assert.equal(r3?.action, 'rig-completed');
    assert.equal((r3 as { outcome: string }).outcome, 'completed');

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(step2Yields));
  });

  it('3-engine template without seal uses resolutionEngine for writ resolution', async () => {
    const template: RigTemplate = {
      engines: [
        { id: 'draft',     designId: 'draft',     givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '${writ}', role: '${vars.role}' } },
        { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '${writ}' } },
      ],
      resolutionEngine: 'review',
    };
    const draftYields = { drafted: true };
    const implementYields = { implemented: true };
    const reviewYields = { passed: true, findings: '### Overall: PASS\nAll requirements met.', sessionId: 'rev-1', mechanicalChecks: [] };

    const fix = buildFixture(
      { spider: { rigTemplates: { default: template } } },
      { status: 'completed' },
      {
        customEngines: {
          draft:     { id: 'draft',     async run() { return { status: 'completed' as const, yields: draftYields }; } },
          implement: { id: 'implement', async run() { return { status: 'completed' as const, yields: implementYields }; } },
          review:    { id: 'review',    async run() { return { status: 'completed' as const, yields: reviewYields }; } },
        },
      },
    );

    const writ = await fix.clerk.post({ title: '3-engine test', body: 'no seal needed' });

    const r1 = await fix.spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const [rig] = await rigsBook(fix.stacks).list();
    assert.equal(rig.engines.length, 3);
    assert.equal(rig.resolutionEngineId, 'review');

    const r2 = await fix.spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'draft');

    const r3 = await fix.spider.crawl();
    assert.equal(r3?.action, 'engine-completed');
    assert.equal((r3 as { engineId: string }).engineId, 'implement');

    const r4 = await fix.spider.crawl();
    assert.equal(r4?.action, 'rig-completed');
    assert.equal((r4 as { outcome: string }).outcome, 'completed');

    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(reviewYields));
  });
});

describe('Kit contributions — rig templates and mappings', () => {
  afterEach(() => { clearGuild(); });

  describe('V1 — kit template registered under qualified name', () => {
    it('registers kit template under pluginId.templateName', async () => {
      // Custom writ type so the kit mapping doesn't collide with Spider's
      // plugin-default `mandate → default` kit mapping (which would be a
      // kit-vs-kit collision and throw at startup).
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'quality-tools.audit' },
      });
      const fix = buildFixture({}, { status: 'completed' }, {
        kits: [kit],
        extraWritTypes: [mandateLikeWritType('audit')],
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'audit' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines.length, 1);
      assert.equal(rig!.engines[0].id, 'step1');
      assert.equal(rig!.engines[0].designId, 'draft');
    });

    it('skips kit contribution when config defines the qualified name', async () => {
      const differentTemplate: RigTemplate = { engines: [{ id: 'config-step', designId: 'draft', givens: {} }] };
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const fix = buildFixture({
        spider: {
          rigTemplates: { 'quality-tools.audit': differentTemplate },
          rigTemplateMappings: { mandate: 'quality-tools.audit' },
        },
      }, { status: 'completed' }, { kits: [kit] });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'config-step');
    });
  });

  describe('V2 — dependency-scoped designId validation', () => {
    it('rejects kit template referencing designId from undeclared plugin', () => {
      const customEngineKit = makeKit('fabricator', {
        engines: { custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) } },
      });
      const badKit = makeKit('quality-tools', {
        rigTemplates: { audit: { engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }] } },
      });
      // quality-tools has no requires: ['fabricator'], so custom-engine is disallowed.
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, { kits: [customEngineKit, badKit] }),
      );
      assert.ok(
        warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
        `Expected warning about quality-tools audit, got: ${JSON.stringify(warnings)}`,
      );
    });

    it('allows designId from declared dependency', () => {
      const customEngineKit = makeKit('fabricator', {
        engines: { custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) } },
      });
      const goodKit = makeKit('quality-tools', {
        requires: ['fabricator'],
        rigTemplates: { audit: { engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }] } },
        rigTemplateMappings: { audit: 'quality-tools.audit' },
      });
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, {
          kits: [customEngineKit, goodKit],
          extraWritTypes: [mandateLikeWritType('audit')],
        }),
      );
      assert.ok(
        !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
        `Unexpected warning: ${JSON.stringify(warnings)}`,
      );
    });

    it('allows built-in Spider engine designIds without any requires', () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'quality-tools.audit' },
      });
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, {
          kits: [kit],
          extraWritTypes: [mandateLikeWritType('audit')],
        }),
      );
      assert.ok(
        !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates')),
        `Unexpected warning: ${JSON.stringify(warnings)}`,
      );
    });
  });

  describe('V4 — kit mapping routes writ type to template', () => {
    it('uses kit-contributed mapping when spawning', async () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'quality-tools.audit' },
      });
      const fix = buildFixture(
        { spider: { variables: { role: 'artificer' } } },
        { status: 'completed' },
        { kits: [kit], extraWritTypes: [mandateLikeWritType('audit')] },
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'audit' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines.length, 1);
      assert.equal(rig!.engines[0].id, 'step1');
    });

    it('config mapping overrides kit mapping for same writ type', async () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const configTemplate: RigTemplate = { engines: [{ id: 'config-engine', designId: 'draft', givens: {} }] };
      const fix = buildFixture(
        {
          spider: {
            rigTemplates: { 'my-template': configTemplate },
            rigTemplateMappings: { mandate: 'my-template' },
          },
        },
        { status: 'completed' },
        { kits: [kit] },
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'config-engine');
    });

    it('throws when two kits map the same writ type (kit-vs-kit collision is fatal)', () => {
      // Use a custom writ type so the collision is strictly between the
      // two test kits — Spider's plugin-default contributes `mandate`,
      // and mixing that into this test would muddy which collision is
      // under test. Only kit-a declares the writ type so the Clerk's
      // writTypes registry doesn't also report a collision; the
      // rigTemplateMappings throw is the one under test.
      const kitA = makeKit('kit-a', {
        rigTemplates: { tmpl: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'kit-a.tmpl' },
      });
      const kitB = makeKit('kit-b', {
        rigTemplates: { tmpl: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'kit-b.tmpl' },
      });
      assert.throws(
        () => buildFixture({}, { status: 'completed' }, {
          kits: [kitA, kitB],
          extraWritTypes: [mandateLikeWritType('audit')],
        }),
        (err: Error) =>
          /rigTemplateMappings/.test(err.message)
          && /audit/.test(err.message)
          && /kit-a/.test(err.message)
          && /kit-b/.test(err.message),
      );
    });
  });

  describe('V5, V6 — lookup chain (explicit mappings only)', () => {
    it('config rigTemplateMappings routes writ type (R10)', async () => {
      const configTemplate: RigTemplate = { engines: [{ id: 'standard-engine', designId: 'draft', givens: {} }] };
      const fix = buildFixture({
        spider: {
          rigTemplates: { standard: configTemplate },
          rigTemplateMappings: { mandate: 'standard' },
        },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'standard-engine');
    });

    it('unmapped writ types are inert — crawl skips them and they stay in open', async () => {
      // Dispatch is opt-in per writ type; an unmapped custom writ type is
      // not dispatched.
      const fix = buildFixture(
        {
          spider: {
            rigTemplates: { standard: { engines: [{ id: 'std', designId: 'draft', givens: {} }] } },
            rigTemplateMappings: { mandate: 'standard' },
            variables: {},
          },
        },
        { status: 'completed' },
        { extraWritTypes: [mandateLikeWritType('custom-type')] },
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'custom-type' });
      const result = await fix.spider.crawl();
      assert.equal(result, null);
      const rig = await fix.spider.forWrit(writ.id);
      assert.equal(rig, null);
      const shown = await fix.clerk.show(writ.id);
      assert.equal(shown.phase, 'open');
    });
  });

  describe('V7 — dangling mapping references', () => {
    it('warns and removes kit mapping pointing to nonexistent template', () => {
      const kit = makeKit('kit-a', {
        rigTemplateMappings: { audit: 'kit-a.nonexistent' },
      });
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, {
          kits: [kit],
          extraWritTypes: [mandateLikeWritType('audit')],
        }),
      );
      assert.ok(
        warnings.some(w => w.includes('kit-a.nonexistent') || w.includes('template not found')),
        `Expected dangling mapping warning, got: ${JSON.stringify(warnings)}`,
      );
    });

    it('throws when config mapping points to nonexistent template', () => {
      assert.throws(() => {
        buildFixture({ spider: { rigTemplateMappings: { mandate: 'nonexistent-template' } } });
      }, /nonexistent-template/);
    });
  });

  describe('V8 — Spider consumes declaration', () => {
    it('declares consumes with blockTypes, rigTemplates, rigTemplateMappings', () => {
      const plugin = createSpider();
      assert.ok('apparatus' in plugin);
      const apparatus = (plugin as { apparatus: { consumes?: string[] } }).apparatus;
      assert.ok(Array.isArray(apparatus.consumes));
      assert.ok(apparatus.consumes!.includes('blockTypes'));
      assert.ok(apparatus.consumes!.includes('rigTemplates'));
      assert.ok(apparatus.consumes!.includes('rigTemplateMappings'));
    });
  });

  describe('V10 — Phase 1b and Phase 2 scanning', () => {
    it('Phase 1b: picks up apparatus supportKit rigTemplates at startup', async () => {
      const app: LoadedApparatus = {
        packageName: '@test/quality-tools',
        id: 'quality-tools',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit: {
            rigTemplates: { audit: SIMPLE_TEMPLATE },
            rigTemplateMappings: { mandate: 'quality-tools.audit' },
          },
        },
      };
      // Config override pins the mapping (registry's mandate-builtin
      // fallback would otherwise resolve mandate → default/spider.default).
      const fix = buildFixture(
        { spider: { rigTemplateMappings: { mandate: 'quality-tools.audit' } } },
        { status: 'completed' },
        { apparatuses: [app] },
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });

    it('apparatus supportKit contributes rig templates and mappings (via Wire phase)', async () => {
      const lateApp: LoadedApparatus = {
        packageName: '@test/late-app',
        id: 'late-app',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit: {
            rigTemplates: { audit: SIMPLE_TEMPLATE },
            rigTemplateMappings: { mandate: 'late-app.audit' },
          },
        },
      };

      const fix = buildFixture(
        { spider: { rigTemplateMappings: { mandate: 'late-app.audit' } } },
        { status: 'completed' },
        { apparatuses: [lateApp] },
      );

      const writ = await fix.clerk.post({ title: 'Late test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });
  });

  describe('V12 — malformed kit contributions', () => {
    it('warns when kit rigTemplates is not an object', () => {
      const kit = makeKit('bad-kit', { rigTemplates: 'invalid' });
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, { kits: [kit] }),
      );
      assert.ok(
        warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates')),
        `Expected warning about bad-kit rigTemplates, got: ${JSON.stringify(warnings)}`,
      );
    });

    it('warns when kit template is missing engines array', () => {
      const kit = makeKit('bad-kit', {
        rigTemplates: { broken: { notEngines: [] } },
      });
      const { warnings } = withWarnings(() =>
        buildFixture({}, { status: 'completed' }, { kits: [kit] }),
      );
      assert.ok(
        warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates.broken')),
        `Expected warning about bad-kit rigTemplates.broken, got: ${JSON.stringify(warnings)}`,
      );
    });
  });

  describe('Cross-kit mapping reference (test 14)', () => {
    it('kit B can reference a template contributed by kit A', async () => {
      const kitA = makeKit('kit-a', { rigTemplates: { pipeline: SIMPLE_TEMPLATE } });
      const kitB = makeKit('kit-b', { rigTemplateMappings: { audit: 'kit-a.pipeline' } });
      const fix = buildFixture({}, { status: 'completed' }, {
        kits: [kitA, kitB],
        extraWritTypes: [mandateLikeWritType('audit')],
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'audit' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });
  });

  describe('No template and no mapping (test 17)', () => {
    it('leaves a writ in open when no template, mapping, or default exists', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: undefined, variables: {} } },
        { status: 'completed' },
        { extraWritTypes: [mandateLikeWritType('orphan-type')] },
      );

      const posted = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'orphan-type' });
      const result = await fix.spider.crawl();
      assert.equal(result, null);
      const writ = await fix.clerk.show(posted.id);
      assert.equal(writ.phase, 'open');
    });
  });

  // Zero-config mandate dispatch — confirms the plan-and-ship commission's
  // D3 outcome: operators who only declare `spider.variables` (role,
  // buildCommand, testCommand) get the canonical draft → implement → review
  // → revise → seal pipeline purely from Spider's plugin-contributed
  // supportKit. Regressing this test means either Spider's supportKit
  // stopped contributing the `default` rigTemplate, or the narrow
  // mandate-builtin fallback in `lookup()` / `listTemplateMappings()` no
  // longer resolves mandate → spider.default — and every zero-config guild
  // would break.
  describe('Zero-config mandate dispatch (plugin-default template + fallback)', () => {
    it('dispatches mandate writs using Spider supportKit defaults when no config templates or mappings exist', async () => {
      const fix = buildFixture({
        spider: {
          rigTemplates: undefined,
          variables: { role: 'tester', buildCommand: 'noop-build', testCommand: 'noop-test' },
        },
      });

      const writ = await fix.clerk.post({ title: 'Zero-config mandate', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      const engineIds = rig!.engines.map(e => e.id);
      assert.deepEqual(engineIds, ['draft', 'implement', 'review', 'revise', 'seal']);

      // Confirm the plugin default is listed in the registry under its
      // qualified kit name with spider provenance (i.e. it was not
      // supplied by the guild config).
      const templates = fix.spider.listTemplates();
      const defaultTemplate = templates.find(t => t.name === 'spider.default');
      assert.ok(defaultTemplate);
      assert.equal(defaultTemplate!.source, 'spider');
    });
  });
});

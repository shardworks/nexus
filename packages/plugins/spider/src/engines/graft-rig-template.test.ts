/**
 * spider.graft-rig-template engine — behavioral tests.
 *
 * Exercises the engine directly without standing up the full Spider crawl
 * loop. The engine needs a fake Guild whose `spider` apparatus exposes a
 * `getTemplate` method — everything else is irrelevant.
 *
 * Coverage:
 *   - Happy path: template resolves, graft emitted, graftTail honours
 *     `template.resolutionEngine`.
 *   - graftTail fallback: last engine in declaration order when
 *     `template.resolutionEngine` is absent.
 *   - Missing template: throws with the template name in the error message.
 *   - Missing / empty `givens.givens`: engine completes and `${vars.X}`
 *     references survive intact.
 *   - Bad input shapes: non-string/empty `template`, non-object `givens.givens`
 *     throw with descriptive errors.
 *   - Caller-supplied `${vars.<key>}` references are substituted while
 *     `${writ}`, `${yields.*}`, and unmatched `${vars.*}` are preserved.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

import graftRigTemplateEngine from './graft-rig-template.ts';
import type { RigTemplate, RigTemplateEngine, SpiderEngineRunResult, SpiderApi } from '../types.ts';

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * Install a minimal fake Guild whose `spider` apparatus implements just the
 * `getTemplate(name)` method used by the engine.
 */
function installGuild(templates: Record<string, RigTemplate>): void {
  const fakeConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };
  const spiderApi = {
    getTemplate(name: string): RigTemplate | undefined {
      return templates[name];
    },
  } as unknown as SpiderApi;

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      if (name === 'spider') return spiderApi as unknown as T;
      throw new Error(`Apparatus "${name}" not found`);
    },
    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

function makeContext(engineId = 'graft-rig-template'): EngineRunContext {
  return { rigId: 'rig-1', engineId, upstream: {} };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('spider.graft-rig-template engine', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── Happy path with resolutionEngine ────────────────────────────────

  it('happy path: template resolves, graft emitted, graftTail honours resolutionEngine', async () => {
    const template: RigTemplate = {
      engines: [
        { id: 'step-a', designId: 'anima-session', givens: { role: 'worker' } },
        { id: 'step-b', designId: 'anima-session', upstream: ['step-a'], givens: { role: 'reviewer' } },
        { id: 'step-c', designId: 'anima-session', upstream: ['step-b'], givens: { role: 'finalizer' } },
      ],
      resolutionEngine: 'step-b',
    };
    installGuild({ 'my-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'my-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graft: RigTemplateEngine[]; graftTail: string };

    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(result.graft), 'graft is an array');
    assert.equal(result.graft.length, 3, 'graft contains all three template engines');
    assert.equal(result.graftTail, 'step-b', 'graftTail honours resolutionEngine');

    // Verify engine ids are present
    const ids = result.graft.map((e) => e.id);
    assert.deepEqual(ids, ['step-a', 'step-b', 'step-c']);
  });

  // ── graftTail fallback to last engine in declaration order ───────────

  it('graftTail falls back to last engine in declaration order when resolutionEngine absent', async () => {
    const template: RigTemplate = {
      engines: [
        { id: 'alpha', designId: 'anima-session' },
        { id: 'beta',  designId: 'anima-session', upstream: ['alpha'] },
        { id: 'gamma', designId: 'anima-session', upstream: ['beta'] },
      ],
      // no resolutionEngine
    };
    installGuild({ 'fallback-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'fallback-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graftTail: string };

    assert.equal(result.status, 'completed');
    assert.equal(result.graftTail, 'gamma', 'graftTail is last engine in declaration order');
  });

  // ── Missing template throws with name in the error message ──────────

  it('missing template: throws with the template name in the error message', async () => {
    installGuild({}); // empty registry

    await assert.rejects(
      () => graftRigTemplateEngine.run({ template: 'no-such-template' }, makeContext()),
      (err: Error) => {
        assert.match(err.message, /no-such-template/, 'error mentions the missing template name');
        return true;
      },
    );
  });

  // ── Missing givens.givens: completes, ${vars.X} left intact ──────────

  it('missing givens.givens: engine completes and ${vars.X} references survive intact', async () => {
    const template: RigTemplate = {
      engines: [
        {
          id: 'work',
          designId: 'anima-session',
          givens: { prompt: '${vars.myPrompt}', role: '${vars.role}' },
        },
      ],
    };
    installGuild({ 'var-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'var-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graft: RigTemplateEngine[] };

    assert.equal(result.status, 'completed');
    assert.equal(result.graft.length, 1);
    const engine = result.graft[0]!;
    // ${vars.X} references are left untouched when no overlay is supplied
    assert.equal(engine.givens?.prompt, '${vars.myPrompt}', '${vars.myPrompt} preserved');
    assert.equal(engine.givens?.role, '${vars.role}', '${vars.role} preserved');
  });

  it('empty givens.givens object: engine completes and ${vars.X} references survive intact', async () => {
    const template: RigTemplate = {
      engines: [
        {
          id: 'work',
          designId: 'anima-session',
          givens: { prompt: '${vars.prompt}' },
        },
      ],
    };
    installGuild({ 'empty-givens-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'empty-givens-template', givens: {} },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graft: RigTemplateEngine[] };

    assert.equal(result.status, 'completed');
    assert.equal(result.graft[0]!.givens?.prompt, '${vars.prompt}', '${vars.prompt} preserved when overlay is empty');
  });

  // ── Bad input shapes throw with descriptive errors ───────────────────

  it('template not a string: throws describing the bad input', async () => {
    installGuild({});

    await assert.rejects(
      () => graftRigTemplateEngine.run({ template: 42 }, makeContext()),
      (err: Error) => {
        assert.match(err.message, /givens\.template/, 'error names givens.template');
        assert.match(err.message, /non-empty string/, 'error says "non-empty string"');
        return true;
      },
    );
  });

  it('template is empty string: throws describing the bad input', async () => {
    installGuild({});

    await assert.rejects(
      () => graftRigTemplateEngine.run({ template: '' }, makeContext()),
      (err: Error) => {
        assert.match(err.message, /givens\.template/, 'error names givens.template');
        return true;
      },
    );
  });

  it('template is missing: throws describing the bad input', async () => {
    installGuild({});

    await assert.rejects(
      () => graftRigTemplateEngine.run({}, makeContext()),
      (err: Error) => {
        assert.match(err.message, /givens\.template/, 'error names givens.template');
        return true;
      },
    );
  });

  it('givens.givens is an array: throws describing the bad input', async () => {
    installGuild({});

    await assert.rejects(
      () => graftRigTemplateEngine.run({ template: 'any', givens: ['not', 'an', 'object'] }, makeContext()),
      (err: Error) => {
        assert.match(err.message, /givens\.givens/, 'error names givens.givens');
        assert.match(err.message, /plain object/, 'error says "plain object"');
        return true;
      },
    );
  });

  it('givens.givens is a string: throws describing the bad input', async () => {
    installGuild({});

    await assert.rejects(
      () => graftRigTemplateEngine.run({ template: 'any', givens: 'oops' }, makeContext()),
      (err: Error) => {
        assert.match(err.message, /givens\.givens/, 'error names givens.givens');
        return true;
      },
    );
  });

  // ── Caller-given overlay: ${vars.<key>} substituted; rest preserved ───

  it('caller-supplied ${vars.<key>} are substituted; ${writ}, ${yields.*}, unmatched ${vars.*} preserved', async () => {
    const template: RigTemplate = {
      engines: [
        {
          id: 'do-work',
          designId: 'anima-session',
          givens: {
            // Will be substituted by caller overlay
            prompt:    '${vars.prompt}',
            // Will be substituted by caller overlay
            role:      '${vars.role}',
            // Not in overlay — must survive intact
            unmatched: '${vars.unmatched}',
            // Spider writ reference — must survive intact
            writ:      '${writ}',
            // Yields reference — must survive intact
            cwd:       '${yields.draft.path}',
            // Non-string value — must pass through literally
            count:     3,
            // Inline mixed expression with matched var + unmatched var
            label:     'job=${vars.prompt} ctx=${vars.unmatched}',
          },
        },
      ],
    };
    installGuild({ 'overlay-template': template });

    const result = (await graftRigTemplateEngine.run(
      {
        template: 'overlay-template',
        givens: { prompt: 'Do the thing', role: 'worker' },
      },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graft: RigTemplateEngine[] };

    assert.equal(result.status, 'completed');
    const g = result.graft[0]!.givens!;

    // Substituted values
    assert.equal(g.prompt,    'Do the thing', '${vars.prompt} was substituted');
    assert.equal(g.role,      'worker',        '${vars.role} was substituted');

    // Preserved untouched
    assert.equal(g.unmatched, '${vars.unmatched}', 'unmatched ${vars.unmatched} preserved');
    assert.equal(g.writ,      '${writ}',            '${writ} preserved');
    assert.equal(g.cwd,       '${yields.draft.path}', '${yields.draft.path} preserved');

    // Non-string passes through
    assert.equal(g.count, 3, 'non-string value passes through unchanged');

    // Mixed inline: matched part substituted, unmatched part preserved
    assert.equal(
      g.label,
      'job=Do the thing ctx=${vars.unmatched}',
      'mixed inline: matched vars substituted, unmatched preserved',
    );
  });

  // ── Yields shape ──────────────────────────────────────────────────────

  it('yields echo the template name and caller givens', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'e', designId: 'anima-session' }],
    };
    installGuild({ 'echo-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'echo-template', givens: { myKey: 'myVal' } },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; yields: Record<string, unknown> };

    assert.equal(result.status, 'completed');
    assert.equal(result.yields.template, 'echo-template');
    assert.deepEqual(result.yields.givens, { myKey: 'myVal' });
  });

  it('yields.givens defaults to {} when givens.givens is omitted', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'e', designId: 'anima-session' }],
    };
    installGuild({ 'no-givens-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'no-givens-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; yields: Record<string, unknown> };

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.yields.givens, {});
  });

  // ── No retry policy, no collect ───────────────────────────────────────

  it('declares no retry policy (all failure modes are deterministic)', () => {
    assert.equal(
      graftRigTemplateEngine.retry,
      undefined,
      'spider.graft-rig-template must not declare a retry policy',
    );
  });

  it('declares no collect() method (clockwork engine, no anima session)', () => {
    assert.equal(
      graftRigTemplateEngine.collect,
      undefined,
      'spider.graft-rig-template must not declare collect()',
    );
  });

  it('exposes id "spider.graft-rig-template"', () => {
    assert.equal(graftRigTemplateEngine.id, 'spider.graft-rig-template');
  });

  // ── Engine slot structure is preserved ───────────────────────────────

  it('graft preserves upstream, designId, id, and when from the template', async () => {
    const template: RigTemplate = {
      engines: [
        { id: 'first',  designId: 'anima-session' },
        { id: 'second', designId: 'anima-session', upstream: ['first'], when: '${yields.first.ok}' },
      ],
    };
    installGuild({ 'shape-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'shape-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graft: RigTemplateEngine[] };

    assert.equal(result.graft.length, 2);
    const [first, second] = result.graft;
    assert.equal(first!.id, 'first');
    assert.equal(first!.designId, 'anima-session');
    assert.equal(first!.upstream, undefined);
    assert.equal(second!.id, 'second');
    assert.equal(second!.designId, 'anima-session');
    assert.deepEqual(second!.upstream, ['first']);
    assert.equal(second!.when, '${yields.first.ok}');
  });

  // ── Single-engine template ────────────────────────────────────────────

  it('single-engine template: graftTail is that engine\'s id', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'anima-session' }],
    };
    installGuild({ 'single-template': template });

    const result = (await graftRigTemplateEngine.run(
      { template: 'single-template' },
      makeContext(),
    )) as SpiderEngineRunResult & { status: 'completed'; graftTail: string };

    assert.equal(result.graftTail, 'only');
  });
});

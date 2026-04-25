/**
 * Spider — template dispatch, variable resolution, startup validation,
 * resolutionEngineId, CDC resolution fallback, STANDARD_TEMPLATE givens,
 * full pipeline integration, and kit-contributed rig templates / mappings.
 *
 * Covers the configuration / template-resolution surface of Spider: how
 * guild-config templates and mappings interact with kit contributions,
 * variable substitution, the resolution-engine identifier, and the
 * fallback path the CDC handler uses when no resolution engine is named.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId, shortId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider, countRunningEngines, countRunningEnginesInRig } from './spider.ts';
import type { SpiderApi, RigDoc, RigView, EngineInstance, EngineAttempt, ReviewYields, MechanicalCheck, RigTemplate, BlockType, CheckResult, SpiderEngineRunResult, SpiderCollectResult, InputRequestDoc } from './types.ts';

import animaSessionEngine from './engines/anima-session.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

import {
  latestAttempt,
  STANDARD_TEMPLATE,
  FRAMEWORK_KIT_FIELDS,
  buildKitEntries,
  buildCtx,
  mergeCustomEnginesIntoSpider,
  buildFixture,
  rigsBook,
  mandateLikeWritType,
  postWrit,
  assertTerminalAt,
} from './spider-test-fixture.ts';

// ── Template-based rig building tests ─────────────────────────────────

describe('Spider — template dispatch', () => {
  afterEach(() => {
    clearGuild();
  });

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
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mandate writ', body: 'test', type: 'mandate' });
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 2, 'rig should use mandate template (2 engines)');
    assert.equal(rigs[0].engines[0].id, 'step1');
    assert.equal(rigs[0].engines[1].id, 'step2');
  });

  it('dispatches a writ via an explicit rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. A writ type must have an explicit mapping
    // in `rigTemplateMappings` (config or kit) to be dispatched; there is no
    // "default template catches all" fallback.
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
        { id: 'c', designId: 'implement', upstream: ['b'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: {
        rigTemplates: { default: defaultTemplate },
        rigTemplateMappings: { mandate: 'default' },
      },
    });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Task writ', body: 'test', type: 'mandate' });
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 3, 'rig should use mapped template (3 engines)');
  });

  it('uses type-specific template over default when both exist', async () => {
    const mandateTemplate: RigTemplate = {
      engines: [
        { id: 'only', designId: 'seal', givens: {} },
      ],
    };
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { mandate: mandateTemplate, default: defaultTemplate }, rigTemplateMappings: { mandate: 'mandate' } },
    });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'Mandate', body: 'test', type: 'mandate' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 1, 'should use mandate template (1 engine)');
    assert.equal(rigs[0].engines[0].id, 'only');
  });

  it('leaves a writ in open when its type has no rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. A writ type with no mapping is inert by
    // configuration — the Spider's crawl loop skips it and the writ remains
    // in `open` status. This is the substrate for any writ type that should
    // be tracked in the books without being executed.
    //
    // Note: we post a `triage` writ (declared here with no mapping) rather
    // than a `mandate`, because the registry applies a narrow mandate-
    // builtin fallback (mandate → default/spider.default) whenever a
    // `default` template is registered. An unmapped custom writ type is
    // the cleanest way to exercise the "no dispatch" branch.
    const fix = buildFixture(
      {
        spider: {
          rigTemplates: { hotfix: { engines: [{ id: 'x', designId: 'seal', givens: {} }] } },
        },
      },
      { status: 'completed' },
      { extraWritTypes: [mandateLikeWritType('triage')] },
    );
    const { clerk, spider, stacks } = fix;

    const posted = await clerk.post({ title: 'Triage writ', body: 'test', type: 'triage' });
    const result = await spider.crawl();
    assert.equal(result, null, 'crawl should return null — no writ was dispatched');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs.length, 0, 'no rig should be created for unmapped writ type');

    // Writ should still be in 'open' — dispatch was skipped, not failed.
    const writ = await clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });

  it('dispatches a mandate writ via the mandate-builtin fallback', async () => {
    // The registry's narrow mandate-builtin fallback resolves mandate →
    // default when a `default` template is registered and no explicit
    // mapping exists. The default fixture registers STANDARD_TEMPLATE as
    // config-level `default`, so a mandate writ dispatches through the
    // fallback without any explicit rigTemplateMappings declaration.
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'Test', body: 'test' }); // type: 'mandate', uses STANDARD_TEMPLATE
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');
    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'STANDARD_TEMPLATE produces 5 engines');
  });

  it('leaves a writ in open when no rigTemplates are configured at all', async () => {
    // Override the fixture's default rigTemplates injection by setting rigTemplates to undefined.
    // With no templates and no mappings for this writ type, an un-mapped
    // writ is inert — dispatch is skipped. We use a custom `triage` type
    // instead of `mandate` because the registry's narrow mandate-builtin
    // fallback (mandate → default/spider.default) would otherwise dispatch
    // when the spider.default kit template is still registered.
    const fix = buildFixture(
      {
        spider: { rigTemplates: undefined },
      },
      { status: 'completed' },
      { extraWritTypes: [mandateLikeWritType('triage')] },
    );
    const { clerk, spider, stacks } = fix;

    const posted = await clerk.post({ title: 'Test writ', body: 'test', type: 'triage' });
    const result = await spider.crawl();
    assert.equal(result, null);

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs.length, 0);

    const writ = await clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });
});
describe('Spider — variable resolution', () => {
  afterEach(() => {
    clearGuild();
  });

  it('${writ} resolves to the full WritDoc object', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '${writ}' } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'My writ', body: 'test body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const engine = rigs[0].engines[0];
    const resolvedWrit = engine.givensSpec.w as { id: string; type: string; title: string };
    assert.equal(resolvedWrit.id, writ.id);
    assert.equal(resolvedWrit.title, writ.title);
  });

  it('${vars.<key>} resolves to the value from spiderConfig.variables', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.cmd, 'make build');
  });

  it('${vars.<key>} resolves non-string value types correctly', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { n: '${vars.count}' } }],
    };
    const fix = buildFixture({ spider: { variables: { count: 42 }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.n, 42);
  });

  it('${vars.<key>} omits the key when the variable is absent from variables dict', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.testCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: {}, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when testCommand is not set');
  });

  it('${vars.<key>} omits the key when the variables dict itself is absent from config', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.testCommand}' } }],
    };
    // No variables key in spider config
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when no variables dict');
  });

  it('literal string without $ prefix is passed through unchanged', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { role: 'reviewer', count: 5 } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.role, 'reviewer');
    assert.equal(rigs[0].engines[0].givensSpec.count, 5);
  });

  it('mixed literals and ${...} expressions resolve correctly together', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { writ: '${writ}', role: 'reviewer', cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'pnpm build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mixed test', body: 'mixed body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    // ${writ} resolves to the WritDoc object
    assert.equal((givens.writ as { id: string }).id, writ.id, '${writ} should resolve to WritDoc');
    // literal string "reviewer" passes through unchanged
    assert.equal(givens.role, 'reviewer', 'literal "reviewer" should pass through unchanged');
    // ${vars.buildCommand} resolves to the configured value
    assert.equal(givens.cmd, 'pnpm build', '${vars.buildCommand} should resolve to configured value');
  });

  it('engine with no givens field produces empty givensSpec', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal' }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.deepEqual(rigs[0].engines[0].givensSpec, {});
  });

  it('${writ} and ${vars.<key>} resolve to their respective values', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Curly brace test', body: 'test body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givensSpec = rigs[0].engines[0].givensSpec;
    // ${writ} resolves to the WritDoc object
    assert.equal((givensSpec.w as { id: string }).id, writ.id, '${writ} should resolve to WritDoc');
    // ${vars.buildCommand} resolves to the configured value
    assert.equal(givensSpec.cmd, 'make build', '${vars.buildCommand} should resolve to configured value');
  });
});
describe('Spider — startup validation', () => {
  afterEach(() => {
    clearGuild();
  });

  it('throws [spider] error for unknown designId', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), `expected [spider] prefix, got: ${err.message}`);
        assert.ok(err.message.includes('unknown designId "nonexistent"'), err.message);
        return true;
      },
    );
  });

  it('accepts Spider builtin designIds (draft, implement, review, revise, seal)', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
                { id: 'b', designId: 'implement', upstream: ['a'], givens: { writ: '${writ}', role: '${vars.role}' } },
                { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
              ],
            },
          },
        },
      })
    );
  });

  it('throws [spider] error for unknown upstream reference', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'x', designId: 'seal', upstream: ['ghost'] },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unknown upstream "ghost"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for duplicate engine ids', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
                { id: 'step1', designId: 'seal', givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('duplicate engine id "step1"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for dependency cycle', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'a', designId: 'draft', upstream: ['c'], givens: { writ: '${writ}' } },
                { id: 'b', designId: 'implement', upstream: ['a'], givens: {} },
                { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('cycle detected'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for self-referencing upstream', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'self', designId: 'seal', upstream: ['self'], givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('cycle detected'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for invalid resolutionEngine', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: {} }],
              resolutionEngine: 'absent',
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('resolutionEngine "absent"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${buildCommand})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${buildCommand}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${role})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { r: '${role}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.buildCommand})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.buildCommand}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.a.b})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.a.b}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('accepts ${vars.a.b} as a valid expression (dot-path traversal)', () => {
    // Under the new interpolation system, ${vars.*} supports arbitrary dot-path traversal
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.a.b}' } }],
            },
          },
        },
      })
    );
  });

  it('accepts ${vars.buildCommand} as a valid expression', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.buildCommand}' } }],
            },
          },
        },
      })
    );
  });

  it('bare $vars.buildCommand (no ${...}) is treated as a literal string without error', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$vars.buildCommand' } }],
            },
          },
        },
      })
    );
  });

  it('accepts ${writ}, ${vars.<key>} curly-brace forms without throwing', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }],
            },
          },
        },
      })
    );
  });

  it('throws [spider] error for invalid curly-brace variable, error includes original ${...} form', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { x: '${badVar}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('"${badVar}"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for empty engines array', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: { engines: [] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('has no engines'), err.message);
        return true;
      },
    );
  });

  it('error messages include the template key', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('rigTemplates.mandate'), err.message);
        return true;
      },
    );
  });
});
describe('Spider — resolutionEngineId', () => {
  afterEach(() => {
    clearGuild();
  });

  it('sets resolutionEngineId on RigDoc when template has resolutionEngine', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: {} }],
      resolutionEngine: 'only',
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].resolutionEngineId, 'only');
  });

  it('omits resolutionEngineId from RigDoc when template has no resolutionEngine', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: {} }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('resolutionEngineId' in rigs[0]) || rigs[0].resolutionEngineId === undefined);
  });
});
describe('Spider — CDC resolution fallback', () => {
  afterEach(() => {
    clearGuild();
  });

  it('uses resolutionEngineId engine yields when present', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Set a resolutionEngineId and mark that engine completed with yields
    const customYields = { result: 'custom-resolution' };
    await book.patch(rig.id, {
      resolutionEngineId: 'implement',
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: customYields }] };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    // CDC should have fired
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(customYields));
  });

  it('falls back to seal engine when no resolutionEngineId', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 1 };
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'seal') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: sealYields }] };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields));
  });

  it('falls back to last completed engine when no resolutionEngineId and no seal', async () => {
    // Use a template without a seal engine
    const template: RigTemplate = {
      engines: [
        { id: 'draft', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'], givens: { writ: '${writ}', role: '${vars.role}' } },
      ],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
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

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(implementYields));
  });

  it('uses "Rig completed" when no engine has yields', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => ({ ...e, status: 'completed' as const })),
      status: 'completed',
    });

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, 'Rig completed');
  });

  it('pre-existing rig without resolutionEngineId falls through to seal then last completed', async () => {
    // Simulate a rig created before the resolutionEngineId feature was added.
    // It has no resolutionEngineId field at all — the CDC handler must degrade gracefully.
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'pre-existing rig', body: 'test' });
    await spider.crawl(); // spawn (creates rig with resolutionEngineId: 'seal' from STANDARD_TEMPLATE)

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Remove resolutionEngineId entirely to simulate a pre-existing rig and
    // set seal with yields — the fallback chain should find seal.
    const sealYields = { sealedCommit: 'legacy-abc', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 3 };
    const { resolutionEngineId: _removed, ...rigWithoutResolutionEngineId } = rig as typeof rig & { resolutionEngineId?: string };

    // Patch the rig to remove resolutionEngineId and set seal yields
    await book.patch(rig.id, {
      ...rigWithoutResolutionEngineId,
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'seal') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: sealYields }] };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    // CDC should fall through to seal engine (backwards compat path)
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields), 'should fall back to seal engine yields');
  });
});
describe('Spider — STANDARD_TEMPLATE full pipeline givens', () => {
  afterEach(() => {
    clearGuild();
  });

  it('STANDARD_TEMPLATE spawns a 5-engine rig with correct givens (using ${vars.role})', async () => {
    const fix = buildFixture(); // uses STANDARD_TEMPLATE with variables: { role: 'artificer' }
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'standard template produces 5 engines');

    const implement = rigs[0].engines.find((e: EngineInstance) => e.id === 'implement');
    const revise = rigs[0].engines.find((e: EngineInstance) => e.id === 'revise');
    const review = rigs[0].engines.find((e: EngineInstance) => e.id === 'review');

    assert.equal(implement?.givensSpec.role, 'artificer', 'implement ${vars.role} resolves to "artificer"');
    assert.equal(revise?.givensSpec.role, 'artificer', 'revise ${vars.role} resolves to "artificer"');
    assert.equal(review?.givensSpec.role, 'reviewer', 'review literal "reviewer" passes through');
    assert.ok(!('buildCommand' in (review?.givensSpec ?? {})), 'review buildCommand absent when not set in variables');
    assert.ok(!('testCommand' in (review?.givensSpec ?? {})), 'review testCommand absent when not set in variables');
  });
});
// ── Full pipeline integration tests ───────────────────────────────────────

describe('Spider — full pipeline integration', () => {
  afterEach(() => {
    clearGuild();
  });

  it('custom 2-engine template (draft → seal): crawls spawn → both engines complete → writ completed', async () => {
    // Configure a custom 2-engine template for 'mandate' writs (the only declared clerk type).
    // Register stub clockwork implementations so no Scriptorium or Animator is needed.
    const twoEngineTemplate: RigTemplate = {
      engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'step2', designId: 'seal', upstream: ['step1'], givens: {} },
      ],
      resolutionEngine: 'step2',
    };

    // Override builtin engines with stub clockwork implementations
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
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: '2-engine writ', body: 'custom pipeline' });

    // spawn: rig created with 2 engines and resolutionEngineId: 'step2'
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 2, 'custom template creates 2-engine rig');
    assert.equal(rigs[0].resolutionEngineId, 'step2', 'resolutionEngineId set from template');

    // step1 (draft stub — clockwork) runs and completes
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'step1');

    // step2 (seal stub — clockwork) runs; all engines done → rig-completed
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'rig-completed');
    assert.equal((r3 as { outcome: string }).outcome, 'completed');

    // CDC: writ transitions to completed using step2's yields (resolutionEngineId: 'step2')
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(step2Yields), 'resolution uses step2 yields via resolutionEngineId');
  });

  it('3-engine template without seal uses resolutionEngine for writ resolution', async () => {
    // Configure a template with draft → implement → review, no seal engine.
    // resolutionEngine: 'review' directs the CDC handler to use review's yields.
    const template: RigTemplate = {
      engines: [
        { id: 'draft',     designId: 'draft',     givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '${writ}', role: '${vars.role}' } },
        { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '${writ}' } },
      ],
      resolutionEngine: 'review',
    };
    // Override builtin engines with stub clockwork implementations
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
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: '3-engine test', body: 'no seal needed' });

    // spawn: rig created with 3 engines, resolutionEngineId: 'review'
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const [rig] = await rigsBook(stacks).list();
    assert.equal(rig.engines.length, 3);
    assert.equal(rig.resolutionEngineId, 'review');

    // draft runs → engine-completed
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'draft');

    // implement runs → engine-completed
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'engine-completed');
    assert.equal((r3 as { engineId: string }).engineId, 'implement');

    // review runs → all done → rig-completed
    const r4 = await spider.crawl();
    assert.equal(r4?.action, 'rig-completed');
    assert.equal((r4 as { outcome: string }).outcome, 'completed');

    // CDC: writ transitions to completed using review's yields (no seal engine present)
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(reviewYields), 'resolution uses review yields via resolutionEngineId');
  });
});
// ── Kit contributions — rig templates and mappings ─────────────────

describe('Kit contributions — rig templates and mappings', () => {
  // Helper to make a LoadedKit with the given kit contributions
  function makeKit(id: string, kit: Record<string, unknown>): LoadedKit {
    return { packageName: `@test/${id}`, id, version: '0.0.0', kit };
  }

  // Helper to collect console.warn calls
  function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    return { warnings, restore: () => { console.warn = original; } };
  }

  // Simple 1-engine template using the built-in 'draft' designId
  const SIMPLE_TEMPLATE: RigTemplate = {
    engines: [{ id: 'step1', designId: 'draft', givens: { writ: '${writ}' } }],
  };

  afterEach(() => {
    clearGuild();
  });

  describe('V1 — kit template registered under qualified name', () => {
    it('registers kit template under pluginId.templateName', async () => {
      // Uses a custom writ type so the kit mapping doesn't collide with
      // Spider's plugin-default `mandate → default` kit mapping, which would
      // otherwise be a kit-vs-kit collision and throw at startup.
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
      const differentTemplate: RigTemplate = {
        engines: [{ id: 'config-step', designId: 'draft', givens: {} }],
      };
      // Config defines 'quality-tools.audit' directly
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
      // Should use config template (1 engine named 'config-step'), not kit template
      assert.equal(rig!.engines[0].id, 'config-step');
    });
  });

  describe('V2 — dependency-scoped designId validation', () => {
    it('rejects kit template referencing designId from undeclared plugin', () => {
      const { warnings, restore } = captureWarnings();
      try {
        // Kit has no requires, but references a non-builtin engine from 'fabricator'
        const customEngineKit = makeKit('fabricator', {
          engines: {
            custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) },
          },
        });
        const badKit = makeKit('quality-tools', {
          rigTemplates: {
            audit: {
              engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }],
            },
          },
        });
        // quality-tools has no requires: ['fabricator'], so custom-engine is disallowed
        buildFixture({}, { status: 'completed' }, { kits: [customEngineKit, badKit] });
        assert.ok(
          warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
          `Expected warning about quality-tools audit, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('allows designId from declared dependency', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const customEngineKit = makeKit('fabricator', {
          engines: {
            custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) },
          },
        });
        const goodKit = makeKit('quality-tools', {
          requires: ['fabricator'],
          rigTemplates: {
            audit: {
              engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }],
            },
          },
          // Custom writ type avoids kit-vs-kit collision with Spider's
          // plugin-default `mandate → default` mapping.
          rigTemplateMappings: { audit: 'quality-tools.audit' },
        });
        buildFixture({}, { status: 'completed' }, {
          kits: [customEngineKit, goodKit],
          extraWritTypes: [mandateLikeWritType('audit')],
        });
        assert.ok(
          !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
          `Unexpected warning: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('allows built-in Spider engine designIds without any requires', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('quality-tools', {
          // No requires — but uses built-in 'draft' engine
          rigTemplates: { audit: SIMPLE_TEMPLATE },
          // Custom writ type avoids kit-vs-kit collision with Spider's
          // plugin-default `mandate → default` mapping.
          rigTemplateMappings: { audit: 'quality-tools.audit' },
        });
        buildFixture({}, { status: 'completed' }, {
          kits: [kit],
          extraWritTypes: [mandateLikeWritType('audit')],
        });
        assert.ok(
          !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates')),
          `Unexpected warning: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });
  });

  describe('V4 — kit mapping routes writ type to template', () => {
    it('uses kit-contributed mapping when spawning', async () => {
      // Custom writ type avoids kit-vs-kit collision with Spider's
      // plugin-default `mandate → default` mapping.
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { audit: 'quality-tools.audit' },
      });
      const fix = buildFixture(
        { spider: { variables: { role: 'artificer' } } },
        { status: 'completed' },
        { kits: [kit], extraWritTypes: [mandateLikeWritType('audit')] }
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
      const configTemplate: RigTemplate = {
        engines: [{ id: 'config-engine', designId: 'draft', givens: {} }],
      };
      const fix = buildFixture(
        {
          spider: {
            rigTemplates: { 'my-template': configTemplate },
            rigTemplateMappings: { mandate: 'my-template' },
          },
        },
        { status: 'completed' },
        { kits: [kit] }
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      // Should use config template (engine named 'config-engine')
      assert.equal(rig!.engines[0].id, 'config-engine');
    });

    it('throws when two kits map the same writ type (kit-vs-kit collision is fatal)', () => {
      // Use a custom writ type so the collision is strictly between the two
      // test kits — Spider's plugin-default contributes `mandate`, and mixing
      // that into this test would muddy which collision is under test. Only
      // kit-a declares the writ type so the Clerk's writTypes registry does
      // not also report a collision; the rigTemplateMappings throw is the
      // one under test here.
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
        (err: Error) => {
          // Error must name both contributing plugins and the conflicting writ type.
          return (
            /rigTemplateMappings/.test(err.message) &&
            /audit/.test(err.message) &&
            /kit-a/.test(err.message) &&
            /kit-b/.test(err.message)
          );
        },
        'kit-vs-kit mapping collision must throw and name both plugins + the writ type'
      );
    });
  });

  describe('V5, V6 — lookup chain (explicit mappings only)', () => {
    it('config rigTemplateMappings routes writ type (R10)', async () => {
      const configTemplate: RigTemplate = {
        engines: [{ id: 'standard-engine', designId: 'draft', givens: {} }],
      };
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
      // Dispatch is strictly opt-in per writ type. A custom writ type with
      // no explicit mapping in rigTemplateMappings is not dispatched; the
      // writ remains in 'open' status for non-dispatch handling.
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
      assert.equal(result, null, 'crawl should return null — custom-type is unmapped');
      const rig = await fix.spider.forWrit(writ.id);
      assert.equal(rig, null);
      const shown = await fix.clerk.show(writ.id);
      assert.equal(shown.phase, 'open');
    });
  });

  describe('V7 — dangling mapping references', () => {
    it('warns and removes kit mapping pointing to nonexistent template', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('kit-a', {
          // Custom writ type avoids kit-vs-kit collision with Spider's
          // plugin-default `mandate → default` mapping — the dangling-mapping
          // warn is the behavior under test here, not the collision throw.
          // No rigTemplates contributed, but mapping points to kit-a.nonexistent
          rigTemplateMappings: { audit: 'kit-a.nonexistent' },
        });
        buildFixture({}, { status: 'completed' }, {
          kits: [kit],
          extraWritTypes: [mandateLikeWritType('audit')],
        });
        assert.ok(
          warnings.some(w => w.includes('kit-a.nonexistent') || w.includes('template not found')),
          `Expected dangling mapping warning, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('throws when config mapping points to nonexistent template', () => {
      assert.throws(() => {
        buildFixture({
          spider: {
            rigTemplateMappings: { mandate: 'nonexistent-template' },
          },
        });
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
      const supportKit = {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      };
      const app: LoadedApparatus = {
        packageName: '@test/quality-tools',
        id: 'quality-tools',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit,
        },
      };
      // Config override: the registry's mandate-builtin fallback resolves
      // mandate → default/spider.default when no explicit mapping exists.
      // Tests that want a specific kit-contributed template to win for
      // the mandate slot declare a config override to pin the mapping.
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
      const supportKit = {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'late-app.audit' },
      };
      const lateApp: LoadedApparatus = {
        packageName: '@test/late-app',
        id: 'late-app',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit,
        },
      };

      // Config override for the same reason as the sibling test above.
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
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('bad-kit', { rigTemplates: 'invalid' });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates')),
          `Expected warning about bad-kit rigTemplates, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('warns when kit template is missing engines array', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('bad-kit', {
          rigTemplates: { broken: { notEngines: [] } },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates.broken')),
          `Expected warning about bad-kit rigTemplates.broken, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });
  });

  describe('Cross-kit mapping reference (test 14)', () => {
    it('kit B can reference a template contributed by kit A', async () => {
      // Custom writ type avoids kit-vs-kit collision with Spider's
      // plugin-default `mandate → default` mapping.
      const kitA = makeKit('kit-a', {
        rigTemplates: { pipeline: SIMPLE_TEMPLATE },
      });
      const kitB = makeKit('kit-b', {
        rigTemplateMappings: { audit: 'kit-a.pipeline' },
      });
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
      // Config has no templates, no mappings, no default
      // Set rigTemplates to undefined to override the buildFixture default
      const fix = buildFixture(
        {
          spider: { rigTemplates: undefined, variables: {} },
        },
        { status: 'completed' },
        { extraWritTypes: [mandateLikeWritType('orphan-type')] },
      );

      const posted = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'orphan-type' });
      const result = await fix.spider.crawl();
      // Opt-in dispatch: unmapped writ types are inert — crawl skips them.
      assert.equal(result, null);
      const writ = await fix.clerk.show(posted.id);
      assert.equal(writ.phase, 'open');
    });
  });

  // Zero-config mandate dispatch — confirms the plan-and-ship commission's D3
  // outcome: operators who only declare `spider.variables` (role,
  // buildCommand, testCommand) get the canonical draft → implement → review
  // → revise → seal pipeline purely from Spider's plugin-contributed
  // supportKit. If this test ever regresses, it means either Spider's
  // supportKit stopped contributing the `default` rigTemplate, or the
  // narrow mandate-builtin fallback in `lookup()` /
  // `listTemplateMappings()` no longer resolves mandate → spider.default
  // when no explicit mapping exists — and every zero-config guild would
  // break.
  describe('Zero-config mandate dispatch (plugin-default template + fallback)', () => {
    it('dispatches mandate writs using Spider supportKit defaults when no config templates or mappings exist', async () => {
      // Override the fixture's STANDARD_TEMPLATE config injection — we want
      // the plugin-default rigTemplate to be the only source. rigTemplateMappings
      // is omitted entirely so the registry's narrow mandate-builtin
      // fallback (mandate → spider.default) has to take effect.
      const fix = buildFixture({
        spider: {
          rigTemplates: undefined,
          variables: { role: 'tester', buildCommand: 'noop-build', testCommand: 'noop-test' },
        },
      });

      const writ = await fix.clerk.post({ title: 'Zero-config mandate', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned', 'mandate writ should dispatch via plugin-default template');

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig, 'rig should be created for the mandate writ');
      const engineIds = rig!.engines.map(e => e.id);
      assert.deepEqual(
        engineIds,
        ['draft', 'implement', 'review', 'revise', 'seal'],
        'plugin-default rig should materialize the canonical 5-engine draft → seal pipeline',
      );

      // Confirm the plugin default is listed in the registry under its
      // qualified kit name with spider provenance (i.e. it was not supplied
      // by the guild config).
      const templates = fix.spider.listTemplates();
      const defaultTemplate = templates.find(t => t.name === 'spider.default');
      assert.ok(defaultTemplate, 'spider.default template should be registered by Spider supportKit');
      assert.equal(defaultTemplate!.source, 'spider', 'default template should be contributed by the spider plugin, not guild config');
    });
  });
});

/**
 * Clerk × Astrolabe writ-type wiring — end-to-end integration test.
 *
 * Boots a real Clerk and a real Astrolabe against a real `MemoryBackend`
 * and asserts the cross-plugin wiring contract for Astrolabe's two
 * production-registered writ types (`step` and `observation-set`):
 *
 *   1. The two production types are present in `clerk.listWritTypes()`
 *      after `astrolabe.start()` returns, each carrying `source: 'plugin'`,
 *      `isDefault: false`, and the six expected mandate-shape state names.
 *   2. A `step` writ posts into `new`, transitions `new → open → completed`,
 *      and the final document carries `phase === 'completed'` with a
 *      populated `resolvedAt`.
 *   3. An `observation-set` writ posts into `new`, transitions
 *      `new → open → completed`, and the final document carries
 *      `phase === 'completed'` with a populated `resolvedAt`.
 *   4. After the captured `phase:started` handler fires, both types are
 *      still listed by `clerk.listWritTypes()`.
 *   5. After the captured `phase:started` handler fires, a subsequent
 *      `clerk.registerWritType(...)` call rejects with the production
 *      diagnostic prefix `[clerk] registerWritType:` and a message that
 *      names the closed registration window.
 *
 * The fixture installs only `stacks` and `clerk` in the apparatus map —
 * Astrolabe's `start()` only resolves those two; nothing else is touched
 * at startup. The test does not modify any production source file.
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

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createAstrolabe } from './astrolabe.ts';

// ── Helpers ──────────────────────────────────────────────────────────

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

/**
 * Flatten a list of LoadedApparatus `supportKit` bags into KitEntry rows,
 * skipping the framework-reserved `requires` / `recommends` keys. Mirrors
 * the equivalent helper in clerk.test.ts and multi-type.integration.test.ts.
 */
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

/**
 * Build a StartupContext with handler capture so test bodies can fire
 * lifecycle events (notably `phase:started`) against an apparatus's
 * registered handlers. Mirrors `buildClerkCtx` in clerk.test.ts.
 */
function buildCtx(kitEntries: KitEntry[] = []): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const ctx: StartupContext = {
    on(event, handler): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) await h(...args);
  }
  return { ctx, fire };
}

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  /**
   * Fires lifecycle events against the handlers registered on the
   * StartupContext that was passed to `clerk.start()`. The seal-exercise
   * scenario uses this to drive `phase:started` against the Clerk's own
   * handler.
   */
  fireOnClerk: (event: string, ...args: unknown[]) => Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const astrolabePlugin = createAstrolabe();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in astrolabePlugin)) throw new Error('astrolabe must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'astrolabe-writ-types-integration',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/astrolabe-writ-types-integration',
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
      return [];
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
  const stacksCtx = buildCtx().ctx;
  stacksPlugin.apparatus.start(stacksCtx);
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the books that Clerk's and Astrolabe's start() bodies
  // will open. Indexes mirror the supportKit declarations on the two
  // apparatuses so the in-memory backend agrees with the production wiring.
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
  memBackend.ensureBook({ ownerId: 'astrolabe', book: 'plans' }, {
    indexes: ['status', 'codex', 'createdAt'],
  });

  // ── Clerk ──────────────────────────────────────────────────────
  // Capture clerk's `on()` handlers so the seal-exercise scenario can
  // fire `phase:started` against the production registration code path.
  const clerkCtxBundle = buildCtx();
  await clerkPlugin.apparatus.start(clerkCtxBundle.ctx);
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Astrolabe ──────────────────────────────────────────────────
  // The wiring under test: astrolabe's start() resolves stacks and clerk
  // through guild().apparatus(...), opens the plans book, and registers
  // the `step` and `observation-set` writ-type configs. The framework
  // guarantees astrolabe.start() runs after clerk.start() because
  // astrolabe declares `requires: ['stacks', 'clerk']`.
  const astrolabeCtx = buildCtx().ctx;
  await astrolabePlugin.apparatus.start(astrolabeCtx);

  return {
    stacks,
    clerk,
    fireOnClerk: clerkCtxBundle.fire,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Astrolabe × Clerk writ-type wiring — production integration', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Scenario 1: registry presence + state-name shape ────────────
  it('lists the step and observation-set types after astrolabe.start() with the expected mandate-shape state names', () => {
    const types = fix.clerk.listWritTypes();
    const byName = new Map(types.map((t) => [t.name, t]));

    const expectedStateNames = ['new', 'open', 'stuck', 'completed', 'failed', 'cancelled'];

    for (const typeName of ['step', 'observation-set']) {
      const row = byName.get(typeName);
      assert.ok(row, `type "${typeName}" must appear in clerk.listWritTypes() after astrolabe.start()`);
      assert.equal(row.source, 'plugin',
        `type "${typeName}" must carry source: "plugin"`);
      assert.equal(row.isDefault, false,
        `type "${typeName}" must carry isDefault: false`);

      const stateNames = row.states.map((s) => s.name).sort();
      assert.deepEqual(
        stateNames,
        [...expectedStateNames].sort(),
        `type "${typeName}" must carry exactly the six mandate-shape state names`,
      );
    }
  });

  // ── Scenario 2: step writ happy-path round trip ─────────────────
  it('round-trips a step writ through new → open → completed with a populated resolvedAt', async () => {
    const writ = await fix.clerk.post({
      type: 'step',
      title: 'integration-test step writ',
      body: 'Round-trip a step writ through its happy-path lifecycle.',
    });

    assert.equal(writ.type, 'step');
    assert.equal(writ.phase, 'new');
    assert.equal(writ.resolvedAt, undefined,
      'a step writ in the initial state must not carry resolvedAt');

    const opened = await fix.clerk.transition(writ.id, 'open');
    assert.equal(opened.id, writ.id);
    assert.equal(opened.phase, 'open');
    assert.equal(opened.resolvedAt, undefined,
      'open is non-terminal — resolvedAt must remain unset');

    const completed = await fix.clerk.transition(writ.id, 'completed');
    assert.equal(completed.id, writ.id);
    assert.equal(completed.phase, 'completed');
    assert.equal(typeof completed.resolvedAt, 'string',
      'completed is terminal — resolvedAt must be populated with a timestamp string');
  });

  // ── Scenario 3: observation-set writ happy-path round trip ──────
  it('round-trips an observation-set writ through new → open → completed with a populated resolvedAt', async () => {
    const writ = await fix.clerk.post({
      type: 'observation-set',
      title: 'integration-test observation-set writ',
      body: 'Round-trip an observation-set writ through its happy-path lifecycle.',
    });

    assert.equal(writ.type, 'observation-set');
    assert.equal(writ.phase, 'new');
    assert.equal(writ.resolvedAt, undefined,
      'an observation-set writ in the initial state must not carry resolvedAt');

    const opened = await fix.clerk.transition(writ.id, 'open');
    assert.equal(opened.id, writ.id);
    assert.equal(opened.phase, 'open');
    assert.equal(opened.resolvedAt, undefined,
      'open is non-terminal — resolvedAt must remain unset');

    const completed = await fix.clerk.transition(writ.id, 'completed');
    assert.equal(completed.id, writ.id);
    assert.equal(completed.phase, 'completed');
    assert.equal(typeof completed.resolvedAt, 'string',
      'completed is terminal — resolvedAt must be populated with a timestamp string');
  });

  // ── Scenario 4: types survive the phase:started seal ───────────
  it('keeps both step and observation-set listed after the captured phase:started handler fires', async () => {
    await fix.fireOnClerk('phase:started');

    const types = fix.clerk.listWritTypes();
    const byName = new Map(types.map((t) => [t.name, t]));
    for (const typeName of ['step', 'observation-set']) {
      const row = byName.get(typeName);
      assert.ok(row,
        `type "${typeName}" must remain listed after phase:started fires`);
      assert.equal(row.source, 'plugin',
        `type "${typeName}" must still carry source: "plugin" post-seal`);
    }
  });

  // ── Scenario 5: post-seal registerWritType throws ──────────────
  //
  // After the captured `phase:started` handler fires, a subsequent
  // `registerWritType(...)` call must throw the production diagnostic.
  // Match by substring on (a) the `[clerk] registerWritType:` prefix
  // and (b) the phrase naming the closed registration window so the
  // test does not wedge on copy edits to the diagnostic.
  it('rejects a post-seal registerWritType call with the production diagnostic naming the closed registration window', async () => {
    await fix.fireOnClerk('phase:started');

    assert.throws(
      () => {
        fix.clerk.registerWritType({
          name: 'post-seal-canary',
          states: [
            { name: 'new', classification: 'initial', allowedTransitions: [] },
          ],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error, 'thrown value must be an Error');
        assert.ok(
          err.message.startsWith('[clerk] registerWritType:'),
          `error message must start with the [clerk] registerWritType: prefix; got: ${err.message}`,
        );
        assert.ok(
          /registration window/.test(err.message),
          `error message must mention the closed registration window; got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// Reference the otherwise-unused buildKitEntries helper so its declaration
// is preserved without triggering an unused-import lint. The helper is part
// of the fixture's intentional surface for future extensions (per t1) and
// mirrors the equivalent helper in the sibling integration tests.
void buildKitEntries;

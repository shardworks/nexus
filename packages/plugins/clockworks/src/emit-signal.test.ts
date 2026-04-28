/**
 * Clockworks — emit() API and `signal` tool behavioral tests, plus the
 * merged-set + two-check `validateSignal` apparatus-level surface.
 *
 * Covers, end-to-end through `ClockworksApi.validateSignal`:
 *
 *   - emit() round-trip: writes a well-formed row with the generated id,
 *     firedAt, emitter, processed=false, and serialized payload.
 *   - emit() coerces `undefined` payload to `null`.
 *   - emit() throws a descriptive Clockworks-attributed error on a
 *     non-JSON-serializable payload — before the Stacks layer sees the
 *     value.
 *   - validateSignal: undeclared name fails the merged-set check.
 *   - validateSignal: plugin-declared name fails the framework-owned
 *     check (called from the anima signal tool).
 *   - validateSignal: operator-original (guild.json-only) name passes
 *     both checks.
 *   - validateSignal: a name claimed by both a plugin contribution and
 *     guild.json resolves with the operator metadata but rejects emit
 *     from anima (sticky `pluginDeclared`).
 *   - validateSignal: per-call hot-edit semantics — editing the
 *     guild.json events map between two calls is observed without
 *     restart; in-process plugin contributions are start-scoped.
 *   - validateSignal: pre-start guard throws the `clockworks: …`
 *     not-yet-ready message.
 *   - The four fail-loud boot guards (D4 plugin-vs-plugin collision, D5
 *     function-form throw / non-object return, D6 malformed kit value,
 *     D19 malformed guild.json value).
 *   - The anima `signal` tool's params schema rejects an `emitter`
 *     field; the handler always emits with `'anima'`.
 *   - The signal tool declares callableBy: ['anima'] so the patron-
 *     facing CLI auto-builder skips it.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, setGuild } from '@shardworks/nexus-core';
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

import { createClockworks } from './clockworks.ts';
import type {
  ClockworksApi,
  EventDoc,
  EventSpec,
  EventsKitContribution,
} from './types.ts';
import { default as signal } from './tools/signal.ts';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

// ── Test fixture ──────────────────────────────────────────────────────

interface PluginEventsContribution {
  pluginId: string;
  value: EventsKitContribution;
}

interface FixtureOptions {
  /** guild.json clockworks.events map — mutable so tests can hot-edit. */
  declaredEvents?: Record<string, EventSpec>;
  /** Plugin-layer `events` kit contributions, listed in registration order. */
  pluginEvents?: PluginEventsContribution[];
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  clockworks: ClockworksApi;
  eventsBook: ReturnType<StacksApi['book']>;
  guildConfig: GuildConfig;
  apparatusMap: Map<string, unknown>;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    clockworks: options.declaredEvents
      ? { events: { ...options.declaredEvents } }
      : undefined,
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return guildConfig;
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
    startupWarnings() {
      return [];
    },
  };

  setGuild(fakeGuild);

  // Start stacks.
  const stacksApparatus = stacksPlugin.apparatus;
  await stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the book schemas for the in-memory backend.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
  });
  backend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });
  backend.ensureBook({ ownerId: 'clockworks', book: 'event_dispatches' }, {
    indexes: ['eventId', 'status', ['eventId', 'status']],
  });

  // Start clerk.
  const clerkApparatus = clerkPlugin.apparatus;
  await clerkApparatus.start(buildCtx());
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Build the kit entries for clockworks's start(): the `events` kit
  // contributions plus a passthrough that mirrors a real Arbor wiring.
  const clockworksCtxEntries: KitEntry[] = [];
  for (const contribution of options.pluginEvents ?? []) {
    clockworksCtxEntries.push({
      pluginId: contribution.pluginId,
      packageName: `@test/${contribution.pluginId}`,
      type: 'events',
      value: contribution.value,
    });
  }

  // Start clockworks.
  const clockworksApparatus = clockworksPlugin.apparatus;
  await clockworksApparatus.start(buildCtx(clockworksCtxEntries));
  const clockworks = clockworksApparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  return { stacks, clerk, clockworks, eventsBook, guildConfig, apparatusMap };
}

// Narrow the signal tool definition to the type produced by the `tool()`
// helper — we type-erase its param shape for test ergonomics.
const signalTool = signal as unknown as ToolDefinition;

async function invokeSignal(
  params: Record<string, unknown>,
): Promise<unknown> {
  const parsed = signalTool.params.parse(params);
  return signalTool.handler(parsed);
}

// ── ClockworksApi.emit() tests ────────────────────────────────────────

describe('Clockworks — emit()', () => {
  afterEach(() => clearGuild());

  it('writes a well-formed row to the events book', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'demo.thing-happened': {} },
    });

    const before = Date.now();
    const id = await fix.clockworks.emit(
      'demo.thing-happened',
      { hello: 'world' },
      'framework',
    );
    const after = Date.now();

    assert.match(id, /^e-[0-9a-z]+-[0-9a-f]+$/);

    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored, 'event row must be persisted');
    assert.equal(stored.id, id);
    assert.equal(stored.name, 'demo.thing-happened');
    assert.deepEqual(stored.payload, { hello: 'world' });
    assert.equal(stored.emitter, 'framework');
    assert.equal(stored.processed, false);
    const firedAtMs = Date.parse(stored.firedAt);
    assert.ok(
      firedAtMs >= before && firedAtMs <= after,
      `firedAt (${stored.firedAt}) should land within [${before}, ${after}]`,
    );
  });

  it('coerces undefined payload to null', async () => {
    const fix = await buildFixture();
    const id = await fix.clockworks.emit('clockworks.timer', undefined, 'framework');
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.payload, null, 'undefined must be coerced to null');
    assert.ok('payload' in stored, 'payload field must be present, not missing');
  });

  it('stores an explicit null payload unchanged', async () => {
    const fix = await buildFixture();
    const id = await fix.clockworks.emit('clockworks.standing-order.failed', null, 'framework');
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.payload, null);
  });

  it('throws a Clockworks-attributed error on a non-serializable payload', async () => {
    const fix = await buildFixture();

    // Circular reference — JSON.stringify will throw TypeError.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const before = await fix.eventsBook.count();

    await assert.rejects(
      () => fix.clockworks.emit('demo.circular', cyclic, 'framework'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^clockworks:/);
        assert.match(err.message, /not JSON-serializable/);
        return true;
      },
    );

    // The failed emit must not have written any new row.
    assert.equal(await fix.eventsBook.count(), before);
  });

  it('throws on a BigInt payload before reaching the Stacks layer', async () => {
    const fix = await buildFixture();
    const before = await fix.eventsBook.count();
    await assert.rejects(
      () => fix.clockworks.emit('demo.bigint', { n: 1n }, 'framework'),
      /not JSON-serializable/,
    );
    assert.equal(await fix.eventsBook.count(), before);
  });

  it('emit() never calls validateSignal — framework emit sites are unchecked', async () => {
    // No declarations anywhere; emit succeeds regardless because emit()
    // does not consult the merged set (D14).
    const fix = await buildFixture();
    const id = await fix.clockworks.emit('totally.unregistered', { ok: true }, 'framework');
    assert.match(id, /^e-/);
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.name, 'totally.unregistered');
  });
});

// ── ClockworksApi.validateSignal() tests ──────────────────────────────

describe('Clockworks — validateSignal()', () => {
  afterEach(() => clearGuild());

  it('throws a clockworks: not-yet-ready error when called before start()', () => {
    const clockworksPlugin = createClockworks();
    if (!('apparatus' in clockworksPlugin)) throw new Error('expected apparatus');
    const api = clockworksPlugin.apparatus.provides as ClockworksApi;
    assert.throws(
      () => api.validateSignal('anything'),
      /^Error: clockworks: validateSignal\(\) called before start\(\) primed the merged event set\./,
    );
  });

  it('rejects an undeclared name with the signal: prefix and a "not declared" message', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'demo.declared': {} },
    });
    assert.throws(
      () => fix.clockworks.validateSignal('demo.unknown'),
      /signal: "demo\.unknown" is not a declared event/,
    );
  });

  it('accepts a name declared only in guild.json (operator-original)', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'demo.thing': {} },
    });
    assert.doesNotThrow(() => fix.clockworks.validateSignal('demo.thing'));
  });

  it('rejects a plugin-declared name with the framework-owned message', async () => {
    const fix = await buildFixture({
      pluginEvents: [
        { pluginId: 'astrolabe', value: { 'astrolabe.plan.finalized': { description: 'plugin' } } },
      ],
    });
    assert.throws(
      () => fix.clockworks.validateSignal('astrolabe.plan.finalized'),
      /signal: "astrolabe\.plan\.finalized" is a framework-owned event/,
    );
  });

  it('a name claimed by both a plugin and guild.json resolves with operator metadata but stays framework-owned', async () => {
    const fix = await buildFixture({
      pluginEvents: [
        { pluginId: 'astrolabe', value: { 'astrolabe.plan.finalized': { description: 'plugin-side' } } },
      ],
      declaredEvents: {
        'astrolabe.plan.finalized': { description: 'operator override' },
      },
    });
    // Sticky `pluginDeclared`: the framework-owned check fires regardless.
    assert.throws(
      () => fix.clockworks.validateSignal('astrolabe.plan.finalized'),
      /framework-owned/,
    );

    // Anima emit through the signal tool is rejected on the same name.
    await assert.rejects(
      () => invokeSignal({ name: 'astrolabe.plan.finalized', payload: {} }),
      /framework-owned/,
    );
  });

  it('hot-edit observability: editing guild.json events between two calls lands without restart', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'demo.first': {} },
    });
    // Initial state: only `demo.first` is declared.
    assert.doesNotThrow(() => fix.clockworks.validateSignal('demo.first'));
    assert.throws(
      () => fix.clockworks.validateSignal('demo.added-later'),
      /signal: "demo\.added-later" is not a declared event/,
    );

    // Hot-edit the guild config in place.
    fix.guildConfig.clockworks!.events = {
      'demo.first': {},
      'demo.added-later': {},
    };

    // Per-call re-read picks the change up.
    assert.doesNotThrow(() => fix.clockworks.validateSignal('demo.added-later'));
  });

  it('plugin-layer is start-scoped: post-start changes to the kit list have no effect', async () => {
    // We can only mutate the local in-memory list of pluginEvents
    // before start; start-time evaluation freezes the plugin layer.
    // Demonstrate by booting with a fixed plugin layer and asserting
    // no later mutation could change the answer (no API exists to
    // mutate it post-start, which is the behavior we want).
    const fix = await buildFixture({
      pluginEvents: [
        { pluginId: 'astrolabe', value: { 'astrolabe.plan.x': {} } },
      ],
    });
    assert.throws(
      () => fix.clockworks.validateSignal('astrolabe.plan.x'),
      /framework-owned/,
    );
    // No way for a test to "add" a plugin contribution after start —
    // surfacing that assertion is the test: validateSignal still
    // rejects unknown names and accepts known ones consistently.
    assert.throws(
      () => fix.clockworks.validateSignal('astrolabe.plan.unknown'),
      /not a declared event/,
    );
  });
});

// ── Fail-loud boot guards ─────────────────────────────────────────────

describe('Clockworks — fail-loud start() guards', () => {
  afterEach(() => clearGuild());

  it('throws on plugin-vs-plugin name collision (D4)', async () => {
    await assert.rejects(
      () =>
        buildFixture({
          pluginEvents: [
            { pluginId: 'astrolabe', value: { 'shared.event': {} } },
            { pluginId: 'reckoner', value: { 'shared.event': {} } },
          ],
        }),
      /clockworks: events kit collision on "shared\.event" — declared by both "astrolabe" and "reckoner"\./,
    );
  });

  it('does not collide when the same plugin contributes the same name twice', async () => {
    // Same pluginId merging is deduplication, not collision.
    const fix = await buildFixture({
      pluginEvents: [
        { pluginId: 'astrolabe', value: { 'shared.event': { description: 'first' } } },
        { pluginId: 'astrolabe', value: { 'shared.event': { description: 'second' } } },
      ],
    });
    // Either iteration order is acceptable — both wins are framework-owned.
    assert.throws(
      () => fix.clockworks.validateSignal('shared.event'),
      /framework-owned/,
    );
  });

  it('throws when a function-form contribution throws (D5)', async () => {
    await assert.rejects(
      () =>
        buildFixture({
          pluginEvents: [
            {
              pluginId: 'astrolabe',
              value: () => {
                throw new Error('boom');
              },
            },
          ],
        }),
      /boom/,
    );
  });

  it('throws when a function-form contribution returns a non-object (D5)', async () => {
    await assert.rejects(
      () =>
        buildFixture({
          pluginEvents: [
            {
              pluginId: 'astrolabe',
              // Type-erase: the runtime guard catches non-records here.
              value: (() => 'not-an-object') as unknown as EventsKitContribution,
            },
          ],
        }),
      /clockworks: events kit "astrolabe" function-form contribution returned string, expected an object\./,
    );
  });

  it('throws on a malformed kit value that is neither record nor function (D6)', async () => {
    await assert.rejects(
      () =>
        buildFixture({
          pluginEvents: [
            {
              pluginId: 'astrolabe',
              value: 42 as unknown as EventsKitContribution,
            },
          ],
        }),
      /clockworks: events kit "astrolabe" contribution must be a record or a function, got number\./,
    );
  });

  it('throws on a malformed guild.json events.<key> value (D19)', async () => {
    // The malformed value is detected on the first validateSignal call
    // because the guild.json layer is read per-call (D7). Boot itself
    // succeeds — only signal callers see the rejection.
    const fix = await buildFixture({
      declaredEvents: {
        'demo.broken': 'oops' as unknown as EventSpec,
      },
    });
    assert.throws(
      () => fix.clockworks.validateSignal('demo.broken'),
      /clockworks: guild\.json clockworks\.events\.demo\.broken: expected object, got string\./,
    );
  });
});

// ── signal tool tests ─────────────────────────────────────────────────

describe('Clockworks — signal tool', () => {
  afterEach(() => clearGuild());

  it('is restricted to anima callers (not patron)', () => {
    assert.deepEqual(signalTool.callableBy, ['anima']);
  });

  it('hardcodes emitter to "anima" — params schema has no `emitter` key, and a passed-in emitter is ignored', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'code.reviewed': {} },
    });

    const id = await invokeSignal({
      name: 'code.reviewed',
      payload: { lines: 42 },
    }) as string;

    assert.match(id, /^e-[0-9a-z]+-[0-9a-f]+$/);
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.emitter, 'anima');
    assert.equal(stored.name, 'code.reviewed');
    assert.deepEqual(stored.payload, { lines: 42 });

    // Structural assertion: the params schema declares only `name` and
    // `payload` — no `emitter` key exists for callers to spoof.
    const shapeKeys = Object.keys(
      (signalTool.params as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    assert.deepEqual(shapeKeys, ['name', 'payload']);

    // Behavioral assertion: even if a caller passes `emitter`, the
    // value is stripped (zod default strip-unknown), and the row's
    // emitter field still records 'anima'.
    const id2 = await invokeSignal({
      name: 'code.reviewed',
      payload: {},
      emitter: 'spoof-attempt',
    }) as string;
    const stored2 = (await fix.eventsBook.get(id2)) as EventDoc | null;
    assert.ok(stored2);
    assert.equal(stored2.emitter, 'anima');
  });

  it('rejects an undeclared name with the signal: prefix message', async () => {
    await buildFixture({
      declaredEvents: { 'demo.declared': {} },
    });

    await assert.rejects(
      () => invokeSignal({ name: 'demo.not-declared', payload: {} }),
      /signal: "demo\.not-declared" is not a declared event/,
    );
  });

  it('rejects a plugin-declared name (framework-owned) when called from anima', async () => {
    await buildFixture({
      pluginEvents: [
        { pluginId: 'clockworks', value: { 'writ.mandate.open': { description: 'writ-lifecycle' } } },
      ],
    });

    await assert.rejects(
      () => invokeSignal({ name: 'writ.mandate.open', payload: {} }),
      /framework-owned/,
    );
  });

  it('propagates emit()\'s non-serializable-payload error through the signal path', async () => {
    await buildFixture({
      declaredEvents: { 'demo.circular': {} },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => invokeSignal({ name: 'demo.circular', payload: cyclic }),
      /not JSON-serializable/,
    );
  });

  it('omitted payload stores null', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'demo.silent': {} },
    });

    const id = await invokeSignal({ name: 'demo.silent' }) as string;
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.payload, null);
  });
});

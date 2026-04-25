/**
 * Clockworks — emit() API and `signal` tool behavioral tests.
 *
 * Covers every behavior enumerated in commission c-modhilaw's acceptance
 * signal:
 *
 *   - emit() round-trip: writes a well-formed row with the generated id,
 *     firedAt, emitter, processed=false, and serialized payload.
 *   - emit() coerces `undefined` payload to `null` (D8).
 *   - emit() throws a descriptive Clockworks-attributed error on a
 *     non-JSON-serializable payload (D2, D11) — before the Stacks layer
 *     sees the value.
 *   - signal: success on a declared custom event, delegating to emit().
 *   - signal: rejects reserved framework-namespace names (D10,
 *     case-sensitive).
 *   - signal: rejects writ-lifecycle patterns for any declared writ
 *     type (D3).
 *   - signal: rejects undeclared event names.
 *   - signal: declares callableBy: ['anima'] so the patron-facing CLI
 *     auto-builder skips it (D6) — the hand-written framework command
 *     in packages/framework/cli is the sole `nsg signal` registration.
 *
 * The dispatcher, runner, CDC auto-wiring, and framework lifecycle
 * emission are NOT tested here — they are out of scope for this
 * commission.
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
import { makeWritTypeApparatus, mandateLikeWritType } from '@shardworks/clerk-apparatus/testing';

import { createClockworks } from './clockworks.ts';
import type { ClockworksApi, EventDoc } from './types.ts';
import { default as signal } from './tools/signal.ts';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

// ── Test fixture ──────────────────────────────────────────────────────

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(
  kits: LoadedKit[],
  apparatuses: LoadedApparatus[] = [],
): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  clockworks: ClockworksApi;
  eventsBook: ReturnType<StacksApi['book']>;
  apparatusMap: Map<string, unknown>;
}

async function buildFixture(options: {
  declaredEvents?: Record<string, { description?: string }>;
  writTypes?: Array<{ name: string; description?: string }>;
} = {}): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  // Build a tiny fake apparatus per requested writ type. Each apparatus
  // calls clerk.registerWritType from its own start(), mirroring the
  // production registration path. The legacy `clerk.writTypes` guild-
  // config channel is gone — registration must flow through
  // ClerkApi.registerWritType.
  const writTypeApparatuses = (options.writTypes ?? []).map((entry) =>
    makeWritTypeApparatus([mandateLikeWritType(entry.name)], { id: `${entry.name}-plugin` }),
  );

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    clockworks: options.declaredEvents
      ? { events: options.declaredEvents }
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

  // Pre-create the book schemas for in-memory backend. In a live guild
  // Arbor reconciles these from supportKit.books; the unit fixture
  // performs the same wiring manually.
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
  await clerkApparatus.start(buildCtx(buildKitEntries([], [])));
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Run each fake writ-type apparatus's start() so it registers its writ
  // type with the now-started Clerk. Mirrors the production ordering for
  // plugins with `requires: ['clerk']`.
  for (const app of writTypeApparatuses) {
    const apparatus = app.apparatus as { start?: (ctx: StartupContext) => void | Promise<void> };
    if (typeof apparatus.start === 'function') {
      await apparatus.start(buildCtx());
    }
  }

  // Start clockworks.
  const clockworksApparatus = clockworksPlugin.apparatus;
  await clockworksApparatus.start(buildCtx());
  const clockworks = clockworksApparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  return { stacks, clerk, clockworks, eventsBook, apparatusMap };
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
    const id = await fix.clockworks.emit('guild.initialized', undefined, 'framework');
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.payload, null, 'undefined must be coerced to null');
    assert.ok('payload' in stored, 'payload field must be present, not missing');
  });

  it('stores an explicit null payload unchanged', async () => {
    const fix = await buildFixture();
    const id = await fix.clockworks.emit('guild.ready', null, 'framework');
    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.payload, null);
  });

  it('throws a Clockworks-attributed error on a non-serializable payload', async () => {
    const fix = await buildFixture();

    // Circular reference — JSON.stringify will throw TypeError.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => fix.clockworks.emit('demo.circular', cyclic, 'framework'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^clockworks:/);
        assert.match(err.message, /not JSON-serializable/);
        return true;
      },
    );

    // The failed emit must not have written anything.
    assert.equal(await fix.eventsBook.count(), 0);
  });

  it('throws on a BigInt payload before reaching the Stacks layer', async () => {
    const fix = await buildFixture();
    await assert.rejects(
      () => fix.clockworks.emit('demo.bigint', { n: 1n }, 'framework'),
      /not JSON-serializable/,
    );
    assert.equal(await fix.eventsBook.count(), 0);
  });
});

// ── signal tool tests ─────────────────────────────────────────────────

describe('Clockworks — signal tool', () => {
  afterEach(() => clearGuild());

  it('is restricted to anima callers (not patron)', () => {
    assert.deepEqual(signalTool.callableBy, ['anima']);
  });

  it('defaults the emitter to "anima" and delegates to emit()', async () => {
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
  });

  it('honors an explicit emitter argument', async () => {
    const fix = await buildFixture({
      declaredEvents: { 'code.reviewed': {} },
    });

    const id = await invokeSignal({
      name: 'code.reviewed',
      payload: {},
      emitter: 'reviewer-anima',
    }) as string;

    const stored = (await fix.eventsBook.get(id)) as EventDoc | null;
    assert.ok(stored);
    assert.equal(stored.emitter, 'reviewer-anima');
  });

  it('rejects reserved framework namespaces (each of seven)', async () => {
    await buildFixture({
      declaredEvents: { 'demo.thing': {} },
    });

    const reserved = [
      'anima.registered',
      'commission.posted',
      'tool.invoked',
      'migration.applied',
      'guild.initialized',
      'standing-order.created',
      'session.start',
    ];

    for (const name of reserved) {
      await assert.rejects(
        () => invokeSignal({ name, payload: {} }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /reserved framework namespace/);
          return true;
        },
        `"${name}" should be rejected as a reserved namespace`,
      );
    }
  });

  it('writ-lifecycle names are rejected for every declared writ type', async () => {
    await buildFixture({
      declaredEvents: { 'demo.thing': {} },
      writTypes: [{ name: 'bug' }, { name: 'feature' }],
    });

    // Includes the built-in "mandate" type as well as the two guild-declared ones.
    const forbidden = [
      'mandate.ready',
      'mandate.completed',
      'mandate.stuck',
      'mandate.failed',
      'bug.ready',
      'bug.completed',
      'bug.stuck',
      'bug.failed',
      'feature.ready',
      'feature.completed',
      'feature.stuck',
      'feature.failed',
    ];

    for (const name of forbidden) {
      await assert.rejects(
        () => invokeSignal({ name, payload: {} }),
        /writ-lifecycle pattern/,
        `"${name}" should be rejected as a writ-lifecycle pattern`,
      );
    }
  });

  it('rejects names not declared under clockworks.events', async () => {
    await buildFixture({
      declaredEvents: { 'demo.declared': {} },
    });

    await assert.rejects(
      () => invokeSignal({ name: 'demo.not-declared', payload: {} }),
      /not declared in guild\.json under clockworks\.events/,
    );
  });

  it('case-sensitive match: "Guild.initialized" (capital G) bypasses the reserved check but fails the declared check', async () => {
    await buildFixture({
      declaredEvents: { 'demo.declared': {} },
    });

    // Not in the reserved-namespace list (lowercase `guild.` only), so
    // it falls through to the declared-events check and fails there.
    await assert.rejects(
      () => invokeSignal({ name: 'Guild.initialized', payload: {} }),
      /not declared in guild\.json under clockworks\.events/,
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

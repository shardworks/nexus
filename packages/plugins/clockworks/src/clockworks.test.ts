/**
 * Clockworks — skeleton smoke test.
 *
 * The commission explicitly ships no runtime behavior in this task, so
 * the test surface is deliberately narrow:
 *
 *   1. `createClockworks()` returns an apparatus plugin.
 *   2. Starting it against an in-memory Stacks apparatus primes both
 *      declared books so they are reachable via `stacks.book(...)`
 *      under owner id `clockworks`.
 *   3. The apparatus resolves to a defined api object via
 *      `guild().apparatus<ClockworksApi>('clockworks')`.
 *   4. The two CLI stub tools are wired into `supportKit.tools`.
 *   5. `stop()` is a callable no-op.
 *
 * All downstream behavior — emission, dispatch, the runner, CDC
 * auto-wiring, the daemon — belongs to later commissions and is NOT
 * tested here.
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
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import { isToolDefinition } from '@shardworks/tools-apparatus';

import { createClockworks } from './clockworks.ts';
import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
} from './types.ts';

// ── Test fixture ──────────────────────────────────────────────────────

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return kitEntries.filter((e) => e.type === type);
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  apparatusMap: Map<string, unknown>;
  stop: () => void | Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clockworksPlugin)) throw new Error('clockworks must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
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

  const stacksApparatus = stacksPlugin.apparatus;
  await stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the Clockworks-owned books so the in-memory backend has
  // the indexed schema available when start() prime its handles. In a
  // live guild Arbor reconciles `supportKit.books` on startup; in this
  // unit fixture we do the equivalent manually.
  const bookSchemas = clockworksPlugin.apparatus.supportKit?.books as
    | Record<string, { indexes?: (string | string[])[] }>
    | undefined;
  if (bookSchemas) {
    for (const [name, schema] of Object.entries(bookSchemas)) {
      backend.ensureBook({ ownerId: 'clockworks', book: name }, schema ?? {});
    }
  }

  const clockworksApparatus = clockworksPlugin.apparatus;
  await clockworksApparatus.start(buildCtx());
  const clockworks = clockworksApparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  async function stop(): Promise<void> {
    if (clockworksApparatus.stop) await clockworksApparatus.stop();
  }

  return { stacks, clockworks, apparatusMap, stop };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Clockworks — skeleton', () => {
  afterEach(() => clearGuild());

  it('exposes both books under owner id "clockworks" after start', async () => {
    const fix = await buildFixture();
    const events: Book<EventDoc> = fix.stacks.book<EventDoc>('clockworks', 'events');
    const dispatches: Book<EventDispatchDoc> = fix.stacks.book<EventDispatchDoc>(
      'clockworks',
      'event_dispatches',
    );

    // Both handles should be usable — `count()` is the lightest
    // observable behavior that exercises the underlying schema.
    assert.equal(await events.count(), 0);
    assert.equal(await dispatches.count(), 0);
  });

  it('round-trips a document through each declared book', async () => {
    // Even though the api is empty, the books themselves must be
    // persistent — downstream tasks depend on it. Use put/get to
    // verify the handles are fully functional (not just reads).
    const fix = await buildFixture();
    const events = fix.stacks.book<EventDoc>('clockworks', 'events');
    const dispatches = fix.stacks.book<EventDispatchDoc>(
      'clockworks',
      'event_dispatches',
    );

    const now = new Date().toISOString();

    const evt: EventDoc = {
      id: 'e-test-aaaa',
      name: 'clockworks.test-event',
      payload: { hello: 'world' },
      emitter: 'test',
      firedAt: now,
      processed: false,
    };
    await events.put(evt);
    const readBack = await events.get(evt.id);
    assert.deepEqual(readBack, evt);

    const dispatch: EventDispatchDoc = {
      id: 'd-test-bbbb',
      eventId: evt.id,
      handlerType: 'relay',
      handlerName: 'test-relay',
      targetRole: null,
      noticeType: null,
      startedAt: null,
      endedAt: null,
      status: 'pending',
      error: null,
    };
    await dispatches.put(dispatch);
    const readBackDispatch = await dispatches.get(dispatch.id);
    assert.deepEqual(readBackDispatch, dispatch);
  });

  it('resolves to a defined api via guild().apparatus<ClockworksApi>("clockworks")', async () => {
    const fix = await buildFixture();
    // Simulate the call site shape downstream consumers will use.
    const api = fix.apparatusMap.get('clockworks');
    assert.ok(api, 'apparatus api must be registered');
    assert.equal(typeof api, 'object');
  });

  it('wires both clock-* stub tools into supportKit.tools', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    const toolsBag = plugin.apparatus.supportKit?.tools;
    assert.ok(Array.isArray(toolsBag), 'supportKit.tools must be an array');
    const tools = toolsBag as unknown[];
    assert.equal(tools.length, 2, 'exactly two stub tools wired');
    assert.ok(
      tools.every((t) => isToolDefinition(t)),
      'every entry must pass isToolDefinition',
    );
    const names = tools.map((t) => (t as { name: string }).name).sort();
    assert.deepEqual(
      names,
      ['clock-list', 'clock-status'],
      'auto-grouping depends on both tools sharing the clock- prefix',
    );
  });

  it('declares the expected apparatus shape (requires stacks, consumes relays)', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    assert.deepEqual(plugin.apparatus.requires, ['stacks']);
    assert.deepEqual(plugin.apparatus.consumes, ['relays']);
    assert.equal(plugin.apparatus.recommends, undefined);
    assert.equal(typeof plugin.apparatus.start, 'function');
    assert.equal(typeof plugin.apparatus.stop, 'function');
  });

  it('stop() is a safe no-op', async () => {
    const fix = await buildFixture();
    // Must not throw; must not leave the api unreachable.
    await fix.stop();
    assert.ok(fix.apparatusMap.get('clockworks'));
  });
});

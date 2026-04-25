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
  Apparatus,
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
import { relay, type RelayDefinition } from './relay.ts';
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

  it('wires clock-* stub tools and the signal tool into supportKit.tools', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    const toolsBag = plugin.apparatus.supportKit?.tools;
    assert.ok(Array.isArray(toolsBag), 'supportKit.tools must be an array');
    const tools = toolsBag as unknown[];
    assert.equal(tools.length, 3, 'exactly three tools wired');
    assert.ok(
      tools.every((t) => isToolDefinition(t)),
      'every entry must pass isToolDefinition',
    );
    const names = tools.map((t) => (t as { name: string }).name).sort();
    assert.deepEqual(
      names,
      ['clock-list', 'clock-status', 'signal'],
      'auto-grouping depends on both clock-* tools sharing the prefix; signal stays flat',
    );
  });

  it('declares the expected apparatus shape (requires stacks + clerk, consumes relays)', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    assert.deepEqual(plugin.apparatus.requires, ['stacks', 'clerk']);
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

// ── Registry fixture & tests ──────────────────────────────────────────

/**
 * Standalone-kit relay contribution. The fixture turns each entry into a
 * `KitEntry { type: 'relays' }` in the order they appear, mirroring
 * Arbor's wire-phase ordering of standalone kits.
 */
interface KitRelayContribution {
  pluginId: string;
  /** Raw value placed under `relays` — usually an array of relays, or
   *  intentionally malformed for negative-path tests. */
  value: unknown;
}

interface RegistryBuildOptions {
  /** Standalone-kit `relays` contributions, listed in wire order. */
  kitRelays?: KitRelayContribution[];
  /** Override the apparatus's own `supportKit.relays` slot before start. */
  supportKitRelays?: RelayDefinition[];
}

interface RegistryFixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  apparatus: Apparatus;
  ctx: StartupContext;
  apparatusMap: Map<string, unknown>;
  warnings: string[];
  /** Re-run start() with a fresh ctx (or the original); used by the
   *  registry-rebuild test. */
  restart: (override?: RegistryBuildOptions) => Promise<void>;
  stop: () => void | Promise<void>;
}

/**
 * Build an in-memory Clockworks fixture with the relay registry exercised.
 * Captures `console.warn` output for assertions on the lattice-format
 * duplicate-name warning and the malformed-entry warn-skip path.
 */
async function buildRegistryFixture(
  opts: RegistryBuildOptions = {},
): Promise<RegistryFixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clockworksPlugin = createClockworks();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clockworksPlugin)) {
    throw new Error('clockworks must be apparatus');
  }

  // Inject supportKit.relays before start so the apparatus's own
  // contribution participates in the registry merge.
  const supportKit = clockworksPlugin.apparatus.supportKit as {
    relays?: RelayDefinition[];
  };
  if (opts.supportKitRelays) {
    supportKit.relays = opts.supportKitRelays;
  }

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

  // Stacks first.
  const stacksApparatus = stacksPlugin.apparatus;
  await stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Materialize the Clockworks-owned books in the in-memory backend.
  const bookSchemas = clockworksPlugin.apparatus.supportKit?.books as
    | Record<string, { indexes?: (string | string[])[] }>
    | undefined;
  if (bookSchemas) {
    for (const [name, schema] of Object.entries(bookSchemas)) {
      backend.ensureBook({ ownerId: 'clockworks', book: name }, schema ?? {});
    }
  }

  // Build the kit-entry list. Standalone kits come first to mirror
  // Arbor's wire-phase ordering; the apparatus's own supportKit.relays
  // is appended last (only when non-empty).
  function makeCtx(o: RegistryBuildOptions): StartupContext {
    const entries: KitEntry[] = [];
    for (const kit of o.kitRelays ?? []) {
      entries.push({
        pluginId: kit.pluginId,
        packageName: `@test/${kit.pluginId}`,
        type: 'relays',
        value: kit.value,
      });
    }
    const supportRelays = supportKit.relays;
    if (Array.isArray(supportRelays) && supportRelays.length > 0) {
      entries.push({
        pluginId: 'clockworks',
        packageName: '@shardworks/clockworks-apparatus',
        type: 'relays',
        value: supportRelays,
      });
    }
    return buildCtx(entries);
  }

  let ctx = makeCtx(opts);

  // Capture warnings produced during start() — the registry's collision
  // and malformed-entry paths emit via console.warn (lattice precedent).
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };

  const clockworksApparatus = clockworksPlugin.apparatus;
  try {
    await clockworksApparatus.start(ctx);
  } finally {
    console.warn = origWarn;
  }
  const clockworks = clockworksApparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  async function restart(override?: RegistryBuildOptions): Promise<void> {
    if (override?.supportKitRelays !== undefined) {
      supportKit.relays = override.supportKitRelays;
    }
    ctx = makeCtx(override ?? opts);
    const restoreWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await clockworksApparatus.start(ctx);
    } finally {
      console.warn = restoreWarn;
    }
  }

  async function stop(): Promise<void> {
    if (clockworksApparatus.stop) await clockworksApparatus.stop();
  }

  return {
    stacks,
    clockworks,
    apparatus: clockworksApparatus,
    ctx,
    apparatusMap,
    warnings,
    restart,
    stop,
  };
}

describe('Clockworks — relay registry', () => {
  afterEach(() => clearGuild());

  it('exposes an empty supportKit.relays slot for downstream contribution', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    const slot = (plugin.apparatus.supportKit as { relays?: unknown }).relays;
    assert.ok(Array.isArray(slot), 'supportKit.relays must be an array');
    assert.equal((slot as unknown[]).length, 0, 'starts empty in this commission');
  });

  it('merges multiple relays from a single kit and resolves each by name', async () => {
    const a = relay({ name: 'alpha', handler: async () => {} });
    const b = relay({ name: 'beta', handler: () => {} });
    const fix = await buildRegistryFixture({
      kitRelays: [{ pluginId: 'kit-a', value: [a, b] }],
    });

    assert.strictEqual(fix.clockworks.resolveRelay('alpha'), a);
    assert.strictEqual(fix.clockworks.resolveRelay('beta'), b);
  });

  it('warns and keeps the first registration on duplicate relay names', async () => {
    const first = relay({ name: 'dup', handler: () => 'first' });
    const second = relay({ name: 'dup', handler: () => 'second' });
    const fix = await buildRegistryFixture({
      kitRelays: [
        { pluginId: 'kit-a', value: [first] },
        { pluginId: 'kit-b', value: [second] },
      ],
    });

    assert.strictEqual(fix.clockworks.resolveRelay('dup'), first);
    assert.ok(
      fix.warnings.some(
        (w) =>
          w.includes('[clockworks]') &&
          w.includes('Kit "kit-b"') &&
          w.includes('relay name "dup"') &&
          w.includes('already registered by kit "kit-a"') &&
          w.includes('duplicate skipped'),
      ),
      `expected lattice-format duplicate warning; got: ${fix.warnings.join(' | ')}`,
    );
  });

  it('merges supportKit.relays alongside standalone kit contributions', async () => {
    const stdlibRelay = relay({ name: 'stdlib-only', handler: () => {} });
    const userRelay = relay({ name: 'user-only', handler: () => {} });
    const fix = await buildRegistryFixture({
      kitRelays: [{ pluginId: 'user-kit', value: [userRelay] }],
      supportKitRelays: [stdlibRelay],
    });

    assert.strictEqual(fix.clockworks.resolveRelay('stdlib-only'), stdlibRelay);
    assert.strictEqual(fix.clockworks.resolveRelay('user-only'), userRelay);
  });

  it('lets a standalone kit override a supportKit.relays entry of the same name (wire order)', async () => {
    const stdlib = relay({ name: 'shared', handler: () => 'stdlib' });
    const user = relay({ name: 'shared', handler: () => 'user' });
    const fix = await buildRegistryFixture({
      kitRelays: [{ pluginId: 'user-kit', value: [user] }],
      supportKitRelays: [stdlib],
    });

    // Standalone kits are wired first → user-kit wins; supportKit
    // contribution is the duplicate that gets skipped with a warning.
    assert.strictEqual(fix.clockworks.resolveRelay('shared'), user);
    assert.ok(
      fix.warnings.some(
        (w) =>
          w.includes('relay name "shared"') &&
          w.includes('already registered by kit "user-kit"'),
      ),
      `expected supportKit override warning; got: ${fix.warnings.join(' | ')}`,
    );
  });

  it('warn-skips a kit entry whose value is not an array', async () => {
    const valid = relay({ name: 'ok', handler: () => {} });
    const fix = await buildRegistryFixture({
      kitRelays: [
        { pluginId: 'broken-kit', value: { not: 'an-array' } },
        { pluginId: 'good-kit', value: [valid] },
      ],
    });

    // The malformed kit's contribution is skipped wholesale; the good
    // kit still resolves.
    assert.strictEqual(fix.clockworks.resolveRelay('ok'), valid);
    assert.ok(
      fix.warnings.some(
        (w) =>
          w.includes('Kit "broken-kit"') &&
          w.includes('relays') &&
          w.includes('expected an array'),
      ),
      `expected non-array warning; got: ${fix.warnings.join(' | ')}`,
    );
  });

  it('warn-skips an individual malformed RelayDefinition inside an otherwise-valid array', async () => {
    const valid = relay({ name: 'good', handler: () => {} });
    const fix = await buildRegistryFixture({
      kitRelays: [
        {
          pluginId: 'mixed-kit',
          value: [valid, { name: 'no-handler' }, null, 'not-an-object'],
        },
      ],
    });

    // The valid relay still resolves.
    assert.strictEqual(fix.clockworks.resolveRelay('good'), valid);
    // The invalid entries do not.
    assert.equal(fix.clockworks.resolveRelay('no-handler'), undefined);
    // At least one warn message about an invalid RelayDefinition fired.
    assert.ok(
      fix.warnings.some(
        (w) =>
          w.includes('Kit "mixed-kit"') &&
          w.includes('not a valid RelayDefinition'),
      ),
      `expected per-entry warning; got: ${fix.warnings.join(' | ')}`,
    );
  });

  it('rebuilds the registry from scratch on a second start()', async () => {
    const r1 = relay({ name: 'first-pass', handler: () => {} });
    const fix = await buildRegistryFixture({
      kitRelays: [{ pluginId: 'kit-a', value: [r1] }],
    });
    assert.strictEqual(fix.clockworks.resolveRelay('first-pass'), r1);

    // Restart with a different relay set — the previous registration
    // must be gone, the new one must be present.
    const r2 = relay({ name: 'second-pass', handler: () => {} });
    await fix.restart({
      kitRelays: [{ pluginId: 'kit-b', value: [r2] }],
    });

    assert.equal(fix.clockworks.resolveRelay('first-pass'), undefined);
    assert.strictEqual(fix.clockworks.resolveRelay('second-pass'), r2);
  });

  it('returns undefined for an unknown relay name', async () => {
    const fix = await buildRegistryFixture({
      kitRelays: [
        {
          pluginId: 'kit-a',
          value: [relay({ name: 'known', handler: () => {} })],
        },
      ],
    });

    assert.equal(fix.clockworks.resolveRelay('unknown'), undefined);
    assert.equal(fix.clockworks.resolveRelay(''), undefined);
  });

  it('starts cleanly with zero relay contributions', async () => {
    const fix = await buildRegistryFixture();
    assert.equal(fix.clockworks.resolveRelay('anything'), undefined);
    // No warnings should have been produced for the empty case.
    assert.equal(
      fix.warnings.filter((w) => w.includes('[clockworks]')).length,
      0,
      `unexpected clockworks warnings on empty start: ${fix.warnings.join(' | ')}`,
    );
  });
});

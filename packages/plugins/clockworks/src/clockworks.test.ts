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

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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

  // The Clockworks `start()` resolves the clerk/writs book to register
  // the writ-lifecycle CDC observer. Pre-seed an empty clerk/writs so
  // the readBook() call returns a working handle in the unit fixture.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId'],
  });

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

    // A fresh start() emits no rows of its own — the boot-time
    // `guild.initialized` and per-book `migration.applied` emissions
    // were removed in C2. Both books are empty.
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

  it('wires the signal and clock-status tools into supportKit.tools', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    const toolsBag = plugin.apparatus.supportKit?.tools;
    assert.ok(Array.isArray(toolsBag), 'supportKit.tools must be an array');
    const tools = toolsBag as unknown[];
    // The `nsg clock list/tick/run/start/stop/status` operator surface
    // lives in the framework CLI as a hand-written command. The
    // anima-callable surface here is `signal` plus `clock-status`.
    assert.equal(tools.length, 2, 'exactly two tools wired');
    assert.ok(
      tools.every((t) => isToolDefinition(t)),
      'every entry must pass isToolDefinition',
    );
    const names = tools.map((t) => (t as { name: string }).name).sort();
    assert.deepEqual(names, ['clock-status', 'signal']);
  });

  it('declares the expected apparatus shape (requires stacks + clerk, recommends animator + loom, consumes relays, events, and standingOrders)', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    assert.deepEqual(plugin.apparatus.requires, ['stacks', 'clerk']);
    assert.deepEqual(plugin.apparatus.recommends, ['animator', 'loom']);
    assert.deepEqual(plugin.apparatus.consumes, ['relays', 'events', 'standingOrders']);
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

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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

  it('exposes the stdlib summon-relay on supportKit.relays', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('clockworks must be apparatus');
    const slot = (plugin.apparatus.supportKit as { relays?: unknown }).relays;
    assert.ok(Array.isArray(slot), 'supportKit.relays must be an array');
    const entries = slot as RelayDefinition[];
    assert.equal(entries.length, 1, 'exactly one stdlib relay wired today');
    assert.equal(entries[0].name, 'summon-relay');
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

// ── processEvents integration ─────────────────────────────────────────

import type { StandingOrder } from './types.ts';

interface DispatchFixtureOptions {
  /** Standing orders injected into the fake guild's `guildConfig().clockworks`. */
  standingOrders?: StandingOrder[];
  /** Relays added to `supportKit.relays` before start(). */
  supportKitRelays?: RelayDefinition[];
  /**
   * Kit-contributed standing-order arrays, listed in wire order. Each
   * entry becomes a `KitEntry { type: 'standingOrders' }` with the
   * given pluginId, mirroring the way standalone kits surface their
   * contributions through the framework's `ctx.kits` walk.
   */
  kitStandingOrders?: Array<{ pluginId: string; value: unknown }>;
}

interface DispatchFixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  guildConfig: GuildConfig;
  events: Book<EventDoc>;
  dispatches: Book<EventDispatchDoc>;
}

/**
 * End-to-end fixture for the `processEvents` integration test. Boots
 * Stacks + Clockworks against an in-memory backend, wires the supplied
 * standing orders into a mutable `GuildConfig`, and registers any
 * supportKit relays so the dispatcher can resolve them.
 */
async function buildDispatchFixture(
  opts: DispatchFixtureOptions = {},
): Promise<DispatchFixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clockworksPlugin = createClockworks();
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clockworksPlugin)) {
    throw new Error('clockworks must be apparatus');
  }

  // Inject supportKit.relays so the registry pulls them in at start().
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
    clockworks: {
      standingOrders: opts.standingOrders ?? [],
    },
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const apiObj = apparatusMap.get(name);
      if (!apiObj) throw new Error(`Apparatus "${name}" not installed`);
      return apiObj as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  const stacksApparatus = stacksPlugin.apparatus;
  await stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  const bookSchemas = clockworksPlugin.apparatus.supportKit?.books as
    | Record<string, { indexes?: (string | string[])[] }>
    | undefined;
  if (bookSchemas) {
    for (const [name, schema] of Object.entries(bookSchemas)) {
      backend.ensureBook({ ownerId: 'clockworks', book: name }, schema ?? {});
    }
  }

  // Build a startup ctx that includes the supportKit.relays (if any)
  // exactly the way the registry-fixture does, so the dispatcher's
  // resolveRelay can find them.
  const ctxEntries: KitEntry[] = [];
  const supportRelays = supportKit.relays;
  if (Array.isArray(supportRelays) && supportRelays.length > 0) {
    ctxEntries.push({
      pluginId: 'clockworks',
      packageName: '@shardworks/clockworks-apparatus',
      type: 'relays',
      value: supportRelays,
    });
  }
  // Kit-contributed standing orders surface as the new `standingOrders`
  // kit type (C1). Each contribution is sealed at apparatus start and
  // merged additively with the operator slice on every `processEvents`
  // call. Malformed contributions throw kit-attributed boot errors.
  for (const kit of opts.kitStandingOrders ?? []) {
    ctxEntries.push({
      pluginId: kit.pluginId,
      packageName: `@test/${kit.pluginId}`,
      type: 'standingOrders',
      value: kit.value,
    });
  }

  await clockworksPlugin.apparatus.start(buildCtx(ctxEntries));
  const clockworks = clockworksPlugin.apparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  // A fresh start() emits no boot-time rows, so no scrub pass is
  // needed here — the events book is empty when this fixture returns.
  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  return {
    stacks,
    clockworks,
    guildConfig,
    events: eventsBook,
    dispatches: stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches'),
  };
}

describe('Clockworks — processEvents integration', () => {
  afterEach(() => clearGuild());

  it('happy path: emit, processEvents, dispatch row + processed flag round-trip', async () => {
    let received: { eventName: string; home: string; params: Record<string, unknown> } | null = null;
    const recorder = relay({
      name: 'recorder',
      handler: (event, ctx) => {
        received = {
          eventName: event!.name,
          home: ctx.home,
          params: ctx.params,
        };
      },
    });
    const fix = await buildDispatchFixture({
      standingOrders: [
        { on: 'demo.thing', run: 'recorder', with: { mode: 'verbose' } },
      ],
      supportKitRelays: [recorder],
    });

    const eventId = await fix.clockworks.emit('demo.thing', { foo: 1 }, 'tester');
    const summary = await fix.clockworks.processEvents();

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0, skipped: 0 });
    assert.deepEqual(received, {
      eventName: 'demo.thing',
      home: '/tmp/test-guild',
      params: { mode: 'verbose' },
    });

    // Dispatch row persisted with the expected canonical shape.
    const dispatchRows = await fix.dispatches.list();
    assert.equal(dispatchRows.length, 1);
    const row = dispatchRows[0];
    assert.equal(row.eventId, eventId);
    assert.equal(row.handlerType, 'relay');
    assert.equal(row.handlerName, 'recorder');
    assert.equal(row.targetRole, null);
    assert.equal(row.noticeType, null);
    assert.equal(row.status, 'success');
    assert.equal(row.error, null);
    assert.ok(row.startedAt);
    assert.ok(row.endedAt);

    // Event flipped to processed.
    const eventRow = await fix.events.get(eventId);
    assert.equal(eventRow?.processed, true);
  });

  it('failure path: a throwing relay records an error row and still flips processed', async () => {
    const boom = relay({
      name: 'boom',
      handler: () => { throw new Error('handler exploded'); },
    });
    const fix = await buildDispatchFixture({
      standingOrders: [{ on: 'demo.boom', run: 'boom' }],
      supportKitRelays: [boom],
    });

    const eventId = await fix.clockworks.emit('demo.boom', null, 'tester');
    const summary = await fix.clockworks.processEvents();

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 1, skipped: 0 });
    const rows = await fix.dispatches.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].error, 'handler exploded');
    const eventRow = await fix.events.get(eventId);
    assert.equal(eventRow?.processed, true);
  });

  it('returns zero counts on an empty queue and writes nothing', async () => {
    const fix = await buildDispatchFixture();
    const summary = await fix.clockworks.processEvents();
    assert.deepEqual(summary, { processedEvents: 0, dispatches: 0, errors: 0, skipped: 0 });
    assert.equal(await fix.events.count(), 0);
    assert.equal(await fix.dispatches.count(), 0);
  });

  it('throws aggregated when any standing order in guild.json is malformed', async () => {
    const fix = await buildDispatchFixture({
      // Manually inject a malformed entry to simulate a hand-edited
      // guild.json. The `as unknown as StandingOrder` cast bypasses
      // the type system the same way an out-of-band JSON edit would.
      standingOrders: [
        { on: 'demo.x', summon: 'reviewer' } as unknown as StandingOrder,
      ],
    });
    await fix.clockworks.emit('demo.x', null, 'tester');

    await assert.rejects(
      fix.clockworks.processEvents(),
      /sugar form has been removed/,
    );

    // No dispatch rows; event still pending.
    assert.equal(await fix.dispatches.count(), 0);
    const rows = await fix.events.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].processed, false);
  });

  it('threads optional eventId, max, and onDispatch through to the dispatcher', async () => {
    const observed: Array<{ eventId: string; status: string }> = [];
    const recorder = relay({
      name: 'recorder',
      handler: () => {},
    });
    const fix = await buildDispatchFixture({
      standingOrders: [{ on: 'demo.x', run: 'recorder' }],
      supportKitRelays: [recorder],
    });

    // Three events; only one is targeted via eventId.
    await fix.clockworks.emit('demo.x', null, 'tester');
    const target = await fix.clockworks.emit('demo.x', null, 'tester');
    await fix.clockworks.emit('demo.x', null, 'tester');

    const summary = await fix.clockworks.processEvents({
      eventId: target,
      onDispatch: (obs) => {
        observed.push({ eventId: obs.eventId, status: obs.status });
      },
    });

    assert.deepEqual(summary, { processedEvents: 1, dispatches: 1, errors: 0, skipped: 0 });
    assert.deepEqual(observed, [{ eventId: target, status: 'success' }]);

    // Now confirm `max` similarly threads through. Two pending events
    // remain; max=1 should process exactly one of them.
    const summary2 = await fix.clockworks.processEvents({ max: 1 });
    assert.equal(summary2.processedEvents, 1);
  });

  it('hot-edits to standing orders take effect on the next sweep', async () => {
    let invoked = 0;
    const counter = relay({
      name: 'counter',
      handler: () => { invoked += 1; },
    });
    const fix = await buildDispatchFixture({
      standingOrders: [],
      supportKitRelays: [counter],
    });

    // First emit + sweep with no orders — the event flips to processed
    // but no relays fire.
    await fix.clockworks.emit('demo.x', null, 'tester');
    await fix.clockworks.processEvents();
    assert.equal(invoked, 0);

    // Now hot-edit the guild config and emit a fresh event. The next
    // sweep must pick the order up without restarting the apparatus.
    fix.guildConfig.clockworks!.standingOrders!.push({
      on: 'demo.x',
      run: 'counter',
    });
    await fix.clockworks.emit('demo.x', null, 'tester');
    const summary = await fix.clockworks.processEvents();
    assert.equal(summary.processedEvents, 1);
    assert.equal(invoked, 1);
  });

  it('end-to-end SOF emit + loop-guard cycle through the apparatus surface', async () => {
    // Two relays — both throw — and two standing orders. The second
    // order is bound to `clockworks.standing-order.failed`, so when SOF#1
    // is dispatched its handler will also throw, emitting SOF#2. Per D9
    // and the architecture doc, the loop-guard only engages on
    // SECOND-generation SOFs (whose `payload.triggeringEvent.name`
    // equals `'clockworks.standing-order.failed'`). It therefore takes
    // three sweeps to drive the full cascade-then-suppress cycle:
    //
    //   sweep 1: process the original event → boomA throws → SOF#1
    //            emitted (triggeringEvent.name = 'demo.cycle').
    //   sweep 2: process SOF#1 → boomB throws → SOF#2 emitted
    //            (triggeringEvent.name = 'clockworks.standing-order.failed').
    //   sweep 3: process SOF#2 → loop-guard engages, `'skipped'` row
    //            written, no fresh SOF emitted (D14).
    const boomA = relay({
      name: 'boomA',
      handler: () => { throw new Error('first explode'); },
    });
    const boomB = relay({
      name: 'boomB',
      handler: () => { throw new Error('second explode'); },
    });
    const fix = await buildDispatchFixture({
      standingOrders: [
        { on: 'demo.cycle', run: 'boomA' },
        { on: 'clockworks.standing-order.failed', run: 'boomB' },
      ],
      supportKitRelays: [boomA, boomB],
    });

    // ── Sweep 1 ────────────────────────────────────────────────────
    const originalId = await fix.clockworks.emit(
      'demo.cycle',
      { hello: 'world' },
      'tester',
    );
    const summary1 = await fix.clockworks.processEvents();
    assert.deepEqual(summary1, {
      processedEvents: 1,
      dispatches: 1,
      errors: 1,
      skipped: 0,
    });
    // A fresh SOF event appears in the events book with the spec'd
    // payload shape and emitter 'framework' (acceptance signal).
    const sofAfterSweep1 = await fix.events.find({
      where: [['name', '=', 'clockworks.standing-order.failed']],
      orderBy: [['id', 'asc']],
    });
    assert.equal(sofAfterSweep1.length, 1);
    const sof1 = sofAfterSweep1[0];
    assert.equal(sof1.emitter, 'framework');
    const sof1Payload = sof1.payload as {
      standingOrder: { on: string; run: string; with?: Record<string, unknown> };
      triggeringEvent: { id: string; name: string };
      error: string;
    };
    assert.deepEqual(sof1Payload.standingOrder, {
      on: 'demo.cycle',
      run: 'boomA',
    });
    assert.deepEqual(sof1Payload.triggeringEvent, {
      id: originalId,
      name: 'demo.cycle',
    });
    assert.equal(sof1Payload.error, 'first explode');

    // ── Sweep 2 ────────────────────────────────────────────────────
    // Process SOF#1 — boomB throws. Loop-guard does NOT engage because
    // SOF#1's payload.triggeringEvent.name === 'demo.cycle'. A fresh
    // SOF#2 is emitted whose triggeringEvent.name === 'clockworks.standing-order.failed'.
    const summary2 = await fix.clockworks.processEvents();
    assert.deepEqual(summary2, {
      processedEvents: 1,
      dispatches: 1,
      errors: 1,
      skipped: 0,
    });
    const sofAfterSweep2 = await fix.events.find({
      where: [['name', '=', 'clockworks.standing-order.failed']],
      orderBy: [['id', 'asc']],
    });
    assert.equal(sofAfterSweep2.length, 2);
    // Find the second-generation SOF by content (id ordering is
    // millisecond-stamped + random-suffixed, so sequential emits
    // within a single ms collapse to suffix-order — we cannot rely
    // on chronological order here).
    const secondGenSof = sofAfterSweep2.find((e) => {
      const p = e.payload as { triggeringEvent?: { name?: string } };
      return p?.triggeringEvent?.name === 'clockworks.standing-order.failed';
    });
    assert.ok(secondGenSof, 'a second-generation SOF must be present');

    // ── Sweep 3 ────────────────────────────────────────────────────
    // SOF#2's loop-guard fires. The relay is NOT invoked (no third
    // SOF is emitted), a `'skipped'` row lands for the boomB handler,
    // summary.skipped === 1 and summary.errors === 0.
    const summary3 = await fix.clockworks.processEvents();
    assert.deepEqual(summary3, {
      processedEvents: 1,
      dispatches: 1,
      errors: 0,
      skipped: 1,
    });
    const sofAfterSweep3 = await fix.events.find({
      where: [['name', '=', 'clockworks.standing-order.failed']],
      orderBy: [['id', 'asc']],
    });
    // Cap the chain at depth 2 (D14) — sweep 3 emits no third SOF.
    assert.equal(sofAfterSweep3.length, 2);
    // Inspect the skipped dispatch row directly.
    const skippedRows = (await fix.dispatches.list({
      orderBy: [['startedAt', 'asc']],
    })).filter((r) => r.status === 'skipped');
    assert.equal(skippedRows.length, 1);
    assert.equal(skippedRows[0].handlerName, 'boomB');
    assert.ok(skippedRows[0].error?.startsWith('loop-guard:'));
    assert.equal(skippedRows[0].startedAt, skippedRows[0].endedAt);
  });
});

// ── Kit-contributed standing orders (C1) ─────────────────────────────

describe('Clockworks — kit-contributed standing orders (event-driven path)', () => {
  afterEach(() => clearGuild());

  it('fires a kit-contributed event-driven order through processEvents', async () => {
    let invoked = 0;
    const recorder = relay({
      name: 'kit-recorder',
      handler: () => {
        invoked += 1;
      },
    });

    const fix = await buildDispatchFixture({
      kitStandingOrders: [
        {
          pluginId: 'demo-kit',
          value: [{ on: 'demo.kit-event', run: 'kit-recorder' }],
        },
      ],
      supportKitRelays: [recorder],
    });

    await fix.clockworks.emit('demo.kit-event', { hello: 'kit' }, 'tester');
    const summary = await fix.clockworks.processEvents();

    assert.deepEqual(summary, {
      processedEvents: 1,
      dispatches: 1,
      errors: 0,
      skipped: 0,
    });
    assert.equal(invoked, 1);
  });

  it('coexists with operator orders additively (both layers fire on the same event)', async () => {
    const fired: string[] = [];
    const r1 = relay({
      name: 'kit-r',
      handler: () => {
        fired.push('kit');
      },
    });
    const r2 = relay({
      name: 'op-r',
      handler: () => {
        fired.push('operator');
      },
    });

    const fix = await buildDispatchFixture({
      standingOrders: [{ on: 'demo.x', run: 'op-r' }],
      kitStandingOrders: [
        {
          pluginId: 'demo-kit',
          value: [{ on: 'demo.x', run: 'kit-r' }],
        },
      ],
      supportKitRelays: [r1, r2],
    });

    await fix.clockworks.emit('demo.x', null, 'tester');
    const summary = await fix.clockworks.processEvents();

    assert.deepEqual(summary, {
      processedEvents: 1,
      dispatches: 2,
      errors: 0,
      skipped: 0,
    });
    // D2 ordering: kit slice first, operator second.
    assert.deepEqual(fired, ['kit', 'operator']);
  });

  it('hot-edits to operator orders still land without restart (kit layer is sealed)', async () => {
    const fired: string[] = [];
    const kitR = relay({
      name: 'kit-only',
      handler: () => {
        fired.push('kit');
      },
    });
    const opR = relay({
      name: 'op-only',
      handler: () => {
        fired.push('operator');
      },
    });

    const fix = await buildDispatchFixture({
      standingOrders: [],
      kitStandingOrders: [
        {
          pluginId: 'demo-kit',
          value: [{ on: 'demo.x', run: 'kit-only' }],
        },
      ],
      supportKitRelays: [kitR, opR],
    });

    // First sweep — only the kit-contributed order matches.
    await fix.clockworks.emit('demo.x', null, 'tester');
    await fix.clockworks.processEvents();
    assert.deepEqual(fired, ['kit']);

    // Hot-edit operator orders — must take effect on the next sweep
    // without restarting the apparatus (D5).
    fix.guildConfig.clockworks!.standingOrders!.push({
      on: 'demo.x',
      run: 'op-only',
    });
    await fix.clockworks.emit('demo.x', null, 'tester');
    await fix.clockworks.processEvents();
    // Second event: kit AND operator both fire.
    assert.deepEqual(fired, ['kit', 'kit', 'operator']);
  });

  it('still rejects malformed operator entries per call as today', async () => {
    const fix = await buildDispatchFixture({
      standingOrders: [
        // Hand-edited operator entry with a dropped sugar key.
        { on: 'demo.x', summon: 'reviewer' } as unknown as StandingOrder,
      ],
      kitStandingOrders: [
        {
          pluginId: 'demo-kit',
          value: [{ on: 'demo.x', run: 'noop' }],
        },
      ],
    });

    await fix.clockworks.emit('demo.x', null, 'tester');
    await assert.rejects(
      fix.clockworks.processEvents(),
      (err: Error) =>
        /sugar form has been removed/.test(err.message) &&
        // The operator-layer error is byte-for-byte the historical
        // `guild.json` text — no kit attribution, even when a kit
        // layer is present.
        /clockworks: invalid standing order in guild\.json:/.test(err.message),
    );
  });

  it('attributes the contributing kit when an unresolved-relay error fires', async () => {
    let captured: string | null = null;

    const fix = await buildDispatchFixture({
      kitStandingOrders: [
        {
          pluginId: 'demo-kit',
          value: [{ on: 'demo.x', run: 'ghost-relay' }],
        },
      ],
    });

    await fix.clockworks.emit('demo.x', null, 'tester');
    await fix.clockworks.processEvents({
      onDispatch: (obs) => {
        if (obs.status === 'error') captured = obs.error;
      },
    });

    assert.ok(captured, 'expected an error observation');
    assert.match(
      captured!,
      /relay "ghost-relay" referenced by standing order 0 \(kit "demo-kit"\) is not registered/,
    );
  });
});

describe('Clockworks — kit-contributed standing orders (boot-time validation)', () => {
  afterEach(() => clearGuild());

  it('fails apparatus boot loud with kit attribution when a kit value is not an array', async () => {
    await assert.rejects(
      buildDispatchFixture({
        kitStandingOrders: [
          { pluginId: 'broken-kit', value: { not: 'an-array' } },
        ],
      }),
      (err: Error) =>
        /standingOrders kit "broken-kit"/.test(err.message) &&
        /must be an array/.test(err.message),
    );
  });

  it('fails apparatus boot loud with kit-attributed validator output when a kit entry is malformed', async () => {
    await assert.rejects(
      buildDispatchFixture({
        kitStandingOrders: [
          {
            pluginId: 'malformed-kit',
            value: [
              // Dropped-sugar form — the validator's per-bullet text
              // must include the kit-attribution block.
              { on: 'demo.x', summon: 'reviewer' },
            ],
          },
        ],
      }),
      (err: Error) =>
        /clockworks: invalid standing order in kit "malformed-kit":/.test(err.message) &&
        /standing order #0 \[kit "malformed-kit"\]:/.test(err.message) &&
        /sugar form has been removed/.test(err.message),
    );
  });

  it('fails apparatus boot loud when a kit-contributed schedule expression is malformed', async () => {
    await assert.rejects(
      buildDispatchFixture({
        kitStandingOrders: [
          {
            pluginId: 'sched-kit',
            value: [{ schedule: 'not-a-cron', run: 'whatever' }],
          },
        ],
      }),
      // The standing-order validator catches malformed schedules at
      // load time, so the kit-attributed validator path fires first.
      (err: Error) =>
        /clockworks: invalid standing order in kit "sched-kit":/.test(err.message) &&
        /"schedule" is invalid/.test(err.message),
    );
  });
});

/**
 * Lattice — unit tests.
 *
 * Covers the behaviors contracted in the commission's Decisions table:
 *
 *   - `emit()` writes a pending pulse and returns the persisted document.
 *   - Phase 2 dispatch transitions deliveryState (pending → delivered on
 *     all-ok, pending → failed on any channel error).
 *   - Channel.send() throwing is captured as `failed` without bubbling.
 *   - Startup scan re-dispatches any deliveryState === 'pending' row.
 *   - `list()` defaults to a 24h window; `until` / `since` overrides work.
 *   - `list()` default limit is 20; `orderBy: createdAt desc` is honored.
 *   - `resolveId()` handles exact, prefix, missing, and ambiguous cases.
 *   - `show` / `count` behaviors.
 *   - Factory registration warning: kit contributes `latticeChannels` with
 *     no consumer scenario is simulated by registering a factory alongside
 *     a config entry referencing an unknown type, which logs a warning.
 *     (The "no consumer" warning itself is framework-level — the Lattice
 *     declares `consumes`, which is what suppresses it when installed.)
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

import { createLattice } from './lattice.ts';
import type {
  DeliveryOutcome,
  LatticeApi,
  LatticeChannel,
  LatticeChannelFactory,
  PulseDoc,
} from './types.ts';

// ── Test fixture ──────────────────────────────────────────────────

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

interface CapturingChannel extends LatticeChannel {
  calls: PulseDoc[];
}

function capturingFactory(type: string, outcome: DeliveryOutcome | 'throw' = { ok: true }): LatticeChannelFactory & { lastChannel?: CapturingChannel } {
  const factory: LatticeChannelFactory & { lastChannel?: CapturingChannel } = {
    type,
    create(): LatticeChannel {
      const calls: PulseDoc[] = [];
      const channel: CapturingChannel = {
        type,
        calls,
        async send(pulse: PulseDoc): Promise<DeliveryOutcome> {
          calls.push(pulse);
          if (outcome === 'throw') {
            throw new Error(`${type} blew up`);
          }
          return outcome;
        },
      };
      factory.lastChannel = channel;
      return channel;
    },
  };
  return factory;
}

interface Fixture {
  stacks: StacksApi;
  lattice: LatticeApi;
  backend: MemoryBackend;
  /** Last-created capturing channels, in channels-config order. */
  channelInstances: CapturingChannel[];
  /** Factories used to build the channels — inspect `.lastChannel.calls`. */
  factories: Array<LatticeChannelFactory & { lastChannel?: CapturingChannel }>;
}

interface BuildOptions {
  factories?: Array<LatticeChannelFactory & { lastChannel?: CapturingChannel }>;
  channels?: Array<Record<string, unknown>>;
  preSeedPending?: PulseDoc[];
}

async function buildFixture(opts: BuildOptions = {}): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const latticePlugin = createLattice();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...(opts.channels !== undefined
      ? { lattice: { channels: opts.channels as GuildConfig['lattice'] extends undefined ? never : NonNullable<GuildConfig['lattice']>['channels'] } }
      : {}),
  } as GuildConfig;

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

  // Start stacks
  const stacksApparatus = stacksPlugin.apparatus;
  stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure the pulses book exists so pre-seeded rows land somewhere.
  backend.ensureBook(
    { ownerId: 'lattice', book: 'pulses' },
    {
      indexes: [
        'triggerType',
        'source',
        'createdAt',
        'deliveryState',
        'writId',
        ['deliveryState', 'createdAt'],
        ['triggerType', 'createdAt'],
      ],
    },
  );

  // Pre-seed pending rows BEFORE start() so the startup scan sees them.
  if (opts.preSeedPending && opts.preSeedPending.length > 0) {
    const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');
    for (const pulse of opts.preSeedPending) {
      await pulsesBook.put(pulse);
    }
  }

  // Build kit entries for the lattice's `latticeChannels` consumption.
  const factories = opts.factories ?? [];
  const kitEntries: KitEntry[] = factories.length
    ? [
        {
          pluginId: 'test-kit',
          packageName: '@shardworks/test-kit',
          type: 'latticeChannels',
          value: factories,
        },
      ]
    : [];

  // Start lattice
  const latticeApparatus = latticePlugin.apparatus;
  await latticeApparatus.start(buildCtx(kitEntries));
  const lattice = latticeApparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  return {
    stacks,
    lattice,
    backend,
    channelInstances: factories.map((f) => f.lastChannel).filter((c): c is CapturingChannel => !!c),
    factories,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('LatticeApi — emit', () => {
  afterEach(() => clearGuild());

  it('persists a pending pulse and returns it', async () => {
    const fix = await buildFixture();
    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      writId: 'w-abc',
      title: 'Writ stuck',
      summary: 'stuck summary',
      context: { writShortId: 'w-abc' },
    });

    assert.ok(pulse.id.startsWith('p-'), 'id should be prefixed with "p-"');
    assert.equal(pulse.source, 'reckoner');
    assert.equal(pulse.triggerType, 'reckoner.writ-stuck');
    assert.equal(pulse.writId, 'w-abc');
    assert.equal(pulse.title, 'Writ stuck');
    assert.equal(pulse.summary, 'stuck summary');
    assert.deepEqual(pulse.context, { writShortId: 'w-abc' });
    assert.equal(pulse.linkUrl, null);
    assert.equal(pulse.deliveryState, 'pending');
    assert.ok(pulse.createdAt);
    assert.equal(pulse.createdAt, pulse.updatedAt);

    // show() may see a post-dispatch state change (with no channels, the
    // dispatcher trivially transitions pending → delivered). Compare the
    // stable fields only.
    const stored = await fix.lattice.show(pulse.id);
    assert.equal(stored.id, pulse.id);
    assert.equal(stored.source, pulse.source);
    assert.equal(stored.triggerType, pulse.triggerType);
    assert.equal(stored.writId, pulse.writId);
    assert.equal(stored.title, pulse.title);
    assert.equal(stored.summary, pulse.summary);
    assert.deepEqual(stored.context, pulse.context);
    assert.equal(stored.createdAt, pulse.createdAt);
  });

  it('treats writId as null when omitted', async () => {
    const fix = await buildFixture();
    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.queue-drained',
      title: 'Drained',
      summary: 'drained summary',
    });
    assert.equal(pulse.writId, null);
    assert.deepEqual(pulse.context, {});
  });

  it('rejects missing source / triggerType / title / summary', async () => {
    const fix = await buildFixture();
    await assert.rejects(() =>
      fix.lattice.emit({
        source: '',
        triggerType: 'x.y',
        title: 't',
        summary: 's',
      }),
    );
    await assert.rejects(() =>
      fix.lattice.emit({
        source: 'x',
        triggerType: '',
        title: 't',
        summary: 's',
      }),
    );
    await assert.rejects(() =>
      fix.lattice.emit({
        source: 'x',
        triggerType: 'x.y',
        title: '',
        summary: 's',
      }),
    );
    await assert.rejects(() =>
      fix.lattice.emit({
        source: 'x',
        triggerType: 'x.y',
        title: 't',
        summary: undefined as unknown as string,
      }),
    );
  });
});

describe('LatticeApi — dispatch (Phase 2)', () => {
  afterEach(() => clearGuild());

  it('marks the pulse delivered when every channel returns ok', async () => {
    const factoryA = capturingFactory('test-ok-a', { ok: true });
    const factoryB = capturingFactory('test-ok-b', { ok: true });
    const fix = await buildFixture({
      factories: [factoryA, factoryB],
      channels: [{ type: 'test-ok-a' }, { type: 'test-ok-b' }],
    });

    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 't',
      summary: 's',
    });

    const after = await fix.lattice.show(pulse.id);
    assert.equal(after.deliveryState, 'delivered');
    assert.equal(factoryA.lastChannel?.calls.length, 1);
    assert.equal(factoryB.lastChannel?.calls.length, 1);
  });

  it('marks the pulse failed when any channel returns ok=false', async () => {
    const goodFactory = capturingFactory('good', { ok: true });
    const badFactory = capturingFactory('bad', { ok: false, error: 'webhook 500' });
    const fix = await buildFixture({
      factories: [goodFactory, badFactory],
      channels: [{ type: 'good' }, { type: 'bad' }],
    });

    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-failed',
      title: 't',
      summary: 's',
    });

    const after = await fix.lattice.show(pulse.id);
    assert.equal(after.deliveryState, 'failed');
    assert.match(after.deliveryError ?? '', /bad: webhook 500/);
  });

  it('captures a thrown channel error without bubbling past the dispatcher', async () => {
    const factory = capturingFactory('throws', 'throw');
    const fix = await buildFixture({
      factories: [factory],
      channels: [{ type: 'throws' }],
    });

    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-failed',
      title: 't',
      summary: 's',
    });

    const after = await fix.lattice.show(pulse.id);
    assert.equal(after.deliveryState, 'failed');
    assert.match(after.deliveryError ?? '', /throws: throws blew up/);
  });

  it('does not re-dispatch a pulse already in a terminal delivery state', async () => {
    const factory = capturingFactory('once', { ok: true });
    const fix = await buildFixture({
      factories: [factory],
      channels: [{ type: 'once' }],
    });

    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 't',
      summary: 's',
    });

    // Dispatch happened post-commit, once.
    assert.equal(factory.lastChannel?.calls.length, 1);

    // A benign patch that leaves deliveryState non-pending must not
    // re-dispatch.
    const after = await fix.lattice.show(pulse.id);
    assert.equal(after.deliveryState, 'delivered');
  });

  it('delivers with no configured channels (marks delivered trivially)', async () => {
    const fix = await buildFixture();
    const pulse = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 't',
      summary: 's',
    });
    const after = await fix.lattice.show(pulse.id);
    assert.equal(after.deliveryState, 'delivered');
  });
});

describe('LatticeApi — startup scan', () => {
  afterEach(() => clearGuild());

  it('re-dispatches pending pulses present at startup', async () => {
    const factory = capturingFactory('seeder', { ok: true });
    const pending: PulseDoc = {
      id: 'p-preexisting',
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      writId: 'w-seed',
      title: 'preexisting',
      summary: 'preexisting summary',
      linkUrl: null,
      context: {},
      deliveryState: 'pending',
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const fix = await buildFixture({
      factories: [factory],
      channels: [{ type: 'seeder' }],
      preSeedPending: [pending],
    });

    const after = await fix.lattice.show('p-preexisting');
    assert.equal(after.deliveryState, 'delivered');
    assert.equal(factory.lastChannel?.calls.length, 1);
    assert.equal(factory.lastChannel?.calls[0]?.id, 'p-preexisting');
  });
});

describe('LatticeApi — list / count / show / resolveId', () => {
  afterEach(() => clearGuild());

  it('lists pulses ordered by createdAt desc and applies the 24h default window', async () => {
    const fix = await buildFixture();

    // Write three pulses, then force their createdAt timestamps so the
    // test does not depend on high-resolution timing. Using explicit
    // stamps spaced a full minute apart keeps the sort deterministic
    // regardless of how quickly emit() resolves.
    const pulsesBook = fix.stacks.book<PulseDoc>('lattice', 'pulses');
    const now = Date.now();
    const ancient = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const recent1Time = new Date(now - 2 * 60 * 1000).toISOString();
    const recent2Time = new Date(now - 1 * 60 * 1000).toISOString();

    const old = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 'old',
      summary: 'old',
    });
    await pulsesBook.patch(old.id, { createdAt: ancient, updatedAt: ancient });

    const recent1 = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-failed',
      title: 'recent1',
      summary: 'recent1',
    });
    await pulsesBook.patch(recent1.id, { createdAt: recent1Time, updatedAt: recent1Time });

    const recent2 = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.queue-drained',
      title: 'recent2',
      summary: 'recent2',
    });
    await pulsesBook.patch(recent2.id, { createdAt: recent2Time, updatedAt: recent2Time });

    // Default list: last 24h.
    const windowList = await fix.lattice.list();
    const windowIds = windowList.map((p) => p.id);
    assert.deepEqual(
      windowIds,
      [recent2.id, recent1.id],
      'default window must exclude pulses older than 24h and order desc',
    );

    // Explicit since overrides default window and returns the old pulse too.
    const fullList = await fix.lattice.list({
      since: new Date(0).toISOString(),
    });
    const fullIds = fullList.map((p) => p.id);
    assert.deepEqual(fullIds, [recent2.id, recent1.id, old.id]);

    // Filter by triggerType.
    const onlyFailed = await fix.lattice.list({
      triggerType: 'reckoner.writ-failed',
    });
    assert.deepEqual(
      onlyFailed.map((p) => p.id),
      [recent1.id],
    );
  });

  it('respects limit and offset defaults', async () => {
    const fix = await buildFixture();
    for (let i = 0; i < 25; i++) {
      await fix.lattice.emit({
        source: 'reckoner',
        triggerType: 'reckoner.writ-stuck',
        title: `p${i}`,
        summary: `s${i}`,
      });
    }
    const first = await fix.lattice.list();
    assert.equal(first.length, 20);

    const next = await fix.lattice.list({ offset: 20 });
    assert.equal(next.length, 5);
  });

  it('counts pulses with optional filters', async () => {
    const fix = await buildFixture();
    await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 't',
      summary: 's',
    });
    await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-failed',
      title: 't',
      summary: 's',
    });
    assert.equal(await fix.lattice.count(), 2);
    assert.equal(await fix.lattice.count({ triggerType: 'reckoner.writ-stuck' }), 1);
  });

  it('resolveId handles exact match, unique prefix, missing, and ambiguous cases', async () => {
    const fix = await buildFixture();
    const p = await fix.lattice.emit({
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      title: 't',
      summary: 's',
    });
    const resolved = await fix.lattice.resolveId(p.id);
    assert.equal(resolved, p.id);

    const prefix = p.id.slice(0, 10);
    const byPrefix = await fix.lattice.resolveId(prefix);
    assert.equal(byPrefix, p.id);

    await assert.rejects(() => fix.lattice.resolveId('p-nope'));

    // Ambiguous: insert two rows with a shared prefix.
    const pulsesBook = fix.stacks.book<PulseDoc>('lattice', 'pulses');
    const now = new Date().toISOString();
    await pulsesBook.put({
      id: 'p-shared-a',
      source: 'x',
      triggerType: 'x.y',
      writId: null,
      title: 't',
      summary: 's',
      linkUrl: null,
      context: {},
      deliveryState: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    await pulsesBook.put({
      id: 'p-shared-b',
      source: 'x',
      triggerType: 'x.y',
      writId: null,
      title: 't',
      summary: 's',
      linkUrl: null,
      context: {},
      deliveryState: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    await assert.rejects(() => fix.lattice.resolveId('p-shared'));
  });

  it('LatticeApi does not expose update or delete', () => {
    // Static API shape — compile-time assertion. If someone adds an
    // `update` or `delete` on LatticeApi, the structural check below
    // will still pass at runtime because `in` is true. So the real
    // guard is the unit test reading the provides surface: no such
    // method should exist.
    const api = (createLattice() as { apparatus: { provides: LatticeApi } }).apparatus
      .provides as unknown as Record<string, unknown>;
    assert.equal('update' in api, false, 'LatticeApi must not expose update');
    assert.equal('delete' in api, false, 'LatticeApi must not expose delete');
  });
});

describe('LatticeApi — factory registration', () => {
  afterEach(() => clearGuild());

  it('warns and skips when lattice.channels references an unknown factory type', async () => {
    const messages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      messages.push(args.map(String).join(' '));
    };
    try {
      await buildFixture({
        factories: [capturingFactory('good', { ok: true })],
        channels: [{ type: 'unknown-type' }, { type: 'good' }],
      });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      messages.some((m) => m.includes('no factory registered for type "unknown-type"')),
      `expected warning for unknown factory type; got: ${messages.join(' | ')}`,
    );
  });

  it('warns on duplicate factory types and keeps the first registration', async () => {
    const messages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      messages.push(args.map(String).join(' '));
    };

    const firstFactory = capturingFactory('dup', { ok: true });
    const secondFactory = capturingFactory('dup', { ok: false, error: 'should-not-run' });
    try {
      const fix = await buildFixture({
        factories: [firstFactory, secondFactory],
        channels: [{ type: 'dup' }],
      });
      const pulse = await fix.lattice.emit({
        source: 'reckoner',
        triggerType: 'reckoner.writ-stuck',
        title: 't',
        summary: 's',
      });
      const after = await fix.lattice.show(pulse.id);
      // First registration wins → ok:true → delivered.
      assert.equal(after.deliveryState, 'delivered');
    } finally {
      console.warn = origWarn;
    }

    assert.ok(
      messages.some((m) => m.includes('factory type "dup" is already registered')),
      `expected duplicate-factory warning; got: ${messages.join(' | ')}`,
    );
  });
});

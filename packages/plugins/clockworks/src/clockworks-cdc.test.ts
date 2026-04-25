/**
 * Clockworks — CDC auto-wiring behavioral tests.
 *
 * Covers task 8 of the Clockworks build (commission c-modnk8ww):
 *
 *   - At start(), every plugin-declared book (other than
 *     `clockworks/events` itself) is registered as a Phase-2 Stacks
 *     CDC watcher. Each create/update/delete row mutation produces
 *     exactly one row in `clockworks/events` whose:
 *       - `name` is `book.<ownerId>.<book>.<created|updated|deleted>`
 *         (past tense)
 *       - `emitter` is the literal `'framework'`
 *       - `payload` is the Stacks CDC event object verbatim
 *
 *   - The recursion guard around `clockworks/events`: a direct call to
 *     `ClockworksApi.emit()` produces exactly one row in
 *     `clockworks/events` and triggers no
 *     `book.clockworks.events.created` echo. This is the regression
 *     that locks the carve-out in place.
 *
 *   - Malformed `books` kit contributions (null value, non-object
 *     value) are skipped silently — matching Stacks' own
 *     `reconcileSchemas()` guard so divergent reactions to the same
 *     malformed contribution cannot occur.
 *
 *   - A guild with zero `books` kit contributions starts cleanly with
 *     no watchers registered.
 *
 *   - The `clockworks/event_dispatches` book *is* auto-wired (it is
 *     not part of the carve-out) — sanity-check by writing a row.
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
import type {
  Book,
  BookEntry,
  StacksApi,
} from '@shardworks/stacks-apparatus';

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

interface SyntheticBook {
  pluginId: string;
  bookName: string;
  schema?: { indexes?: (string | string[])[] };
}

interface FixtureOptions {
  /** Synthetic plugins that contribute books via the `books` kit type. */
  syntheticBooks?: SyntheticBook[];
  /**
   * Raw, possibly-malformed `books` kit entries to stress the
   * silent-skip guard (e.g. value: null, value: 'not-an-object').
   */
  rawBookEntries?: KitEntry[];
}

interface Fixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  events: Book<EventDoc>;
  apparatusMap: Map<string, unknown>;
}

async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
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

  // Pre-create the Clockworks-owned books — in a live guild Arbor
  // reconciles supportKit.books on startup; the unit fixture performs
  // the same wiring manually.
  const clockworksBookSchemas = clockworksPlugin.apparatus.supportKit?.books as
    | Record<string, { indexes?: (string | string[])[] }>
    | undefined;
  if (clockworksBookSchemas) {
    for (const [name, schema] of Object.entries(clockworksBookSchemas)) {
      backend.ensureBook({ ownerId: 'clockworks', book: name }, schema ?? {});
    }
  }

  // Pre-create any synthetic-plugin books and assemble the kit entries
  // the fake context will surface to clockworks.start().
  const kitEntries: KitEntry[] = [];

  // Group synthetic books by pluginId so each plugin contributes a
  // single `books` kit entry (matching how live plugins register).
  const groupedByPlugin = new Map<string, SyntheticBook[]>();
  for (const sb of opts.syntheticBooks ?? []) {
    const list = groupedByPlugin.get(sb.pluginId) ?? [];
    list.push(sb);
    groupedByPlugin.set(sb.pluginId, list);
  }

  for (const [pluginId, books] of groupedByPlugin) {
    const value: Record<string, { indexes?: (string | string[])[] }> = {};
    for (const sb of books) {
      const schema = sb.schema ?? {};
      backend.ensureBook({ ownerId: pluginId, book: sb.bookName }, schema);
      value[sb.bookName] = schema;
    }
    kitEntries.push({
      pluginId,
      packageName: `@test/${pluginId}`,
      type: 'books',
      value,
    });
  }

  // Append any raw (possibly malformed) book kit entries — used by
  // tests that need to inject `null` / non-object values to verify the
  // silent-skip guard.
  for (const raw of opts.rawBookEntries ?? []) {
    kitEntries.push(raw);
  }

  // Also surface clockworks's own books kit entry so the auto-wiring
  // pass observes it (and skips the events book by name).
  if (clockworksBookSchemas) {
    kitEntries.push({
      pluginId: 'clockworks',
      packageName: '@shardworks/clockworks-apparatus',
      type: 'books',
      value: clockworksBookSchemas,
    });
  }

  const clockworksApparatus = clockworksPlugin.apparatus;
  await clockworksApparatus.start(buildCtx(kitEntries));
  const clockworks = clockworksApparatus.provides as ClockworksApi;
  apparatusMap.set('clockworks', clockworks);

  const events = stacks.book<EventDoc>('clockworks', 'events');

  return { stacks, clockworks, events, apparatusMap };
}

interface MyDoc extends BookEntry {
  id: string;
  value: string;
}

// ── CDC auto-wiring: create / update / delete event shape ─────────────

describe('Clockworks — CDC auto-wiring (book.* events)', () => {
  afterEach(() => clearGuild());

  it('emits exactly one book.<owner>.<book>.created on a put() of a new row', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'test-plugin', bookName: 'myBook' },
      ],
    });

    const myBook = fix.stacks.book<MyDoc>('test-plugin', 'myBook');
    await myBook.put({ id: 'r1', value: 'hello' });

    const rows = await fix.events.list();
    assert.equal(rows.length, 1, 'exactly one event row landed');
    const evt = rows[0];
    assert.equal(evt.name, 'book.test-plugin.myBook.created');
    assert.equal(evt.emitter, 'framework');

    const payload = evt.payload as { type: string; ownerId: string; book: string; entry: MyDoc };
    assert.equal(payload.type, 'create');
    assert.equal(payload.ownerId, 'test-plugin');
    assert.equal(payload.book, 'myBook');
    assert.deepEqual(payload.entry, { id: 'r1', value: 'hello' });
  });

  it('emits exactly one book.<owner>.<book>.updated on a put() over an existing row', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'test-plugin', bookName: 'myBook' },
      ],
    });

    const myBook = fix.stacks.book<MyDoc>('test-plugin', 'myBook');
    await myBook.put({ id: 'r1', value: 'first' });
    await myBook.put({ id: 'r1', value: 'second' });

    const rows = await fix.events.list({ orderBy: ['firedAt', 'asc'] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'book.test-plugin.myBook.created');
    assert.equal(rows[1].name, 'book.test-plugin.myBook.updated');
    assert.equal(rows[1].emitter, 'framework');

    const payload = rows[1].payload as {
      type: string; ownerId: string; book: string; entry: MyDoc; prev: MyDoc;
    };
    assert.equal(payload.type, 'update');
    assert.equal(payload.ownerId, 'test-plugin');
    assert.equal(payload.book, 'myBook');
    assert.deepEqual(payload.entry, { id: 'r1', value: 'second' });
    assert.deepEqual(payload.prev, { id: 'r1', value: 'first' });
  });

  it('emits exactly one book.<owner>.<book>.updated on a patch()', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'test-plugin', bookName: 'myBook' },
      ],
    });

    const myBook = fix.stacks.book<MyDoc>('test-plugin', 'myBook');
    await myBook.put({ id: 'r1', value: 'first' });
    await myBook.patch('r1', { value: 'patched' });

    const rows = await fix.events.list({ orderBy: ['firedAt', 'asc'] });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].name, 'book.test-plugin.myBook.updated');
    const payload = rows[1].payload as { type: string; entry: MyDoc };
    assert.equal(payload.type, 'update');
    assert.deepEqual(payload.entry, { id: 'r1', value: 'patched' });
  });

  it('emits exactly one book.<owner>.<book>.deleted on a delete() of an existing row', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'test-plugin', bookName: 'myBook' },
      ],
    });

    const myBook = fix.stacks.book<MyDoc>('test-plugin', 'myBook');
    await myBook.put({ id: 'r1', value: 'hello' });
    await myBook.delete('r1');

    const rows = await fix.events.list({ orderBy: ['firedAt', 'asc'] });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].name, 'book.test-plugin.myBook.deleted');
    assert.equal(rows[1].emitter, 'framework');
    const payload = rows[1].payload as { type: string; id: string; prev: MyDoc };
    assert.equal(payload.type, 'delete');
    assert.equal(payload.id, 'r1');
    assert.deepEqual(payload.prev, { id: 'r1', value: 'hello' });
  });

  it('delete() of a non-existent row produces no event (no CDC fire)', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'test-plugin', bookName: 'myBook' },
      ],
    });

    const myBook = fix.stacks.book<MyDoc>('test-plugin', 'myBook');
    await myBook.delete('nope'); // silent no-op per BookSpec

    assert.equal(await fix.events.count(), 0);
  });

  it('clockworks/event_dispatches IS auto-wired (only events is excluded)', async () => {
    const fix = await buildFixture();

    // Write directly to the event_dispatches book; the auto-wired
    // watcher on `clockworks/event_dispatches` should re-emit it.
    const dispatches = fix.stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');
    const doc: EventDispatchDoc = {
      id: 'd-test-cdc',
      eventId: 'e-source',
      handlerType: 'relay',
      handlerName: 'relay-x',
      targetRole: null,
      noticeType: null,
      startedAt: null,
      endedAt: null,
      status: 'pending',
      error: null,
    };
    await dispatches.put(doc);

    const rows = await fix.events.list();
    assert.equal(rows.length, 1, 'event_dispatches write produced an event');
    assert.equal(rows[0].name, 'book.clockworks.event_dispatches.created');
    assert.equal(rows[0].emitter, 'framework');
  });
});

// ── Recursion guard for clockworks/events ─────────────────────────────

describe('Clockworks — CDC auto-wiring recursion guard', () => {
  afterEach(() => clearGuild());

  it('emit() writes exactly one row to clockworks/events with no echo', async () => {
    const fix = await buildFixture();

    const id = await fix.clockworks.emit(
      'something.custom',
      { hello: 'world' },
      'test',
    );

    const rows = await fix.events.list();
    assert.equal(rows.length, 1, 'exactly one row — no recursive echo');
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].name, 'something.custom');
    assert.equal(rows[0].emitter, 'test');

    // Specifically: no `book.clockworks.events.*` row appeared.
    const echoes = rows.filter((r) => r.name.startsWith('book.clockworks.events.'));
    assert.equal(echoes.length, 0, 'no book.clockworks.events.* echo row');
  });

  it('multiple emit() calls each produce exactly one row (no compounding echo)', async () => {
    const fix = await buildFixture();

    await fix.clockworks.emit('a.first', { n: 1 }, 'test');
    await fix.clockworks.emit('a.second', { n: 2 }, 'test');
    await fix.clockworks.emit('a.third', { n: 3 }, 'test');

    const rows = await fix.events.list({ orderBy: ['firedAt', 'asc'] });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.name),
      ['a.first', 'a.second', 'a.third'],
    );
  });
});

// ── Malformed-contribution tolerance ─────────────────────────────────

describe('Clockworks — CDC auto-wiring kit-entry tolerance', () => {
  afterEach(() => clearGuild());

  it('silently skips books-kit entries whose value is null', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'good-plugin', bookName: 'goodBook' },
      ],
      rawBookEntries: [
        {
          pluginId: 'bad-plugin',
          packageName: '@test/bad-plugin',
          type: 'books',
          value: null,
        },
      ],
    });

    // The good plugin's book is wired and writes are observable.
    const good = fix.stacks.book<MyDoc>('good-plugin', 'goodBook');
    await good.put({ id: 'r1', value: 'ok' });

    const rows = await fix.events.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'book.good-plugin.goodBook.created');
  });

  it('silently skips books-kit entries whose value is a non-object', async () => {
    const fix = await buildFixture({
      syntheticBooks: [
        { pluginId: 'good-plugin', bookName: 'goodBook' },
      ],
      rawBookEntries: [
        {
          pluginId: 'bad-plugin-string',
          packageName: '@test/bad-plugin-string',
          type: 'books',
          value: 'not-an-object',
        },
        {
          pluginId: 'bad-plugin-number',
          packageName: '@test/bad-plugin-number',
          type: 'books',
          value: 42,
        },
      ],
    });

    const good = fix.stacks.book<MyDoc>('good-plugin', 'goodBook');
    await good.put({ id: 'r1', value: 'ok' });

    const rows = await fix.events.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'book.good-plugin.goodBook.created');
  });

  it('starts cleanly with zero books-kit contributions (only clockworks own books wired)', async () => {
    // No syntheticBooks, no rawBookEntries — only the clockworks-owned
    // contribution exists, and within that only event_dispatches is
    // wired (events is the carve-out).
    const fix = await buildFixture();

    // Sanity: nothing has been emitted yet.
    assert.equal(await fix.events.count(), 0);

    // A direct emit() still works (the events book is reachable);
    // and writing to event_dispatches is observed.
    await fix.clockworks.emit('startup.smoke', { ok: true }, 'test');
    assert.equal(await fix.events.count(), 1);
  });
});

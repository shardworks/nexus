/**
 * Tests for the hand-written `nsg signal` framework CLI command.
 *
 * Two surfaces:
 *
 * 1. **Handler unit tests** — exercise `runSignal()` against a stub
 *    guild that supplies an in-memory `ClockworksApi`. The stub's
 *    `validateSignal` and `emit` mirror the real apparatus's contract
 *    so tests cover the parse path, the validator-rejection path, and
 *    the apparatus-not-installed path.
 *
 * 2. **Commander integration test** — build the Command from
 *    `buildSignalCommand()` and assert that the help output advertises
 *    `<name>` as a positional and `--payload` as the only flag, and
 *    that the auto-registration list at `customFrameworkCommands`
 *    includes it.
 *
 * The framework lifecycle, dispatcher, and runner are NOT tested here.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import { buildSignalCommand, runSignal } from './signal.ts';
import { customFrameworkCommands } from './index.ts';

// ── Stub apparatus types ─────────────────────────────────────────────

interface RecordedEmit {
  name: string;
  payload: unknown;
  emitter: string;
}

interface StubClockworks {
  validateSignal(name: string): void;
  emit(name: string, payload: unknown, emitter: string): Promise<string>;
}

interface StubClockworksOptions {
  /** Names accepted by the stub validator; everything else is rejected. */
  declaredNames?: string[];
  /** Names that pass validation but are flagged as framework-owned. */
  pluginOwnedNames?: string[];
}

function makeStubClockworks(
  records: RecordedEmit[],
  opts: StubClockworksOptions = {},
): StubClockworks {
  const declared = new Set(opts.declaredNames ?? []);
  const pluginOwned = new Set(opts.pluginOwnedNames ?? []);
  let counter = 0;
  return {
    validateSignal(name: string): void {
      if (!declared.has(name) && !pluginOwned.has(name)) {
        throw new Error(
          `signal: "${name}" is not a declared event. Declare it under ` +
            `clockworks.events in guild.json (or via a plugin's events kit) ` +
            `before emitting it.`,
        );
      }
      if (pluginOwned.has(name)) {
        throw new Error(
          `signal: "${name}" is a framework-owned event and cannot be emitted ` +
            `from the signal surface. Framework-owned events are claimed by a ` +
            `plugin's events kit; only the framework may emit them.`,
        );
      }
    },
    async emit(name, payload, emitter) {
      // Mirror emit's serialize-check so the parse path is exercised
      // through the real (clockworks-side) error message.
      try {
        JSON.stringify(payload === undefined ? null : payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `clockworks: event "${name}" payload is not JSON-serializable: ${reason}`,
        );
      }
      const id = `e-stub-${++counter}`;
      records.push({ name, payload: payload === undefined ? null : payload, emitter });
      return id;
    },
  };
}

interface StubGuildOptions {
  declaredNames?: string[];
  pluginOwnedNames?: string[];
  records?: RecordedEmit[];
  /** Omit the clockworks apparatus entirely — exercises the not-installed path. */
  withoutClockworks?: boolean;
}

function setupStubGuild(opts: StubGuildOptions = {}): RecordedEmit[] {
  const records = opts.records ?? [];
  const apparatusMap = new Map<string, unknown>();
  if (!opts.withoutClockworks) {
    apparatusMap.set(
      'clockworks',
      makeStubClockworks(records, {
        declaredNames: opts.declaredNames,
        pluginOwnedNames: opts.pluginOwnedNames,
      }),
    );
  }

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  } as GuildConfig;

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return guildConfig;
    },
    kits() {
      return [];
    },
    apparatuses() {
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
  return records;
}

afterEach(() => {
  clearGuild();
});

// ── runSignal — happy paths ──────────────────────────────────────────

describe('runSignal', () => {
  it('parses the JSON payload and emits with operator emitter', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.thing-happened'],
    });

    const id = await runSignal({
      name: 'demo.thing-happened',
      payloadJson: '{"hello":"world","count":3}',
    });

    assert.match(id, /^e-stub-/);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'demo.thing-happened');
    assert.deepEqual(records[0].payload, { hello: 'world', count: 3 });
    assert.equal(records[0].emitter, 'operator');
  });

  it('omitted payload stores null', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.silent'],
    });

    await runSignal({ name: 'demo.silent' });

    assert.equal(records.length, 1);
    assert.equal(records[0].payload, null);
  });

  it('handles array payloads', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.list'],
    });

    await runSignal({ name: 'demo.list', payloadJson: '[1,2,3]' });
    assert.deepEqual(records[0].payload, [1, 2, 3]);
  });

  it('handles primitive JSON payloads (number, string, true, null)', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.num', 'demo.str', 'demo.bool', 'demo.null'],
    });

    await runSignal({ name: 'demo.num', payloadJson: '42' });
    await runSignal({ name: 'demo.str', payloadJson: '"hello"' });
    await runSignal({ name: 'demo.bool', payloadJson: 'true' });
    await runSignal({ name: 'demo.null', payloadJson: 'null' });

    assert.equal(records[0].payload, 42);
    assert.equal(records[1].payload, 'hello');
    assert.equal(records[2].payload, true);
    assert.equal(records[3].payload, null);
  });
});

// ── runSignal — failure paths ────────────────────────────────────────

describe('runSignal — error surfaces', () => {
  it('rejects malformed JSON payload with a --payload-attributed message', async () => {
    setupStubGuild({ declaredNames: ['demo.thing'] });

    await assert.rejects(
      () => runSignal({ name: 'demo.thing', payloadJson: '{not json' }),
      /signal: --payload is not valid JSON/,
    );
  });

  it('surfaces the validator-rejection prefix for an undeclared name', async () => {
    setupStubGuild({ declaredNames: ['demo.declared'] });

    await assert.rejects(
      () => runSignal({ name: 'demo.not-declared', payloadJson: '{}' }),
      /signal: "demo\.not-declared" is not a declared event/,
    );
  });

  it('surfaces the framework-owned rejection for a plugin-claimed name', async () => {
    setupStubGuild({
      declaredNames: ['demo.declared'],
      pluginOwnedNames: ['mandate.ready'],
    });

    await assert.rejects(
      () => runSignal({ name: 'mandate.ready', payloadJson: '{}' }),
      /signal: "mandate\.ready" is a framework-owned event/,
    );
  });

  it('errors out when no guild is loaded', async () => {
    clearGuild();
    await assert.rejects(
      () => runSignal({ name: 'whatever' }),
      /Not inside a guild/,
    );
  });

  it('surfaces the apparatus-not-installed error when clockworks is absent', async () => {
    setupStubGuild({ withoutClockworks: true });

    await assert.rejects(
      () => runSignal({ name: 'demo.thing', payloadJson: '{}' }),
      /Apparatus "clockworks" not installed/,
    );
  });

  it('rejects payload that JSON.parse cannot handle (`undefined` literal)', async () => {
    setupStubGuild({ declaredNames: ['demo.thing'] });
    await assert.rejects(
      () => runSignal({ name: 'demo.thing', payloadJson: 'undefined' }),
      /signal: --payload is not valid JSON/,
    );
  });
});

// ── Commander Command shape ──────────────────────────────────────────

describe('buildSignalCommand', () => {
  it('registers <name> as a positional argument', () => {
    const cmd = buildSignalCommand();
    assert.equal(cmd.name(), 'signal');
    assert.equal(cmd.registeredArguments.length, 1);
    assert.equal(cmd.registeredArguments[0].name(), 'name');
    // Required positional — the brackets in `<name>` make it required.
    assert.equal(cmd.registeredArguments[0].required, true);
  });

  it('exposes --payload as the only option (no --name flag)', () => {
    const cmd = buildSignalCommand();
    const flags = cmd.options.map((o) => o.long);
    assert.deepEqual(flags, ['--payload']);
  });

  it('help text mentions both <name> and --payload', () => {
    const cmd = buildSignalCommand();
    const help = cmd.helpInformation();
    assert.match(help, /<name>/);
    assert.match(help, /--payload/);
  });

  it('parses positional <name> and --payload through to the handler', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.thing-happened'],
    });

    const cmd = buildSignalCommand();
    cmd.exitOverride();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await cmd.parseAsync(
        ['demo.thing-happened', '--payload', '{"v":1}'],
        { from: 'user' },
      );
    } finally {
      console.log = originalLog;
    }

    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'demo.thing-happened');
    assert.deepEqual(records[0].payload, { v: 1 });
    assert.equal(records[0].emitter, 'operator');
  });

  it('omitting --payload stores null payload', async () => {
    const records = setupStubGuild({
      declaredNames: ['demo.ping'],
    });

    const cmd = buildSignalCommand();
    cmd.exitOverride();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await cmd.parseAsync(['demo.ping'], { from: 'user' });
    } finally {
      console.log = originalLog;
    }

    assert.equal(records.length, 1);
    assert.equal(records[0].payload, null);
  });
});

// ── Custom-command registration ──────────────────────────────────────

describe('customFrameworkCommands export', () => {
  it('includes the signal command builder', () => {
    const names = customFrameworkCommands.map((b) => b().name());
    assert.ok(names.includes('signal'));
  });
});

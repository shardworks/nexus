/**
 * `clock-status` MCP tool tests.
 *
 * Three surfaces:
 *
 *  - Tool metadata — `name`, `callableBy: ['anima']`, parameterless.
 *  - Handler against a tmp-home guild with no daemon running:
 *    returns `{ running: false }`.
 *  - Handler against a tmp-home guild with a fake live pidfile:
 *    returns `{ running: true, pid, logFile, uptime }`.
 *
 * The fake live pidfile points at the test process pid — guaranteed
 * alive — so the handler exercises the same branch as a real running
 * daemon without us having to spawn one.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearGuild, setGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import { createClockworks } from '../clockworks.ts';
import clockStatusTool from './clock-status.ts';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clock-status-tool-'));
}

function setupFakeGuild(home: string): void {
  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };
  const fakeGuild: Guild = {
    home,
    apparatus<T>(): T {
      throw new Error('no apparatus needed for clock-status');
    },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

afterEach(() => clearGuild());

describe('clock-status tool definition', () => {
  it('has the correct name', () => {
    assert.equal(clockStatusTool.name, 'clock-status');
  });

  it('is callable from anima only', () => {
    assert.deepEqual(clockStatusTool.callableBy, ['anima']);
  });

  it('has no parameters', () => {
    const shape = clockStatusTool.params.shape as Record<string, unknown>;
    assert.deepEqual(Object.keys(shape), []);
  });
});

describe('apparatus support kit registration', () => {
  it('contributes clock-status alongside signal in supportKit.tools', () => {
    const plugin = createClockworks();
    if (!('apparatus' in plugin)) throw new Error('expected apparatus plugin');
    const tools = plugin.apparatus.supportKit?.tools ?? [];
    const names = tools.map((t) => (t as { name: string }).name).sort();
    assert.deepEqual(names, ['clock-status', 'signal']);
  });
});

describe('clock-status handler', () => {
  it('returns { running: false } when no daemon is recorded', async () => {
    const home = makeTmpHome();
    setupFakeGuild(home);
    const status = await clockStatusTool.handler({});
    assert.deepEqual(status, { running: false });
  });

  it('returns { running: true, pid, logFile, uptime } when a daemon is alive', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), String(process.pid), 'utf-8');
    setupFakeGuild(home);

    const status = await clockStatusTool.handler({}) as {
      running: boolean;
      pid?: number;
      logFile?: string;
      uptime?: number;
    };
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.match(status.logFile ?? '', /clock\.log$/);
    assert.equal(typeof status.uptime, 'number');
  });

  it('returns { running: true, host: standalone, pid, logFile, uptime } for a live standalone daemon', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clock.pid'), String(process.pid), 'utf-8');
    setupFakeGuild(home);

    const status = await clockStatusTool.handler({}) as {
      running: boolean;
      host?: string;
      pid?: number;
      logFile?: string;
      uptime?: number;
    };
    assert.equal(status.running, true);
    assert.equal(status.host, 'standalone');
    assert.equal(status.pid, process.pid);
    assert.match(status.logFile ?? '', /clock\.log$/);
    assert.equal(typeof status.uptime, 'number');
  });

  it('returns { running: true, host: guild-daemon } when only daemon.pid is alive (T4/D5)', async () => {
    // When no clock.pid is present but daemon.pid is live, clockStatus
    // falls back to the unified guild daemon. The MCP tool should expose
    // the same guild-daemon branch that the CLI text output does.
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    // Write daemon.pid pointing at a live process — no clock.pid.
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid), 'utf-8');
    setupFakeGuild(home);

    const status = await clockStatusTool.handler({}) as {
      running: boolean;
      host?: string;
      pid?: number;
      logFile?: string;
      uptime?: number;
    };
    assert.equal(status.running, true);
    assert.equal(status.host, 'guild-daemon');
    assert.equal(status.pid, process.pid);
    assert.match(status.logFile ?? '', /daemon\.out$/);
    assert.equal(typeof status.uptime, 'number');
  });

  it('reports stalePidfile and unlinks when the pidfile points at a dead pid', async () => {
    const home = makeTmpHome();
    const dir = path.join(home, '.nexus');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'clock.pid');
    fs.writeFileSync(file, '999999999', 'utf-8');
    setupFakeGuild(home);

    const status = await clockStatusTool.handler({}) as {
      running: boolean;
      stalePidfile?: boolean;
    };
    assert.equal(status.running, false);
    assert.equal(status.stalePidfile, true);
    assert.equal(fs.existsSync(file), false);
  });
});

/**
 * Spider tool unit tests — handlers + tool definition + supportKit
 * registration for the patron-callable tools that aren't covered by
 * dedicated test files.
 *
 * Uses the native Node test runner consistent with the rest of the package.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { SpiderApi } from '../types.ts';

import rigCancelTool from './rig-cancel.ts';
import writRescueStuckTool from './writ-rescue-stuck.ts';
import { createSpider } from '../spider.ts';
import type { RigDoc } from '../types.ts';

// ── rig-cancel ────────────────────────────────────────────────────────────

describe('rig-cancel tool', () => {
  afterEach(() => clearGuild());

  it('has name "rig-cancel"', () => {
    assert.equal(rigCancelTool.name, 'rig-cancel');
  });

  it('requires write permission', () => {
    assert.equal(rigCancelTool.permission, 'write');
  });

  it('params schema has required rigId and optional reason', () => {
    const parsed = rigCancelTool.params.parse({ rigId: 'rig-123' });
    assert.equal(parsed.rigId, 'rig-123');
    assert.equal(parsed.reason, undefined);

    const parsedWithReason = rigCancelTool.params.parse({ rigId: 'rig-456', reason: 'No longer needed' });
    assert.equal(parsedWithReason.rigId, 'rig-456');
    assert.equal(parsedWithReason.reason, 'No longer needed');
  });

  it('handler delegates to SpiderApi.cancel()', async () => {
    let cancelCalledWith: { rigId: string; options?: { reason?: string } } | null = null;
    const cancelledRig = { id: 'rig-1', writId: 'writ-1', status: 'cancelled', engines: [], createdAt: '' } as RigDoc;

    const mockSpider: SpiderApi = {
      crawl: async () => null,
      show: async () => { throw new Error('not implemented'); },
      list: async () => [],
      forWrit: async () => null,
      resume: async () => {},
      cancel: async (rigId, options) => {
        cancelCalledWith = { rigId, options };
        return cancelledRig;
      },
      getBlockType: () => undefined,
      listBlockTypes: () => [],
      listTemplates: () => [],
      listTemplateMappings: () => ({}),
    };

    const fakeGuild = {
      home: '/tmp/test-guild',
      apparatus<T>(name: string): T {
        if (name === 'spider') return mockSpider as unknown as T;
        throw new Error(`Apparatus "${name}" not found`);
      },

      tryApparatus<T>(name: string): T | null {
        try { return this.apparatus<T>(name); } catch { return null; }
      },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 'test-guild', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };

    setGuild(fakeGuild as any);

    const result = await rigCancelTool.handler({ rigId: 'rig-1', reason: 'Test reason' });
    assert.deepEqual(result, cancelledRig);
    assert.ok(cancelCalledWith !== null, 'cancel should have been called');
    assert.equal(cancelCalledWith!.rigId, 'rig-1');
    assert.deepEqual(cancelCalledWith!.options, { reason: 'Test reason' });
  });

  it('handler omits options when reason is not provided', async () => {
    let cancelCalledWith: { rigId: string; options?: { reason?: string } } | null = null;
    const cancelledRig = { id: 'rig-2', writId: 'writ-2', status: 'cancelled', engines: [], createdAt: '' } as RigDoc;

    const mockSpider: SpiderApi = {
      crawl: async () => null,
      show: async () => { throw new Error('not implemented'); },
      list: async () => [],
      forWrit: async () => null,
      resume: async () => {},
      cancel: async (rigId, options) => {
        cancelCalledWith = { rigId, options };
        return cancelledRig;
      },
      getBlockType: () => undefined,
      listBlockTypes: () => [],
      listTemplates: () => [],
      listTemplateMappings: () => ({}),
    };

    const fakeGuild = {
      home: '/tmp/test-guild',
      apparatus<T>(name: string): T {
        if (name === 'spider') return mockSpider as unknown as T;
        throw new Error(`Apparatus "${name}" not found`);
      },

      tryApparatus<T>(name: string): T | null {
        try { return this.apparatus<T>(name); } catch { return null; }
      },
      config<T>(): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return { name: 'test-guild', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      startupWarnings() { return []; },
    };

    setGuild(fakeGuild as any);

    await rigCancelTool.handler({ rigId: 'rig-2' });
    assert.ok(cancelCalledWith !== null);
    assert.equal(cancelCalledWith!.options, undefined);
  });
});

// ── writ-rescue-stuck registration ────────────────────────────────────────

describe('writ-rescue-stuck tool — kit registration', () => {
  it('is registered in spider supportKit.tools', () => {
    const spiderPlugin = createSpider();
    const kit = spiderPlugin.apparatus.supportKit as { tools?: Array<{ name: string }> };
    const names = (kit.tools ?? []).map((t) => t.name);
    assert.ok(
      names.includes('writ-rescue-stuck'),
      `expected supportKit.tools to include "writ-rescue-stuck"; got ${JSON.stringify(names)}`,
    );
  });

  it('has name "writ-rescue-stuck" and write permission', () => {
    assert.equal(writRescueStuckTool.name, 'writ-rescue-stuck');
    assert.equal(writRescueStuckTool.permission, 'write');
  });
});

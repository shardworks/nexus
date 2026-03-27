import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePluginKey } from './rig.ts';

describe('derivePluginKey', () => {
  it('strips @shardworks scope', () => {
    assert.equal(derivePluginKey('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(derivePluginKey('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(derivePluginKey('@acme/my-plugin'), 'acme/my-plugin');
    assert.equal(derivePluginKey('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(derivePluginKey('my-plugin'), 'my-plugin');
    assert.equal(derivePluginKey('nexus-stdlib'), 'nexus-stdlib');
  });
});

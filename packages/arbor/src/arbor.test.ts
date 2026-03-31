import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePluginId } from './arbor.ts';

describe('derivePluginId', () => {
  it('strips @shardworks scope', () => {
    assert.equal(derivePluginId('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(derivePluginId('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(derivePluginId('@acme/my-plugin'), 'acme/my-plugin');
    assert.equal(derivePluginId('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(derivePluginId('my-plugin'), 'my-plugin');
    assert.equal(derivePluginId('nexus-stdlib'), 'nexus-stdlib');
  });
});

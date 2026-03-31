import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePluginId } from './arbor.ts';

describe('derivePluginId', () => {
  it('strips @shardworks scope', () => {
    assert.equal(derivePluginId('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(derivePluginId('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(derivePluginId('@acme/my-tool'), 'acme/my-tool');
    assert.equal(derivePluginId('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(derivePluginId('my-tool'), 'my-tool');
    assert.equal(derivePluginId('nexus-stdlib'), 'nexus-stdlib');
  });

  it('strips -kit suffix', () => {
    assert.equal(derivePluginId('my-relay-kit'), 'my-relay');
    assert.equal(derivePluginId('@shardworks/nexus-relay-kit'), 'nexus-relay');
  });

  it('strips -apparatus suffix', () => {
    assert.equal(derivePluginId('books-apparatus'), 'books');
    assert.equal(derivePluginId('@shardworks/books-apparatus'), 'books');
    assert.equal(derivePluginId('@acme/cache-apparatus'), 'acme/cache');
  });

  it('strips -plugin suffix', () => {
    assert.equal(derivePluginId('my-thing-plugin'), 'my-thing');
    assert.equal(derivePluginId('@shardworks/nexus-thing-plugin'), 'nexus-thing');
  });

  it('does not strip suffix-like substrings in the middle', () => {
    assert.equal(derivePluginId('my-kit-tools'), 'my-kit-tools');
    assert.equal(derivePluginId('apparatus-runner'), 'apparatus-runner');
  });
});

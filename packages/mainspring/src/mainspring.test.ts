import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRigKey } from './mainspring.ts';

describe('deriveRigKey', () => {
  it('strips @shardworks scope', () => {
    assert.equal(deriveRigKey('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(deriveRigKey('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(deriveRigKey('@acme/my-rig'), 'acme/my-rig');
    assert.equal(deriveRigKey('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(deriveRigKey('my-rig'), 'my-rig');
    assert.equal(deriveRigKey('nexus-stdlib'), 'nexus-stdlib');
  });
});

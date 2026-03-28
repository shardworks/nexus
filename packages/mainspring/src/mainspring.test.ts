import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRigId } from './mainspring.ts';

describe('deriveRigId', () => {
  it('strips @shardworks scope', () => {
    assert.equal(deriveRigId('@shardworks/nexus-stdlib'), 'nexus-stdlib');
    assert.equal(deriveRigId('@shardworks/nexus-ledger'), 'nexus-ledger');
  });

  it('drops @ only for third-party scopes', () => {
    assert.equal(deriveRigId('@acme/my-rig'), 'acme/my-rig');
    assert.equal(deriveRigId('@other/foo'), 'other/foo');
  });

  it('passes through unscoped names', () => {
    assert.equal(deriveRigId('my-rig'), 'my-rig');
    assert.equal(deriveRigId('nexus-stdlib'), 'nexus-stdlib');
  });
});

/**
 * Tests for the `upgrade` framework command.
 *
 * Currently a stub — tests confirm the stub behavior and tool metadata.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import upgradeTool from './upgrade.ts';

describe('upgrade tool definition', () => {
  it('has the correct name', () => {
    assert.equal(upgradeTool.name, 'upgrade');
  });

  it('has a non-empty description', () => {
    assert.ok(upgradeTool.description.length > 0);
  });

  it('is callable from cli only', () => {
    assert.deepEqual(upgradeTool.callableFrom, ['cli']);
  });

  it('exposes a dryRun param', () => {
    const shape = upgradeTool.params.shape as Record<string, unknown>;
    assert.ok('dryRun' in shape);
  });
});

describe('upgrade handler', () => {
  it('returns a "not yet implemented" message', async () => {
    const result = await upgradeTool.handler({});
    assert.ok(typeof result === 'string');
    assert.ok((result as string).toLowerCase().includes('not yet implemented'));
  });

  it('ignores dryRun param without error', async () => {
    const result = await upgradeTool.handler({ dryRun: true });
    assert.ok(typeof result === 'string');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGuildConfig } from './guild-config.ts';
import type { GuildConfig } from './guild-config.ts';

describe('createInitialGuildConfig', () => {
  it('returns a valid config with the given name, version and model', () => {
    const config: GuildConfig = createInitialGuildConfig('test-guild', '0.1.0', 'claude-sonnet-4-20250514');
    assert.equal(config.name, 'test-guild');
    assert.equal(config.nexus, '0.1.0');
    assert.equal(config.model, 'claude-sonnet-4-20250514');
  });

  it('has empty registries', () => {
    const config = createInitialGuildConfig('test-guild', '0.1.0', 'test-model');
    assert.deepEqual(config.workshops, {});
    assert.deepEqual(config.roles, {});
    assert.deepEqual(config.baseTools, []);
    assert.deepEqual(config.tools, {});
    assert.deepEqual(config.engines, {});
    assert.deepEqual(config.curricula, {});
    assert.deepEqual(config.temperaments, {});
  });
});

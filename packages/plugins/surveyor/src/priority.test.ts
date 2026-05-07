/**
 * Priority translation tests (T3).
 *
 * Covers:
 *   - Per-layer scope defaults (D4)
 *   - D5 empty domain pass-through
 *   - Hint-present and hint-absent variants
 *   - visionRelation default is 'vision-advancer'
 *   - Severity / decay / deadline / complexity from hints
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPriority } from './priority.ts';

describe('defaultPriority — layer scope defaults (D4)', () => {
  it('vision → major-area', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.equal(priority.scope, 'major-area');
  });

  it('charge → minor-area', () => {
    const { priority } = defaultPriority('charge', undefined);
    assert.equal(priority.scope, 'minor-area');
  });

  it('piece → minor-area', () => {
    const { priority } = defaultPriority('piece', undefined);
    assert.equal(priority.scope, 'minor-area');
  });
});

describe('defaultPriority — defaults when hints absent', () => {
  it('visionRelation defaults to vision-advancer', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.equal(priority.visionRelation, 'vision-advancer');
  });

  it('severity defaults to moderate', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.equal(priority.severity, 'moderate');
  });

  it('time.decay defaults to false', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.equal(priority.time.decay, false);
  });

  it('time.deadline defaults to null', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.equal(priority.time.deadline, null);
  });

  it('D5 domain is empty array', () => {
    const { priority } = defaultPriority('vision', undefined);
    assert.deepEqual(priority.domain, []);
  });

  it('complexity is undefined when not in hints', () => {
    const { complexity } = defaultPriority('vision', undefined);
    assert.equal(complexity, undefined);
  });
});

describe('defaultPriority — hints present', () => {
  it('severity from hints: serious', () => {
    const { priority } = defaultPriority('vision', { severity: 'serious' });
    assert.equal(priority.severity, 'serious');
  });

  it('severity from hints: critical', () => {
    const { priority } = defaultPriority('charge', { severity: 'critical' });
    assert.equal(priority.severity, 'critical');
  });

  it('decay from hints: true', () => {
    const { priority } = defaultPriority('piece', { decay: true });
    assert.equal(priority.time.decay, true);
  });

  it('deadline from hints', () => {
    const { priority } = defaultPriority('vision', { deadline: '2026-06-15' });
    assert.equal(priority.time.deadline, '2026-06-15');
  });

  it('complexity from hints: bounded', () => {
    const { complexity } = defaultPriority('vision', { complexity: 'bounded' });
    assert.equal(complexity, 'bounded');
  });

  it('complexity from hints: exploratory', () => {
    const { complexity } = defaultPriority('charge', { complexity: 'exploratory' });
    assert.equal(complexity, 'exploratory');
  });

  it('complexity from hints: open-ended', () => {
    const { complexity } = defaultPriority('piece', { complexity: 'open-ended' });
    assert.equal(complexity, 'open-ended');
  });

  it('complexity from hints: mechanical', () => {
    const { complexity } = defaultPriority('vision', { complexity: 'mechanical' });
    assert.equal(complexity, 'mechanical');
  });

  it('unknown severity in hints falls back to moderate', () => {
    const { priority } = defaultPriority('vision', { severity: 'extreme' as 'critical' });
    assert.equal(priority.severity, 'moderate');
  });

  it('domain remains empty (D5) even when other hints present', () => {
    const { priority } = defaultPriority('vision', { severity: 'serious', decay: true });
    assert.deepEqual(priority.domain, []);
  });

  it('all hints combined produce correct Priority', () => {
    const { priority, complexity } = defaultPriority('vision', {
      severity: 'critical',
      deadline: '2026-12-31',
      decay: true,
      complexity: 'exploratory',
    });
    assert.equal(priority.severity, 'critical');
    assert.equal(priority.scope, 'major-area');
    assert.equal(priority.time.deadline, '2026-12-31');
    assert.equal(priority.time.decay, true);
    assert.deepEqual(priority.domain, []);
    assert.equal(complexity, 'exploratory');
  });
});

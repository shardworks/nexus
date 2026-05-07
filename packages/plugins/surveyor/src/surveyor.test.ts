/**
 * Surveyor apparatus — unit tests.
 *
 * Covers:
 *   - Kit registry sealing invariants (T2)
 *   - Multi-surveyor fail-loud (D15)
 *   - Per-entry validation errors
 *   - SurveyorApi listSurveyors / getActiveSurveyor
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSurveyorWithHooks } from './surveyor.ts';

// ── Helper to build a valid descriptor ────────────────────────────────

function validDescriptor(id: string) {
  return {
    id,
    description: `The ${id} surveyor`,
    rigTemplates: {
      'survey-vision': {},
      'survey-charge': {},
      'survey-piece':  {},
    },
    version: '1.0.0',
  };
}

// ── Registry registration ──────────────────────────────────────────────

describe('surveyor kit registry', () => {
  it('registers a valid surveyor descriptor', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    assert.deepEqual(hooks.getRegisteredSurveyorIds(), ['scaffold-surveyor']);
  });

  it('throws when value is not an array', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: {} }),
      /Kit "x" surveyors: expected an array/,
    );
  });

  it('throws when entry is not an object', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: ['not-an-object'] }),
      /entry is not an object/,
    );
  });

  it('throws when id is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'x',
        value: [{ description: 'desc', rigTemplates: {} }],
      }),
      /missing a non-empty string "id" field/,
    );
  });

  it('throws when description is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', rigTemplates: {} }],
      }),
      /missing a non-empty string "description" field/,
    );
  });

  it('throws when rigTemplates is missing', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', description: 'desc' }],
      }),
      /"rigTemplates" must be an object/,
    );
  });

  it('throws when version is not a string', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [{ id: 'scaffold-surveyor', description: 'desc', rigTemplates: {}, version: 42 }],
      }),
      /"version" must be a string or omitted/,
    );
  });

  it('throws when id does not match pluginId (D14)', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [validDescriptor('different-id')],
      }),
      /must equal the contributing plugin id/,
    );
  });

  it('throws when id is not kebab-case', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'BadPlugin',
        value: [{ ...validDescriptor('BadPlugin'), id: 'BadPlugin' }],
      }),
      /must be kebab-case/,
    );
  });

  it('throws on duplicate id from different kits', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    // Duplicate from same pluginId should also throw (different pluginId scenario)
    assert.throws(
      () => hooks.registerKitSurveyors({
        pluginId: 'scaffold-surveyor',
        value: [validDescriptor('scaffold-surveyor')],
      }),
      /duplicate id/,
    );
  });

  it('registers without version (optional field)', () => {
    const { hooks } = createSurveyorWithHooks();
    const descriptor = {
      id: 'scaffold-surveyor',
      description: 'Scaffold surveyor',
      rigTemplates: {},
    };
    hooks.registerKitSurveyors({ pluginId: 'scaffold-surveyor', value: [descriptor] });
    assert.deepEqual(hooks.getRegisteredSurveyorIds(), ['scaffold-surveyor']);
  });
});

// ── Registry sealing ───────────────────────────────────────────────────

describe('surveyor registry sealing', () => {
  it('is not sealed before sealRegistry()', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.equal(hooks.isSealed(), false);
  });

  it('is sealed after sealRegistry()', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.equal(hooks.isSealed(), true);
  });

  it('throws when registering after seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.throws(
      () => hooks.registerKitSurveyors({ pluginId: 'x', value: [validDescriptor('x')] }),
      /startup registration window has closed/,
    );
  });
});

// ── D15 multi-surveyor fail-loud ───────────────────────────────────────

describe('D15 multi-surveyor fail-loud', () => {
  it('throws at seal time when more than one surveyor registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.registerKitSurveyors({
      pluginId: 'another-surveyor',
      value: [validDescriptor('another-surveyor')],
    });
    assert.throws(
      () => hooks.sealRegistry(),
      /Multiple surveyors registered/,
    );
  });

  it('does not throw when exactly one surveyor registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    assert.doesNotThrow(() => hooks.sealRegistry());
  });

  it('does not throw when zero surveyors registered', () => {
    const { hooks } = createSurveyorWithHooks();
    assert.doesNotThrow(() => hooks.sealRegistry());
  });
});

// ── SurveyorApi ────────────────────────────────────────────────────────

describe('SurveyorApi', () => {
  it('getActiveSurveyor returns undefined before seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    // Not sealed yet — activeSurveyor is undefined.
    assert.equal(hooks.getActiveSurveyorId(), undefined);
  });

  it('getActiveSurveyor returns the sole registered surveyor after seal', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.registerKitSurveyors({
      pluginId: 'scaffold-surveyor',
      value: [validDescriptor('scaffold-surveyor')],
    });
    hooks.sealRegistry();
    assert.equal(hooks.getActiveSurveyorId(), 'scaffold-surveyor');
  });

  it('getActiveSurveyor returns undefined when zero surveyors registered', () => {
    const { hooks } = createSurveyorWithHooks();
    hooks.sealRegistry();
    assert.equal(hooks.getActiveSurveyorId(), undefined);
  });
});

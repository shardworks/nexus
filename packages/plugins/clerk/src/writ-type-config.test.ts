/**
 * Tests for the writ-type configuration validator.
 *
 * The happy-path fixture is a mandate-shaped config mirroring the Clerk's
 * current phase machine — six states (`new` initial; `open`, `stuck`
 * active; `completed`, `failed`, `cancelled` terminal) with `completed`
 * carrying the `success` attr and `failed` carrying the `failure` attr,
 * plus a `childrenBehavior` declaring both `allSuccess` and `anyFailure`
 * triggers.
 *
 * Every structural check has at least one happy-path and one failing-case
 * assertion. Failing-case assertions confirm that the thrown error message
 * contains the offending field path, so the `[clerk] writTypeConfig.<path>:
 * ...` shape stays stable.
 *
 * The fixture is inline — per decision D14, shipping a canonical mandate
 * fixture from this module would pre-empt the Clerk refactor's own
 * registration of the built-in type. Each test builds its own fixture from
 * a deep clone of the local `mandateConfig`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateWritTypeConfig } from './writ-type-config.ts';
import type {
  WritTypeConfig,
  WritTypeStateDefinition,
} from './writ-type-config.ts';

// ── Fixture ──────────────────────────────────────────────────────────

/**
 * Canonical happy-path writ-type config used by every test below. Mirrors
 * the Clerk's current phase machine (see `ALLOWED_FROM` in clerk.ts) with
 * `new → open → completed/failed/cancelled` plus the `open ↔ stuck` loop.
 *
 * `new`       — initial
 * `open`      — active; transitions to `stuck`, `completed`, `failed`,
 *               `cancelled`
 * `stuck`     — active; transitions to `open`, `failed`, `cancelled`
 * `completed` — terminal, `success` attr
 * `failed`    — terminal, `failure` attr
 * `cancelled` — terminal, `cancelled` attr
 *
 * `childrenBehavior` targets `completed` (allSuccess) and `failed`
 * (anyFailure), both with `copyResolution: true`. Both targets are
 * reachable from every non-terminal state — `new → open` then out from
 * `open`, or `stuck → open` or `stuck → failed` directly.
 */
function buildMandateConfig(): WritTypeConfig {
  return {
    name: 'mandate',
    states: [
      { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
      {
        name: 'open',
        classification: 'active',
        allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'],
      },
      {
        name: 'stuck',
        classification: 'active',
        allowedTransitions: ['open', 'failed', 'cancelled'],
      },
      {
        name: 'completed',
        classification: 'terminal',
        attrs: ['success'],
        allowedTransitions: [],
      },
      {
        name: 'failed',
        classification: 'terminal',
        attrs: ['failure'],
        allowedTransitions: [],
      },
      {
        name: 'cancelled',
        classification: 'terminal',
        attrs: ['cancelled'],
        allowedTransitions: [],
      },
    ],
    childrenBehavior: {
      allSuccess: { transition: 'completed', copyResolution: true },
      anyFailure: { transition: 'failed', copyResolution: true },
    },
  };
}

/**
 * Return a deep clone of the canonical mandate fixture so tests can mutate
 * the clone without leaking state across cases.
 */
function clone(): WritTypeConfig {
  return JSON.parse(JSON.stringify(buildMandateConfig())) as WritTypeConfig;
}

/**
 * Convenience helper to find a state by name in a cloned fixture, so
 * mutation tests stay readable regardless of the state's array index.
 */
function stateByName(config: WritTypeConfig, name: string): WritTypeStateDefinition {
  const state = config.states.find((s) => s.name === name);
  if (!state) {
    throw new Error(`fixture missing state "${name}"`);
  }
  return state;
}

/**
 * Assert that `validateWritTypeConfig(config)` throws, and that the thrown
 * error message contains both the canonical `[clerk] writTypeConfig.`
 * prefix and the supplied offending-field path.
 */
function assertThrowsWithPath(config: WritTypeConfig, path: string): void {
  assert.throws(
    () => validateWritTypeConfig(config),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected an Error instance');
      assert.match(err.message, /^\[clerk\] writTypeConfig\./);
      assert.ok(
        err.message.includes(path),
        `expected error message to reference path "${path}"; got: ${err.message}`,
      );
      return true;
    },
  );
}

// ── Happy path ───────────────────────────────────────────────────────

describe('validateWritTypeConfig() — happy path', () => {
  it('accepts the mandate-shaped fixture', () => {
    assert.doesNotThrow(() => validateWritTypeConfig(buildMandateConfig()));
  });

  it('returns void on success', () => {
    assert.equal(validateWritTypeConfig(buildMandateConfig()), undefined);
  });

  it('accepts a fixture with no childrenBehavior declared', () => {
    const config = clone();
    delete config.childrenBehavior;
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('accepts a fixture with only one childrenBehavior trigger declared', () => {
    const config = clone();
    config.childrenBehavior = {
      allSuccess: { transition: 'completed', copyResolution: true },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('accepts a transition action without copyResolution', () => {
    const config = clone();
    config.childrenBehavior = {
      allSuccess: { transition: 'completed' },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('accepts a fixture with unknown but non-empty attrs (forward-compat)', () => {
    const config = clone();
    stateByName(config, 'open').attrs = ['custom-tag'];
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });
});

// ── Name + states top-level checks ───────────────────────────────────

describe('validateWritTypeConfig() — top-level shape', () => {
  it('rejects an empty name', () => {
    const config = clone();
    config.name = '';
    assertThrowsWithPath(config, 'name');
  });

  it('rejects a non-string name', () => {
    const config = clone();
    (config as { name: unknown }).name = 42;
    assertThrowsWithPath(config, 'name');
  });

  it('rejects an empty states array', () => {
    const config: WritTypeConfig = { name: 'mandate', states: [] };
    assertThrowsWithPath(config, 'states');
  });

  it('rejects a non-array states field', () => {
    const config = clone();
    (config as { states: unknown }).states = 'nope';
    assertThrowsWithPath(config, 'states');
  });
});

// ── Per-state name + classification checks ──────────────────────────

describe('validateWritTypeConfig() — per-state shape', () => {
  it('rejects an empty state name', () => {
    const config = clone();
    stateByName(config, 'open').name = '';
    assertThrowsWithPath(config, 'states[');
  });

  it('rejects duplicate state names', () => {
    const config = clone();
    // Give `stuck` the same name as `open`.
    stateByName(config, 'stuck').name = 'open';
    assertThrowsWithPath(config, 'states[2].name');
  });

  it('rejects a classification outside the known vocabulary', () => {
    const config = clone();
    const open = stateByName(config, 'open');
    (open as { classification: unknown }).classification = 'maybe';
    assertThrowsWithPath(config, 'states[1].classification');
  });
});

// ── allowedTransitions references ───────────────────────────────────

describe('validateWritTypeConfig() — allowedTransitions references', () => {
  it('rejects an allowedTransitions target that does not exist', () => {
    const config = clone();
    stateByName(config, 'open').allowedTransitions.push('phantom');
    assertThrowsWithPath(config, 'states[1].allowedTransitions[');
  });
});

// ── Initial state count ─────────────────────────────────────────────

describe('validateWritTypeConfig() — initial-state count', () => {
  it('rejects zero initial states', () => {
    const config = clone();
    // Demote `new` to active; keep inbound transition by adding open → new
    // so the inbound check doesn't fire first.
    stateByName(config, 'new').classification = 'active';
    stateByName(config, 'open').allowedTransitions.push('new');
    assertThrowsWithPath(config, 'states');
  });

  it('rejects multiple initial states', () => {
    const config = clone();
    // Promote `open` to initial alongside `new`.
    stateByName(config, 'open').classification = 'initial';
    assertThrowsWithPath(config, 'states');
  });
});

// ── Terminal states have no outbound transitions ────────────────────

describe('validateWritTypeConfig() — terminal outbound transitions', () => {
  it('rejects a terminal state with outbound transitions', () => {
    const config = clone();
    stateByName(config, 'completed').allowedTransitions.push('open');
    assertThrowsWithPath(config, 'states[3].allowedTransitions');
  });
});

// ── Non-initial states must have inbound transitions ────────────────

describe('validateWritTypeConfig() — inbound-transition coverage', () => {
  it('rejects a non-initial state with no inbound transitions', () => {
    const config = clone();
    // Orphan `cancelled` by removing every inbound edge to it.
    stateByName(config, 'new').allowedTransitions = ['open'];
    stateByName(config, 'open').allowedTransitions = ['stuck', 'completed', 'failed'];
    stateByName(config, 'stuck').allowedTransitions = ['open', 'failed'];
    assertThrowsWithPath(config, 'states[5]');
  });
});

// ── childrenBehavior triggers ───────────────────────────────────────

describe('validateWritTypeConfig() — childrenBehavior triggers', () => {
  it('rejects an empty action object on a declared trigger', () => {
    const config = clone();
    // Type-unsafe on purpose: simulate an operator passing an empty action.
    (config.childrenBehavior as { allSuccess?: unknown }).allSuccess = {};
    assertThrowsWithPath(config, 'childrenBehavior.allSuccess');
  });

  it('rejects an action with no transition field', () => {
    const config = clone();
    (config.childrenBehavior as { anyFailure?: unknown }).anyFailure = {
      copyResolution: true,
    };
    assertThrowsWithPath(config, 'childrenBehavior.anyFailure.transition');
  });

  it('rejects a transition target that does not exist', () => {
    const config = clone();
    config.childrenBehavior = {
      allSuccess: { transition: 'phantom', copyResolution: true },
      anyFailure: { transition: 'failed', copyResolution: true },
    };
    assertThrowsWithPath(config, 'childrenBehavior.allSuccess.transition');
  });

  it('rejects an unreachable transition target from some non-terminal state', () => {
    // Add an active "isolated" state whose only outbound edge leads to a
    // terminal state that is NOT `completed`. Give it an inbound edge from
    // `open` so it satisfies the inbound-coverage check. `isolated` is
    // then a non-terminal state from which `completed` is unreachable, so
    // the `childrenBehavior.allSuccess.transition = 'completed'` trigger
    // target is unreachable from some non-terminal state.
    const config = clone();
    config.states.push({
      name: 'isolated',
      classification: 'active',
      allowedTransitions: ['cancelled'],
    });
    stateByName(config, 'open').allowedTransitions.push('isolated');
    assertThrowsWithPath(config, 'childrenBehavior.allSuccess.transition');
  });

  it('rejects a non-object childrenBehavior', () => {
    const config = clone();
    (config as { childrenBehavior: unknown }).childrenBehavior = 'oops';
    assertThrowsWithPath(config, 'childrenBehavior');
  });

  it('rejects a non-boolean copyResolution', () => {
    const config = clone();
    (config.childrenBehavior!.allSuccess as { copyResolution: unknown }).copyResolution = 1;
    assertThrowsWithPath(config, 'childrenBehavior.allSuccess.copyResolution');
  });
});

// ── parentTerminal trigger (downward cascade) ───────────────────────

describe('validateWritTypeConfig() — parentTerminal trigger', () => {
  it('accepts a parentTerminal action with transition + static resolution', () => {
    const config = clone();
    config.childrenBehavior = {
      ...config.childrenBehavior,
      parentTerminal: {
        transition: 'cancelled',
        resolution: 'Automatically cancelled due to parent termination',
      },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('accepts a parentTerminal action with transition only', () => {
    const config = clone();
    config.childrenBehavior = {
      ...config.childrenBehavior,
      parentTerminal: { transition: 'cancelled' },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('accepts a parentTerminal action whose transition target is unknown to this config', () => {
    // The downward trigger's target lives in child type configs, so
    // same-config existence/reachability is not enforced — runtime
    // fail-loud at api.transition handles per-child enforcement.
    const config = clone();
    config.childrenBehavior = {
      ...config.childrenBehavior,
      parentTerminal: { transition: 'phantom-state-only-in-child-configs' },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });

  it('rejects a parentTerminal action with an empty transition field', () => {
    const config = clone();
    (config.childrenBehavior as { parentTerminal?: unknown }).parentTerminal = {
      transition: '',
    };
    assertThrowsWithPath(config, 'childrenBehavior.parentTerminal.transition');
  });

  it('rejects a parentTerminal action with a non-string resolution', () => {
    const config = clone();
    (config.childrenBehavior as { parentTerminal?: unknown }).parentTerminal = {
      transition: 'cancelled',
      resolution: 123,
    };
    assertThrowsWithPath(config, 'childrenBehavior.parentTerminal.resolution');
  });

  it('rejects a parentTerminal action with an empty resolution string', () => {
    const config = clone();
    (config.childrenBehavior as { parentTerminal?: unknown }).parentTerminal = {
      transition: 'cancelled',
      resolution: '',
    };
    assertThrowsWithPath(config, 'childrenBehavior.parentTerminal.resolution');
  });

  it('rejects a parentTerminal action with both copyResolution and resolution set', () => {
    const config = clone();
    (config.childrenBehavior as { parentTerminal?: unknown }).parentTerminal = {
      transition: 'cancelled',
      copyResolution: true,
      resolution: 'static',
    };
    assert.throws(
      () => validateWritTypeConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^\[clerk\] writTypeConfig\.childrenBehavior\.parentTerminal:/);
        assert.match(err.message, /mutually exclusive/);
        return true;
      },
    );
  });

  it('rejects an upward action with both copyResolution and resolution set', () => {
    const config = clone();
    config.childrenBehavior = {
      allSuccess: {
        transition: 'completed',
        copyResolution: true,
        resolution: 'should not coexist',
      },
    };
    assert.throws(
      () => validateWritTypeConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^\[clerk\] writTypeConfig\.childrenBehavior\.allSuccess:/);
        assert.match(err.message, /mutually exclusive/);
        return true;
      },
    );
  });

  it('accepts an upward trigger with resolution and no copyResolution', () => {
    const config = clone();
    config.childrenBehavior = {
      allSuccess: { transition: 'completed', resolution: 'static-success' },
    };
    assert.doesNotThrow(() => validateWritTypeConfig(config));
  });
});

// ── attrs field ─────────────────────────────────────────────────────

describe('validateWritTypeConfig() — attrs field', () => {
  it('rejects attrs declared as a non-array', () => {
    const config = clone();
    (stateByName(config, 'completed') as { attrs: unknown }).attrs = 'success';
    assertThrowsWithPath(config, 'attrs');
  });

  it('rejects an empty-string attr entry', () => {
    const config = clone();
    stateByName(config, 'completed').attrs = [''];
    assertThrowsWithPath(config, 'attrs[0]');
  });
});

// ── First-violation semantics ───────────────────────────────────────

describe('validateWritTypeConfig() — first-violation semantics', () => {
  it('throws on the first structural violation and does not accumulate errors', () => {
    const config = clone();
    // Introduce two violations: an empty name AND a bad classification.
    // The name check is first in the ordering, so the thrown error must
    // reference `name`, not the downstream classification failure.
    config.name = '';
    (stateByName(config, 'open') as { classification: unknown }).classification = 'maybe';
    try {
      validateWritTypeConfig(config);
      assert.fail('expected validator to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /writTypeConfig\.name:/);
      assert.doesNotMatch(err.message, /classification/);
    }
  });
});

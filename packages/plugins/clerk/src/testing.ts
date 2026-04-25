/**
 * Test helpers for the Clerk apparatus.
 *
 * `makeWritTypeApparatus(types)` returns a tiny `LoadedApparatus` whose
 * `start()` calls `clerk.registerWritType(config)` for each supplied
 * config. Mirrors the production registration path so test fixtures
 * exercise the same ordering rules the framework would in a real guild —
 * a fake apparatus must be wired in before the Clerk's startup window
 * seals.
 *
 * `mandateLikeWritType(name)` is a convenience that produces a
 * `WritTypeConfig` clone of mandate's six-state machine under the given
 * name. Used by tests that previously declared throwaway writ types via
 * the legacy `clerk.writTypes` guild-config or kit-channel paths.
 */

import { guild } from '@shardworks/nexus-core';
import type { LoadedApparatus, StartupContext } from '@shardworks/nexus-core';

import type { ClerkApi } from './types.ts';
import type { WritTypeConfig } from './writ-type-config.ts';

/**
 * Build a fake `LoadedApparatus` whose `start()` calls
 * `clerk.registerWritType(config)` for each entry in `types`. The fake
 * apparatus declares no books, no provides, and no consumes — it exists
 * only to register writ types from a real `start()` call so tests
 * exercise the same registration path the framework uses in production.
 *
 * Use the apparatus like any other `LoadedApparatus`: feed it into the
 * fixture's `extraApparatuses` parameter (or equivalent), and the
 * harness will run its `start()` while the Clerk's registration window
 * is still open.
 */
export function makeWritTypeApparatus(
  types: WritTypeConfig[],
  options: { id?: string; packageName?: string; version?: string } = {},
): LoadedApparatus {
  const id = options.id ?? 'fake-writ-type-apparatus';
  const packageName = options.packageName ?? `@test/${id}`;
  const version = options.version ?? '0.0.0';
  return {
    id,
    packageName,
    version,
    apparatus: {
      requires: ['clerk'],
      start(_ctx: StartupContext): void {
        const clerk = guild().apparatus<ClerkApi>('clerk');
        for (const config of types) {
          clerk.registerWritType(config);
        }
      },
    },
  };
}

/**
 * Return a `WritTypeConfig` that clones mandate's six-state machine under
 * a different name. Convenience for tests that previously declared
 * throwaway writ types via the legacy `clerk.writTypes` guild-config
 * channel — the cloned config preserves byte-for-byte the lifecycle
 * mandate-typed writs flow through.
 */
export function mandateLikeWritType(name: string): WritTypeConfig {
  return {
    name,
    states: [
      { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
      { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
      { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
      { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
      { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
      { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
    ],
  };
}

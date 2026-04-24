/**
 * The Clockworks — event substrate and standing-order engine (Pillar 5).
 *
 * This commission ships the skeleton only. The factory:
 *
 *   - Declares plugin id `clockworks` (derived from the package name).
 *   - Requires the Stacks; consumes the future `relays` kit vocabulary.
 *   - Publishes two books (`events`, `event_dispatches`) under owner id
 *     `clockworks`, with the index set anticipated by the runner /
 *     status query patterns in `docs/architecture/clockworks.md`.
 *   - Resolves the Stacks during `start()` and obtains handles on both
 *     books so downstream commissions (task 3 `emit()`, task 4 runner,
 *     task 8 CDC auto-wiring, task 10 daemon) can read/write them
 *     immediately.
 *   - Provides an empty `ClockworksApi` that downstream tasks extend.
 *
 * There is no runtime behavior here: no emission, no dispatch, no relay
 * invocation. `start()` only primes book handles; `stop()` is a no-op
 * — its shape exists so task 10's daemon teardown has a drop-in site.
 *
 * See: docs/architecture/clockworks.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
} from './types.ts';

import { clockList, clockStatus } from './tools/index.ts';

// ── Kit contribution vocabulary (future) ────────────────────────────

// The `relays` kit type is contributed by task 2 (the relay SDK). The
// Clockworks declares `consumes: ['relays']` now so the framework's
// unconsumed-kit warning stays quiet once downstream kits start
// contributing relays — even though the runtime consumer does not
// exist yet. `consumes` is zero-cost advisory metadata.
const RELAYS_KIT = 'relays';

export function createClockworks(): Plugin {
  // Handles primed during start() and retained for downstream use when
  // subsequent tasks extend this factory with runtime behavior.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let events: Book<EventDoc>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let dispatches: Book<EventDispatchDoc>;

  // Empty api surface for this commission — task 3 replaces this with
  // the real shape (`emit()` and friends).
  const api: ClockworksApi = {};

  return {
    apparatus: {
      requires: ['stacks'],
      consumes: [RELAYS_KIT],

      provides: api,

      supportKit: {
        books: {
          events: {
            indexes: [
              'name',
              'processed',
              'firedAt',
              ['processed', 'firedAt'],
            ],
          },
          event_dispatches: {
            indexes: [
              'eventId',
              'status',
              ['eventId', 'status'],
            ],
          },
        },
        tools: [clockStatus, clockList],
      },

      async start(_ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');

        // Prime book handles so downstream commissions — once they
        // extend `api` — can use them without re-resolving Stacks.
        events = stacks.book<EventDoc>('clockworks', 'events');
        dispatches = stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');

        // Reference the handles to satisfy the unused-binding check
        // until a subsequent task introduces their first real reader.
        void events;
        void dispatches;
      },

      stop(): void {
        // No-op — runtime teardown arrives with task 10's daemon.
      },
    },
  };
}

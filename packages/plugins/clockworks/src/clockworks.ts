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
import { generateId, guild } from '@shardworks/nexus-core';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
} from './types.ts';

import { clockList, clockStatus, signal } from './tools/index.ts';

// ── Kit contribution vocabulary (future) ────────────────────────────

// The `relays` kit type is contributed by task 2 (the relay SDK). The
// Clockworks declares `consumes: ['relays']` now so the framework's
// unconsumed-kit warning stays quiet once downstream kits start
// contributing relays — even though the runtime consumer does not
// exist yet. `consumes` is zero-cost advisory metadata.
const RELAYS_KIT = 'relays';

export function createClockworks(): Plugin {
  // Handles primed during start() and retained for the factory's
  // closure-scoped api methods (and by downstream commissions that
  // extend this factory with additional runtime behavior).
  let events: Book<EventDoc>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let dispatches: Book<EventDispatchDoc>;

  const api: ClockworksApi = {
    async emit(name: string, payload: unknown, emitter: string): Promise<string> {
      if (!events) {
        throw new Error(
          'clockworks: emit() called before start() primed the events book handle.',
        );
      }

      // Coerce undefined to null so the stored row shape is predictable
      // — decision D8 in the commission spec. null is valid JSON and
      // matches the optional payload type signature.
      const storedPayload = payload === undefined ? null : payload;

      // Pre-serialize-check (D2, D11) — fail loud at the API boundary
      // rather than surfacing an obscure SQLite-layer throw later.
      // The attempted serialize value is discarded; Stacks owns the
      // final persistence-format decision.
      try {
        JSON.stringify(storedPayload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `clockworks: event "${name}" payload is not JSON-serializable: ${reason}`,
        );
      }

      const id = generateId('e');
      const firedAt = new Date().toISOString();

      const doc: EventDoc = {
        id,
        name,
        payload: storedPayload,
        emitter,
        firedAt,
        processed: false,
      };

      await events.put(doc);
      return id;
    },
  };

  return {
    apparatus: {
      // Clerk is required because the `signal` tool's writ-lifecycle
      // validator (D3) resolves `ClerkApi` to enumerate declared writ
      // types before rejecting `<type>.{ready,completed,stuck,failed}`
      // patterns.
      requires: ['stacks', 'clerk'],
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
        tools: [clockStatus, clockList, signal],
      },

      async start(_ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');

        // Prime book handles so `emit()` and downstream commissions can
        // use them without re-resolving Stacks.
        events = stacks.book<EventDoc>('clockworks', 'events');
        dispatches = stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');

        // Reference the dispatches handle to satisfy the unused-binding
        // check until the runner / dispatcher commission claims it.
        void dispatches;
      },

      stop(): void {
        // No-op — runtime teardown arrives with task 10's daemon.
      },
    },
  };
}

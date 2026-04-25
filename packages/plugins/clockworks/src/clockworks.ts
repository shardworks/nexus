/**
 * The Clockworks — event substrate and standing-order engine (Pillar 5).
 *
 * This commission ships the relay registry plumbing on top of the
 * skeleton. The factory:
 *
 *   - Declares plugin id `clockworks` (derived from the package name).
 *   - Requires the Stacks; consumes the `relays` kit vocabulary.
 *   - Publishes two books (`events`, `event_dispatches`) under owner id
 *     `clockworks`, with the index set anticipated by the runner /
 *     status query patterns in `docs/architecture/clockworks.md`.
 *   - Resolves the Stacks during `start()` and obtains handles on both
 *     books so downstream commissions (task 3 `emit()`, task 4 runner,
 *     task 8 CDC auto-wiring, task 10 daemon) can read/write them
 *     immediately.
 *   - Builds a name-keyed relay registry from `ctx.kits('relays')`
 *     entries merged with the apparatus's own `supportKit.relays`. The
 *     registry is closure-scoped, cleared at the top of every `start()`
 *     for idempotent restart semantics, and uses first-writer-wins on
 *     duplicate names with a lattice-format warning. Reachable from the
 *     api via `resolveRelay(name)`.
 *
 * There is no dispatcher in this commission: nothing reads from the
 * registry yet. `start()` primes the book handles and the registry;
 * `stop()` is a no-op — its shape exists so task 10's daemon teardown
 * has a drop-in site. Task 4 will add the dispatcher; task 5 will fill
 * the currently-empty `supportKit.relays` slot with the summon relay.
 *
 * See: docs/architecture/clockworks.md
 */

import type { KitEntry, Plugin, StartupContext } from '@shardworks/nexus-core';
import { generateId, guild } from '@shardworks/nexus-core';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
} from './types.ts';

import { isRelayDefinition, type RelayDefinition } from './relay.ts';
import { clockList, clockStatus, signal } from './tools/index.ts';

// ── Kit contribution vocabulary ─────────────────────────────────────

// The `relays` kit type carries plugin-contributed relay handlers. The
// Clockworks declares `consumes: [RELAYS_KIT]` so the framework's
// unconsumed-kit warning stays quiet, and resolves contributions during
// `start()` into a name-keyed registry. The constant is load-bearing —
// the existing test asserts the exact string.
const RELAYS_KIT = 'relays';

// ── Registry ────────────────────────────────────────────────────────

interface RegisteredRelay {
  pluginId: string;
  relay: RelayDefinition;
}

export function createClockworks(): Plugin {
  // Handles primed during start() and retained for the factory's
  // closure-scoped api methods (and by downstream commissions that
  // extend this factory with additional runtime behavior).
  let events: Book<EventDoc>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let dispatches: Book<EventDispatchDoc>;

  // Registered relays keyed by `name` — first writer wins, with a
  // warning for duplicates. Built fresh on every `start()` (so the
  // future daemon-restart path stays idempotent).
  const relays = new Map<string, RegisteredRelay>();

  /**
   * Register a single kit's `relays` contribution. Mirrors the lattice's
   * factory-registration shape: warn-and-skip on a malformed top-level
   * entry value, warn-and-skip per-element on a malformed relay, and
   * warn-and-keep-first on a duplicate name. Survivable — a malformed
   * third-party kit must not take down Clockworks.
   */
  function registerKitRelays(entry: KitEntry): void {
    const { pluginId } = entry;
    const raw = entry.value;
    if (!Array.isArray(raw)) {
      console.warn(
        `[clockworks] Kit "${pluginId}" relays: expected an array, got ${typeof raw} — skipped.`,
      );
      return;
    }

    for (const candidate of raw) {
      if (!isRelayDefinition(candidate)) {
        console.warn(
          `[clockworks] Kit "${pluginId}" relays: entry is not a valid RelayDefinition — skipped.`,
        );
        continue;
      }
      if (relays.has(candidate.name)) {
        const existing = relays.get(candidate.name)!;
        console.warn(
          `[clockworks] Kit "${pluginId}" relays: relay name "${candidate.name}" is already registered by kit "${existing.pluginId}" — duplicate skipped.`,
        );
        continue;
      }
      relays.set(candidate.name, { pluginId, relay: candidate });
    }
  }

  // ── API ────────────────────────────────────────────────────────

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

    resolveRelay(name: string): RelayDefinition | undefined {
      const entry = relays.get(name);
      return entry?.relay;
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
        // Reserved for task 5 (the summon relay). An empty array is a
        // cleaner signal than omission and exercises the merge path
        // through the registry-build code today.
        relays: [] as RelayDefinition[],
      },

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');

        // Prime book handles so `emit()` and downstream commissions can
        // use them without re-resolving Stacks.
        events = stacks.book<EventDoc>('clockworks', 'events');
        dispatches = stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');

        // Reference the dispatches handle to satisfy the unused-binding
        // check until the runner / dispatcher commission claims it.
        void dispatches;

        // Rebuild the relay registry from scratch. Arbor wires standalone
        // kits ahead of apparatus supportKits, so honoring the returned
        // order naturally gives user-kit relays priority over
        // stdlib ones contributed by `supportKit.relays`.
        relays.clear();
        for (const entry of ctx.kits(RELAYS_KIT)) {
          registerKitRelays(entry);
        }
      },

      stop(): void {
        // No-op — runtime teardown arrives with task 10's daemon.
      },
    },
  };
}

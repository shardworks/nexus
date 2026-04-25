/**
 * The Clockworks — event substrate and standing-order engine (Pillar 5).
 *
 * The factory:
 *
 *   - Declares plugin id `clockworks` (derived from the package name).
 *   - Requires the Stacks and Clerk; consumes the `relays` kit
 *     vocabulary.
 *   - Publishes two books (`events`, `event_dispatches`) under owner id
 *     `clockworks`, with the index set anticipated by the runner /
 *     status query patterns in `docs/architecture/clockworks.md`.
 *   - Resolves the Stacks during `start()` and obtains writable handles
 *     on both books so `emit()`, `processEvents()`, and the future
 *     daemon can use them without re-resolving Stacks.
 *   - Provides the `ClockworksApi` (`emit()`, `resolveRelay()`,
 *     `processEvents()`) that downstream tasks extend.
 *   - Builds a name-keyed relay registry from `ctx.kits('relays')`
 *     entries merged with the apparatus's own `supportKit.relays`. The
 *     registry is closure-scoped, cleared at the top of every `start()`
 *     for idempotent restart semantics, and uses first-writer-wins on
 *     duplicate names with a lattice-format warning. Reachable from the
 *     api via `resolveRelay(name)`.
 *   - Auto-wires every plugin-declared book (other than
 *     `clockworks/events` itself) as a CDC observer that re-emits each
 *     row create/update/delete as a `book.<ownerId>.<book>.<verb>`
 *     event with emitter `'framework'`. Standing orders can therefore
 *     bind directly to book mutations without each plugin having to
 *     call `emit()` from every write site.
 *   - Exposes `processEvents()` — the event-triggered dispatch entry
 *     point. Each call re-reads `clockworks.standingOrders` from
 *     `guild.json`, validates them via the standing-order validator,
 *     and delegates to the pure `runDispatchSweep` primitive in
 *     `dispatcher.ts`. The CLI (later commission) and daemon (later
 *     commission) compose on top of the same primitive.
 *
 * `start()` primes the book handles, the registry, the CDC watchers,
 * and the dispatch path; `stop()` remains a no-op — its shape exists
 * so the future daemon teardown has a drop-in site. Task 5 will fill
 * the currently-empty `supportKit.relays` slot with the summon relay.
 *
 * See: docs/architecture/clockworks.md
 */

import type { KitEntry, Plugin, StartupContext } from '@shardworks/nexus-core';
import { generateId, guild } from '@shardworks/nexus-core';
import type {
  Book,
  BookEntry,
  BookSchema,
  ChangeEvent,
  StacksApi,
} from '@shardworks/stacks-apparatus';

import type {
  ClockworksApi,
  EventDispatchDoc,
  EventDoc,
} from './types.ts';

import { runDispatchSweep, type DispatchSummary } from './dispatcher.ts';
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

// ── CDC verb mapping ─────────────────────────────────────────────────
//
// Stacks' CDC event tags are present-tense imperatives
// (`'create' | 'update' | 'delete'`). The auto-wired event names use
// past tense — `created`, `updated`, `deleted` — to match the rest of
// the guild's event namespace (`commission.posted`, `code.reviewed`)
// and to read naturally as a log line.
const CDC_VERB_PAST_TENSE: Record<'create' | 'update' | 'delete', string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

export function createClockworks(): Plugin {
  // Handles primed during start() and retained for the factory's
  // closure-scoped api methods (and by downstream commissions that
  // extend this factory with additional runtime behavior).
  let events: Book<EventDoc>;
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

    async processEvents(): Promise<DispatchSummary> {
      if (!events || !dispatches) {
        throw new Error(
          'clockworks: processEvents() called before start() primed the book handles.',
        );
      }

      // D15: re-read the standing-order array per call so operators can
      // hot-edit guild.json without restarting the apparatus. The
      // dispatcher then re-validates it via the standing-order
      // validator on every sweep (D3).
      const g = guild();
      const standingOrders = g.guildConfig().clockworks?.standingOrders ?? [];

      // D11: per-call read of `home`. D21: pure dispatcher receives
      // every dependency by parameter so unit tests can drive it
      // without booting Stacks.
      return runDispatchSweep({
        events,
        dispatches,
        resolveRelay: api.resolveRelay,
        standingOrders,
        home: g.home,
      });
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

        // Prime book handles so `emit()`, `processEvents()`, and
        // downstream commissions can use them without re-resolving
        // Stacks.
        events = stacks.book<EventDoc>('clockworks', 'events');
        dispatches = stacks.book<EventDispatchDoc>('clockworks', 'event_dispatches');

        // Rebuild the relay registry from scratch. Arbor wires standalone
        // kits ahead of apparatus supportKits, so honoring the returned
        // order naturally gives user-kit relays priority over
        // stdlib ones contributed by `supportKit.relays`.
        relays.clear();
        for (const entry of ctx.kits(RELAYS_KIT)) {
          registerKitRelays(entry);
        }

        // ── CDC auto-wiring ───────────────────────────────────────────
        //
        // Make every plugin-declared book observable as a Clockworks
        // event automatically: register a Phase-2 (post-commit) Stacks
        // CDC watcher on each declared book that re-emits each
        // create/update/delete row mutation as a
        // `book.<ownerId>.<bookName>.<verb>` event with emitter
        // `'framework'`.
        //
        // Lifecycle: registration MUST happen here in start(), because
        // the Stacks CDC registry seals at `phase:started`; no later
        // registration is possible.
        //
        // Carve-out: `clockworks/events` is excluded. A watcher on the
        // events book would observe its own emit() write and re-emit
        // forever — Stacks' per-transaction cascade-depth guard does
        // not protect across transactions. Every other book — including
        // `clockworks/event_dispatches` — is auto-wired.
        //
        // Phase 2 (failOnError: false): the handler runs after the
        // triggering transaction commits. Emit-handler errors are
        // logged via Stacks' Phase-2 error path and do not roll back
        // the primary write — observation is layered on top of the
        // substrate, not gating it.
        //
        // Enumeration mirrors Stacks' own `reconcileSchemas()`: walk
        // `ctx.kits('books')`, treat each entry's value as a record
        // of book name → BookSchema, skip silently when the value is
        // not a non-null object (matching Stacks' guard exactly so
        // divergent reactions to the same malformed contribution
        // cannot occur).
        for (const entry of ctx.kits('books')) {
          const books = entry.value;
          if (typeof books !== 'object' || books === null) continue;
          for (const bookName of Object.keys(books as Record<string, BookSchema>)) {
            // Recursion guard — see above.
            if (entry.pluginId === 'clockworks' && bookName === 'events') continue;

            stacks.watch<BookEntry>(
              entry.pluginId,
              bookName,
              async (event: ChangeEvent<BookEntry>) => {
                // Compose the event name from the delivered CDC event
                // — equivalent to (entry.pluginId, bookName) at runtime
                // but slightly more robust to future Stacks changes
                // and matches the architecture-doc reference sketch.
                const verb = CDC_VERB_PAST_TENSE[event.type];
                const name = `book.${event.ownerId}.${event.book}.${verb}`;
                // Pass the CDC event object through unchanged — there
                // is no second consumer to earn a normalized shape, so
                // passthrough preserves all available context.
                //
                // No try/catch: Stacks' Phase-2 error path already
                // logs `[stacks] Phase 2 handler error (...)`. Wrapping
                // would either duplicate or mask that log line.
                await api.emit(name, event, 'framework');
              },
              { failOnError: false },
            );
          }
        }
      },

      stop(): void {
        // No-op — runtime teardown arrives with task 10's daemon.
      },
    },
  };
}

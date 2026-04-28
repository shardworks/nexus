/**
 * The Clockworks↔Stacks signals bridge — observer-translator that
 * surfaces every Stacks change-data-capture (CDC) row mutation as a
 * Clockworks event.
 *
 * At apparatus `start()`, the bridge walks every plugin-declared book
 * in `ctx.kits('books')` (other than `clockworks/events` itself) and
 * registers a Phase-2 (post-commit) Stacks CDC watcher on each
 * declared book. Each create / update / delete row mutation produces
 * exactly one row in `clockworks/events` whose:
 *
 *   - `name`    is `book.<ownerId>.<book>.<verb>` where verb maps
 *               create/update/delete to created/updated/deleted (past
 *               tense matches the convention used elsewhere in the
 *               guild's event namespace).
 *   - `emitter` is the literal `'framework'` — `book.*` events are
 *               part of the framework's substrate-observation contract;
 *               this bridge is a relocation of where the registration
 *               happens, not a re-attribution of the contract owner.
 *   - `payload` is the Stacks `ChangeEvent` object verbatim — no
 *               normalization. There is no second consumer to earn a
 *               normalized projection; passthrough preserves all
 *               available context.
 *
 * Standing orders can therefore bind directly to row mutations without
 * each plugin author having to call `emit()` from every write site.
 *
 * ── Carve-out: `clockworks/events` ─────────────────────────────────
 *
 * The `clockworks/events` book is the only book excluded from
 * auto-wiring. The carve-out is an *architectural boundary* —
 * auto-wiring the events book would pollute the framework event stream
 * with `book.clockworks.events.created` rows describing the very acts
 * of emission, which is feedback noise without a consumer. The Stacks
 * substrate now enforces a Phase-2 cross-transaction re-entry depth
 * bound (`MAX_PHASE2_REENTRY_DEPTH` in `stacks-core.ts`) that would
 * terminate any runaway loop, so this carve-out is no longer the
 * load-bearing safety net it once was — the substrate is. Future
 * maintainers: do not remove the carve-out on the assumption that the
 * substrate now covers it. The two serve different purposes: the
 * substrate caps depth; the carve-out keeps the events book free of
 * self-feedback in the first place. Every other book — including
 * `clockworks/event_dispatches` — is auto-wired.
 *
 * The carve-out predicate is a pair of literal-string comparisons —
 * `entry.pluginId === 'clockworks' && bookName === 'events'`. Importing
 * a constant from `@shardworks/clockworks-apparatus` would entangle
 * the plugins for no behavioural gain.
 *
 * ── Phase-2 isolation ─────────────────────────────────────────────
 *
 * The handler runs after the triggering transaction commits
 * (`failOnError: false`). Emit-handler errors are logged via Stacks'
 * Phase-2 error path and do not roll back the primary write —
 * observation is layered on top of the substrate, not gating it. We
 * deliberately do not wrap the `emit()` call in try/catch: Stacks'
 * Phase-2 error path already logs `[stacks] Phase 2 handler error
 * (...)`. Wrapping would either duplicate or mask that diagnostic.
 *
 * ── Registration timing ───────────────────────────────────────────
 *
 * Registration MUST happen here in `start()`, because the Stacks CDC
 * registry seals at the framework's `phase:started` signal — no later
 * registration is possible. The bridge declares
 * `requires: ['stacks', 'clockworks']` so both dependencies have
 * started before its own `start()` runs; the framework's start-order
 * gate guarantees the `ctx.kits('books')` snapshot is fully assembled.
 *
 * ── Malformed kit entries ─────────────────────────────────────────
 *
 * Enumeration mirrors Stacks' own `reconcileSchemas()`: walk
 * `ctx.kits('books')`, treat each entry's value as a record of
 * book name → schema, skip silently when the value is not a non-null
 * object (matching Stacks' guard exactly so divergent reactions to
 * the same malformed contribution cannot occur). The events-kit
 * function form mirrors the same silent-skip so the declared set
 * stays in sync with the emitted set.
 *
 * See: docs/architecture/apparatus/clockworks-stacks-signals.md
 */

import type {
  KitEntry,
  Plugin,
  StartupContext,
} from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type {
  ClockworksApi,
  EventSpec,
} from '@shardworks/clockworks-apparatus';
import type {
  BookEntry,
  ChangeEvent,
  StacksApi,
} from '@shardworks/stacks-apparatus';

// ── CDC verb mapping ─────────────────────────────────────────────────
//
// Stacks' CDC event tags are present-tense imperatives
// (`'create' | 'update' | 'delete'`). The auto-wired event names use
// past tense — `created`, `updated`, `deleted` — to read naturally as
// a log line and match the past-tense convention used elsewhere in the
// guild's event namespace.
const CDC_VERB_PAST_TENSE: Record<'create' | 'update' | 'delete', string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

// ── Carve-out predicate ──────────────────────────────────────────────
//
// The single book the bridge does NOT auto-wire. Literal-string match
// to today (D6) — importing a constant from
// `@shardworks/clockworks-apparatus` would entangle the plugins for
// no behavioural gain.
const CARVE_OUT_PLUGIN_ID = 'clockworks';
const CARVE_OUT_BOOK_NAME = 'events';

/**
 * Function-form `events` kit contribution. Walks `ctx.kits('books')`
 * with the same silent-skip and carve-out the watcher loop applies and
 * enumerates `book.<owner>.<book>.<verb>` for the three verbs.
 *
 * Mirrors the watcher's carve-out so the declared set equals the
 * emitted set. Closing the spoofing vector for `book.clockworks.
 * events.*` (which the bridge does not declare and therefore does not
 * mark framework-owned) is captured as a separate follow-up — the
 * carve-out is preserved for parity with the watcher.
 */
function buildEventsContribution(
  ctx: StartupContext,
): Record<string, EventSpec> {
  const events: Record<string, EventSpec> = {};
  for (const entry of ctx.kits('books')) {
    const books = entry.value;
    if (typeof books !== 'object' || books === null) continue;
    for (const bookName of Object.keys(books as Record<string, unknown>)) {
      if (
        entry.pluginId === CARVE_OUT_PLUGIN_ID &&
        bookName === CARVE_OUT_BOOK_NAME
      ) {
        continue;
      }
      for (const verb of Object.values(CDC_VERB_PAST_TENSE)) {
        events[`book.${entry.pluginId}.${bookName}.${verb}`] = {
          description:
            `Stacks CDC observation: a row was ${verb} in ` +
            `book "${bookName}" owned by plugin "${entry.pluginId}". ` +
            `Emitted by the clockworks-stacks-signals bridge.`,
        };
      }
    }
  }
  return events;
}

/**
 * The bridge plugin factory. Returns a synchronous-`start()` apparatus
 * with no `provides` (no consumer needs an API surface — the bridge is
 * opaque to other plugins) and a single function-form events
 * contribution.
 */
export function createClockworksStacksSignals(): Plugin {
  return {
    apparatus: {
      // Hard dependencies: the bridge cannot register Stacks watchers
      // without Stacks, and it cannot route emissions without
      // Clockworks. Both must be started before this apparatus's
      // `start()` runs; the framework's start-order gate enforces it.
      requires: ['stacks', 'clockworks'],
      // No `recommends` — the bridge has no soft dependencies.
      // Echoing Clockworks' `recommends` list (animator, loom) would
      // create startup-warning noise without earning its keep here.
      consumes: ['books'],

      supportKit: {
        // Function-form contribution — the declared set is computed
        // from the same `ctx.kits('books')` snapshot the watcher
        // loop walks, with the same silent-skip and carve-out, so
        // declared==emitted for every book the bridge actually
        // observes.
        events: buildEventsContribution,
      },

      start(ctx: StartupContext): void {
        // ── Resolve dependencies ──────────────────────────────────
        //
        // Both Stacks and Clockworks are guaranteed to have started
        // by `requires: ['stacks', 'clockworks']`. Resolve once and
        // capture in closure (mirrors cartograph's pattern); the
        // closure's lifetime matches the apparatus's lifetime.
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');
        const clockworks = g.apparatus<ClockworksApi>('clockworks');

        // ── CDC auto-wiring ───────────────────────────────────────
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
        // Carve-out: `clockworks/events` is excluded. This is an
        // *architectural boundary* — auto-wiring the events book would
        // pollute the framework event stream with `book.clockworks.
        // events.created` rows describing the very acts of emission,
        // which is feedback noise without a consumer. The Stacks
        // substrate now enforces a Phase-2 cross-transaction re-entry
        // depth bound (`MAX_PHASE2_REENTRY_DEPTH` in `stacks-core.ts`)
        // that would terminate any runaway loop, so this carve-out is
        // no longer the load-bearing safety net it once was — the
        // substrate is. Future maintainers: do not remove the carve-out
        // on the assumption that the substrate now covers it. The two
        // serve different purposes: the substrate caps depth; the
        // carve-out keeps the events book free of self-feedback in the
        // first place. Every other book — including
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
        for (const entry of ctx.kits('books') as KitEntry[]) {
          const books = entry.value;
          if (typeof books !== 'object' || books === null) continue;
          for (const bookName of Object.keys(books as Record<string, unknown>)) {
            // Recursion guard — see above.
            if (
              entry.pluginId === CARVE_OUT_PLUGIN_ID &&
              bookName === CARVE_OUT_BOOK_NAME
            ) {
              continue;
            }

            stacks.watch<BookEntry>(
              entry.pluginId,
              bookName,
              async (event: ChangeEvent<BookEntry>) => {
                // Compose the event name from the delivered CDC event
                // (D20) — equivalent to (entry.pluginId, bookName) at
                // runtime but slightly more robust to future Stacks
                // changes and matches the architecture-doc reference
                // sketch.
                const verb = CDC_VERB_PAST_TENSE[event.type];
                const name = `book.${event.ownerId}.${event.book}.${verb}`;
                // Pass the CDC event object through unchanged — there
                // is no second consumer to earn a normalized shape, so
                // passthrough preserves all available context.
                //
                // No try/catch: Stacks' Phase-2 error path already
                // logs `[stacks] Phase 2 handler error (...)`. Wrapping
                // would either duplicate or mask that log line.
                await clockworks.emit(name, event, 'framework');
              },
              { failOnError: false },
            );
          }
        }
      },
    },
  };
}

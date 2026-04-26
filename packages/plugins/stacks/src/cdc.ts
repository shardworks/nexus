/**
 * CDC registry — handler registration, event buffering, and coalescing.
 *
 * Two-phase execution model:
 * - Phase 1 (failOnError: true):  runs INSIDE the transaction
 * - Phase 2 (failOnError: false): runs AFTER commit with coalesced events
 *
 * See: docs/specification.md (stacks § CDC)
 */

import type { BookEntry, ChangeEvent, ChangeHandler, WatchOptions } from './types.ts';

// ── Phase-2 re-entry depth error ──────────────────────────────────────

/**
 * Thrown when the substrate-level Phase-2 cross-transaction re-entry
 * depth bound trips. Distinct from the Phase-1 cascade-depth error so
 * log filtering and the conformance regex can route operators to the
 * correct remediation path (D8): break a Phase-2 cycle by writing to a
 * non-watched book, or add a state-machine guard so the handler stops
 * calling itself.
 *
 * Re-thrown by `firePhase2`'s per-handler catch (rather than swallowed
 * with the usual handler-error log) so the bound surfaces past the
 * registry's catch-and-log block to the original `runTransaction`
 * caller (D6).
 */
export class Phase2DepthExceededError extends Error {
  constructor(limit: number) {
    super(
      `[stacks] Maximum Phase-2 re-entry depth (${limit}) exceeded. ` +
      `A Phase-2 handler chain re-entered Phase-2 across transaction ` +
      `boundaries past the substrate bound. Break the cycle by writing ` +
      `to a non-watched book, or add an in-handler state-machine guard ` +
      `so the handler stops calling itself.`,
    );
    this.name = 'Phase2DepthExceededError';
  }
}

// ── Registry entry ────────────────────────────────────────────────────

interface WatcherEntry {
  handler: ChangeHandler;
  failOnError: boolean;
}

// ── Event buffer entry (raw, pre-coalesce) ────────────────────────────

export interface BufferedEvent {
  ref: string;          // "${ownerId}/${bookName}"
  ownerId: string;
  book: string;
  docId: string;
  type: 'create' | 'update' | 'delete';
  entry?: BookEntry;    // present for create/update
  prev?: BookEntry;     // present for update/delete
}

// ── Coalescing state machine ──────────────────────────────────────────

interface CoalesceState {
  ownerId: string;
  book: string;
  docId: string;
  /** The first event's type — needed for coalescing rules. */
  firstType: 'create' | 'update' | 'delete';
  /** The most recent event's type. */
  lastType: 'create' | 'update' | 'delete';
  /** Pre-transaction state (prev from first event). */
  prev?: BookEntry;
  /** Final state (entry from last event). */
  entry?: BookEntry;
}

/**
 * Coalesce buffered events per-document.
 *
 * Rules:
 *   create                    → create (final state)
 *   create → update(s)        → create (final state)
 *   create → delete           → (no event)
 *   update(s)                 → update (first prev, final state)
 *   update(s) → delete        → delete (first prev)
 *   delete                    → delete (prev)
 */
export function coalesceEvents(buffer: BufferedEvent[]): ChangeEvent<BookEntry>[] {
  const states = new Map<string, CoalesceState>();

  for (const event of buffer) {
    const key = `${event.ref}:${event.docId}`;
    const existing = states.get(key);

    if (!existing) {
      states.set(key, {
        ownerId: event.ownerId,
        book: event.book,
        docId: event.docId,
        firstType: event.type,
        lastType: event.type,
        prev: event.prev,
        entry: event.entry,
      });
    } else {
      existing.lastType = event.type;
      if (event.entry) existing.entry = event.entry;
      // prev stays as the first event's prev (pre-transaction state)
    }
  }

  const events: ChangeEvent<BookEntry>[] = [];

  for (const state of states.values()) {
    if (state.firstType === 'create' && state.lastType === 'delete') {
      // create → delete: no event (document never existed from observer's perspective)
      continue;
    }

    if (state.firstType === 'create') {
      // create (possibly followed by updates): coalesces to create with final state
      events.push({
        type: 'create',
        ownerId: state.ownerId,
        book: state.book,
        entry: state.entry!,
      });
    } else if (state.lastType === 'delete') {
      // update(s) → delete: coalesces to delete with original prev
      events.push({
        type: 'delete',
        ownerId: state.ownerId,
        book: state.book,
        id: state.docId,
        prev: state.prev!,
      });
    } else {
      // update(s): coalesces to single update with first prev, final entry
      events.push({
        type: 'update',
        ownerId: state.ownerId,
        book: state.book,
        entry: state.entry!,
        prev: state.prev!,
      });
    }
  }

  return events;
}

// ── CDC Registry ──────────────────────────────────────────────────────

export class CdcRegistry {
  private readonly watchers = new Map<string, WatcherEntry[]>();
  private locked = false;

  /**
   * Register a CDC handler for a book.
   * Must be called during guild startup — arbor calls `sealCdc()` on the
   * Stacks core via the `phase:started` event after all apparatus start()
   * methods return, after which this throws.
   */
  watch(
    ownerId: string,
    bookName: string,
    handler: ChangeHandler,
    options?: WatchOptions,
  ): void {
    if (this.locked) {
      throw new Error(
        `[stacks] watch() called after guild startup completed. ` +
        `Handlers must be registered during apparatus startup.`,
      );
    }

    const key = `${ownerId}/${bookName}`;
    let entries = this.watchers.get(key);
    if (!entries) {
      entries = [];
      this.watchers.set(key, entries);
    }
    entries.push({
      handler,
      failOnError: options?.failOnError ?? true,
    });
  }

  /** Seal the CDC registry — called by the Stacks core when arbor fires phase:started, after all apparatus start() methods complete. */
  lock(): void {
    this.locked = true;
  }

  /** Check if any handlers are registered for a book (controls pre-read). */
  hasWatchers(ownerId: string, bookName: string): boolean {
    const key = `${ownerId}/${bookName}`;
    const entries = this.watchers.get(key);
    return entries !== undefined && entries.length > 0;
  }

  /** Get Phase 1 handlers (failOnError: true) for a book. */
  getPhase1Handlers(ownerId: string, bookName: string): WatcherEntry[] {
    const key = `${ownerId}/${bookName}`;
    return (this.watchers.get(key) ?? []).filter((e) => e.failOnError);
  }

  /** Get Phase 2 handlers (failOnError: false) for a book. */
  getPhase2Handlers(ownerId: string, bookName: string): WatcherEntry[] {
    const key = `${ownerId}/${bookName}`;
    return (this.watchers.get(key) ?? []).filter((e) => !e.failOnError);
  }

  /**
   * Fire Phase 1 handlers for a single event. Throws on handler error
   * (caller is responsible for rolling back the transaction).
   */
  async firePhase1(
    ownerId: string,
    bookName: string,
    event: ChangeEvent<BookEntry>,
  ): Promise<void> {
    for (const entry of this.getPhase1Handlers(ownerId, bookName)) {
      await entry.handler(event);
    }
  }

  /**
   * Fire Phase 2 handlers for coalesced events. Errors are logged, not
   * thrown — except for `Phase2DepthExceededError`, which is re-thrown
   * so the substrate-level cross-transaction re-entry bound surfaces
   * past this catch-and-log block to the original `runTransaction`
   * caller (D6). Callers should wrap this invocation with depth
   * tracking (`enterPhase2Hop` / `exitPhase2Hop` on `StacksCore`); the
   * gate check itself fires inside `runTransaction` before any backend
   * transaction is opened.
   */
  async firePhase2(events: ChangeEvent<BookEntry>[]): Promise<void> {
    for (const event of events) {
      for (const entry of this.getPhase2Handlers(event.ownerId, event.book)) {
        try {
          await entry.handler(event);
        } catch (err) {
          // Phase-2 re-entry bound: surface past the per-handler catch
          // so the original runTransaction caller sees the failure
          // rather than having it swallowed and logged like a normal
          // handler error.
          if (err instanceof Phase2DepthExceededError) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[stacks] Phase 2 handler error (${event.ownerId}/${event.book}): ${msg}`);
        }
      }
    }
  }
}

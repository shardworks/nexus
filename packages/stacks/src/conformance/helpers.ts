/**
 * Conformance test helpers — create a StacksApi from a bare backend,
 * bypassing the guild startup machinery.
 *
 * Each test gets a fresh backend + API instance. No state leaks.
 */

import type { StacksBackend, BookRef } from '../backend.ts';
import type {
  BookEntry,
  StacksApi,
  ChangeEvent,
  ChangeHandler,
  WatchOptions,
} from '../types.ts';
import { createTestableStacks } from './testable-stacks.ts';

// ── Test factory ─────────────────────────────────────────────────────

export interface TestStacks {
  stacks: StacksApi;
  backend: StacksBackend;
  /** Ensure a book exists (bypasses kit contribution flow). */
  ensureBook(ownerId: string, bookName: string, schema?: { indexes?: (string | string[])[] }): void;
}

export function createTestStacks(backendFactory: () => StacksBackend): TestStacks {
  const backend = backendFactory();
  backend.open({ home: '/tmp/stacks-test' });

  const stacks = createTestableStacks(backend);

  return {
    stacks,
    backend,
    ensureBook(ownerId: string, bookName: string, schema = {}) {
      backend.ensureBook({ ownerId, book: bookName }, schema);
    },
  };
}

// ── Seed helper (bypasses CDC lock) ──────────────────────────────────

export function seedDocument(
  backend: StacksBackend,
  ref: BookRef,
  entry: BookEntry,
): void {
  const tx = backend.beginTransaction();
  tx.put(ref, entry);
  tx.commit();
}

// ── Event collector ──────────────────────────────────────────────────

export function collectEvents<T extends BookEntry = BookEntry>(
  stacks: StacksApi,
  ownerId: string,
  bookName: string,
  options?: WatchOptions,
): ChangeEvent<T>[] {
  const events: ChangeEvent<T>[] = [];
  stacks.watch<T>(ownerId, bookName, ((event: ChangeEvent<T>) => {
    events.push(event);
  }) as ChangeHandler<T>, options);
  return events;
}

// ── Backend spy (for 2.6 — verifying withPrev behavior) ─────────────

export interface PutCall {
  ref: BookRef;
  entry: BookEntry;
  withPrev: boolean;
}

/**
 * Wraps a backend factory to record put() calls on transactions,
 * so tests can verify whether withPrev was requested.
 */
export function spyingBackendFactory(
  factory: () => StacksBackend,
): { factory: () => StacksBackend; putCalls: PutCall[] } {
  const putCalls: PutCall[] = [];

  const wrappedFactory = (): StacksBackend => {
    const backend = factory();
    const origBeginTransaction = backend.beginTransaction.bind(backend);

    backend.beginTransaction = () => {
      const tx = origBeginTransaction();
      const origPut = tx.put.bind(tx);

      tx.put = (ref, entry, opts) => {
        putCalls.push({ ref, entry, withPrev: opts?.withPrev ?? false });
        return origPut(ref, entry, opts);
      };

      return tx;
    };

    return backend;
  };

  return { factory: wrappedFactory, putCalls };
}

// ── Default book ref ─────────────────────────────────────────────────

export const OWNER = 'test-owner';
export const BOOK = 'testbook';
export const REF: BookRef = { ownerId: OWNER, book: BOOK };

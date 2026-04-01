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

// ── Default book ref ─────────────────────────────────────────────────

export const OWNER = 'test-owner';
export const BOOK = 'testbook';
export const REF: BookRef = { ownerId: OWNER, book: BOOK };

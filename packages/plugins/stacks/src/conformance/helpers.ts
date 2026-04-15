/**
 * Conformance test helpers — create a StacksApi from a bare backend,
 * bypassing the guild startup machinery.
 *
 * Each test gets a fresh backend + API instance. No state leaks.
 */

import assert from 'node:assert/strict';
import type { StacksBackend, BookRef } from '../backend.ts';
import type {
  BookEntry,
  StacksApi,
  ChangeEvent,
  ChangeHandler,
  CreateEvent,
  UpdateEvent,
  DeleteEvent,
  WatchOptions,
} from '../types.ts';
import { createTestableStacks } from './testable-stacks.ts';

// ── Test factory ─────────────────────────────────────────────────────

export interface TestStacks {
  stacks: StacksApi;
  backend: StacksBackend;
  /** Ensure a book exists (bypasses kit contribution flow). */
  ensureBook(ownerId: string, bookName: string, schema?: { indexes?: (string | string[])[] }): void;
  /** Seal the CDC registry (mirrors arbor's `phase:started` seal). */
  sealCdc(): void;
}

export function createTestStacks(backendFactory: () => StacksBackend): TestStacks {
  const backend = backendFactory();
  backend.open({ home: '/tmp/stacks-test' });

  const { api, sealCdc } = createTestableStacks(backend);

  return {
    stacks: api,
    backend,
    ensureBook(ownerId: string, bookName: string, schema = {}) {
      backend.ensureBook({ ownerId, book: bookName }, schema);
    },
    sealCdc,
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

// ── CDC event assertion helpers ──────────────────────────────────────

/** Assert the event is a `create` and check its fields. */
export function assertCreateEvent(
  event: ChangeEvent<BookEntry>,
  expected: { entry: BookEntry; ownerId?: string; book?: string },
): asserts event is CreateEvent<BookEntry> {
  assert.strictEqual(event.type, 'create');
  assert.deepStrictEqual(event.entry, expected.entry);
  if (expected.ownerId !== undefined) assert.strictEqual(event.ownerId, expected.ownerId);
  if (expected.book !== undefined) assert.strictEqual(event.book, expected.book);
}

/** Assert the event is an `update` and check its fields. */
export function assertUpdateEvent(
  event: ChangeEvent<BookEntry>,
  expected: { entry: BookEntry; prev: BookEntry; ownerId?: string; book?: string },
): asserts event is UpdateEvent<BookEntry> {
  assert.strictEqual(event.type, 'update');
  assert.deepStrictEqual(event.entry, expected.entry);
  assert.deepStrictEqual(event.prev, expected.prev);
  if (expected.ownerId !== undefined) assert.strictEqual(event.ownerId, expected.ownerId);
  if (expected.book !== undefined) assert.strictEqual(event.book, expected.book);
}

/** Assert the event is a `delete` and check its fields. */
export function assertDeleteEvent(
  event: ChangeEvent<BookEntry>,
  expected: { id: string; prev: BookEntry; ownerId?: string; book?: string },
): asserts event is DeleteEvent<BookEntry> {
  assert.strictEqual(event.type, 'delete');
  assert.strictEqual(event.id, expected.id);
  assert.deepStrictEqual(event.prev, expected.prev);
  if (expected.ownerId !== undefined) assert.strictEqual(event.ownerId, expected.ownerId);
  if (expected.book !== undefined) assert.strictEqual(event.book, expected.book);
}

// ── Default book ref ─────────────────────────────────────────────────

export const OWNER = 'test-owner';
export const BOOK = 'testbook';
export const REF: BookRef = { ownerId: OWNER, book: BOOK };

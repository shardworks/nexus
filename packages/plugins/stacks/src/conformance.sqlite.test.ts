/**
 * Conformance suite — SqliteBackend
 *
 * Runs all conformance tiers against the SQLite backend.  The parametric
 * suite is identical to the MemoryBackend run; per-test isolation is
 * handled by createTestStacks() in conformance/helpers.ts, which gives
 * each test its own mkdtemp home directory.
 */

import { describe } from 'node:test';
import { SqliteBackend } from './sqlite-backend.ts';
import { runConformanceSuite } from './conformance/suite.ts';

describe('Stacks Conformance — SqliteBackend', () => {
  runConformanceSuite('SqliteBackend', () => new SqliteBackend());
});

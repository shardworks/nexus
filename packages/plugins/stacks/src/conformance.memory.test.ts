/**
 * Conformance suite — MemoryBackend
 *
 * Runs all conformance tiers against the in-memory backend.
 */

import { describe } from 'node:test';
import { MemoryBackend } from './memory-backend.ts';
import { runConformanceSuite } from './conformance/suite.ts';

describe('Stacks Conformance — MemoryBackend', () => {
  runConformanceSuite('MemoryBackend', () => new MemoryBackend());
});

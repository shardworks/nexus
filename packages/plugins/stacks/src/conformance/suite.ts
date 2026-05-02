/**
 * Stacks conformance test suite — parametric registration.
 *
 * Exports a single function that registers all conformance tiers
 * against a given backend factory. Each backend test file calls
 * this with its own factory function.
 */

import type { StacksBackend } from '../backend.ts';

import { tier1DataIntegrity } from './tier1-data-integrity.ts';
import { tier2Cdc } from './tier2-cdc.ts';
import { tier25Transactions } from './tier2.5-transactions.ts';
import { tier3Queries } from './tier3-queries.ts';
import { tier4EdgeCases } from './tier4-edge-cases.ts';

export function runConformanceSuite(
  _suiteName: string,
  backendFactory: () => StacksBackend,
): void {
  // Node test runner uses the describe/it calls inside each tier function
  // to register tests. The suite name is just for documentation.
  tier1DataIntegrity(backendFactory);
  tier2Cdc(backendFactory);
  tier25Transactions(backendFactory);
  tier3Queries(backendFactory);
  tier4EdgeCases(backendFactory);
}

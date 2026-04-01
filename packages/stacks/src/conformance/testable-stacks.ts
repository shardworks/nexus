/**
 * Testable Stacks — a minimal StacksApi wired directly to a backend,
 * without requiring the guild startup machinery.
 *
 * Uses the same StacksCore as the production apparatus, ensuring
 * behavioral identity by construction.
 */

import type { StacksBackend } from '../backend.ts';
import type { StacksApi } from '../types.ts';
import { StacksCore } from '../stacks-core.ts';

export function createTestableStacks(backend: StacksBackend): StacksApi {
  const core = new StacksCore(backend);
  return core.createApi();
}

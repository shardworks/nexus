/**
 * @shardworks/fabricator-apparatus — The Fabricator.
 *
 * Guild engine design registry: scans kit contributions, stores engine designs
 * by ID, and provides the FabricatorApi for design lookup.
 *
 * The EngineDesign, EngineRunContext, and EngineRunResult types live here
 * canonically — kit authors import from this package to contribute engines.
 */

import { createFabricator } from './fabricator.ts';

// ── Engine authoring API ───────────────────────────────────────────────

export type {
  EngineDesign,
  EngineDesignInfo,
  EngineRunContext,
  EngineRunResult,
  EngineRetryConfig,
  EngineRetryBackoffConfig,
} from './fabricator.ts';

// ── Fabricator API ────────────────────────────────────────────────────

export type { FabricatorApi } from './fabricator.ts';

// ── Apparatus factory (for tests and direct instantiation) ────────────

export {
  createFabricator,
  DEFAULT_ENGINE_RETRY_BACKOFF,
  validateEngineRetryConfig,
  resolveEngineRetryConfig,
  resolveEngineRetryConfigWithOverrides,
} from './fabricator.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createFabricator();

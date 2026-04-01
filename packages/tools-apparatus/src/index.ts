/**
 * @shardworks/tools-apparatus — The Instrumentarium.
 *
 * Guild tool registry: scans kit contributions, resolves role-gated tool sets,
 * and provides the InstrumentariumApi for tool lookup and resolution.
 *
 * The tool() factory and ToolDefinition type currently live in @shardworks/nexus-core
 * and are re-exported here for convenience. They will move here canonically in a
 * future migration (see instrumentarium.md Implementation Notes).
 *
 * See: docs/architecture/apparatus/instrumentarium.md
 */

// ── Tool authoring API (re-exported from core during transition) ──────

export {
  type ToolCaller,
  type ToolDefinition,
  tool,
  isToolDefinition,
} from '@shardworks/nexus-core';

// ── Instrumentarium API ───────────────────────────────────────────────

export {
  type InstrumentariumApi,
  type InstrumentariumConfig,
  type ResolvedTool,
  type ResolveOptions,
  createInstrumentarium,
} from './instrumentarium.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createInstrumentarium } from './instrumentarium.ts';
export default createInstrumentarium();

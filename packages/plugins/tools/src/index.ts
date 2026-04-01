/**
 * @shardworks/tools-apparatus — The Instrumentarium.
 *
 * Guild tool registry: scans kit contributions, resolves permission-gated
 * tool sets, and provides the InstrumentariumApi for tool lookup and resolution.
 *
 * The tool() factory and ToolDefinition type live here canonically.
 *
 * See: docs/specification.md (instrumentarium)
 */

import { createInstrumentarium } from './instrumentarium.ts';

// ── Tool authoring API ───────────────────────────────────────────────

export {
  type ToolCaller,
  type ToolDefinition,
  tool,
  isToolDefinition,
} from './tool.ts';

// ── Instrumentarium API ───────────────────────────────────────────────

export {
  type InstrumentariumApi,
  type ResolvedTool,
  type ResolveOptions,
} from './instrumentarium.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createInstrumentarium();

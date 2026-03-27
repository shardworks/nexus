/**
 * @shardworks/nexus-rig — guild machinery
 *
 * The rig is the internal guild host: plugin management, tool discovery,
 * and the runtime seam between the CLI/MCP surface and installed plugins.
 *
 * Plugin authors never import from rig — they import from @shardworks/nexus-core.
 * The CLI and session provider import from rig.
 *
 * Package dependency graph:
 *   core     — public SDK, types, tool() factory
 *   rig      — guild host, createRig(), Rig object
 *   cli      — nsg binary, Commander.js, maps NexusTool[] → commands
 *   plugins  — import from core only
 *
 * Inter-plugin API: plugin packages export a typed `fromRig(rig: Rig)` factory
 * that returns their public API surface. Callers import the plugin package and
 * call `fromRig(rig)` to get a typed, initialized reference.
 */

// Re-export guild root discovery from core — consumers can import from one place
export { findGuildRoot } from '@shardworks/nexus-core';

export {
  createRig,
  derivePluginKey,
  type Rig,
  type NexusPlugin,
  type NexusTool,
  type ListToolsOptions,
} from './rig.ts';

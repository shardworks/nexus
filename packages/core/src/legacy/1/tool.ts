// Re-exports for legacy code that imports from this path
export {
  type ToolCaller,
  type ToolDefinition,
  tool,
  isToolDefinition,
  resolveToolFromExport,
  resolveAllToolsFromExport,
} from '../../tool.ts';

/** @deprecated Removed — handlers now use guild() singleton. Kept for type compatibility. */
export type ToolContext = Record<string, never>;

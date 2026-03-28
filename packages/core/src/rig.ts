import type { ToolDefinition } from './tool.ts';

/**
 * The author-facing export type for a rig package.
 *
 * Rig packages export this as their default export. Mainspring reads
 * it at load time to discover the rig's contributions.
 *
 * All fields are optional — a rig may contribute tools, future engine
 * definitions, lifecycle hooks, or any combination thereof.
 *
 * @example
 * ```typescript
 * import { type Rig, tool } from '@shardworks/nexus-core';
 *
 * const myTool = tool({ ... });
 *
 * export default {
 *   tools: [myTool],
 * } satisfies Rig;
 * ```
 */
export interface Rig {
  /** Tools this rig contributes to the guild. */
  tools?: ToolDefinition[];
}

/**
 * Type guard: is this value a Rig export object?
 *
 * Distinguished from bare ToolDefinition/array exports for backward
 * compatibility — rigs may still export a single tool or tool array
 * directly.
 */
export function isRig(obj: unknown): obj is Rig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    !Array.isArray(obj) &&
    ('tools' in obj)
  );
}

import type { ToolDefinition } from './tool.ts';

/**
 * Schema declaration for a single Book in a rig's `books` map.
 *
 * Rig authors declare which fields they want to query on — arbor
 * creates the backing SQLite indexes at startup. No SQL, no JSONPath
 * syntax; field names are plain or dot-notation for nested fields.
 *
 * @example
 *   books: {
 *     writs: { indexes: ['status', 'createdAt', 'parent.id'] },
 *   }
 */
export interface BookOptions {
  /**
   * Field names to index for efficient querying.
   *
   * Plain field names ('status') or dot notation for nested fields
   * ('parent.id'). The storage adapter translates these internally.
   *
   * @example ['status', 'createdAt', 'anima']
   */
  indexes?: string[];
}

/**
 * The author-facing export type for a rig package.
 *
 * Rig packages export this as their default export. Arbor reads
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

  /**
   * Books this rig declares — named document collections backed by SQLite.
   *
   * Arbor reads these declarations at startup and creates tables and
   * indexes for any that don't yet exist. Additive only — no destructive
   * migrations.
   *
   * @example
   *   books: {
   *     writs: { indexes: ['status', 'createdAt'] },
   *   }
   */
  books?: Record<string, BookOptions>;
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
